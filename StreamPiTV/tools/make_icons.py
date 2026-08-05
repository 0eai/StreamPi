#!/usr/bin/env python3
"""Render the launcher icons — adaptive foreground plus the legacy square/round mipmaps.

The adaptive foreground deliberately bakes a dark backing behind the mark instead of being
fully transparent. Fire OS composites the foreground onto its own light tile rather than using
our background layer, and a light or gradient mark on light grey is invisible; the backing makes
the icon self-sufficient. On Android TV it is the same colour as the background layer, so
nothing changes there.

That backing fills the whole canvas rather than a 264px disc. A disc sized to the safe circle
leaves a visible ring, and enlarging it would leave a square mask's corners transparent; a
full-canvas fill is cropped cleanly by every launcher mask — circle, squircle or rounded square.

The mark itself stays inside the 264px safe circle, which caps how large it can be: for the
current 510:457 source, anything wider than ~196px pushes the bounding box's corners outside
that circle (sqrt((w/2)^2 + (h/2)^2) <= 132).

Re-run after changing the source logo:  python3 tools/make_icons.py
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "..", "app/src/main/res/drawable-nodpi/streampi_logo.png")
RES = os.path.join(HERE, "..", "app/src/main/res")

DARK = (10, 10, 10, 255)          # #0A0A0A, same as @color/ic_launcher_background
CANVAS = 432                      # 108dp at 4x
SAFE = 264                        # 66dp circle guaranteed visible under any mask
MARK_IN_DISC = 190                # see the safe-circle limit above before raising this

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def fit(img, box):
    s = min(box / img.width, box / img.height)
    return img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)


def centre(base, img):
    base.alpha_composite(img, ((base.width - img.width) // 2, (base.height - img.height) // 2))


def main():
    logo = Image.open(LOGO).convert("RGBA")

    # Backing fills the canvas so any mask shape crops it fully — see module docstring.
    fg = Image.new("RGBA", (CANVAS, CANVAS), DARK)
    centre(fg, fit(logo, MARK_IN_DISC))
    os.makedirs(os.path.join(RES, "drawable-nodpi"), exist_ok=True)
    fg.save(os.path.join(RES, "drawable-nodpi/ic_launcher_foreground.png"))
    print(f"adaptive foreground {CANVAS}px, full-canvas backing, mark {MARK_IN_DISC}px "
          f"(safe-circle limit ~196px)")

    for bucket, px in LEGACY.items():
        out = os.path.join(RES, f"mipmap-{bucket}")
        os.makedirs(out, exist_ok=True)
        sq = Image.new("RGBA", (px, px), DARK)
        centre(sq, fit(logo, round(px * 0.66)))
        sq.convert("RGB").save(os.path.join(out, "ic_launcher.png"))

        mask = Image.new("L", (px * 4, px * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
        rnd = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        rnd.paste(sq, (0, 0), mask.resize((px, px), Image.LANCZOS))
        rnd.save(os.path.join(out, "ic_launcher_round.png"))
    print("legacy mipmaps:", ", ".join(f"{k}={v}px" for k, v in LEGACY.items()))


if __name__ == "__main__":
    main()
