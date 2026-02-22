"""
レート制限モジュール。
Redis（マルチプロセス対応）またはインメモリ（シングルプロセス用フォールバック）を自動選択する。
"""

import os
import time
import uuid
import logging
from threading import Lock

from dotenv import load_dotenv

# 単体テスト時にもenvが確実に読まれるよう、各モジュールでも呼ぶ（冪等）
load_dotenv()

logger = logging.getLogger(__name__)

# ─── 設定 ──────────────────────────────────────
REDIS_URL = os.getenv("REDIS_URL", "")
RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "20"))
RATE_LIMIT_DAILY = int(os.getenv("RATE_LIMIT_DAILY", "1000"))


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
        return {1, 'daily'}
    end

    local minute_count = redis.call('ZCARD', minute_key)
    if minute_count >= per_minute then
        return {1, 'minute'}
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
            tuple: (制限中か, エラーメッセージ, request_id|None)
        """
        now = time.time()
        today = time.strftime("%Y-%m-%d")
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

        if result[0] == 1:
            reason = result[1] if isinstance(result[1], str) else result[1].decode()
            if reason == "daily":
                return True, f"1日あたりのAPI上限({RATE_LIMIT_DAILY}回)に達しました", None
            return True, f"リクエスト頻度が高すぎます（上限: {RATE_LIMIT_PER_MINUTE}回/分）", None

        returned_id = result[1] if isinstance(result[1], str) else result[1].decode()
        return False, "", returned_id

    def release(self, client_ip, request_id):
        """失敗時に指定IDの予約のみを取り消す。"""
        today = time.strftime("%Y-%m-%d")
        minute_key = f"rate:minute:{client_ip}"
        daily_key = f"rate:daily:{client_ip}:{today}"
        self._client.eval(self._LUA_RELEASE, 2, minute_key, daily_key, request_id)

    def get_daily_count(self, client_ip):
        """日次カウントを取得する（テスト・監視用）。"""
        today = time.strftime("%Y-%m-%d")
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
            tuple: (制限中か, エラーメッセージ, request_id|None)
        """
        now = time.time()
        today = time.strftime("%Y-%m-%d")

        with self._lock:
            daily = self._daily_store.get(client_ip, {"date": "", "count": 0})
            if daily.get("date") != today:
                daily = {"date": today, "count": 0}

            if daily["count"] >= RATE_LIMIT_DAILY:
                return True, f"1日あたりのAPI上限({RATE_LIMIT_DAILY}回)に達しました", None

            entries = list(self._rate_store.get(client_ip, []))
            recent = [e for e in entries if now - e[0] < 60]
            if len(recent) >= RATE_LIMIT_PER_MINUTE:
                return True, f"リクエスト頻度が高すぎます（上限: {RATE_LIMIT_PER_MINUTE}回/分）", None

            request_id = uuid.uuid4().hex[:12]
            self._rate_store[client_ip] = recent + [(now, request_id)]
            daily["count"] += 1
            self._daily_store[client_ip] = daily

        return False, "", request_id

    def release(self, client_ip, request_id):
        """失敗時に指定IDの予約のみを取り消す。"""
        now = time.time()
        today = time.strftime("%Y-%m-%d")

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
        today = time.strftime("%Y-%m-%d")
        daily = self._daily_store.get(client_ip, {"date": "", "count": 0})
        if daily.get("date") != today:
            return 0
        return daily["count"]


# ─── バックエンド選択・公開API ─────────────────────
_backend = None


def _get_backend():
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
