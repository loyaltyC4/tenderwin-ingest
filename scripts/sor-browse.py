#!/usr/bin/env python3
"""Download via CloakBrowser (stealth Chromium): page fetch -> JS binary fetch -> base64.

Usage: sor-browse.py <url> [<url> ...]
Saves under evidence/sor/_raw and prints a stats line (money hits, unit hints, samples).
"""
import base64, hashlib, os, re, subprocess, sys, zipfile
from cloakbrowser import launch

RAW = "/Users/chikondinkhalamba/AutoClaw/Shared/ops/evidence/sor/_raw"
os.makedirs(RAW, exist_ok=True)
MONEY = re.compile(r"\$\s?\d[\d,]*(?:\.\d{1,2})?")
UNIT = re.compile(r"\b(m2|m3|m\^2|lm|each|ea\b|hr\b|hour|tonne|per tonne|kg|km|day|item|sum|per hour)\b", re.I)

JS = """async (u) => {
  const r = await fetch(u, {credentials:'include'});
  const b = await r.arrayBuffer();
  let s=''; const v=new Uint8Array(b); const CH=0x8000;
  for (let i=0;i<v.length;i+=CH) s+=String.fromCharCode.apply(null, v.subarray(i,i+CH));
  return {ct: r.headers.get('content-type')||'', code: r.status, b64: btoa(s)};
}"""


def slug(u):
    h = hashlib.sha1(u.encode()).hexdigest()[:10]
    b = re.sub(r"[^A-Za-z0-9._-]", "_", u.split("?")[0].rstrip("/").split("/")[-1])[:60]
    return f"{b}-{h}"


def extract(path):
    ext = os.path.splitext(path)[1].lower()
    head = open(path, "rb").read(8)
    try:
        if head[:4] == b"%PDF" or ext == ".pdf":
            import pypdf
            try:
                r = pypdf.PdfReader(path)
                return "\n".join((pg.extract_text() or "") for pg in r.pages[:60])
            except Exception as e:
                return f"__PDF_FAIL__ {e}"
        if head[:2] == b"PK":
            z = zipfile.ZipFile(path); out = []
            for n in z.namelist()[:10]:
                if n.endswith("sharedStrings.xml"):
                    out += re.findall(r"<t[^>]*>(.*?)</t>", z.read(n).decode("utf-8", "ignore"))
                elif re.match(r"xl/worksheets/sheet\d+\.xml", n):
                    for row in re.findall(r"<row[^>]*>(.*?)</row>", z.read(n).decode("utf-8", "ignore")):
                        out.append(" | ".join(re.findall(r"<c[^>]*>(?:<f>.*?</f>)?<v>(.*?)</v>", row)))
            return "\n".join(out)
        if "word" in ext:
            x = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8", "ignore")
            return re.sub(r"<[^>]+>", "", re.sub(r"</w:p>", "\n", x))
        return open(path, encoding="utf-8", errors="ignore").read()
    except Exception as e:
        return f"__PARSE_FAIL__ {e}"


def main():
    b = launch(headless=True)
    page = b.new_page()
    for u in sys.argv[1:]:
        try:
            resp = page.context.request.get(u, timeout=60000, fail_on_status_code=False)
            code, ct, data = resp.status, resp.headers.get("content-type", ""), resp.body()
        except Exception as e:
            print(f"{u} | ERR | {str(e)[:90]} |"); continue
        ext = ""
        if data[:4] == b"%PDF": ext = ".pdf"
        elif data[:2] == b"PK": ext = ".xlsx"
        elif "pdf" in ct: ext = ".pdf"
        elif "sheet" in ct or "excel" in ct: ext = ".xlsx"
        elif "word" in ct: ext = ".docx"
        else: ext = ".html"
        dest = os.path.join(RAW, slug(u) + ext)
        open(dest, "wb").write(data)
        txt = extract(dest)
        m = MONEY.findall(txt)
        ctx = []
        for mm in MONEY.finditer(txt):
            ctx.append(re.sub(r"\s+", " ", txt[max(0, mm.start() - 60):mm.end() + 25]).strip())
            if len(ctx) >= 3: break
        print(f"{u} | {code} | {ext} | {len(data)} | money={len(m)} units={len(UNIT.findall(txt))} | " + " || ".join(ctx)[:300])
    b.close()


if __name__ == "__main__":
    main()
