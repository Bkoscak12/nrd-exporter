#!/usr/bin/env python3
"""Build index.html, the install page that GitHub Pages serves.

The bookmark on that page is a small loader: each click fetches the current nrd-exporter.js
from GitHub Pages, so pushing a change updates everyone's bookmark with nothing to re-install.

Usage: python3 build.py
"""
import html
import json
import pathlib

PAGES_URL = "https://bkoscak12.github.io/nrd-exporter/"
NRD_SEARCH = "https://info.securities-administrators.ca/nrsmobile/nrssearch.aspx"

here = pathlib.Path(__file__).parent
src = (here / "nrd-exporter.js").read_text(encoding="utf-8")

# The ?v= timestamp skips the browser cache so every click gets the latest pushed version.
loader = (
    "(()=>{"
    "if(location.hostname!=='info.securities-administrators.ca'){"
    "if(confirm('NRD Exporter runs on the NRD site. Open the National Registration Search now?\\n\\n(Click the bookmark again once it loads.)'))"
    f"location.href='{NRD_SEARCH}';return}}"
    "if(window.__nrdx){window.__nrdx.show();return}"
    "const s=document.createElement('script');"
    f"s.src='{PAGES_URL}nrd-exporter.js?v='+Date.now();"
    "s.onerror=()=>alert('NRD Exporter could not load from GitHub. Check your internet connection and try again.');"
    "document.body.appendChild(s)})()"
)
bookmarklet = "javascript:" + loader.replace("%", "%25").replace("#", "%23")

page = (here / "install.template.html").read_text(encoding="utf-8")
page = page.replace("{{BOOKMARKLET}}", html.escape(bookmarklet, quote=True))
page = page.replace("{{SOURCE_JSON}}", json.dumps(src).replace("</", "<\\/"))
(here / "index.html").write_text(page, encoding="utf-8")
print(f"index.html written ({len(bookmarklet):,} char loader bookmark)")
