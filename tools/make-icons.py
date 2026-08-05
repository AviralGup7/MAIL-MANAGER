#!/usr/bin/env python3
"""
Generate the extension icons.

Code-generated on purpose: the output is byte-identical on every run, so an
icon change shows up as a real diff instead of imperceptible AI-resample noise,
and nobody has to keep a 3 MB source PSD in the repo.

The mark: a rounded square with a blue->violet diagonal gradient (matching
--accent and the brand mark in app.css) and a white envelope glyph whose flap
is drawn as a chevron. Everything is supersampled 8x then downsampled with
LANCZOS, which is what gives clean edges at 16px.

Run:  python3 tools/make-icons.py
"""

from PIL import Image, ImageDraw
import os

SS = 8  # supersample factor
SIZES = (16, 48, 128)
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

# app.css --accent (#1a4fd6) -> the violet in #brand-mark (#8b5cf6)
C0 = (26, 79, 214)
C1 = (139, 92, 246)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # Diagonal gradient, drawn as horizontal lines over the anti-diagonal.
    grad = Image.new("RGB", (n, n))
    gd = ImageDraw.Draw(grad)
    for i in range(2 * n):
        gd.line([(0, i), (i, 0)], fill=lerp(C0, C1, i / (2 * n - 1)))

    # Rounded-square mask. Radius 22% matches the 7px/26px of #brand-mark.
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # Envelope. Proportions chosen so the glyph still reads at 16px: a wide,
    # short body with a shallow flap. A taller envelope turns to mush.
    pad_x = n * 0.215
    body_top = n * 0.315
    body_bot = n * 0.685
    left, right = pad_x, n - pad_x
    stroke = max(1, int(n * 0.055))
    radius = int(n * 0.05)

    d.rounded_rectangle(
        [left, body_top, right, body_bot],
        radius=radius,
        outline=(255, 255, 255, 255),
        width=stroke,
    )

    # Flap: two lines from the top corners to the centre, inset so they meet
    # the body outline cleanly rather than crossing it.
    inset = stroke * 0.5
    apex = ((left + right) / 2, body_top + (body_bot - body_top) * 0.46)
    d.line([(left + inset, body_top + inset), apex], fill=(255, 255, 255, 255), width=stroke)
    d.line([(right - inset, body_top + inset), apex], fill=(255, 255, 255, 255), width=stroke)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, f"icon{s}.png")
        render(s).save(path, optimize=True)
        print(f"icon{s}.png  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
