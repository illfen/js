#!/usr/bin/env python3
"""
GLM Sniper 验证码识别服务
用于识别「文字点选验证码」—— 图片中有多个中文字符，需要按指定顺序点击。

启动方式:
    pip install -r requirements.txt
    python server.py

默认监听 http://127.0.0.1:9898
油猴脚本会自动将验证码截图发送到此服务。
"""

import base64
import io
import json
import logging
import time
from typing import Optional

import cv2
import numpy as np
import requests as http_requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image, ImageEnhance, ImageFilter

# ---------- 初始化 ----------
app = Flask(__name__)
CORS(app)  # 允许跨域 (油猴脚本从 bigmodel.cn 发请求)

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(message)s')
log = logging.getLogger('captcha-server')

# 延迟加载 ddddocr (启动较慢, 模型约 100MB)
_ocr = None
_det = None
_paddle_ocr = None


def get_ocr():
    global _ocr
    if _ocr is None:
        import ddddocr
        _ocr = ddddocr.DdddOcr(show_ad=False)
        log.info('ddddocr OCR 模型已加载')
    return _ocr


def get_det():
    global _det
    if _det is None:
        import ddddocr
        _det = ddddocr.DdddOcr(det=True, show_ad=False)
        log.info('ddddocr 检测模型已加载')
    return _det


def get_paddle_ocr():
    global _paddle_ocr
    if _paddle_ocr is None:
        from paddleocr import PaddleOCR
        _paddle_ocr = PaddleOCR(use_angle_cls=False, lang='ch', show_log=False)
        log.info('PaddleOCR 模型已加载')
    return _paddle_ocr


def paddle_ocr_crop(crop_img: Image.Image) -> str:
    """用 PaddleOCR 识别单个裁剪区域"""
    pocr = get_paddle_ocr()
    img_np = np.array(crop_img.convert('RGB'))
    # PaddleOCR 需要 BGR
    img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
    result = pocr.ocr(img_bgr, det=False, cls=False)
    if result and result[0]:
        # result[0] 是 [(text, confidence), ...]
        texts = [r[0] for r in result[0] if r[1] > 0.3]
        combined = ''.join(texts)
        return ''.join(c for c in combined if '\u4e00' <= c <= '\u9fff')
    return ''


# ---------- 形近字模糊匹配 ----------

# 共享偏旁/部首的形近字映射 (OCR 常见混淆)
_SIMILAR_CHARS = {}

def _build_similar_map():
    """构建形近字映射表"""
    groups = [
        '村郴林枫材析杆杉松柏柳桂栋梅梧榆楠槐檀植椅桃棉棋楼樱橘',  # 木旁
        '江河湖海泊池沙洋洲浙涧溪潭瀑沧沪汕汝沛洛浩涛淮渝湘泡泥注洞浅浇浮涂消淡渠温漫漂潮',  # 水旁
        '铁铜银锌钢锡镇镜链锋铭锐镶钊钎铸锄铂钙钟铃铅铲',  # 金旁
        '陈阵防陪院隆隐障陵附阻陡隧陶隋邦邮部郊都邻郑',  # 阝旁
        '花草药茶荷莲菊萍蒲芭苗芳荣蓉蔡藏蕊蒸薄藤蘑菇莓',  # 草头
        '请说话语诗词谈谊认让训记讲许论诊谷诺读课谁调谦谱',  # 言旁
        '明映时晚晨晴暗暖曙曦昭晖暑昏晾晰晓旷',  # 日旁
        '吗呢啊哈吧呀吹呼咬哭唱嘴喊嚷啸嗅吃叫叶听',  # 口旁
        '他她你们位体伯仲任佳信催偿像倾做傍',  # 人旁
        '把扮打扫扬投抱抬挑挡捡换接拔拉拍拖拼指挺提揭搜撑撒撞擦摸抄',  # 手旁
        '安宝宣宫宇宁宜容宽寒察寨寓寝密富审',  # 宀头
        '背肯肌肝肤胖胆脆脉脑腰膀臂胸膊腊腿',  # 月旁
        '跑跳路踪蹦蹈踩跨蹄跪蹲践踏距跃蹬',  # 足旁
        '芒芝芥芬芳芮芯花芸芽苍苏苑苗范茂茅茉茫茶荆荐',  # 艹头
        '闻问闭闲间闪闯阅阁阔阐闷',  # 门框
        '纪约红纯纱纲纳纹练组终经结给络绝统编绪绘缝缠绕',  # 绞丝
        '飘飞风凤凡',
        '睛睁睦瞧瞳眨眯瞄瞎瞬盯盼眠',  # 目旁
        '补衬衫袄被裤裙裳袍袖襟袜',  # 衤旁
        '敖散敢教救敏敬數整',  # 攵旁
        '箔篮筷筑笼簸笨筋簿箭篇筒策箱篷',  # 竹头
        '撑掌拿掰掏掠掀控推',  # 手+掌系
        '铂白柏伯',  # 白/柏/铂 容易互相混淆
        '乘乖垂',  # 结构相似
        '场扬汤杨',
        '辈背非',
    ]
    for group in groups:
        for c in group:
            _SIMILAR_CHARS[c] = set(group) - {c}

