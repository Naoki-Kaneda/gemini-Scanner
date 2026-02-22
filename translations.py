"""
検出結果の日本語翻訳辞書。
Google Cloud Vision APIの各種検出結果を日本語で表示するために使用。
"""

OBJECT_TRANSLATIONS = {
    # 人物・身体
    "person": "人", "face": "顔", "head": "頭", "hand": "手",
    "finger": "指", "hair": "髪", "eye": "目", "smile": "笑顔",
    # 衣類
    "clothing": "衣類", "shirt": "シャツ", "jacket": "ジャケット",
    "shoe": "靴", "hat": "帽子", "glasses": "メガネ", "tie": "ネクタイ",
    "dress": "ドレス", "suit": "スーツ",
    # 家具・室内
    "furniture": "家具", "table": "テーブル", "chair": "椅子",
    "desk": "机", "shelf": "棚", "bed": "ベッド", "sofa": "ソファ",
    "door": "ドア", "window": "窓", "wall": "壁", "floor": "床",
    "ceiling": "天井", "room": "部屋", "building": "建物",
    # 電子機器
    "laptop": "ノートPC", "computer": "コンピュータ", "monitor": "モニター",
    "screen": "画面", "keyboard": "キーボード", "mouse": "マウス",
    "phone": "電話", "smartphone": "スマホ", "tablet": "タブレット",
    "camera": "カメラ", "television": "テレビ",
    # 食べ物・飲み物
    "food": "食べ物", "drink": "飲み物", "water": "水",
    "bottle": "ボトル", "cup": "カップ", "plate": "皿",
    # 乗り物
    "car": "車", "vehicle": "車両", "truck": "トラック",
    "bicycle": "自転車", "motorcycle": "バイク", "bus": "バス",
    "train": "電車", "airplane": "飛行機", "boat": "船",
    # 動物
    "animal": "動物", "dog": "犬", "cat": "猫", "bird": "鳥",
    "fish": "魚", "horse": "馬",
    # 自然
    "tree": "木", "flower": "花", "plant": "植物", "grass": "草",
    "sky": "空", "cloud": "雲", "mountain": "山",
    # 道具・物品
    "book": "本", "paper": "紙", "pen": "ペン", "bag": "鞄",
    "box": "箱", "tool": "工具", "machine": "機械", "metal": "金属",
    "plastic": "プラスチック", "wood": "木材", "glass": "ガラス",
    "light": "照明", "sign": "標識", "clock": "時計",
    # 産業・工場
    "equipment": "機器", "pipe": "パイプ", "wire": "ワイヤー",
    "cable": "ケーブル", "circuit board": "基板", "screw": "ネジ",
    "bolt": "ボルト", "nut": "ナット", "gear": "歯車",
    # その他
    "text": "文字", "number": "数字", "logo": "ロゴ",
    "photograph": "写真", "art": "アート", "design": "デザイン",
    "technology": "技術", "engineering": "エンジニアリング",
    "office": "オフィス", "indoor": "室内", "outdoor": "屋外",
    # OBJECT_LOCALIZATION 用の複合語ラベル
    "bicycle wheel": "自転車の車輪", "car mirror": "カーミラー",
    "human face": "人の顔", "human hand": "人の手",
    "human hair": "人の髪", "human eye": "人の目",
    "human nose": "人の鼻", "human mouth": "人の口",
    "human ear": "人の耳", "human body": "人体",
    "human arm": "人の腕", "human leg": "人の足",
    "tire": "タイヤ", "wheel": "車輪",
    "backpack": "リュック", "umbrella": "傘",
    "handbag": "ハンドバッグ", "suitcase": "スーツケース",
    "sports ball": "ボール", "tennis racket": "テニスラケット",
    "wine glass": "ワイングラス", "coffee cup": "コーヒーカップ",
    "dining table": "ダイニングテーブル", "potted plant": "鉢植え",
    "cell phone": "携帯電話", "remote control": "リモコン",
    "traffic light": "信号機", "stop sign": "一時停止標識",
    "fire hydrant": "消火栓", "parking meter": "パーキングメーター",
    "bench": "ベンチ", "skateboard": "スケートボード",
    "surfboard": "サーフボード", "scissors": "ハサミ",
    "teddy bear": "テディベア", "toothbrush": "歯ブラシ",
    "refrigerator": "冷蔵庫", "microwave": "電子レンジ",
    "oven": "オーブン", "sink": "シンク", "toilet": "トイレ",
    "couch": "ソファ", "vase": "花瓶", "pillow": "枕",
}

# ─── 顔検出: 感情の尤度ラベル翻訳 ───────────────────
EMOTION_LIKELIHOOD = {
    "VERY_UNLIKELY": "非常に低い",
    "UNLIKELY": "低い",
    "POSSIBLE": "あり得る",
    "LIKELY": "高い",
    "VERY_LIKELY": "非常に高い",
}

# ─── 顔検出: 感情名の翻訳 ────────────────────────────
EMOTION_NAMES = {
    "joy": "喜び",
    "sorrow": "悲しみ",
    "anger": "怒り",
    "surprise": "驚き",
}

# ─── 分類タグ（LABEL_DETECTION）用の翻訳辞書 ───────────
# OBJECT_TRANSLATIONS を基盤に、LABEL_DETECTION 固有のラベルを追加
LABEL_TRANSLATIONS = {
    **OBJECT_TRANSLATIONS,
    "electronics": "電子機器", "gadget": "ガジェット",
    "font": "フォント", "brand": "ブランド", "product": "製品",
    "screenshot": "スクリーンショット", "software": "ソフトウェア",
    "multimedia": "マルチメディア", "website": "ウェブサイト",
    "material property": "素材特性", "pattern": "パターン",
    "rectangle": "四角形", "parallel": "並行", "symmetry": "対称",
    "circle": "円", "line": "線",
    "automotive design": "自動車デザイン",
    "landscape": "風景", "nature": "自然", "urban": "都市",
    "architecture": "建築", "interior design": "インテリアデザイン",
    "event": "イベント", "sport": "スポーツ", "recreation": "レクリエーション",
    "wrench": "レンチ", "pliers": "ペンチ", "hammer": "ハンマー",
    "screwdriver": "ドライバー", "measurement": "計測",
    "industrial": "工業", "manufacturing": "製造", "factory": "工場",
}
