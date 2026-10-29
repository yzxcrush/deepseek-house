#!/usr/bin/env python3
"""Generate Android launcher icons for DeepSeek House from the user's photo.

Source:  /data/data/com.termux/files/home/1/inbox/a_gifshow.jpg  (first photo in gallery)
Crop:    head-focused square (removes the "CAFÉ STILE" label column and the stray "e")
Outputs: legacy mipmap PNGs (rounded + round) and adaptive-icon foreground layers,
         plus dist/icon-512.png for documentation / Play-style preview.

Run:  python3 scripts/make_icons.py [--crop L,T,R,B]
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = "/data/data/com.termux/files/home/1/inbox/a_gifshow.jpg"
RES = os.path.join(ROOT, "app", "res")
DIST = os.path.join(ROOT, "dist")

# head-focused crop chosen from previews (B_head, tightened on the right)
DEFAULT_CROP = (130, 20, 690, 580)   # left, top, right, bottom in source pixels

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
BG_HEX = "#4A63B8"   # sampled from the artwork's blue background


def rounded_mask(size, radius_ratio=0.22):
    m = Image.new("L", (size, size), 0)
    r = int(size * radius_ratio)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return m


def circle_mask(size):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size - 1, size - 1), fill=255)
    return m


def square_crop(img, box):
    w, h = img.size
    l, t, r, b = box
    l = max(0, min(l, w - 1)); t = max(0, min(t, h - 1))
    r = max(l + 1, min(r, w)); b = max(t + 1, min(b, h))
    side = min(r - l, b - t)
    # keep the crop square, anchored at its center
    cx, cy = (l + r) // 2, (t + b) // 2
    l = max(0, cx - side // 2); t = max(0, cy - side // 2)
    return img.crop((l, t, l + side, t + side))


def main():
    box = DEFAULT_CROP
    if "--crop" in sys.argv:
        i = sys.argv.index("--crop")
        box = tuple(int(v) for v in sys.argv[i + 1].split(","))
    src = Image.open(SRC).convert("RGB")
    sq = square_crop(src, box)
    print("source:", src.size, "crop:", box, "-> square:", sq.size)

    for dpi, size in LEGACY.items():
        d = os.path.join(RES, f"mipmap-{dpi}")
        os.makedirs(d, exist_ok=True)
        base = sq.resize((size, size), Image.LANCZOS)
        # subtle inner rim so the icon reads on any wallpaper
        rim = base.copy()
        dr = ImageDraw.Draw(rim)
        dr.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22),
                             outline=(255, 255, 255, 40), width=max(1, size // 48))
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(rim, (0, 0), rounded_mask(size))
        out.save(os.path.join(d, "ic_launcher.png"))
        rnd = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        rnd.paste(base, (0, 0), circle_mask(size))
        rnd.save(os.path.join(d, "ic_launcher_round.png"))

        # adaptive foreground: full-bleed 108dp layer, photo fills it
        fsize = FG[dpi]
        fg = sq.resize((fsize, fsize), Image.LANCZOS).convert("RGBA")
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))

    # adaptive icon xml (API 26+)
    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    template = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(anydpi, name), "w", encoding="utf-8") as f:
            f.write(template)

    values = os.path.join(RES, "values")
    os.makedirs(values, exist_ok=True)
    with open(os.path.join(values, "ic_launcher.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                f'    <color name="ic_launcher_background">{BG_HEX}</color>\n</resources>\n')

    # previews / documentation
    os.makedirs(DIST, exist_ok=True)
    sq.resize((512, 512), Image.LANCZOS).save(os.path.join(DIST, "icon-512.png"))
    prev = Image.new("RGB", (420, 420), (23, 33, 43))
    for i, dpi in enumerate(("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi")):
        im = Image.open(os.path.join(RES, f"mipmap-{dpi}", "ic_launcher.png"))
        s = im.size[0]
        prev.paste(im, (10 + i * 80, 10), im)
    prev.save("/data/data/com.termux/files/home/1/inbox/icon_final_preview.png")
    print("icons written to", RES)


if __name__ == "__main__":
    main()
