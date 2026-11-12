#!/usr/bin/env python3
"""Download a URL (curl, browser UA), keep by extension, extract text, report $ hits.

Usage: sor-grab.py <url> [<url> ...]
Writes into /Users/chikondinkhalamba/AutoClaw/Shared/ops/evidence/sor/_raw
Prints: url | status | type | bytes | money_hits | unit_hints | first 3 money contexts
"""
import hashlib, os, re, subprocess, sys, zipfile, io

RAW = "/Users/chikondinkhalamba/AutoClaw/Shared/ops/evidence/sor/_raw"
os.makedirs(RAW, exist_ok=True)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

MONEY = re.compile(r"\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*\.\d{2}\b")
UNIT = re.compile(r"\b(m2|m3|lm|lm\.m|each|ea|no\.|hr|hour|tonne|t\b|kg|km|day|item|sum|m\^?2|per m2|per m3|per hour)\b", re.I)


def slug(url):
    h = hashlib.sha1(url.encode()).hexdigest()[:10]
    base = re.sub(r"[^A-Za-z0-9._-]", "_", url.split("?")[0].rstrip("/").split("/")[-1])[:60]
    return f"{base}-{h}"


def text_from(path, head):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".pdf" or head[:4] == b"%PDF":
            r = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, timeout=120)
            return r.stdout.decode("utf-8", "ignore")
        if ext in (".xlsx", ".xlsm") or head[:2] == b"PK":
            z = zipfile.ZipFile(path)
            names = [n for n in z.namelist() if n.endswith("sharedStrings.xml") or re.match(r"xl/worksheets/sheet\d+\.xml", n)]
            out = []
            for n in names[:8]:
                raw = z.read(n).decode("utf-8", "ignore")
                if n.endswith("sharedStrings.xml"):
                    out += re.findall(r"<t[^>]*>(.*?)</t>", raw)
                else:
                    for row in re.findall(r"<row[^>]*>(.*?)</row>", raw):
                        cells = re.findall(r"<c[^>]*>(?:<f>.*?</f>)?<v>(.*?)</v>", row)
                        out.append(" | ".join(cells))
            return "\n".join(out)
        if ext == ".docx":
            z = zipfile.ZipFile(path)
            x = z.read("word/document.xml").decode("utf-8", "ignore")
            x = re.sub(r"</w:p>", "\n", x); x = re.sub(r"</w:tc>", " | ", x)
            return re.sub(r"<[^>]+>", "", x)
        if ext == ".csv" or ext == ".txt":
            return open(path, encoding="utf-8", errors="ignore").read()
        return open(path, encoding="utf-8", errors="ignore").read()
    except Exception as e:
        return f"__PARSE_FAIL__ {e}"


def main():
    for url in sys.argv[1:]:
        dest = os.path.join(RAW, slug(url))
        r = subprocess.run(["curl", "-sSL", "--max-time", "90", "-A", UA, "-o", dest + ".part",
                            "-w", "%{http_code} %{content_type}", url], capture_output=True)
        meta = r.stdout.decode().strip()
        code = meta.split(" ")[0] if meta else "000"
        ctype = meta.split(" ", 1)[1] if " " in meta else ""
        if not os.path.exists(dest + ".part"):
            print(f"{url} | {code} | nodownload | 0 | 0 | 0 |")
            continue
        head = open(dest + ".part", "rb").read(8)
        size = os.path.getsize(dest + ".part")
        ext = ""
        for e, sig in ((".pdf", b"%PDF"), (".xlsx", b"PK"), (".docx", b"PK")):
            if head.startswith(sig):
                ext = e; break
        if not ext:
            if "pdf" in ctype: ext = ".pdf"
            elif "sheet" in ctype or "excel" in ctype: ext = ".xlsx"
            elif "word" in ctype: ext = ".docx"
            elif "html" in ctype: ext = ".html"
        final = dest + (ext or ".bin")
        os.replace(dest + ".part", final)
        if size < 800 and not ext == ".html":
            print(f"{url} | {code} | {ext or 'bin'} | {size} | 0 | 0 | tiny/err")
            continue
        txt = text_from(final, head)
        money = MONEY.findall(txt)
        units = len(UNIT.findall(txt))
        ctx = []
        for m in re.finditer(r"\$\s?\d[\d,]*(\.\d{1,2})?", txt):
            ctx.append(txt[max(0, m.start() - 70):m.end() + 30].replace("\n", " ").strip())
            if len(ctx) >= 3: break
        print(f"{url} | {code} | {ext or 'bin'} | {size} | {len(money)} | {units} | " + " || ".join(ctx)[:400])


if __name__ == "__main__":
    main()
