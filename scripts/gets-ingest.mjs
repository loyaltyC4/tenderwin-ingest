// NZ GETS ingest (2026-11-08). Reads the public GETS RSS (all current NZ government
// tenders in one call), maps rows into vula_tenders (source "nz-gets", additive),
// and marks rows that left the feed as closed. Phase 1: listings; detail-page
// enrichment (closing dates, documents) comes later.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (never logged).
// Run: node scripts/gets-ingest.mjs
import { createClient } from "@supabase/supabase-js";

const FEED = "https://www.gets.govt.nz/ExternalRSSFeed.htm";
const SOURCE = "nz-gets";

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function parseGetsFeed(xml, observedAt = new Date().toISOString()) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const pick = (tag) => { const x = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return x ? decodeEntities(x[1]) : ""; };
    const link = (pick("link") || pick("guid")).replace("gets.govt.nz//", "gets.govt.nz/");
    const id = (link.match(/[?&]id=(\d+)/) || [])[1];
    if (!id) continue;
    const title = pick("title");
    const buyer = pick("dc:creator") || "New Zealand Government";
    const pub = pick("pubDate");
    const cat = pick("category");
    const ref = (title.match(/^([A-Z0-9][A-Z0-9./-]{2,20})\s*[-–]/) || [])[1] || id;
    const data = {
      ocid: `gets-nz-${id}`,
      source: SOURCE,
      ref,
      title,
      buyer,
      province: "New Zealand",
      category: cat ? cat.replace(/^\d+\s*-\s*/, "").slice(0, 80) : null,
      published: pub ? new Date(pub).toISOString() : observedAt,
      closes: null,
      status: "active",
      url: link,
      sourceDetailUrl: link,
      sourceUrl: "https://www.gets.govt.nz",
      sourceObservedAt: observedAt,
      docs: [],
    };
    out.push({ ocid: data.ocid, title, buyer, province: "New Zealand", category: data.category, value: null,
      published: data.published, closes: null, status: "active", data, updated_at: observedAt });
  }
  return out;
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const r = await fetch(FEED, { headers: { "user-agent": "TenderWinBot/1.0 (+https://tenderwin.com.au)" } });
  if (!r.ok) throw new Error("feed " + r.status);
  const xml = await r.text();
  const observed = new Date().toISOString();
  const rows = parseGetsFeed(xml, observed);
  const seen = new Set(rows.map(x => x.ocid));
  console.log(`feed items: ${rows.length}`);
  // existing rows for this source (merge-safe upsert)
  let from = 0; const existing = new Map();
  while (true) {
    const { data } = await sb.from("vula_tenders").select("ocid,data").eq("data->>source", SOURCE).range(from, from + 999);
    if (!data || !data.length) break;
    for (const x of data) existing.set(x.ocid, x.data);
    from += 1000;
    if (data.length < 1000) break;
  }
  console.log("existing nz-gets rows:", existing.size);
  let upserted = 0, closed = 0;
  for (const row of rows) {
    const ex = existing.get(row.ocid);
    const data = ex ? { ...ex, ...row.data, docs: ex.docs || [], contact: ex.contact || row.data.contact || null } : row.data;
    const up = await sb.from("vula_tenders").upsert({ ...row, data }, { onConflict: "ocid" });
    if (up.error) { throw new Error("upsert failed: " + up.error.message.slice(0, 80)); }
    upserted++;
  }
  for (const [ocid, ex] of existing) {
    if (!seen.has(ocid) && ex.status !== "closed") {
      const cl = await sb.from("vula_tenders").update({ status: "closed", updated_at: new Date().toISOString() }).eq("ocid", ocid);
      if (cl.error) throw new Error("close failed: " + cl.error.message.slice(0, 80));
      closed++;
    }
  }
  console.log(`upserted: ${upserted} | newly closed: ${closed}`);
  // Register/refresh this source's scan state so the site's freshness gate uses
  // nz-gets's own complete time (not the federal fallback, which can post-date us).
  const fsr = await sb.from("vula_tender_feed_state").upsert({
    source: SOURCE, status: "complete",
    last_attempt_at: observed, last_success_at: observed, last_complete_started_at: observed,
  }, { onConflict: "source" });
  if (fsr.error) console.log("FEED STATE ERROR:", fsr.error.message.slice(0, 100));
  else console.log("feed state refreshed");
  // read-back verification: can this key see its own rows?
  const { count } = await sb.from("vula_tenders").select("ocid", { count: "exact", head: true }).eq("data->>source", SOURCE);
  console.log("read-back nz-gets row count:", count);
  const { data: st } = await sb.from("vula_tender_feed_state").select("source,last_complete_started_at").eq("source", SOURCE).maybeSingle();
  console.log("feed state row:", JSON.stringify(st));
}
main().catch(e => { console.error("FAIL", e.message); process.exit(1); });
