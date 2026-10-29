#!/usr/bin/env python3
"""DeepSeek House 壁纸：仿 Telegram 默认深色「涂鸦」壁纸。

- 底色取「相册第一张图」的蓝色调（采样后压暗成 #17212B 系）。
- 图案为程序绘制的白描小涂鸦（气泡、纸飞机、心、星星、音符、猫、云、闪电……），
  低不透明度平铺，模拟 Telegram 的 doodle wallpaper，保证气泡文字可读。
- 未使用任何 Telegram 版权素材，全部为脚本原创绘制。

用法：python3 scripts/make_wallpaper.py [源图路径]
输出：app/assets/web/img/wallpaper.jpg（1080x1920，JPEG）
"""
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else "/data/data/com.termux/files/home/1/inbox/a_gifshow.jpg"
OUT_DIR = os.path.join(ROOT, "app", "assets", "web", "img")
W, H = 1080, 1920
TILE = 420
BASE = (24, 24, 24)


def stroke(draw, pts, width, color):
    draw.line(pts, fill=color, width=width, joint="curve")


def doodle(kind, size, draw, color, lw):
    s = size
    def P(x, y):
        return (x * s, y * s)
    if kind == "bubble":
        draw.rounded_rectangle([P(0.12, 0.2), P(0.88, 0.68)], radius=int(s * 0.2), outline=color, width=lw)
        stroke(draw, [P(0.3, 0.68), P(0.42, 0.86), P(0.52, 0.68)], lw, color)
    elif kind == "plane":
        stroke(draw, [P(0.1, 0.5), P(0.9, 0.16), P(0.6, 0.9)], lw, color)
        stroke(draw, [P(0.9, 0.16), P(0.42, 0.56)], lw, color)
        stroke(draw, [P(0.42, 0.56), P(0.6, 0.9)], lw, color)
    elif kind == "heart":
        draw.arc([P(0.08, 0.2), P(0.5, 0.62)], 180, 360, fill=color, width=lw)
        draw.arc([P(0.5, 0.2), P(0.92, 0.62)], 180, 360, fill=color, width=lw)
        stroke(draw, [P(0.08, 0.4), P(0.5, 0.88)], lw, color)
        stroke(draw, [P(0.92, 0.4), P(0.5, 0.88)], lw, color)
    elif kind == "star":
        pts = []
        for i in range(10):
            r = 0.46 if i % 2 == 0 else 0.2
            a = -math.pi / 2 + i * math.pi / 5
            pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
        draw.polygon([(x * s, y * s) for x, y in pts], outline=color, width=lw)
    elif kind == "note":
        draw.ellipse([P(0.14, 0.62), P(0.42, 0.84)], outline=color, width=lw)
        stroke(draw, [P(0.42, 0.74), P(0.42, 0.16)], lw, color)
        stroke(draw, [P(0.42, 0.16), P(0.78, 0.26)], lw, color)
    elif kind == "cat":
        draw.ellipse([P(0.14, 0.26), P(0.86, 0.9)], outline=color, width=lw)
        stroke(draw, [P(0.16, 0.34), P(0.3, 0.1), P(0.44, 0.28)], lw, color)
        stroke(draw, [P(0.84, 0.34), P(0.7, 0.1), P(0.56, 0.28)], lw, color)
        draw.ellipse([P(0.34, 0.5), P(0.4, 0.56)], fill=color)
        draw.ellipse([P(0.6, 0.5), P(0.66, 0.56)], fill=color)
        stroke(draw, [P(0.44, 0.68), P(0.5, 0.72), P(0.56, 0.68)], lw, color)
    elif kind == "cloud":
        draw.arc([P(0.06, 0.34), P(0.5, 0.78)], 90, 270, fill=color, width=lw)
        draw.arc([P(0.3, 0.2), P(0.78, 0.68)], 180, 360, fill=color, width=lw)
        draw.arc([P(0.54, 0.3), P(0.94, 0.7)], 270, 90, fill=color, width=lw)
        stroke(draw, [P(0.06, 0.56), P(0.94, 0.56)], lw, color)
    elif kind == "bolt":
        stroke(draw, [P(0.56, 0.08), P(0.28, 0.54), P(0.5, 0.54), P(0.42, 0.92), P(0.74, 0.42), P(0.52, 0.42)], lw, color)
    elif kind == "mail":
        draw.rounded_rectangle([P(0.08, 0.24), P(0.92, 0.76)], radius=int(s * 0.08), outline=color, width=lw)
        stroke(draw, [P(0.12, 0.3), P(0.5, 0.58), P(0.88, 0.3)], lw, color)
    elif kind == "pin":
        draw.ellipse([P(0.24, 0.08), P(0.76, 0.6)], outline=color, width=lw)
        stroke(draw, [P(0.3, 0.5), P(0.5, 0.94)], lw, color)
        stroke(draw, [P(0.7, 0.5), P(0.5, 0.94)], lw, color)
        draw.ellipse([P(0.42, 0.26), P(0.58, 0.42)], outline=color, width=lw)
    elif kind == "moon":
        draw.arc([P(0.14, 0.1), P(0.9, 0.9)], 40, 320, fill=color, width=lw)
    elif kind == "flower":
        for i in range(6):
            a = i * math.pi / 3
            cx, cy = 0.5 + 0.3 * math.cos(a), 0.5 + 0.3 * math.sin(a)
            draw.ellipse([(cx - 0.13) * s, (cy - 0.13) * s, (cx + 0.13) * s, (cy + 0.13) * s],
                         outline=color, width=lw)
    elif kind == "smile":
        draw.ellipse([P(0.1, 0.1), P(0.9, 0.9)], outline=color, width=lw)
        draw.arc([P(0.3, 0.38), P(0.7, 0.74)], 20, 160, fill=color, width=lw)
        draw.ellipse([P(0.34, 0.32), P(0.4, 0.38)], fill=color)
        draw.ellipse([P(0.6, 0.32), P(0.66, 0.38)], fill=color)
    elif kind == "bookmark":
        draw.polygon([P(0.26, 0.1), P(0.74, 0.1), P(0.74, 0.92), P(0.5, 0.72), P(0.26, 0.92)],
                     outline=color, width=lw)
    elif kind == "wave":
        draw.arc([P(0.06, 0.36), P(0.5, 0.64)], 180, 360, fill=color, width=lw)
        draw.arc([P(0.5, 0.36), P(0.94, 0.64)], 180, 360, fill=color, width=lw)
    elif kind == "atom":
        draw.ellipse([P(0.12, 0.3), P(0.88, 0.7)], outline=color, width=lw)
        draw.ellipse([P(0.3, 0.12), P(0.7, 0.88)], outline=color, width=lw)
        draw.ellipse([P(0.42, 0.42), P(0.58, 0.58)], fill=color)


