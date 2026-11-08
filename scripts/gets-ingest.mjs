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


// ---------- detail enrichment (Phase 2) ----------
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
function parseNzDate(line) {
  // "Monday, 31 December 2029 5:00 PM (Pacific/Auckland UTC+13:00)"
  const m = line.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)?/i);
  const off = (line.match(/UTC([+-]\d{2}):(\d{2})/) || [])[0];
  if (!m) return null;
  let h = parseInt(m[4], 10);
  if (m[6] && /pm/i.test(m[6]) && h < 12) h += 12;
  if (m[6] && /am/i.test(m[6]) && h === 12) h = 0;
  const dt = new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[2].toLowerCase()], parseInt(m[1], 10), h, parseInt(m[5], 10)));
  if (off) {
    const sign = off[3] === "-" ? -1 : 1;
    const oh = parseInt(off.slice(4, 6), 10), om = parseInt(off.slice(7, 9), 10);
    dt.setUTCMinutes(dt.getUTCMinutes() - sign * (oh * 60 + om));
  }
  return dt.toISOString();
}
function extractDetail(html) {
  let txt = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  const emails = [...new Set((txt.match(/mailto:([^"'>\s]+)/gi) || []).map(x => x.slice(7).replace(/&amp;/g, "@").split("?")[0]).filter(e => /\.(govt\.nz|gov\.nz|co\.nz|\.com)$/i.test(e)))].slice(0, 3);
  txt = txt.replace(/<[^>]+>/g, "\n");
  const lines = txt.split("\n").map(l => l.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = { closes: null, openDate: null, tenderType: null, coverage: null, categories: [], regions: null, department: null, description: null, contactEmails: emails, contactName: null, contactPhone: null };
  for (let j = 0; j < lines.length; j++) {
    const l = lines[j];
    if (/^(RFx ID|Tender Name|Open Date|Close Date|Department\/Business Unit|Tender Type|Tender Coverage|Categories|Regions|Exemption Reason|Required Pre-qualifications)\b/.test(l) || l === "&nbsp;:" || l === ":") {
      const label = l.replace(/\s*&nbsp;:\s*$|\s*:\s*$/, "").trim();
      const next = (lines[j + 1] || "").trim();
      if (/^Open Date/i.test(l)) out.openDate = parseNzDate(next) || next;
      else if (/^Close Date/i.test(l)) out.closes = parseNzDate(next) || null;
      else if (/^Tender Type/i.test(l)) out.tenderType = next.slice(0, 60);
      else if (/^Tender Coverage/i.test(l)) out.coverage = next.slice(0, 40);
      else if (/^Regions/i.test(l)) out.regions = next.slice(0, 60);
      else if (/^Department\/Business Unit/i.test(l)) out.department = next.slice(0, 80);
      else if (/^Categories/i.test(l)) { const cats = [next]; for (let k = j + 2; k < Math.min(j + 8, lines.length); k++) { const cl = lines[k]; if (!cl || /^(Regions|Exemption|Required|Contact)/i.test(cl)) break; cats.push(cl); } out.categories = cats.slice(0, 6); }
    }
  }
  // description = the largest text block in the details area (heuristic: longest line runs)
  const bodyLines = lines.slice(0, lines.findIndex(l => /Advertised RFx|Closed Tenders|GETS glossary/i.test(l)) > -1 ? lines.length : lines.length);
  const long = lines.filter(l => l.length > 140).sort((a, b) => b.length - a.length)[0];
  if (long) out.description = long.slice(0, 2500);
  // phone
  const ph = txt.match(/(?:\+64|0[29])[-\s]?\d[\d\s]{6,14}/);
  if (ph) out.contactPhone = ph[0].replace(/\s+/g, " ").trim().slice(0, 24);
  return out;
}
export async function enrichDetails(sb, targets) {
  const results = { enriched: 0, withCloses: 0, withDocs: 0 };
  for (const row of targets) {
    try {
      const url = row.data?.sourceDetailUrl;
      if (!url) continue;
      const r = await fetch(url, { headers: { "user-agent": "TenderWinBot/1.0 (+https://tenderwin.com.au)" } });
      if (!r.ok) continue;
      const det = extractDetail(await r.text());
      const ex = row.data || {};
      const docs = [];
      // GETS-hosted attachments only (never external agency pdfs)
      const html = await (await fetch(url, { headers: { "user-agent": "TenderWinBot/1.0" } })).text();
      for (const m of html.matchAll(/href="([^"]*(?:ExternalAttachment|DownloadAttachment|\/api\/[a-z]*document|attachment\.action)[^"]*)"/gi)) {
        const href = m[1].replace(/&amp;/g, "&");
        docs.push({ title: decodeURIComponent((href.match(/[?&]file(?:Name)?=([^&]+)/) || [])[1] || "GETS attachment"), url: href.startsWith("http") ? href : "https://www.gets.govt.nz" + href, format: (href.match(/\.([a-z0-9]{2,4})(?:$|&|\?)/i) || [])[1] || "FILE", type: "Tender document (public)" });
      }
      const upd = { ...ex, closes: det.closes || ex.closes || null, status: det.closes && new Date(det.closes) < new Date() ? "closed" : (ex.status || "active"),
        url: ex.url || url, sourceDetailUrl: ex.sourceDetailUrl || url,
        contact: ex.contact && ex.contact.email ? ex.contact : { name: det.contactName || null, email: (det.contactEmails || [])[0] || null, phone: det.contactPhone || null } };
      upd.data = { ...ex, ...{ tenderType: det.tenderType || ex.tenderType, coverage: det.coverage || ex.coverage, regions: det.regions || ex.regions, department: det.department || ex.department, description: det.description || ex.description, contactEmails: det.contactEmails || ex.contactEmails, sourceObservedAt: new Date().toISOString() } };
      if (docs.length) upd.docs = docs;
      const merged = { ...row };
      if (upd.docs && upd.docs.length) merged.data.docs = upd.docs;
      const up = await sb.from("vula_tenders").upsert({ ocid: merged.ocid, title: merged.title, buyer: merged.buyer, province: merged.province, category: merged.category, value: merged.value, published: merged.published, closes: upd.closes, status: upd.status, data: { ...(merged.data || {}), docs: (upd.docs && upd.docs.length) ? upd.docs : ((merged.data || {}).docs || []), contact: upd.contact, tenderType: upd.data.tenderType, coverage: upd.data.coverage, regions: upd.data.regions, department: upd.data.department, description: upd.data.description, contactEmails: upd.data.contactEmails, sourceObservedAt: upd.data.sourceObservedAt }, updated_at: new Date().toISOString() }, { onConflict: "ocid" });
      if (up.error) throw new Error(up.error.message.slice(0, 60));
      results.enriched++;
      if (upd.closes) results.withCloses++;
      if (upd.docs && upd.docs.length) results.withDocs++;
    } catch (e) { console.log("  enrich err:", String(e.message).slice(0, 60)); }
    await new Promise(r => setTimeout(r, 1500));
  }
  return results;
}
// ---------- end detail enrichment ----------

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
  // Phase 2 detail enrichment: close dates, tender type, contacts, description, docs.
  // Paced + capped so a run stays a few minutes; the daily workflow fills over time.
  const enrichTargets = rows
    .filter(r => !r.closes)
    .slice(0, 40)
    .map(r => ({ ocid: r.ocid, title: r.title, buyer: r.buyer, province: r.province, category: r.category, value: null, published: r.published, closes: null, status: r.status, data: r.data }));
  if (enrichTargets.length) {
    const er = await enrichDetails(sb, enrichTargets);
    console.log(`enriched: ${er.enriched} | with closes: ${er.withCloses} | with docs: ${er.withDocs}`);
  }
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
  // --- replicate the site's /api/tenders query exactly ---
  const now = new Date().toISOString();
  const { data: rows2 } = await sb.from("vula_tenders").select("data,published")
    .not("ocid", "like", "ocds-9t57fa-%").not("ocid", "like", "prod-%")
    .or(`and(or(closes.is.null,closes.gte.${now}),or(status.is.null,status.eq.active))`)
    .order("published", { ascending: false }).order("ocid").range(0, 999);
  const nzInSql = (rows2 || []).filter(r => String(r.data?.ocid || "").startsWith("gets-nz"));
  console.log("site-SQL page-1 rows:", (rows2 || []).length, "| nz in SQL page:", nzInSql.length);
  if (nzInSql.length) {
    const { data: fss } = await sb.from("vula_tender_feed_state").select("source,last_complete_started_at");
    const completeAt = {}; for (const x of fss || []) completeAt[x.source] = x.last_complete_started_at || null;
    const t = nzInSql[0].data;
    const cutoff = t.source === "qld-qtenders" ? null : ((t.source in completeAt) ? completeAt[t.source] : completeAt["autender-ocds"]);
    console.log("gate check — source:", t.source, "| observedAt:", t.sourceObservedAt, "| cutoff:", cutoff,
      "| passes:", !cutoff || Date.parse(t.sourceObservedAt || 0) >= Date.parse(cutoff));
  }
}
main().catch(e => { console.error("FAIL", e.message); process.exit(1); });
