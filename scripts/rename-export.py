#!/usr/bin/env python3
# Finalize the export: for each photo in export/_raw, apply the EXIF orientation,
# matte verticals onto a horizontal 3:2 background, and save
# with an identifying name in export/. Also generates export/captions.html.
# Uses Pillow (handles rotated photos correctly — EXIF orientation 5/6/7/8).
import json
import os
import sys
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if len(sys.argv) < 2:
    print("✖ usage: rename-export.py <slug>", file=sys.stderr)
    sys.exit(1)
SLUG = sys.argv[1]
TRIP = os.path.join(ROOT, "trips", SLUG)
EXPORT = os.path.join(TRIP, "export")
RAW = os.path.join(EXPORT, "_raw")
MAP = os.path.join(TRIP, "export-map.json")

RAW_EXTS = ["jpeg", "jpg", "JPG", "JPEG", "png", "heic", "HEIC"]


def die(msg):
    print("✖ " + msg, file=sys.stderr)
    sys.exit(1)


def find_raw(uuid):
    for ext in RAW_EXTS:
        p = os.path.join(RAW, f"{uuid}.{ext}")
        if os.path.exists(p):
            return p
    return None


def hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def esc(s):
    return (str(s or "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def main():
    if not os.path.exists(MAP):
        die("export-map.json not found — prepare the export in the app first.")
    if not os.path.isdir(RAW):
        die("export/_raw not found — run the osxphotos command first.")

    data = json.load(open(MAP))
    items = data.get("items", [])
    options = data.get("options", {"matteVertical": True, "padColor": "FFFFFF"})
    matte_vertical = options.get("matteVertical", True)
    pad_rgb = hex_to_rgb(options.get("padColor", "FFFFFF"))

    copied = 0
    matted = 0
    missing = []

    for it in items:
        src = find_raw(it["uuid"])
        if not src:
            missing.append(it)
            continue
        dest = os.path.join(EXPORT, it["name"] + ".jpg")
        # apply EXIF orientation (rotated photos become true portrait)
        img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        w, h = img.size
        if matte_vertical and h > w:
            W = round(h * 3 / 2)
            canvas = Image.new("RGB", (W, h), pad_rgb)
            canvas.paste(img, ((W - w) // 2, 0))
            img = canvas
            matted += 1
        img.save(dest, "JPEG", quality=92)
        copied += 1

    # captions sheet
    rows = []
    for it in items:
        src = find_raw(it["uuid"])
        thumb = "_raw/" + os.path.basename(src) if src else ""
        cap = esc(it.get("caption")) or '<span class="empty">(no caption)</span>'
        img_html = f'<img src="{esc(thumb)}" />' if thumb else "—"
        rows.append(
            f'<tr><td class="n">{esc(it["name"])}</td>'
            f'<td class="img">{img_html}</td><td class="cap">{cap}</td></tr>')

    html = """<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Album captions</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; color:#1b2a4a; margin:32px; }
  h1 { color:#1e4fd6; }
  table { border-collapse: collapse; width:100%; }
  td { border-bottom:1px solid #dbe4f5; padding:10px 8px; vertical-align:top; }
  td.n { font-weight:600; white-space:nowrap; font-size:13px; color:#1e4fd6; }
  td.img img { width:120px; height:auto; border-radius:6px; display:block; }
  td.cap { font-size:15px; line-height:1.5; }
  .empty { color:#9aa7c2; font-style:italic; }
  @media print { .noprint { display:none; } td.img img { width:90px; } }
</style></head><body>
  <h1>\U0001F4D6 Album captions — in sheet order</h1>
  <p class="noprint">Print this or keep it open beside you to copy each caption into the lined column of the physical album.</p>
  <table><thead><tr><td class="n">Position</td><td class="img">Photo</td><td class="cap">Caption</td></tr></thead>
  <tbody>""" + "".join(rows) + """</tbody></table>
</body></html>"""
    open(os.path.join(EXPORT, "captions.html"), "w").write(html)

    print(f"✓ {copied} photos in export/ ({matted} verticals matted to landscape)")
    print("✓ export/captions.html generated")
    if missing:
        print(f"⚠ {len(missing)} not found in export/_raw:")
        for m in missing[:10]:
            print(f"   - {m['name']} ({m['uuid']})")


if __name__ == "__main__":
    main()
