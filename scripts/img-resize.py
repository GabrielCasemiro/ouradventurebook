#!/usr/bin/env python3
# Resize an image for the web: apply EXIF orientation (exif_transpose),
# downscale to at most <maxdim> on the longest side (NEVER upscales) and save JPEG.
# Usage: img-resize.py <src> <dest> <maxdim>
import sys
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

src, dest, maxdim = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
w, h = im.size
longest = max(w, h)
if longest > maxdim:
    scale = maxdim / longest
    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
im.save(dest, "JPEG", quality=82)
