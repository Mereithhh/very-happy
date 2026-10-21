#!/usr/bin/env python3
"""B-724: outline the wordmark and OG slogan into scripts/brand/textOutlines.json.

Static logo assets must not depend on fonts installed on the rendering machine, so
text is converted to paths once (IBM Plex, SIL OFL 1.1, from @fontsource in
node_modules). Re-run only when the wordmark or slogan text changes:

    python3 -m venv /tmp/vh-outline && /tmp/vh-outline/bin/pip install fonttools==4.60.1
    /tmp/vh-outline/bin/python scripts/brand/outline-text.py

Paths are in a local frame: baseline at y=0, x from 0, cap height = 40 units.
"""
import json
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FS = ROOT / "node_modules/@fontsource"


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def outline(font_file, text, kern=None, cap=40.0):
    f = TTFont(font_file)
    gs, cmap, hmtx, upm = f.getGlyphSet(), f.getBestCmap(), f["hmtx"], f["head"].unitsPerEm
    s = cap / f["OS/2"].sCapHeight
    x, out = 0.0, []
    for i, ch in enumerate(text):
        gn = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=fmt)
        gs[gn].draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        out.append(pen.getCommands())
        x += hmtx[gn][0] * s + (kern or {}).get(text[i:i + 2], 0) * s
    return {"text": text, "d": "".join(out), "width": round(x, 2), "cap": cap}


data = {
    "wordmark": outline(FS / "ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff", "Very Happy", {"Ve": -28, "ry": -6}),
    "slogan": outline(FS / "ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff", "Every machine. Every agent. Anywhere."),
    "url": outline(FS / "ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff", "veryhappy.dev"),
}
(Path(__file__).parent / "textOutlines.json").write_text(json.dumps(data, indent=1) + "\n")
print({k: v["width"] for k, v in data.items()})
