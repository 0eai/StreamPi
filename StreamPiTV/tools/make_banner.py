#!/usr/bin/env python3
"""Render the Android TV / Fire TV launcher banner at every density bucket.

The launcher draws these tiles side by side with first-party banners, so the artwork has
to sit at a comparable scale or it reads as oversized. Measured off a real Apps row, the
Google banners keep their artwork at roughly 32-49% of the tile height (mean ~43%) and
under ~87% of the width. ART_HEIGHT_FRAC is set from that, not picked by eye.

Re-run after changing the source logo:  python3 tools/make_banner.py
"""
from PIL import Image, ImageDraw, ImageFont
import os
import sys

LOGO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "app/src/main/res/drawable-nodpi/streampi_logo.png")
OUT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app/src/main/res")
FONT = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
WORDMARK = "TV"
BG = (10, 10, 10, 255)          # #0A0A0A, matches the app background

ART_HEIGHT_FRAC = 0.42          # tallest element vs banner height
MAX_WIDTH_FRAC = 0.80           # whole lockup vs banner width
TEXT_TO_MARK = 0.66             # wordmark height relative to the mark
GAP_FRAC = 0.05                 # space between mark and wordmark

# 320x180 is the xhdpi baseline; the larger buckets are rendered natively rather than
# upscaled, because Fire TV and 4K panels draw this tile large.
SIZES = {"xhdpi": (320, 180), "xxhdpi": (480, 270), "xxxhdpi": (640, 360)}


def render(logo, W, H):
    mark_h = round(H * ART_HEIGHT_FRAC)
    scale = mark_h / logo.height
    mark = logo.resize((round(logo.width * scale), mark_h), Image.LANCZOS)

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    target_text_h = mark_h * TEXT_TO_MARK
    gap = round(W * GAP_FRAC)

    best = None
    for size in range(round(H * 0.5), 7, -1):
        font = ImageFont.truetype(FONT, size)
        bb = probe.textbbox((0, 0), WORDMARK, font=font)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        fits_w = mark.width + gap + tw <= W * MAX_WIDTH_FRAC
        if fits_w and th <= target_text_h:
            best = (font, bb, tw, th)
            break
    if best is None:
        raise SystemExit("could not fit the wordmark; loosen MAX_WIDTH_FRAC")
    font, bb, tw, th = best

    im = Image.new("RGBA", (W, H), BG)
    total = mark.width + gap + tw
    x0 = (W - total) // 2
    im.alpha_composite(mark, (x0, (H - mark_h) // 2))
    ImageDraw.Draw(im).text(
        (x0 + mark.width + gap, (H - th) // 2 - bb[1]), WORDMARK, font=font,
        fill=(255, 255, 255, 255),
    )
    return im.convert("RGB"), dict(mark=mark.size, font=font.size, text=(tw, th),
                                   total=total, art_h=max(mark_h, th))


def main():
    logo = Image.open(LOGO).convert("RGBA")
    for bucket, (W, H) in SIZES.items():
        d = os.path.join(OUT_ROOT, f"drawable-{bucket}")
        os.makedirs(d, exist_ok=True)
        im, info = render(logo, W, H)
        im.save(os.path.join(d, "tv_banner.png"))
        print(f"{bucket:8} {W}x{H}  mark={info['mark']} font={info['font']}px "
              f"art_h={info['art_h']/H*100:.0f}% width={info['total']/W*100:.0f}%")


if __name__ == "__main__":
    sys.exit(main())
