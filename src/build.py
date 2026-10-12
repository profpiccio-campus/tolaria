#!/usr/bin/env python3
"""Costruisce dist/index.html unendo src/template.html e src/content.txt."""
import pathlib
import re
import shutil

root = pathlib.Path(__file__).parent
tpl = (root / "src" / "template.html").read_text(encoding="utf-8")
content = (root / "src" / "content.txt").read_text(encoding="utf-8").strip()
body = tpl.replace("__CONTENT__", content)

m = re.search(r"<title>(.*?)</title>", body)
title = m.group(1) if m else "Informatica in Classe"
if m:
    body = body.replace(m.group(0), "", 1)

head = (
    '<!doctype html>\n<html lang="it">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    "<title>" + title + "</title>\n"
    "<style>:root{color-scheme:light}[hidden]{display:none!important}body{margin:0}img{max-width:100%}</style>\n"
    "</head>\n<body>\n"
)
out = root / "dist"
out.mkdir(exist_ok=True)
(out / "index.html").write_text(head + body + "\n</body>\n</html>\n", encoding="utf-8")
att = root / "allegati"
if att.is_dir():
    shutil.copytree(att, out / "allegati", dirs_exist_ok=True)
print("Creato", out / "index.html")
