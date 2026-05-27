"""
Generate LenderBuild favicon and PWA icons.
Design: "LB" in white on navy #1E3A5F background, rounded corners.
"""
from PIL import Image, ImageDraw, ImageFont
import os, struct, zlib

NAVY = (30, 58, 95)      # #1E3A5F
WHITE = (255, 255, 255)

def make_icon(size, radius_frac=0.18):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r = int(size * radius_frac)
    # Rounded rect background
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=NAVY + (255,))

    # Pick font size — aim for ~55% of icon height
    target_h = int(size * 0.52)
    font = None
    # Try system fonts
    for path in [
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/Arial Bold.ttf",
        "C:/Windows/Fonts/calibrib.ttf",
        "C:/Windows/Fonts/verdanab.ttf",
        "C:/Windows/Fonts/trebucbd.ttf",
    ]:
        if os.path.exists(path):
            for sz in range(target_h, 4, -1):
                try:
                    f = ImageFont.truetype(path, sz)
                    bb = draw.textbbox((0, 0), "LB", font=f)
                    if (bb[3] - bb[1]) <= target_h:
                        font = f
                        break
                except Exception:
                    pass
            if font:
                break

    if font is None:
        font = ImageFont.load_default()

    bb = draw.textbbox((0, 0), "LB", font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x = (size - tw) / 2 - bb[0]
    y = (size - th) / 2 - bb[1]
    draw.text((x, y), "LB", fill=WHITE + (255,), font=font)
    return img


def save_ico(img_512, path):
    """Save a multi-size ICO file (16, 32, 48, 64) from a 512px source."""
    sizes = [16, 32, 48, 64]
    import io
    frames = []
    for s in sizes:
        frame = img_512.resize((s, s), Image.LANCZOS).convert("RGBA")
        buf = io.BytesIO()
        frame.save(buf, format="PNG")
        frames.append((s, buf.getvalue()))

    with open(path, "wb") as f:
        # ICO header
        f.write(struct.pack("<HHH", 0, 1, len(frames)))  # reserved, type=1 (ICO), count
        offset = 6 + len(frames) * 16
        for s, data in frames:
            f.write(struct.pack("BBBBHHII",
                s if s < 256 else 0,   # width (0 = 256)
                s if s < 256 else 0,   # height
                0,                     # color count
                0,                     # reserved
                1,                     # color planes
                32,                    # bits per pixel
                len(data),             # size of data
                offset,                # offset
            ))
            offset += len(data)
        for _, data in frames:
            f.write(data)


out = "frontend/public"
os.makedirs(out, exist_ok=True)

img512 = make_icon(512)
img192 = make_icon(192)
img180 = make_icon(180)

img512.save(f"{out}/logo512.png", "PNG", optimize=True)
img192.save(f"{out}/logo192.png", "PNG", optimize=True)
img180.save(f"{out}/apple-touch-icon.png", "PNG", optimize=True)
save_ico(img512, f"{out}/favicon.ico")

print("Icons generated:")
for f in ["favicon.ico", "logo192.png", "logo512.png", "apple-touch-icon.png"]:
    size = os.path.getsize(f"{out}/{f}")
    print(f"  {f}: {size} bytes")
