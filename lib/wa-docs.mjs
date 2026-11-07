// Tenders WA specification documents: pure helpers (parsing, signatures, row building).
// WA hands files only to a logged-in supplier, and its site blocks Vercel's IPs, so the scheduled ingest
// runner (scripts/wa-docs.mjs) logs in, downloads each open tender's pack, stores the files and writes
// `docs` rows carrying `waFile` (see enrich.mjs isPortalFile). The site then streams them to signed-in
// TenderWin users. The download is the portal's own "Download for Tender Documents" form; nothing is
// bid, submitted or responded to.
//
// COPY NOTICE: also lives in bidcheck-au/lib so the tests can run there. Keep byte-identical.

const txt = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

// "Specification Documents" block of a tender detail page -> [{ name, ver }].
// Each file is <span class="LIST_TITLE">NAME</span> <span class="SMALL_GRAY">(Ver 2 - 4 Nov, 2026)</span>.
export function parseWaFileList(html) {
  const s = String(html || "");
  const i = s.indexOf('id="documents"');
  if (i < 0) return [];
  const out = [];
  const re = /<span class="LIST_TITLE">([^<]{1,300})<\/span>\s*<span class="SMALL_GRAY">\(([^)<]{0,60})\)<\/span>/g;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(s))) out.push({ name: txt(m[1]), ver: txt(m[2]) });
  return out;
}

// Identity of a pack: changes when a file is added, removed or re-versioned (an addendum).
export const waSignature = (files) => (files || []).map((f) => `${f.name}|${f.ver}`).sort().join("\n");

// The portal's logged-in menu carries the supplier dashboard link; the anonymous menu does not.
export const waLoggedIn = (html) => /supplier\/dashboard\.action/.test(String(html || ""));

// "Token: onxfrb9" in the login email.
export function parseWaToken(emailText) {
  const m = txt(emailText).match(/\bToken:\s*([A-Za-z0-9]{4,12})\b/);
  return m ? m[1] : "";
}

// CSRF interstitial ("Security Warning") that carries the real download link with a fresh nonce.
export function parseNonceLink(html) {
  const m = String(html || "").match(/href="(https:\/\/www\.tenders\.wa\.gov\.au\/watenders\/tender\/downloadspecs\.action\?CSRFNONCE=[^"]+)"/);
  return m ? m[1].replace(/&amp;/g, "&") : "";
}

// "Download for Tender Documents" page -> the form to POST.
export function parseRequestForm(html) {
  const s = String(html || "");
  const f = s.match(/<form[^>]*name="form"[^>]*action="([^"]+)"[^>]*>[\s\S]*?<\/form>/i);
  if (!f) return null;
  const psf = f[0].match(/name="psfId"\s+value="(\d+)"/);
  const count = new Set([...f[0].matchAll(/documentRequested\[(\d+)\]/g)].map((m) => m[1])).size;
  if (!psf || !count) return null;
  return { action: f[1].replace(/&amp;/g, "&"), psfId: psf[1], count };
}

export const waViewId = (ocid) => String(ocid || "").match(/^wa-tenders-(\d+)$/)?.[1] || "";

export function safeFileName(name) {
  const n = String(name || "document").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  return n || "document";
}
const CT = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip", txt: "text/plain", csv: "text/csv", rtf: "application/rtf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", dwg: "application/octet-stream" };
export const extOf = (n) => (String(n || "").match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
export const contentTypeFor = (n) => CT[extOf(n)] || "application/octet-stream";

export const WA_BUCKET = "wa-docs";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Storage key for one file: stable per tender + position + name, so a re-download overwrites in place.
export const waStorageKey = (ocid, index, name) => `${ocid}/${index}-${safeFileName(name).replace(/[^\w.\- ]+/g, "_")}`;

// docs rows persisted on the tender. `stored` = [{ name, key, size, ver }].
export function buildWaRows(stored, detailUrl) {
  return (stored || []).map((f) => ({
    title: f.name, format: extOf(f.name) || "file", url: detailUrl || "https://www.tenders.wa.gov.au",
    waFile: f.key, waName: f.name, waVer: f.ver || "", waSize: f.size || 0,
  }));
}

// Pick the tenders to fetch this run: open, soonest-closing first, only when the pack is new or changed.
export function pickWaDue(rows, { now = Date.now(), limit = 20 } = {}) {
  return (rows || [])
    .filter((r) => r.closes ? Date.parse(r.closes) > now : true)
    .sort((a, b) => (Date.parse(a.closes) || Infinity) - (Date.parse(b.closes) || Infinity))
    .slice(0, limit);
}
