#!/usr/bin/env python3
# Compose one social slide: fit the whole photo (never cropped) onto a WxH canvas.
# Background is either a solid hex color or "blur" (a blurred, zoomed copy of the
# same photo filling the canvas). Applies EXIF orientation. Saves JPEG.
# Usage: social-canvas.py <src> <dest> <W> <H> <bg>   (bg = "FFFFFF" | "blur")
import sys
from PIL import Image, ImageOps, ImageFilter

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

src, dest, W, H, bg = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]

im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")

def contain(img, w, h):
    r = min(w / img.width, h / img.height)
    return img.resize((max(1, round(img.width * r)), max(1, round(img.height * r))), Image.LANCZOS)

def cover(img, w, h):
    r = max(w / img.width, h / img.height)
    big = img.resize((max(1, round(img.width * r)), max(1, round(img.height * r))), Image.LANCZOS)
    x = (big.width - w) // 2
    y = (big.height - h) // 2
    return big.crop((x, y, x + w, y + h))

if bg == "blur":
    canvas = cover(im, W, H).filter(ImageFilter.GaussianBlur(max(8, W // 40)))
    # darken slightly so the framed photo pops
    canvas = Image.blend(canvas, Image.new("RGB", (W, H), (0, 0, 0)), 0.18)
else:
    hexc = bg.lstrip("#")
    rgb = tuple(int(hexc[i:i + 2], 16) for i in (0, 2, 4)) if len(hexc) == 6 else (255, 255, 255)
    canvas = Image.new("RGB", (W, H), rgb)

# leave a small margin so nothing touches the edge
margin = round(min(W, H) * 0.04)
photo = contain(im, W - 2 * margin, H - 2 * margin)
canvas.paste(photo, ((W - photo.width) // 2, (H - photo.height) // 2))
canvas.save(dest, "JPEG", quality=90)
