// NZ GETS closed corpus: the public closed-tender list (~245 pages x 25 = ~6,100 records,
// back to 2014). Adds catalogue depth, buyer award history and SEO pages — NOT active
// opportunities. Insert-only: live nz-gets rows are never overwritten.
//
// env: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY  NZ_CLOSED_PAGES (default 245)  NZ_CLOSED_FROM (default 1)
import { createClient } from "@supabase/supabase-js";

const E = process.env;
if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) { console.error("missing supabase env"); process.exit(1); }
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const UA = "TenderWinBot/1.0 (+https://tenderwin.com.au)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseClose(s) {
  // "4:00 PM 29 Jul 2014 (Pacific/Auckland UTC+12:00)"
  const m = String(s || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (/pm/i.test(m[3]) && h < 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  const mo = MONTHS[m[5].toLowerCase().slice(0, 3)];
  if (mo == null) return null;
  const dt = new Date(Date.UTC(parseInt(m[6], 10), mo, parseInt(m[4], 10), h, parseInt(m[2], 10)));
  const off = (String(s).match(/UTC([+-]\d{2}):(\d{2})/) || []);
  if (off.length === 3) {
    const sign = off[1][0] === "-" ? -1 : 1;
    dt.setUTCMinutes(dt.getUTCMinutes() - sign * (Math.abs(parseInt(off[1], 10)) * 60 + parseInt(off[2], 10)));
  }
  return dt.toISOString();
}

const FROM = Number(E.NZ_CLOSED_FROM || 1), TO = Number(E.NZ_CLOSED_PAGES || 245);
let inserted = 0, seen = 0, failed = 0;

for (let page = FROM; page <= TO; page++) {
  try {
    const r = await fetch(`https://www.gets.govt.nz/ExternalClosedTenderList.htm?page=${page}&orderBy=date`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) { failed++; continue; }
    const html = await r.text();
    const rows = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]{0,1600}?)<\/tr>/g)) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]{0,400}?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
      if (tds.length < 6 || !/^\d{4,9}$/.test(tds[0])) continue;
      const id = tds[0], ref = tds[1], title = tds[2], type = tds[3], closeRaw = tds[4], buyer = tds[5];
      const closes = parseClose(closeRaw);
      const ocid = `gets-nz-${id}`;
      rows.push({
        ocid, title: title.slice(0, 200), buyer: buyer.slice(0, 140), province: "New Zealand",
        category: null, value: null, published: closes, closes, status: "closed",
        data: { ocid, source: "nz-gets", ref: ref || id, title, buyer, province: "New Zealand", category: null,
          published: closes, closes, status: "closed", url: `https://www.gets.govt.nz/ExternalTenderDetails.htm?id=${id}`,
          sourceDetailUrl: `https://www.gets.govt.nz/ExternalTenderDetails.htm?id=${id}`,
          sourceUrl: "https://www.gets.govt.nz", sourceObservedAt: new Date().toISOString(),
          docs: [], closedCorpus: true, tenderType: type || null },
        updated_at: new Date().toISOString(),
      });
      seen++;
    }
    // insert-only: fetch which ocids already exist, insert the rest
    const ids = rows.map((x) => x.ocid);
    const { data: have } = await sb.from("vula_tenders").select("ocid").in("ocid", ids);
    const known = new Set((have || []).map((x) => x.ocid));
    const fresh = rows.filter((x) => !known.has(x.ocid));
    if (fresh.length) {
      const { error } = await sb.from("vula_tenders").insert(fresh);
      if (error) { console.log(`page ${page}: insert err ${error.message.slice(0, 70)}`); failed++; }
      else inserted += fresh.length;
    }
    if (page % 20 === 0) console.log(`  page ${page}/${TO} | seen ${seen} | inserted ${inserted} | failed ${failed}`);
  } catch (e) { failed++; console.log(`page ${page}: ${String(e.message).slice(0, 50)}`); }
  await sleep(700);
}
console.log(`DONE: pages ${FROM}-${TO} | seen ${seen} | inserted ${inserted} | failed ${failed}`);
