"""
レート制限モジュール。
Redis（マルチプロセス対応）またはインメモリ（シングルプロセス用フォールバック）を自動選択する。
"""

from __future__ import annotations

import os
import time
import uuid
import logging
from threading import Lock
from typing import Optional, Protocol, Tuple

from dotenv import load_dotenv

# 単体テスト時にもenvが確実に読まれるよう、各モジュールでも呼ぶ（冪等）
load_dotenv()

logger = logging.getLogger(__name__)

# ─── 設定 ──────────────────────────────────────
REDIS_URL = os.getenv("REDIS_URL", "")
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))
RATE_LIMIT_DAILY = int(os.getenv("RATE_LIMIT_DAILY", "1000"))

# レート制限メッセージ（両バックエンドで共通）
_MSG_DAILY_EXCEEDED = f"1日あたりのAPI上限({RATE_LIMIT_DAILY}回)に達しました"
_MSG_MINUTE_EXCEEDED = f"リクエスト頻度が高すぎます（上限: {RATE_LIMIT_PER_MINUTE}回/分）"


def _today_key():
    """本日の日付キー文字列を返す（YYYY-MM-DD形式）。"""
    return time.strftime("%Y-%m-%d")


class RateLimiterBackend(Protocol):
    """レート制限バックエンドのインターフェース仕様（構造的部分型）。"""

    def try_consume(self, client_ip: str) -> Tuple[bool, str, Optional[str | int]]: ...
    def release(self, client_ip: str, request_id: str) -> None: ...
    def get_daily_count(self, client_ip: str) -> int: ...


def _seconds_until_midnight():
    """翌日0時までの残り秒数を返す（日付境界リセット用）。"""
    import datetime
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0) + datetime.timedelta(days=1)
    return max(int((midnight - now).total_seconds()), 1)


# ─── Redis バックエンド ────────────────────────────
class RedisRateLimiter:
    """Redis原子操作によるレート制限（マルチプロセス安全）。"""

    # Lua: チェック＆予約を原子的に実行
    # 戻り値: [status, payload]
    # status 0: 成功, payload = request_id
    # status 1: 分制限超過, payload = wait_seconds ( oldest_ts + 60 - now )
    # status 2: 日制限超過, payload = 'daily'
    _LUA_CONSUME = """
    local minute_key = KEYS[1]
    local daily_key = KEYS[2]
    local now = tonumber(ARGV[1])
    local request_id = ARGV[2]
    local per_minute = tonumber(ARGV[3])
    local daily_limit = tonumber(ARGV[4])
    local daily_ttl = tonumber(ARGV[5])

    redis.call('ZREMRANGEBYSCORE', minute_key, '-inf', now - 60)

    local daily_count = tonumber(redis.call('GET', daily_key) or '0')
    if daily_count >= daily_limit then
        return {2, 'daily'}
    end

    local minute_count = redis.call('ZCARD', minute_key)
    if minute_count >= per_minute then
        local oldest = redis.call('ZRANGE', minute_key, 0, 0, 'WITHSCORES')
        local wait = 10
        if #oldest >= 2 then
            wait = math.max(1, math.ceil(tonumber(oldest[2]) + 60 - now))
        end
        return {1, wait}
    end

    redis.call('ZADD', minute_key, now, request_id)
    redis.call('EXPIRE', minute_key, 90)
    redis.call('INCR', daily_key)
    if redis.call('TTL', daily_key) < 0 then
        redis.call('EXPIRE', daily_key, daily_ttl)
    end

    return {0, request_id}
    """

    # Lua: 指定IDの予約のみ取り消し
    _LUA_RELEASE = """
    local minute_key = KEYS[1]
    local daily_key = KEYS[2]
    local request_id = ARGV[1]

    local removed = redis.call('ZREM', minute_key, request_id)
    if removed > 0 then
        local current = tonumber(redis.call('GET', daily_key) or '0')
        if current > 0 then
            redis.call('DECR', daily_key)
        end
    end
    return removed
    """

    def __init__(self, client):
        self._client = client

    def try_consume(self, client_ip):
        """
        制限チェック＆予約を原子的に実行する。

        Returns:
            tuple: (制限中か, エラーメッセージ, request_id|wait_seconds|None)
        """
        now = time.time()
        today = _today_key()
        request_id = uuid.uuid4().hex[:12]

        # 翌日0時までの残り秒数（日付境界でリセットするため）
        seconds_until_midnight = _seconds_until_midnight()

        minute_key = f"rate:minute:{client_ip}"
        daily_key = f"rate:daily:{client_ip}:{today}"

        result = self._client.eval(
            self._LUA_CONSUME, 2, minute_key, daily_key,
            str(now), request_id,
            str(RATE_LIMIT_PER_MINUTE), str(RATE_LIMIT_DAILY),
            str(seconds_until_midnight),
        )

        status = result[0]
        payload = result[1] if isinstance(result[1], str) else result[1]
        if isinstance(payload, bytes):
            payload = payload.decode()

        if status == 2:  # daily
            return True, _MSG_DAILY_EXCEEDED, None
        if status == 1:  # minute
            return True, _MSG_MINUTE_EXCEEDED, payload

        return False, "", payload

    def release(self, client_ip, request_id):
        """失敗時に指定IDの予約のみを取り消す。"""
        today = _today_key()
        minute_key = f"rate:minute:{client_ip}"
        daily_key = f"rate:daily:{client_ip}:{today}"
        self._client.eval(self._LUA_RELEASE, 2, minute_key, daily_key, request_id)

    def get_daily_count(self, client_ip):
        """日次カウントを取得する（テスト・監視用）。"""
        today = _today_key()
        daily_key = f"rate:daily:{client_ip}:{today}"
        count = self._client.get(daily_key)
        return int(count) if count else 0


