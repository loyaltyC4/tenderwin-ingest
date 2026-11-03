// Shared minimal .docx text extraction. A docx is a zip: read the central directory, inflate word/document.xml
// (and headers/footers) and strip the XML to text. No dependency, safe on serverless.
import { inflateRawSync } from "zlib";

export function docxText(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return "";
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = [];
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), fl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fl).toString("utf8");
    if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
      const lfl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
      const data = buf.slice(off + 30 + lfl + lel, off + 30 + lfl + lel + csize);
      const xml = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
      out.push(xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
    }
    p += 46 + fl + el + cl;
  }
  return out.join("\n");
}

