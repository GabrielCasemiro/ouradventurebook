#!/usr/bin/env python3
# Ingest one uploaded photo: bake EXIF orientation, write a thumbnail and a web
# image, and print JSON metadata (dimensions, capture date, EXIF, GPS). Pillow.
# Usage: ingest-upload.py <src> <thumb_out> <web_out>
import json
import os
import sys
from PIL import Image, ImageOps

src, thumb_out, web_out = sys.argv[1], sys.argv[2], sys.argv[3]

im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
W, H = im.size


def save(maxdim, out):
    img = im
    longest = max(W, H)
    if longest > maxdim:
        s = maxdim / longest
        img = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)
    img.save(out, "JPEG", quality=85)


save(1600, thumb_out)
save(2560, web_out)

meta = {}
date = None
try:
    exif = Image.open(src).getexif()
    ex = exif.get_ifd(0x8769)   # Exif IFD
    gps = exif.get_ifd(0x8825)  # GPS IFD
    cam = " ".join(str(x).strip() for x in [exif.get(0x010F), exif.get(0x0110)] if x).strip()
    if cam:
        meta["camera"] = cam
    if ex.get(0xA434):
        meta["lens"] = str(ex.get(0xA434)).strip()
    if ex.get(0x8827):
        iso = ex.get(0x8827)
        meta["iso"] = int(iso[0] if isinstance(iso, (list, tuple)) else iso)
    if ex.get(0x829D):
        meta["aperture"] = round(float(ex.get(0x829D)), 2)
    if ex.get(0x920A):
        meta["focalLength"] = round(float(ex.get(0x920A)), 2)
    if ex.get(0x829A):
        meta["shutter"] = float(ex.get(0x829A))
    dto = ex.get(0x9003) or exif.get(0x0132)  # DateTimeOriginal / DateTime
    if dto:
        d, t = str(dto).strip().split(" ")
        date = f"{d.replace(':', '-')}T{t}"

    def dms(v, ref):
        val = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
        return -val if ref in ("S", "W") else val

    if gps.get(2) and gps.get(4):
        meta["lat"] = dms(gps[2], gps.get(1))
        meta["lng"] = dms(gps[4], gps.get(3))
except Exception:
    pass

try:
    meta["filesize"] = os.path.getsize(src)
except Exception:
    pass

print(json.dumps({"width": W, "height": H, "date": date, "meta": meta or None}))