# ─── インメモリ バックエンド ──────────────────────
class InMemoryRateLimiter:
    """インメモリレート制限（シングルプロセス用フォールバック）。"""

    def __init__(self):
        try:
            from cachetools import TTLCache
        except ImportError:
            raise ImportError(
                "cachetools がインストールされていません。pip install -r requirements.txt を実行してください。"
            )
        self._rate_store = TTLCache(maxsize=10_000, ttl=90)
        self._daily_store = TTLCache(maxsize=10_000, ttl=86400)
        self._lock = Lock()

    def try_consume(self, client_ip):
        """
        制限チェック＆予約を原子的に実行する。

        Returns:
            tuple: (制限中か, エラーメッセージ, request_id|wait_seconds|None)
        """
        now = time.time()
        today = _today_key()

        with self._lock:
            daily = self._daily_store.get(client_ip, {"date": "", "count": 0})
            if daily.get("date") != today:
                daily = {"date": today, "count": 0}

            if daily["count"] >= RATE_LIMIT_DAILY:
                return True, _MSG_DAILY_EXCEEDED, None

            entries = list(self._rate_store.get(client_ip, []))
            recent = [e for e in entries if now - e[0] < 60]
            if len(recent) >= RATE_LIMIT_PER_MINUTE:
                # 最も古いエントリーが消えるまでの秒数を計算（切り上げ）
                oldest_ts = recent[0][0]
                wait_seconds = max(1, int(oldest_ts + 60 - now) + 1)
                return True, _MSG_MINUTE_EXCEEDED, wait_seconds

            request_id = uuid.uuid4().hex[:12]
            self._rate_store[client_ip] = recent + [(now, request_id)]
            daily["count"] += 1
            self._daily_store[client_ip] = daily

        return False, "", request_id

    def release(self, client_ip, request_id):
        """失敗時に指定IDの予約のみを取り消す。"""
        now = time.time()
        today = _today_key()

        with self._lock:
            entries = list(self._rate_store.get(client_ip, []))
            new_entries = []
            removed = False
            for e in entries:
                if not removed and e[1] == request_id:
                    removed = True
                    continue
                if now - e[0] < 60:
                    new_entries.append(e)
            self._rate_store[client_ip] = new_entries

            if removed:
                daily = self._daily_store.get(client_ip, {"date": "", "count": 0})
                if daily.get("date") == today and daily["count"] > 0:
                    daily["count"] -= 1
                    self._daily_store[client_ip] = daily

    def get_daily_count(self, client_ip):
        """日次カウントを取得する（テスト・監視用）。"""
        today = _today_key()
        daily = self._daily_store.get(client_ip, {"date": "", "count": 0})
        if daily.get("date") != today:
            return 0
        return daily["count"]


# ─── バックエンド選択・公開API ─────────────────────
_backend: Optional[RateLimiterBackend] = None


def _get_backend() -> RateLimiterBackend:
    """設定に基づいてバックエンドを初期化・取得する（遅延初期化）。"""
    global _backend
    if _backend is not None:
        return _backend

    if REDIS_URL:
        try:
            import redis
            client = redis.from_url(REDIS_URL, decode_responses=False)
            client.ping()
            _backend = RedisRateLimiter(client)
            # URLの認証情報をマスクしてログ出力
            safe_url = REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL
            logger.info("レート制限: Redis バックエンド (%s)", safe_url)
            return _backend
        except Exception as e:
            logger.warning("Redis接続失敗、インメモリにフォールバック: %s", e)

    _backend = InMemoryRateLimiter()
    logger.info("レート制限: インメモリバックエンド（シングルプロセスのみ）")
    return _backend


def try_consume_request(client_ip):
    """レート制限チェック＆予約。"""
    return _get_backend().try_consume(client_ip)


def release_request(client_ip, request_id):
    """失敗時に指定IDの予約を取り消す。"""
    return _get_backend().release(client_ip, request_id)


def get_daily_count(client_ip):
    """日次カウントを取得する。"""
    return _get_backend().get_daily_count(client_ip)


def get_backend_type():
    """現在のレート制限バックエンド種別を返す（監視・readyz用）。"""
    backend = _get_backend()
    if isinstance(backend, RedisRateLimiter):
        return "redis"
    return "in_memory"


def reset_for_testing():
    """テスト用: バックエンドをインメモリにリセットする。"""
    global _backend
    _backend = InMemoryRateLimiter()
    return _backend
