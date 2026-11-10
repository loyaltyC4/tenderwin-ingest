// Tenders WA closed corpus: the public "Closed and Under Evaluation" list (~175 records).
// Insert-only; live wa-tenders rows are never touched.
// env: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "@supabase/supabase-js";

const E = process.env;
if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const decode = (s) => String(s || "").replace(/&ndash;/g, "-").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

const r = await fetch("https://www.tenders.wa.gov.au/watenders/tender/search/tender-search.action?action=advanced-tender-search-closed-tender", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60000) });
if (!r.ok) { console.error("closed list http", r.status); process.exit(1); }
const html = await r.text();
const rows = new Map();
const pat = /<a[^>]+href="[^"]*tender-details\.action\?id=(\d+)[^"]*"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
for (const m of html.matchAll(pat)) {
  const title = decode(m[2].replace(/<[^>]+>/g, " "));
  if (!title || title.length < 8) continue;
  if (!rows.has(m[1])) rows.set(m[1], title.slice(0, 200));
}
console.log("closed rows found:", rows.size);
const now = new Date().toISOString();
const out = [...rows.entries()].map(([id, title]) => {
  const ocid = `wa-tenders-${id}`;
  return {
    ocid, title, buyer: null, province: "WA", category: null, value: null,
    published: null, closes: null, status: "closed",
    data: { ocid, source: "wa-tenders", ref: id, title, province: "WA", closes: null, status: "closed",
      url: `https://www.tenders.wa.gov.au/watenders/tender/display/tender-details.action?id=${id}&action=display-tender-details`,
      sourceDetailUrl: `https://www.tenders.wa.gov.au/watenders/tender/display/tender-details.action?id=${id}&action=display-tender-details`,
      sourceUrl: "https://www.tenders.wa.gov.au", sourceObservedAt: now, docs: [], closedCorpus: true },
    updated_at: now,
  };
});
const ids = out.map((x) => x.ocid);
const { data: have } = await sb.from("vula_tenders").select("ocid").in("ocid", ids);
const known = new Set((have || []).map((x) => x.ocid));
const fresh = out.filter((x) => !known.has(x.ocid));
console.log("already known:", known.size, "| new:", fresh.length);
if (fresh.length) {
  const { error } = await sb.from("vula_tenders").insert(fresh);
  console.log(error ? "insert err: " + error.message.slice(0, 80) : `inserted ${fresh.length}`);
}