KINDS = ["bubble", "plane", "heart", "star", "note", "cat", "cloud", "bolt",
         "mail", "pin", "moon", "flower", "smile", "bookmark", "wave", "atom"]


def build_tile(seed=7):
    rnd = random.Random(seed)
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    cells = 3
    step = TILE / cells
    kinds = KINDS[:]
    rnd.shuffle(kinds)
    for row in range(cells):
        for col in range(cells):
            kind = kinds[(row * cells + col) % len(kinds)]
            size = int(step * rnd.uniform(0.42, 0.62))
            icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            alpha = rnd.randint(12, 20)
            color = (255, 255, 255, alpha)
            if kind in ("bolt", "plane", "star") and rnd.random() < 0.35:
                color = (110, 145, 235, alpha + 2)
            doodle(kind, size, ImageDraw.Draw(icon), color, 2)
            icon = icon.rotate(rnd.uniform(-28, 28), resample=Image.BICUBIC, expand=True)
            x = int(col * step + step / 2 - icon.width / 2 + rnd.uniform(-6, 6))
            y = int(row * step + step / 2 - icon.height / 2 + rnd.uniform(-6, 6))
            tile.alpha_composite(icon, (x, y))
    return tile


def sample_blue(src_path):
    try:
        img = Image.open(src_path).convert("RGB").resize((32, 32))
        px = list(img.getdata())
        px.sort(key=lambda c: (c[2] - c[0]), reverse=True)
        top = px[: len(px) // 3]
        r = sum(p[0] for p in top) // len(top)
        g = sum(p[1] for p in top) // len(top)
        b = sum(p[2] for p in top) // len(top)
        return tuple(max(14, min(48, int(v * 0.16))) for v in (r, g, b))
    except Exception:
        return (20, 30, 42)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    base = sample_blue(SRC)
    print("sampled base:", base)

    canvas = Image.new("RGB", (W, H), BASE)
    top, bottom = (29, 29, 30), (17, 17, 18)
    for y in range(H):
        t = y / (H - 1)
        shade = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        ImageDraw.Draw(canvas).line([(0, y), (W, y)], fill=shade)
    blue = Image.new("RGB", (W, H), base)
    canvas = Image.blend(canvas, blue, 0.10)

    tile = build_tile()
    pattern = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for y in range(0, H, TILE):
        for x in range(0, W, TILE):
            pattern.alpha_composite(tile, (x, y))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), pattern).convert("RGB")

    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).ellipse((-W // 4, -H // 6, W + W // 4, H + H // 6), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(int(min(W, H) * 0.16)))
    canvas = Image.composite(canvas, ImageEnhance.Brightness(canvas).enhance(0.82), mask)

    rnd = random.Random(20261029)
    small = Image.new("L", (W // 4, H // 4))
    small.putdata([128 + rnd.randint(-4, 4) for _ in range(small.width * small.height)])
    grain = small.resize((W, H), Image.BILINEAR)
    canvas = Image.blend(canvas, Image.merge("RGB", (grain, grain, grain)), 0.03)

    out = os.path.join(OUT_DIR, "wallpaper.jpg")
    canvas.save(out, quality=88, optimize=True, progressive=True)
    print(out, os.path.getsize(out) // 1024, "KB", canvas.size)


if __name__ == "__main__":
    main()