_build_similar_map()


# ---------- 偏旁拆字: OCR 常把左右结构的字识别成右半部分 ----------
# 键 = OCR 可能识别出的部件, 值 = 包含该部件的完整字
_COMPONENT_MAP = {}

def _build_component_map():
    """构建 '部件 -> 完整字' 映射"""
    pairs = {
        # 钅旁 (金属)
        '本': '钵笨体',
        '白': '柏铂泊怕拍帕伯',
        '令': '铃岭领零龄',
        '甬': '桶捅筒通涌踊',
        '占': '站粘毡钻',
        '仓': '沧苍抢枪',
        '皮': '被披坡波破',
        '寺': '诗持待特等',
        '主': '注驻柱住',
        '且': '姐租组阻',
        '巴': '把吧爸芭疤靶',
        '包': '抱饱泡胞跑炮',
        '分': '份粉纷芬盆',
        '公': '松翁颂讼',
        '工': '功攻江红空',
        '交': '校胶较郊饺绞',
        '各': '格络阁骆客路',
        '古': '故固姑估苦枯胡湖',
        '可': '河何柯哥歌',
        '兰': '栏拦烂澜',
        '力': '历沥励',
        '马': '妈码玛蚂骂驾',
        '门': '闪闲问闻闷',
        '目': '睛瞧盯眠',
        '尃': '博膊搏缚薄',
        '专': '传转砖',
        '者': '著猪暑都赌堵煮',
        '青': '情晴清精请',
        '夫': '扶肤麸',
        '付': '附府符腐',
        '果': '课裸棵颗',
        '奇': '骑椅寄崎',
        '合': '给洽恰',
        '反': '版饭板返',
        '方': '放房防芳访纺',
        '非': '排辈悲斐',
        '甫': '捕辅铺浦',
        '卖': '读续赎',
        '昌': '唱倡猖',
        '成': '城诚盛',
        '东': '冻栋陈',
        '发': '拨泼废',
        '高': '搞稿镐',
        '官': '管馆棺',
        '光': '旷辉',
        '里': '理鲤',
        '卢': '炉芦驴颅',
        '仑': '论轮沦抡',
        '乔': '桥骄轿侨',
        '生': '胜牲姓性',
        '由': '抽油轴邮',
        '着': '薄',
        '事': '膊',
        # 走之底 (辶): OCR 只识别内部部件
        '力': '边办动劝加功务励劣努',
        '尺': '迟迈',
        '斥': '迟',
        '万': '迈',
        '关': '送',
        '首': '道',
        '过': '过',
        '元': '远',
        '云': '运',
        '连': '连',
        '车': '连',
        '还': '还',
        '不': '还',
        '井': '进',
        '辰': '逢',
        '造': '造',
        '告': '造',
        '选': '选',
        '先': '选',
        '退': '退',
        '良': '退',
        '回': '逗迥',
        '豆': '逗',
        # 走字底 (走)
        '取': '趣',
        '召': '超',
        '土': '赶',
        # 其他常见拆字
        '乃': '奶仍',
        '少': '抄炒纱',
        '央': '映英',
        '采': '彩菜',
        '争': '挣睁筝',
        '仑': '论轮沦',
        '至': '到致',
        '台': '治始抬胎苔',
        '令': '铃岭领零龄',
        '寸': '村讨付对',
    }
    for comp, full_chars in pairs.items():
        _COMPONENT_MAP[comp] = set(full_chars)

