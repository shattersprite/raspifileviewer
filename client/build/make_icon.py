"""Draws the PiScreen app icon and writes icon.png (1024 px) and icon.ico (16-256 px).

The icon is a monitor showing test-card colour bars, with the red tally lamp lit.
Sizes of 32 px and below use a simplified drawing so they stay crisp.

Run:  python build/make_icon.py      (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SS = 4  # supersampling factor for smooth edges

GRAPHITE_TOP, GRAPHITE_BOTTOM = (42, 47, 53), (23, 25, 28)
WHITE = (246, 247, 248, 255)
TALLY = (224, 53, 43, 255)
BARS = ["#c4c7ca", "#d9c23c", "#40b6c2", "#3fa35d", "#ad52ad", "#cf463b", "#3a55b5"]


def s(v):
    return int(round(v * SS))


def rounded_mask(size, box, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([s(c) for c in box], radius=s(radius), fill=255)
    return m


def full_icon():
    W = s(1024)
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # Background tile with a vertical graphite gradient.
    grad = Image.new("RGBA", (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(W):
        t = y / (W - 1)
        c = tuple(int(GRAPHITE_TOP[i] + (GRAPHITE_BOTTOM[i] - GRAPHITE_TOP[i]) * t) for i in range(3))
        gd.line([(0, y), (W, y)], fill=c + (255,))
    img.paste(grad, (0, 0), rounded_mask((W, W), (32, 32, 992, 992), 212))

    # Glow behind the tally lamp, drawn first so it only tints the tile, not the monitor.
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([s(830 - 130), s(250 - 130), s(830 + 130), s(250 + 130)], fill=(255, 90, 79, 140))
    glow = glow.filter(ImageFilter.GaussianBlur(s(36)))
    img = Image.alpha_composite(img, glow)

    # Screen: colour bars clipped to the screen area.
    bars = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bars)
    x0, x1, y0, y1 = 214, 810, 290, 642
    step = (x1 - x0) / len(BARS)
    for i, col in enumerate(BARS):
        bd.rectangle([s(x0 + i * step), s(y0), s(x0 + (i + 1) * step) + SS, s(y1)], fill=col)
    img.paste(bars, (0, 0), rounded_mask((W, W), (x0, y0, x1, y1), 10))

    # Monitor frame and stand.
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([s(160), s(236), s(864), s(696)], radius=s(62), outline=WHITE, width=s(52))
    d.rectangle([s(478), s(694), s(546), s(758)], fill=WHITE)
    d.rounded_rectangle([s(356), s(752), s(668), s(804)], radius=s(26), fill=WHITE)

    # Tally lamp: a graphite ring that cuts into the frame, then the lamp.
    d = ImageDraw.Draw(img)
    d.ellipse([s(830 - 110), s(250 - 110), s(830 + 110), s(250 + 110)], fill=(31, 35, 40, 255))
    d.ellipse([s(830 - 80), s(250 - 80), s(830 + 80), s(250 + 80)], fill=TALLY)
    return img.resize((1024, 1024), Image.LANCZOS)


def small_icon(px):
    """Bold, simplified version for tiny sizes."""
    W = s(1024)
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=s(200), fill=(30, 34, 38, 255))
    d.rounded_rectangle([s(140), s(250), s(884), s(720)], radius=s(56), fill=(58, 85, 181, 255),
                        outline=WHITE, width=s(96))
    d.rounded_rectangle([s(380), s(790), s(644), s(880)], radius=s(45), fill=WHITE)
    d.ellipse([s(852 - 190), s(210 - 190), s(852 + 190), s(210 + 190)], fill=(30, 34, 38, 255))
    d.ellipse([s(852 - 140), s(210 - 140), s(852 + 140), s(210 + 140)], fill=TALLY)
    return img.resize((px, px), Image.LANCZOS)


def main():
    big = full_icon()
    big.save(HERE / "icon.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [small_icon(p) if p <= 32 else big.resize((p, p), Image.LANCZOS) for p in sizes]
    frames[-1].save(HERE / "icon.ico", format="ICO", sizes=[(p, p) for p in sizes], append_images=frames[:-1])
    # Preview sheet for checking the small sizes.
    sheet = Image.new("RGBA", (sum(sizes) + 10 * len(sizes) + 10, 276), (232, 234, 236, 255))
    x = 10
    for f in frames:
        sheet.paste(f, (x, 266 - f.height), f)
        x += f.width + 10
    sheet.save(HERE / "icon-preview.png")
    print("wrote icon.png, icon.ico, icon-preview.png")


if __name__ == "__main__":
    main()
