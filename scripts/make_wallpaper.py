#!/usr/bin/env python3
"""从「相册第一张图」衍生 DeepSeek House 聊天壁纸。

思路：不对原图做可辨认的使用，而是重度模糊 + 压暗 + 蓝调化，只保留
它的蓝色光斑与明暗氛围，作为深色聊天背景；前景气泡与文字保持清晰。

用法：python3 scripts/make_wallpaper.py [源图路径]
输出：
  app/assets/web/img/wallpaper.jpg       （深色版，默认使用）
  app/assets/web/img/wallpaper-soft.jpg  （柔和版候选）
  /data/data/com.termux/files/home/1/inbox/wallpaper-preview.jpg （预览）
"""
import os
import sys
import math
import random

from PIL import Image, ImageDraw, ImageFilter, ImageEnhance, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else "/data/data/com.termux/files/home/1/inbox/a_gifshow.jpg"
OUT_DIR = os.path.join(ROOT, "app", "assets", "web", "img")
INBOX = "/data/data/com.termux/files/home/1/inbox"
W, H = 1080, 1920

BASE = (23, 33, 43)      # #17212B
PANEL = (14, 22, 33)     # #0E1621
ACCENT = (82, 136, 193)  # #5288C1


def cover_resize(img, w, h):
    """等比放大到覆盖目标尺寸，再居中裁切。"""
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    nw, nh = int(math.ceil(sw * scale)), int(math.ceil(sh * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


def tint(img, color, amount):
    layer = Image.new("RGB", img.size, color)
    return Image.blend(img, layer, amount)


def vignette(img, strength=0.55):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    # 中心亮、四角暗
    d.ellipse((-w // 3, -h // 4, w + w // 3, h + h // 4), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(min(w, h) * 0.18)))
    dark = ImageEnhance.Brightness(img).enhance(1 - strength)
    return Image.composite(img, dark, mask)


def noise(img, amount=6):
    w, h = img.size
    rnd = random.Random(20261029)
    small = Image.new("L", (w // 3, h // 3))
    small.putdata([128 + rnd.randint(-amount, amount) for _ in range(small.width * small.height)])
    grain = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(0.6))
    return ImageChops.add(img, Image.merge("RGB", (grain, grain, grain)), scale=2.0, offset=-64)


def build(soft=False):
    src = Image.open(SRC).convert("RGB")
    # 1) 铺满竖屏 + 重度模糊，只留色块与明暗
    img = cover_resize(src, W, H)
    img = img.filter(ImageFilter.GaussianBlur(radius=64 if not soft else 52))
    # 2) 提高蓝调纯度
    img = ImageEnhance.Color(img).enhance(1.45)
    img = tint(img, (60, 115, 200), 0.24)
    # 3) 压暗：先乘亮度，再与深蓝底色混合
    img = ImageEnhance.Brightness(img).enhance(0.62 if not soft else 0.72)
    img = Image.blend(Image.new("RGB", img.size, BASE), img, 0.62 if not soft else 0.52)
    # 4) 顶部/底部渐变收暗，保证气泡与输入栏区域低对比
    grad = Image.new("L", (1, H))
    for y in range(H):
        t = y / max(1, H - 1)
        # 顶部 0.16 → 中间 0.02 → 底部 0.22
        v = 0.10 * (1 - min(1, t / 0.32)) ** 2 + 0.16 * max(0, (t - 0.62) / 0.38) ** 1.6
        grad.putpixel((0, y), int(255 * min(1, v)))
    grad = grad.resize((W, H))
    img = Image.composite(Image.new("RGB", img.size, PANEL), img, grad)
    # 5) 暗角 + 极轻噪点
    img = vignette(img, strength=0.5 if not soft else 0.42)
    img = noise(img, amount=5)
    # 6) 再压一点整体亮度到 ~18%
    img = ImageEnhance.Brightness(img).enhance(0.95 if not soft else 1.02)
    return img


def previews(dark, soft_img):
    """两版并排 + 叠加模拟气泡，检查可读性。"""
    scale = 0.32
    pw, ph = int(W * scale), int(H * scale)
    canvas = Image.new("RGB", (pw * 2 + 36, ph + 56), (10, 14, 20))
    for i, (img, label) in enumerate(((dark, "dark (默认)"), (soft_img, "soft"))):
        thumb = img.resize((pw, ph), Image.LANCZOS)
        d = ImageDraw.Draw(thumb)
        # 顶栏
        d.rectangle((0, 0, pw, 26), fill=(23, 33, 43))
        d.text((8, 8), "DeepSeek House", fill=(255, 255, 255))
        # 左侧 AI 气泡
        d.rounded_rectangle((10, 60, int(pw * 0.72), 118), radius=14, fill=(24, 37, 51))
        d.text((18, 72), "有什么可以帮你？", fill=(230, 238, 245))
        # 右侧用户气泡
        d.rounded_rectangle((int(pw * 0.42), 132, pw - 10, 178), radius=14, fill=(43, 82, 120))
        d.text((int(pw * 0.46), 144), "介绍一下 DeepSeek", fill=(240, 246, 252))
        # 输入栏
        d.rectangle((0, ph - 30, pw, ph), fill=(23, 33, 43))
        d.rounded_rectangle((38, ph - 26, pw - 44, ph - 6), radius=10, fill=(14, 22, 33))
        canvas.paste(thumb, (12 + i * (pw + 12), 40))
    canvas.save(os.path.join(INBOX, "wallpaper-preview.jpg"), quality=92)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    dark = build(soft=False)
    soft = build(soft=True)
    dark_path = os.path.join(OUT_DIR, "wallpaper.jpg")
    soft_path = os.path.join(INBOX, "wallpaper-soft.jpg")
    dark.save(dark_path, quality=82, optimize=True, progressive=True)
    soft.save(soft_path, quality=82, optimize=True, progressive=True)
    previews(dark, soft)
    for p in (dark_path, soft_path):
        print(p, os.path.getsize(p) // 1024, "KB")
    print("preview:", os.path.join(INBOX, "wallpaper-preview.jpg"))


if __name__ == "__main__":
    main()