_build_component_map()


def _fuzzy_match(target_c, candidates):
    """用形近字匹配: 如果 target_c 和候选字共享偏旁，视为匹配"""
    similar = _SIMILAR_CHARS.get(target_c, set())
    # 形近字表匹配
    if similar:
        for pos in candidates:
            for c in pos['char']:
                if c in similar:
                    log.info(f'  模糊匹配: "{target_c}" ≈ "{pos["char"]}" (形近字)')
                    return pos
    # 偏旁拆字匹配: OCR 识别出右半部件
    for pos in candidates:
        for c in pos['char']:
            if c in _COMPONENT_MAP and target_c in _COMPONENT_MAP[c]:
                log.info(f'  拆字匹配: "{target_c}" 含部件 "{c}" (偏旁拆字)')
                return pos
    return None


def _char_similarity(target_c, ocr_c):
    """计算两个字的相似度 (0~1)，用于排除法最优分配"""
    if target_c == ocr_c:
        return 1.0
    if ocr_c == '?':
        return 0.0
    # OCR 可能返回多字 (如 "陈东") -> 取单字最高分
    best = 0.0
    for c in ocr_c:
        if c == target_c:
            return 1.0
        similar = _SIMILAR_CHARS.get(target_c, set())
        if c in similar:
            best = max(best, 0.6)
        if target_c in c or c in target_c:
            best = max(best, 0.8)
        # 偏旁拆字: OCR 经常只识别出右半部分
        if c in _COMPONENT_MAP and target_c in _COMPONENT_MAP[c]:
            best = max(best, 0.7)
        # Unicode 码点接近 -> 可能形近
        diff = abs(ord(target_c) - ord(c))
        if diff <= 5:
            best = max(best, 0.3)
        elif diff <= 20:
            best = max(best, 0.15)
    return best


# ---------- 图片预处理 ----------

def preprocess_for_detection(img_bytes: bytes) -> bytes:
    """预处理整张背景图，提高文字区域检测率"""
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return img_bytes

    # 1. 提高对比度 (CLAHE — 自适应直方图均衡化)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge([l, a, b])
    img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # 2. 轻度锐化
    kernel = np.array([[-0.5, -0.5, -0.5],
                       [-0.5,  5.0, -0.5],
                       [-0.5, -0.5, -0.5]])
    img = cv2.filter2D(img, -1, kernel)

    _, buf = cv2.imencode('.png', img)
    return buf.tobytes()


def preprocess_crop_for_ocr(crop_img: Image.Image) -> bytes:
    """预处理单个裁剪区域，提高单字 OCR 准确率"""
    # 1. 放大 2x (小字放大后识别更准)
    w, h = crop_img.size
    if w < 60 or h < 60:
        crop_img = crop_img.resize((w * 2, h * 2), Image.LANCZOS)

    # 2. 增强对比度
    enhancer = ImageEnhance.Contrast(crop_img)
    crop_img = enhancer.enhance(1.8)

    # 3. 锐化
    crop_img = crop_img.filter(ImageFilter.SHARPEN)

    # 4. 转灰度 → 二值化 (黑字白底，OCR 最喜欢)
    gray = crop_img.convert('L')
    # 自适应阈值: 用 numpy+cv2
    gray_np = np.array(gray)
    binary = cv2.adaptiveThreshold(
        gray_np, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 5
    )
    # 转回 PIL → PNG bytes
    result = Image.fromarray(binary)
    buf = io.BytesIO()
    result.save(buf, format='PNG')
    return buf.getvalue()


