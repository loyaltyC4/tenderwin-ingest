// BoQ pack extraction — step 1: list AU tenders naming a pricing/BoQ document.
// Uses the Supabase *management* SQL endpoint because PostgREST on this project is 402
// (egress quota exceeded). Read-only. env: OUT (default /tmp/boq-candidates.json)
import fs from "node:fs";
import os from "node:os";

const OUT = process.env.OUT || "/tmp/boq-candidates.json";
const PROJECT = "dtjydsaoatddghbuqlyv";
const PAT = "(pricing schedule|price schedule|schedule of (prices|rates|quantities)|bill of quantities|boq|pricing form|price form|rates schedule|schedule of works)";
const AU = ["vendorpanel-rss", "wa-tenders", "autender-atm", "nsw-etendering", "qld-qtenders",
  "vic-tendersearch", "tas-tenders", "nt-qtol", "act-tendersearch"];

const tok = () => fs.readFileSync(`${os.homedir()}/AutoClaw/Shared/.secrets/keys.env`, "utf8")
  .match(/^SUPABASE_ACCESS_TOKEN=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");

const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok()}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(90000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`sql ${r.status}: ${t.slice(0, 160)}`);
  return JSON.parse(t || "[]");
};

const list = AU.map((s) => `'${s}'`).join(",");
const rows = await sql(`
  select ocid, data->>'source' as src, title, province, closes, value,
         (select json_agg(d) from jsonb_array_elements(data->'docs') d) as docs
  from vula_tenders
  where data->>'source' in (${list})
    and data ? 'docs'
    and jsonb_array_length(data->'docs') > 0`);

const out = [];
for (const r of rows) {
  const hits = (r.docs || []).filter((d) => new RegExp(PAT, "i").test(d.name || d.title || ""));
  if (!hits.length) continue;
  out.push({ ocid: r.ocid, src: r.src, title: r.title, province: r.province, closes: r.closes, value: r.value, docs: hits });
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const by = {};
out.forEach((o) => { by[o.src] = (by[o.src] || 0) + 1; });
console.log(JSON.stringify({ scanned: rows.length, candidates: out.length, bySource: by }));
