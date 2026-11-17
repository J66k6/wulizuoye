"""
tools/make-assets.py — 生成站点图标与社交分享图。
依赖 Pillow；只在开发时运行，生成结果已提交到 assets/img/。
"""

from pathlib import Path
from math import cos, sin, radians
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "assets" / "img"
IMG.mkdir(parents=True, exist_ok=True)

FONT_BOLD = Path("C:/Windows/Fonts/msyhbd.ttc")
FONT_REG = Path("C:/Windows/Fonts/msyh.ttc")


def radial_glow(size, color, inner=0.0):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx = cy = size / 2
    max_r = size / 2
    steps = 100
    for i in range(steps, 0, -1):
        t = i / steps
        r = max_r * t
        alpha = int(color[3] * (1 - t) ** 2.2)
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=(color[0], color[1], color[2], alpha),
        )
    return layer


def make_icon(size):
    ss = 1024
    canvas = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # 圆角底板
    pad = 45
    draw.rounded_rectangle(
        [pad, pad, ss - pad, ss - pad],
        radius=210,
        fill=(8, 13, 26, 255),
        outline=(40, 74, 120, 255),
        width=4,
    )

    # 背景微光
    glow = radial_glow(900, (30, 110, 180, 70))
    canvas.alpha_composite(glow, (60, 60))

    # 轨道环
    orbit = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    od = ImageDraw.Draw(orbit)
    od.ellipse([170, 375, 854, 650], outline=(79, 230, 255, 230), width=12)
    orbit = orbit.rotate(-28, center=(ss / 2, ss / 2), resample=Image.BICUBIC)
    canvas.alpha_composite(orbit)

    orbit2 = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    od2 = ImageDraw.Draw(orbit2)
    od2.ellipse([170, 375, 854, 650], outline=(157, 123, 255, 150), width=8)
    orbit2 = orbit2.rotate(52, center=(ss / 2, ss / 2), resample=Image.BICUBIC)
    canvas.alpha_composite(orbit2)

    # 星点
    for angle, radius, color, r in [
        (-28, 342, (255, 255, 255, 255), 18),
        (52, 334, (157, 200, 255, 220), 11),
        (-28 + 130, 342, (79, 230, 255, 180), 8),
        (52 + 210, 334, (157, 123, 255, 160), 7),
    ]:
        x = ss / 2 + cos(radians(angle)) * radius
        y = ss / 2 + sin(radians(angle)) * radius
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)

    # 中心球
    core = radial_glow(430, (79, 230, 255, 230))
    canvas.alpha_composite(core, (int(ss / 2 - 215), int(ss / 2 - 215)))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse([452, 452, 572, 572], fill=(240, 254, 255, 255))
    draw.ellipse([420, 420, 604, 604], outline=(79, 230, 255, 90), width=3)

    # 主题光晕
    halo = radial_glow(560, (79, 230, 255, 45))
    canvas.alpha_composite(halo, (int(ss / 2 - 280), int(ss / 2 - 280)))

    return canvas.resize((size, size), Image.LANCZOS)


def make_og():
    w, h = 1200, 630
    base = Image.new("RGB", (w, h), (5, 8, 17))
    draw = ImageDraw.Draw(base)

    # 渐变
    for y in range(h):
        t = y / h
        r = int(6 + 10 * (1 - t))
        g = int(10 + 20 * (1 - t))
        b = int(22 + 38 * (1 - t))
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # 网格
    for x in range(0, w, 60):
        draw.line([(x, 0), (x, h)], fill=(12, 20, 36), width=1)
    for y in range(0, h, 60):
        draw.line([(0, y), (w, y)], fill=(12, 20, 36), width=1)

    # 右侧光晕
    glow = radial_glow(760, (79, 140, 255, 70))
    base.paste(glow, (620, -70), glow)

    # 右侧轨道
    orbit = Image.new("RGBA", (760, 760), (0, 0, 0, 0))
    od = ImageDraw.Draw(orbit)
    od.ellipse([70, 210, 690, 560], outline=(79, 230, 255, 210), width=7)
    orbit = orbit.rotate(-28, center=(380, 380), resample=Image.BICUBIC)
    base.paste(orbit, (630, 30), orbit)

    orbit2 = Image.new("RGBA", (760, 760), (0, 0, 0, 0))
    od2 = ImageDraw.Draw(orbit2)
    od2.ellipse([70, 210, 690, 560], outline=(157, 123, 255, 130), width=5)
    orbit2 = orbit2.rotate(52, center=(380, 380), resample=Image.BICUBIC)
    base.paste(orbit2, (630, 30), orbit2)

    core = radial_glow(300, (79, 230, 255, 220))
    base.paste(core, (875, 250), core)
    draw = ImageDraw.Draw(base)
    draw.ellipse([960, 335, 1030, 405], fill=(240, 254, 255))
    draw.ellipse([945, 320, 1045, 420], outline=(79, 230, 255, 90), width=2)

    # 文案
    title_font = ImageFont.truetype(str(FONT_BOLD), 84)
    sub_font = ImageFont.truetype(str(FONT_REG), 30)
    tag_font = ImageFont.truetype(str(FONT_BOLD), 22)
    small_font = ImageFont.truetype(str(FONT_REG), 21)

    draw.text((78, 92), "角动量守恒", font=title_font, fill=(233, 242, 255))
    draw.text((82, 196), "虚 拟 仿 真 实 验 室", font=sub_font, fill=(79, 230, 255))
    draw.text(
        (82, 268),
        "可交互 · 可对话 · 可评估",
        font=tag_font,
        fill=(190, 210, 235),
    )
    draw.text(
        (82, 330),
        "拖动配重改变转动惯量，验证 L = Iω；",
        font=small_font,
        fill=(142, 163, 198),
    )
    draw.text(
        (82, 366),
        "再用 AI 助教诊断迷思、自适应测评。",
        font=small_font,
        fill=(142, 163, 198),
    )

    # 公式胶囊
    draw.rounded_rectangle([82, 438, 430, 512], radius=18, fill=(12, 22, 42), outline=(40, 74, 120))
    formula_font = ImageFont.truetype(str(FONT_REG), 34)
    draw.text((108, 458), "L = Iω = 常量", font=formula_font, fill=(233, 242, 255))

    draw.text((82, 552), "UNIVERSITY PHYSICS · H5 LAB", font=small_font, fill=(80, 100, 130))

    base.save(IMG / "og.png", optimize=True)


if __name__ == "__main__":
    make_icon(192).save(IMG / "icon-192.png", optimize=True)
    make_icon(512).save(IMG / "icon-512.png", optimize=True)
    make_icon(180).save(IMG / "apple-touch-icon.png", optimize=True)
    make_og()
    print("assets generated:", *[p.name for p in IMG.iterdir()])