def _merge_overlapping_boxes(bboxes, iou_threshold=0.3, dist_threshold=50):
    """合并重叠的检测框，同一个字只保留一个框 (取最大的)"""
    if not bboxes:
        return bboxes

    # 按面积从大到小排序
    bboxes = sorted(bboxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    merged = []

    for box in bboxes:
        x1, y1, x2, y2 = box
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        is_dup = False

        for kept in merged:
            kx1, ky1, kx2, ky2 = kept
            kcx, kcy = (kx1 + kx2) / 2, (ky1 + ky2) / 2

            # 方法1: 中心点距离太近 → 重复
            dist = ((cx - kcx) ** 2 + (cy - kcy) ** 2) ** 0.5
            if dist < dist_threshold:
                is_dup = True
                break

            # 方法2: IoU 太高 → 重复
            ix1 = max(x1, kx1)
            iy1 = max(y1, ky1)
            ix2 = min(x2, kx2)
            iy2 = min(y2, ky2)
            if ix1 < ix2 and iy1 < iy2:
                inter = (ix2 - ix1) * (iy2 - iy1)
                area1 = (x2 - x1) * (y2 - y1)
                area2 = (kx2 - kx1) * (ky2 - ky1)
                iou = inter / (area1 + area2 - inter)
                if iou > iou_threshold:
                    is_dup = True
                    break

        if not is_dup:
            merged.append(box)

    return merged


# ---------- 核心逻辑: 文字点选识别 ----------

def solve_click_captcha(
    bg_base64: str,
    target_chars: str,
    prompt_img_base64: Optional[str] = None
) -> list[dict]:
    """
    识别文字点选验证码。

    参数:
        bg_base64:        验证码背景图 (base64 编码的 PNG/JPG)
        target_chars:     需要点击的目标文字，如 "植株" (按顺序)
        prompt_img_base64: 提示文字的截图 (如果有单独的提示图片)

    返回:
        [{"char": "植", "x": 120, "y": 80}, {"char": "株", "x": 230, "y": 150}]
        坐标相对于背景图左上角。
    """
    t0 = time.time()
    det = get_det()
    ocr = get_ocr()

    # 1. 解码背景图
    bg_bytes = base64.b64decode(bg_base64)
    bg_img = Image.open(io.BytesIO(bg_bytes)).convert('RGB')
    w, h = bg_img.size
    log.info(f'背景图: {w}x{h}, 目标文字: "{target_chars}"')

    # 2. 如果提示文字是图片，先 OCR 识别出目标文字
    if prompt_img_base64 and not target_chars:
        prompt_bytes = base64.b64decode(prompt_img_base64)
        target_chars = ocr.classification(prompt_bytes)
        target_chars = ''.join(c for c in target_chars if '\u4e00' <= c <= '\u9fff')
        log.info(f'提示图 OCR 结果: "{target_chars}"')

    if not target_chars:
        log.warning('未提供目标文字，无法识别')
        return []

    # 3. 预处理 → 检测图片中所有文字区域的位置
    enhanced_bytes = preprocess_for_detection(bg_bytes)
    bboxes = det.detection(enhanced_bytes)
    # 如果预处理后检测不到，退回原图
    if not bboxes:
        bboxes = det.detection(bg_bytes)
    log.info(f'检测到 {len(bboxes)} 个原始区域: {bboxes}')
    # 去除重叠的检测框 (ddddocr 经常对同一个字检测出多个框)
    bboxes = _merge_overlapping_boxes(bboxes)
    log.info(f'去重后 {len(bboxes)} 个区域: {bboxes}')

    # 4. 对每个检测到的区域做 OCR 识别 (原图裁剪 + 预处理)
    char_positions = []
    for bbox in bboxes:
        x1, y1, x2, y2 = bbox
        # 稍微扩大裁剪区域
        pad = 5
        crop_box = (max(0, x1 - pad), max(0, y1 - pad), min(w, x2 + pad), min(h, y2 + pad))
        cropped = bg_img.crop(crop_box)

        # 三路 OCR: ddddocr原图 + ddddocr预处理 + PaddleOCR
        buf_raw = io.BytesIO()
        cropped.save(buf_raw, format='PNG')
        raw_bytes = buf_raw.getvalue()

        text_raw = ocr.classification(raw_bytes)
        text_raw = ''.join(c for c in text_raw if '\u4e00' <= c <= '\u9fff')

        preprocessed_bytes = preprocess_crop_for_ocr(cropped)
        text_pre = ocr.classification(preprocessed_bytes)
        text_pre = ''.join(c for c in text_pre if '\u4e00' <= c <= '\u9fff')

        text_paddle = paddle_ocr_crop(cropped)

        # 优先级: 精确匹配目标字 > 模糊匹配 > 最长结果
        candidates = [('paddle', text_paddle), ('raw', text_raw), ('pre', text_pre)]
        char_text = ''
        chosen_src = ''
        # 1) 找精确匹配目标字的
        for src, txt in candidates:
            if txt and any(c in target_chars for c in txt):
                char_text = txt
                chosen_src = src
                break
        # 2) 找模糊/拆字匹配的
        if not char_text:
            for src, txt in candidates:
                if txt and any(_char_similarity(tc, txt) > 0 for tc in target_chars):
                    char_text = txt
                    chosen_src = src
                    break
        # 3) 取最短非空结果 (单字优于多字)
        if not char_text:
            non_empty = [(src, txt) for src, txt in candidates if txt]
            if non_empty:
                non_empty.sort(key=lambda x: len(x[1]))
                chosen_src, char_text = non_empty[0]

        log.info(f'  三路 OCR: raw="{text_raw}" pre="{text_pre}" paddle="{text_paddle}" → 选="{char_text}"({chosen_src})')

        cx = (x1 + x2) // 2
        cy = (y1 + y2) // 2
        char_positions.append({
            'char': char_text or '?',
            'x': cx,
            'y': cy,
            'bbox': [x1, y1, x2, y2]
        })
        log.info(f'  区域 ({x1},{y1})-({x2},{y2}) -> "{char_text or "?"}" 中心=({cx},{cy})')

    # 5. 按目标文字顺序匹配坐标
    #    策略: 精确匹配 → 形近字 → 排除法 (3个区域3个目标，猜也能猜对)
    remaining_positions = list(char_positions)
    results = []
    unmatched_targets = []

    for target_c in target_chars:
        best = None
        # 5a. 精确匹配
        for pos in remaining_positions:
            if target_c in pos['char']:
                best = pos
                break
        # 5b. 形近字模糊匹配
        if not best:
            best = _fuzzy_match(target_c, remaining_positions)
        if best:
            results.append({'char': target_c, 'x': best['x'], 'y': best['y']})
            remaining_positions.remove(best)
        else:
            unmatched_targets.append(target_c)

    # 5c. 排除法: 用相似度打分做最优分配 (穷举所有排列，取总分最高的)
    matched_count = len(results)  # 精确/模糊匹配的数量
    elim_score = 0.0
    if unmatched_targets and remaining_positions:
        log.info(f'  排除法: {len(unmatched_targets)} 个未匹配目标 ← {len(remaining_positions)} 个剩余区域')
        from itertools import permutations
        best_assignment = None
        best_score = -1
        rp = remaining_positions[:len(unmatched_targets)]
        for perm in permutations(range(len(rp))):
            score = sum(
                _char_similarity(unmatched_targets[i], rp[perm[i]]['char'])
                for i in range(len(unmatched_targets))
            )
            if score > best_score:
                best_score = score
                best_assignment = perm
        elim_score = best_score
        if best_assignment:
            for i, pi in enumerate(best_assignment):
                pos = rp[pi]
                target_c = unmatched_targets[i]
                log.info(f'  排除法分配: "{target_c}" ← 区域 "{pos["char"]}" ({pos["x"]},{pos["y"]}) 相似={_char_similarity(target_c, pos["char"]):.1f}')
                results.append({'char': target_c, 'x': pos['x'], 'y': pos['y']})

    # 按目标文字原始顺序排序 (重要! 点击必须按顺序)
    target_order = {c: i for i, c in enumerate(target_chars)}
    results.sort(key=lambda r: target_order.get(r['char'], 99))

    # 置信度: high=全匹配, medium=至少一半精确匹配, low=大量猜测
    n_target = len(target_chars)
    n_unmatched = n_target - matched_count
    if matched_count == n_target:
        confidence = 'high'
    elif matched_count >= 2:
        confidence = 'medium'  # 至少2个精确匹配，剩下1个猜的可接受
    elif matched_count == 1 and n_unmatched <= 1 and elim_score >= 0.5:
        confidence = 'medium'  # 1个精确 + 1个有强相似度依据
    else:
        confidence = 'low'  # 精确匹配不足，刷新换图更快

    elapsed = time.time() - t0
    log.info(f'识别完成 ({elapsed:.2f}s) 置信度={confidence} 匹配={matched_count}/{n_target} 排除法分={elim_score:.1f}: {results}')
    return results, (w, h), confidence


# ---------- API 路由 ----------

@app.route('/solve', methods=['POST'])
def api_solve():
    """
    POST /solve
    Body (JSON):
    {
        "image": "<base64 编码的验证码背景图>",
        "target": "植株",                    // 目标文字 (按顺序)
        "prompt_image": "<base64>"           // 可选: 提示文字截图
    }

    Response:
    {
        "success": true,
        "points": [
            {"char": "植", "x": 120, "y": 80},
            {"char": "株", "x": 230, "y": 150}
        ],
        "time_ms": 850
    }
    """
    try:
        data = request.get_json(force=True)
        image_b64 = data.get('image', '')
        image_url = data.get('image_url', '')
        target = data.get('target', '')
        prompt_img = data.get('prompt_image', '')

        # 如果没有 base64 但有 URL，服务器自己获取图片
        if not image_b64 and image_url:
            # data: URL → 直接提取 base64
            if image_url.startswith('data:'):
                try:
                    image_b64 = image_url.split(',', 1)[1]
                    log.info(f'从 data URL 提取 base64: {len(image_b64)} chars')
                except Exception:
                    return jsonify({'success': False, 'error': 'invalid data URL'}), 400
            else:
                # HTTP URL → 下载
                try:
                    log.info(f'从 URL 下载图片: {image_url[:80]}...')
                    resp = http_requests.get(image_url, timeout=10, headers={
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                        'Referer': 'https://open.bigmodel.cn/',
                        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    })
                    resp.raise_for_status()
                    image_b64 = base64.b64encode(resp.content).decode('utf-8')
                    log.info(f'下载成功: {len(resp.content)} bytes')
                except Exception as dl_err:
                    log.error(f'图片下载失败: {dl_err}')
                    return jsonify({'success': False, 'error': f'download failed: {dl_err}'}), 400

        if not image_b64:
            return jsonify({'success': False, 'error': 'image or image_url is required'}), 400

        t0 = time.time()
        points, (img_w, img_h), confidence = solve_click_captcha(image_b64, target, prompt_img)
        elapsed_ms = int((time.time() - t0) * 1000)

        return jsonify({
            'success': len(points) > 0,
            'points': points,
            'time_ms': elapsed_ms,
            'image_width': img_w,
            'image_height': img_h,
            'confidence': confidence,
        })
    except Exception as e:
        log.exception('识别异常')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': 'ddddocr'})


if __name__ == '__main__':
    log.info('=== GLM Sniper 验证码识别服务 ===')
    log.info('监听: http://127.0.0.1:9898')
    log.info('预加载模型中...')
    get_ocr()
    get_det()
    log.info('就绪! 等待请求...')
    app.run(host='127.0.0.1', port=9898, debug=False)
