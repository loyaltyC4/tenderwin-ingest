// State + council-portal adapters — VIC, ACT, NT, TAS, VendorPanel (councils).
//
// SOURCES (all free; Firecrawl only as a fallback where a portal WAF-blocks
// direct fetches — verified Oct 2026):
//   vic-tendersearch  — tenders.vic.gov.au (TenderSearch HTML table, ~68 open)
//   act-tendersearch  — tenders.act.gov.au (same platform; WAF flakes on
//                       direct fetches sometimes -> Firecrawl html fallback)
//   nt-qtol           — tendersonline.nt.gov.au (class-structured HTML, ~33)
//   tas-tenders       — tenders.tas.gov.au /OpenForBids/List/Public/Agency
//                       (plain HTML rows, no login; ~37 open)
//   vendorpanel-rss   — vendorpanel.com.au PublicTendersRssV2.aspx (hundreds of
//                       council tenders in ONE free RSS feed)
//   wa-tenders        — tenders.wa.gov.au advertised list (Struts: session
//                       nonce two-step GET; ~160 advertised)
//
// QLD is ingested by the Playwright worker in GitHub Actions (scripts/qtenders-extract.mjs)
// posting into /api/cron/ingest-qld — parsing lives here (mapQldTender).
// NOT WIRED: NSW (old eTendering API decommissioned Jul 2025; buy.nsw has no
// public API), SA (login/Cloudflare wall).
//
// MAINTENANCE: every parser is pure and tested against real captured pages —
// run `node scripts/test-state-parsers.mjs` after any portal change to see
// exactly which regex broke. Fixtures live in scripts/fixtures/.

export const VIC_SOURCE = 'vic-tendersearch';
export const ACT_SOURCE = 'act-tendersearch';
export const NT_SOURCE = 'nt-qtol';
export const TAS_SOURCE = 'tas-tenders';
export const VP_SOURCE = 'vendorpanel-rss';
export const WA_SOURCE = 'wa-tenders';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------- fetching: direct first (free), Firecrawl fallback ----------

// FIRECRAWL_API_KEYS (comma-separated) is tried in order; FIRECRAWL_API_KEY is the single-key fallback.
// A key answering 402 (out of credits) or 401 is skipped for the rest of this process.
const deadFirecrawlKeys = new Set();
function firecrawlKeys() {
  const list = String(process.env.FIRECRAWL_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.FIRECRAWL_API_KEY) list.push(process.env.FIRECRAWL_API_KEY.trim());
  return [...new Set(list)];
}
function firecrawlKey() {
  const live = firecrawlKeys().find((k) => !deadFirecrawlKeys.has(k));
  if (live) return live;
  if (firecrawlKeys().length) throw new Error('firecrawl_http_402');
  throw new Error('firecrawl_not_configured');
}

async function fetchDirect(url, { timeoutMs = 30000, attempt = 0 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) { await sleep(7000 * (attempt + 1)); return fetchDirect(url, { timeoutMs, attempt: attempt + 1 }); }
    throw new Error(`direct_http_${res.status}`);
  }
  if (!res.ok) throw new Error(`direct_http_${res.status}`);
  const text = await res.text();
  if (!text || text.length < 400) throw new Error('direct_empty_page');
  return text;
}

export async function fetchViaFirecrawl(url, { timeoutMs = 45000, maxAgeMs = 12 * 60 * 60 * 1000, attempt = 0 } = {}) {
  const key = firecrawlKey();
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['html'], proxy: 'auto', maxAge: maxAgeMs }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 402 || res.status === 401) {
    deadFirecrawlKeys.add(key);
    return fetchViaFirecrawl(url, { timeoutMs, maxAgeMs, attempt }); // next key, or firecrawl_http_402 when none left
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) { await sleep(12000 * (attempt + 1)); return fetchViaFirecrawl(url, { timeoutMs, maxAgeMs, attempt: attempt + 1 }); }
    throw new Error(`firecrawl_http_${res.status}`);
  }
  if (!res.ok) throw new Error(`firecrawl_http_${res.status}`);
  const j = await res.json().catch(() => null);
  if (!j?.success) throw new Error('firecrawl_scrape_failed');
  const html = j.data?.html;
  if (!html || html.length < 400) throw new Error('firecrawl_empty_page');
  return html;
}

// Portal page fetch: direct (free) first; Firecrawl fallback only if the
// portal blocks the direct call (WAF/datacenter rules). Returns RAW HTML/XML.
export async function fetchStatePortalPage(url, opts = {}) {
  try { return await fetchDirect(url, opts); }
  catch { return fetchViaFirecrawl(url, opts); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- date helpers ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// AEST/AEDT offset by month (eastern states); midday-or-later closings make
// the DST-boundary risk window tiny (same trade-off the ATM adapter makes).
function easternOffsetMonth(monthIndex) {
  return monthIndex >= 9 || monthIndex <= 2 ? 11 : 10;
}

// "Fri, 10 March 2023 9:15 am" -> ISO (VIC/ACT/NT list labels)
export function parseTenderSearchDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  let hour = parseInt(m[4], 10);
  const isPm = /pm/i.test(m[6]);
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const d = new Date(Date.UTC(+m[3], month, +m[1], hour - easternOffsetMonth(month), +m[5]));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// "19/11/2026 02:00 PM" or "02:00 PM 03/12/2030" -> ISO at a fixed offset
export function parseDmDate(s, offsetHours = 10, offsetHalf = 0) {
  if (!s) return null;
  let dd, mo, yy, hh, mi, ap;
  let m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) { [, dd, mo, yy, hh, mi, ap] = m; }
  else { // "02:00 PM 03/12/2030" (TAS)
    m = String(s).match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (!m) return null;
    [, hh, mi, ap, dd, mo, yy] = m;
  }
  let hour = parseInt(hh, 10);
  const isPm = /pm/i.test(ap);
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const d = new Date(Date.UTC(+yy, +mo - 1, +dd, hour - offsetHours, +mi - offsetHalf));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// "29/Oct/2026 02:00 PM (UTC+10:00) Brisbane time" -> { iso, tzLabel }
export function parseDmDateOnly(s, offsetHours = 10) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12 - offsetHours, 0));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function parseVpDate(s) {
  if (!s) return { iso: null, tzLabel: null };
  const m = String(s).match(/(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  const tz = String(s).match(/\((UTC[+\-][\d:]+)\)\s*([A-Za-z ]+?)\s*time/i);
  if (!m) return { iso: null, tzLabel: tz ? tz[2] : null };
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return { iso: null, tzLabel: tz ? tz[2] : null };
  let hour = parseInt(m[4], 10);
  const isPm = /pm/i.test(m[6]);
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const d = new Date(Date.UTC(+m[3], month, +m[1], hour - 10, +m[5]));
  return { iso: Number.isFinite(d.getTime()) ? d.toISOString() : null, tzLabel: tz ? tz[2].trim() : null };
}

// Council timezone label -> AU state code (VendorPanel items carry the
// council's own local time; the label reliably identifies its state).
const TZ_STATE = { Brisbane: 'QLD', Sydney: 'NSW', Melbourne: 'VIC', Adelaide: 'SA', Perth: 'WA', Hobart: 'TAS', Darwin: 'NT', Canberra: 'ACT' };

function strip(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&#160;/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---------- VIC / ACT: TenderSearch platform (HTML table rows) ----------

export function parseTenderSearchRow(htmlRow) {
  const id = htmlRow.match(/\/tender\/view\?id=(\d+)/);
  if (!id) return null;
  const ref = htmlRow.match(/<b>([A-Z0-9][A-Z0-9.\-]*)<\/b>/);
  const title = htmlRow.match(/class="strong tenderRowTitle"\s*>([\s\S]*?)<\/a>/);
  const status = htmlRow.match(/class="tender-row-state"[^>]*>([^<]+)</);
  const type = htmlRow.match(/class="tender-row-state"[^>]*>[^<]+<\/span>\s*<br>\s*([A-Za-z ]{3,40})\s*<\/td>/);
  const buyer = htmlRow.match(/Issued by:\s*([^<]+)</);
  const published = htmlRow.match(/class="opening_date"[^>]*>([^<]+)</);
  const closes = htmlRow.match(/class="closing_date"[^>]*>([^<]+)</);
  const unspsc = htmlRow.match(/UNSPSC:\s*(\d{6,8})\s*-\s*([A-Za-z][^<]{2,60})/);
  return {
    ref: ref ? strip(ref[1]) : id[1],
    viewId: id[1],
    title: strip(title ? title[1] : ''),
    detailUrl: `https://PLACEHOLDER/tender/view?id=${id[1]}`,
    status: status ? strip(status[1]) : 'Open',
    type: type ? strip(type[1]) : '',
    buyer: buyer ? strip(buyer[1]) : null,
    published: published ? strip(published[1]) : null,
    closes: closes ? strip(closes[1]) : null,
    unspsc: unspsc ? { code: unspsc[1], label: strip(unspsc[2]) } : null,
  };
}

export function mapTenderSearchRow(row, { state, host, source, observedAt }) {
  if (!row.viewId || !row.title) throw new Error('tsearch_schema_invalid');
  return {
    ocid: `${source}-${row.viewId}`,
    ocidDerived: true,
    portalId: row.ref || row.viewId,
    source,
    sourceUrl: `https://${host}/tender/search?tenderState=OPEN`,
    sourceDetailUrl: `https://${host}/tender/view?id=${row.viewId}`,
    sourceObservedAt: observedAt,
    sourceStatus: row.status,
    sourceDates: { published: row.published, closes: row.closes, timeZone: 'Australia/Melbourne' },
    ref: row.ref || row.viewId,
    title: row.title,
    description: row.title,
    buyer: row.buyer || `${state} Government`,
    province: state,
    category: row.unspsc ? row.unspsc.label : '',
    value: null, // the list does not publish values — never guessed
    published: parseTenderSearchDate(row.published),
    closes: parseTenderSearchDate(row.closes),
    status: 'active',
  };
}

// Returns RAW parsed rows; vicMapper/actMapper bind state/host/source.
export async function fetchTenderSearchState({ host, maxPages = 4, timeoutMs = 30000 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://${host}/tender/search?tenderState=OPEN${page > 1 ? `&page=${page}` : ''}`;
    const html = await fetchStatePortalPage(url, { timeoutMs });
    const rowBlocks = [...html.matchAll(/<tr[^>]*id="tenderRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
    const parsed = rowBlocks.map(parseTenderSearchRow).filter(Boolean);
    rows.push(...parsed);
    const ofMatch = html.match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/);
    if (!ofMatch) break;
    if (parseInt(ofMatch[2], 10) >= parseInt(ofMatch[3], 10) || !parsed.length) break;
  }
  if (!rows.length) throw new Error('state_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.viewId, r])).values()];
  return { rows: deduped, total: deduped.length };
}

export async function fetchVicTenders(opts = {}) {
  return fetchTenderSearchState({ host: 'www.tenders.vic.gov.au', ...opts });
}
export async function fetchActTenders(opts = {}) {
  return fetchTenderSearchState({ host: 'www.tenders.act.gov.au', maxPages: 2, ...opts });
}
export function vicMapper(r, observedAt) {
  return mapTenderSearchRow(r, { state: 'VIC', host: 'www.tenders.vic.gov.au', source: VIC_SOURCE, observedAt });
}
export function actMapper(r, observedAt) {
  return mapTenderSearchRow(r, { state: 'ACT', host: 'www.tenders.act.gov.au', source: ACT_SOURCE, observedAt });
}

// ---------- NT: Quotations and Tenders Online (class-structured cards) ----------

export function parseNtCards(html) {
  const cards = [...html.matchAll(/<div class="tender-card">([\s\S]*?)(?=<div class="tender-card">|<div class="pagination|$)/g)].map(m => m[1]);
  const rows = [];
  for (const c of cards) {
    const num = c.match(/tender-card__tender-number">\s*(?:Quote|Tender)\s+([A-Z0-9.\-]+)\s*</);
    const agency = c.match(/tender-card__agency-text">\s*([^<]+?)\s*</);
    const link = c.match(/tender-card__title">\s*<a href="\/Tender\/Details\/(\d+)[^"]*">([\s\S]*?)<\/a>/);
    if (!link) continue; // stray test rows have no title link
    const closing = c.match(/Closing\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+(?:AM|PM))/);
    const cat = c.match(/tender-card__category[^>]*>([^<]+)</) || c.match(/>(Building|Civil|Cleaning|Consultancy|Demolition|Electrical\/Mechanical|Hydraulic|Information Technology|Landscaping|Miscellaneous|Project Management|Security|Supply and Delivery|Tier 2 Quote)</);
    rows.push({
      ref: num ? num[1] : link[1],
      viewId: link[1],
      title: strip(link[2]),
      detailUrl: `https://tendersonline.nt.gov.au/Tender/Details/${link[1]}`,
      buyer: agency ? strip(agency[1]) : null,
      closes: closing ? closing[1] : null,
      category: cat ? strip(cat[1]) : '',
    });
  }
  return rows;
}

export function mapNtTender(row, observedAt = new Date().toISOString()) {
  if (!row.viewId || !row.title) throw new Error('nt_schema_invalid');
  return {
    ocid: `${NT_SOURCE}-${row.viewId}`,
    ocidDerived: true, portalId: row.ref, source: NT_SOURCE,
    sourceUrl: 'https://tendersonline.nt.gov.au/Tender/Search/Current',
    sourceDetailUrl: row.detailUrl, sourceObservedAt: observedAt,
    sourceStatus: 'Current',
    sourceDates: { published: null, closes: row.closes, timeZone: 'Australia/Darwin' },
    ref: row.ref, title: row.title, description: row.title,
    buyer: row.buyer || 'NT Government', province: 'NT',
    category: row.category || '', value: null,
    published: observedAt, closes: parseDmDate(row.closes, 9, 30), status: 'active',
  };
}

// Returns RAW parsed rows; ntMapper binds the rest.
export async function fetchNtTenders({ maxPages = 7, timeoutMs = 30000 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://tendersonline.nt.gov.au/Tender/Search/Current${page > 1 ? `?page=${page}` : ''}`;
    const html = await fetchStatePortalPage(url, { timeoutMs });
    const before = rows.length;
    rows.push(...parseNtCards(html));
    if (page > 1 && rows.length === before) break; // past the last page
  }
  if (!rows.length) throw new Error('nt_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.viewId, r])).values()];
  return { rows: deduped, total: deduped.length };
}
export function ntMapper(r, observedAt = new Date().toISOString()) {
  return mapNtTender(r, observedAt);
}

// ---------- TAS: tenders.tas.gov.au OpenForBids (plain HTML rows) ----------

export function parseTasRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = m[1];
    const link = r.match(/href="\/OpenForBids\/Details\/(\d+)"[^>]*>\s*([^<]{4,300})/);
    if (!link) continue;
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1].replace(/<[^>]+>/g, ' ')));
    // TAS row cells: files | title | category | published dd/mm/yyyy | "HH:MM PM dd/mm/yyyy" closing
    rows.push({
      ref: `TAS-${link[1]}`,
      viewId: link[1],
      title: strip(link[2]),
      detailUrl: `https://www.tenders.tas.gov.au/OpenForBids/Details/${link[1]}`,
      category: cells[2] || '',
      published: cells[3] || null,
      closes: cells[4] || null,
    });
  }
  return rows;
}

export function mapTasTender(row, observedAt = new Date().toISOString()) {
  if (!row.viewId || !row.title) throw new Error('tas_schema_invalid');
  return {
    ocid: `${TAS_SOURCE}-${row.viewId}`,
    ocidDerived: true, portalId: row.ref, source: TAS_SOURCE,
    sourceUrl: 'https://www.tenders.tas.gov.au/OpenForBids/List/Public/Agency',
    sourceDetailUrl: row.detailUrl, sourceObservedAt: observedAt,
    sourceStatus: 'Open for Bids',
    sourceDates: { published: row.published, closes: row.closes, timeZone: 'Australia/Hobart' },
    ref: row.ref, title: row.title, description: row.title,
    buyer: 'Tasmanian Government', province: 'TAS',
    category: row.category || '', value: null,
    published: parseDmDateOnly(row.published) || observedAt, closes: parseDmDate(row.closes, 10), status: 'active',
  };
}

export async function fetchTasTenders({ timeoutMs = 30000 } = {}) {
  const html = await fetchStatePortalPage('https://www.tenders.tas.gov.au/OpenForBids/List/Public/Agency', { timeoutMs });
  const rows = parseTasRows(html);
  if (!rows.length) throw new Error('tas_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.viewId, r])).values()];
  return { rows: deduped, total: deduped.length };
}
export function tasMapper(r, observedAt = new Date().toISOString()) {
  return mapTasTender(r, observedAt);
}

// ---------- VendorPanel: council tenders via free public RSS ----------

export function parseVendorPanelItems(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const rows = [];
  for (const it of items) {
    const title = it.match(/<title>([\s\S]*?)<\/title>/);
    if (!title) continue;
    const desc = strip((it.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '');
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const guid = (it.match(/<guid>([\s\S]*?)<\/guid>/) || [])[1];
    const ref = desc.match(/Reference number<\/b>\s*:\s*([A-Z0-9\-]+)/i);
    const buyer = desc.match(/Issued by\s*:\s*<\/b>\s*([^<]+?)<|Issued by\s*:\s*([A-Za-z][^<]{2,60})/);
    const closing = desc.match(/Closing Date<\/b>\s*:\s*([^<]+)</i);
    const cats = desc.match(/Tender categories<\/b>\s*:\s*([^<]+)</i);
    const closingInfo = parseVpDate(closing ? closing[1] : '');
    rows.push({
      ref: ref ? ref[1] : (guid || '').slice(0, 24),
      title: strip(title[1]),
      detailUrl: link ? link.trim() : 'https://www.vendorpanel.com.au/publictenders.aspx',
      buyer: buyer ? strip(buyer[1] || buyer[2] || '') : null,
      closesRaw: closing ? closing[1] : null,
      closes: closingInfo.iso,
      province: closingInfo.tzLabel ? (TZ_STATE[closingInfo.tzLabel] || null) : null,
      category: cats ? strip(cats[1]) : '',
    });
  }
  return rows;
}

export function mapVpTender(row, observedAt = new Date().toISOString()) {
  if (!row.title) throw new Error('vp_schema_invalid');
  const ref = row.ref || row.title.slice(0, 40).replace(/\s+/g, '-');
  return {
    ocid: `${VP_SOURCE}-${ref}`,
    ocidDerived: true, portalId: ref, source: VP_SOURCE,
    sourceUrl: 'https://www.vendorpanel.com.au/publictenders.aspx',
    sourceDetailUrl: row.detailUrl, sourceObservedAt: observedAt,
    sourceStatus: 'Open',
    sourceDates: { published: null, closes: row.closesRaw, timeZone: 'council local time' },
    ref, title: row.title, description: row.title,
    buyer: row.buyer || 'Local council (VendorPanel)',
    province: row.province, // null when the tz label is absent — never guessed
    category: row.category || '', value: null,
    published: observedAt, closes: row.closes, status: 'active',
  };
}

export async function fetchVendorpanelTenders({ timeoutMs = 45000 } = {}) {
  const xml = await fetchStatePortalPage('https://www.vendorpanel.com.au/PublicTendersRssV2.aspx?mode=all', { timeoutMs });
  const rows = parseVendorPanelItems(xml);
  if (!rows.length) throw new Error('vp_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.ref, r])).values()];
  return { rows: deduped, total: deduped.length };
}
export function vpMapper(r, observedAt = new Date().toISOString()) {
  return mapVpTender(r, observedAt);
}

// ---------- WA: tenders.wa.gov.au (Struts form-search: nonce + session) ----------

// "31 Dec, 2027 2:30 PM" -> ISO (AWST +8, no DST)
export function parseWaDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return null;
  let hour = parseInt(m[4], 10);
  const isPm = /pm/i.test(m[6]);
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  const d = new Date(Date.UTC(+m[3], month, +m[1], hour - 8, +m[5]));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function parseWaRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = m[1];
    const link = r.match(/href="([^"]*tender-details\.action\?id=(\d+)[^"]*)"[^>]*>\s*([^<]{6,300})/);
    if (!link) continue;
    if (/demonstration/i.test(r)) continue; // the portal's practice row
    const ref = r.match(/<b>([A-Z0-9][A-Z0-9.\-]{2,})<\/b>/);
    const buyer = r.match(/Issued by\s+([^<]+)</);
    const closing = r.match(/SUMMARY_CLOSINGDATE[^>]*>\s*([^<]+)/);
    const unspsc = r.match(/UNSPSC:\s*([^<]{2,70})/);
    rows.push({
      ref: ref ? strip(ref[1]) : link[2],
      viewId: link[2],
      title: strip(link[3]),
      detailUrl: `https://www.tenders.wa.gov.au/watenders/tender/display/tender-details.action?id=${link[2]}`,
      buyer: buyer ? strip(buyer[1]) : null,
      closes: closing ? strip(strip(closing[1])) : null,
      category: unspsc ? strip(unspsc[1]) : '',
    });
  }
  return rows;
}

export function mapWaTender(row, observedAt = new Date().toISOString()) {
  if (!row.viewId || !row.title) throw new Error('wa_schema_invalid');
  return {
    ocid: `wa-tenders-${row.viewId}`,
    ocidDerived: true, portalId: row.ref, source: WA_SOURCE,
    sourceUrl: 'https://www.tenders.wa.gov.au/watenders/tender/search/tender-search.action?action=advanced-tender-search-open-tender',
    sourceDetailUrl: row.detailUrl, sourceObservedAt: observedAt,
    sourceStatus: 'Advertised',
    sourceDates: { published: null, closes: row.closes, timeZone: 'Australia/Perth' },
    ref: row.ref, title: row.title, description: row.title,
    buyer: row.buyer || 'WA Government', province: 'WA',
    category: row.category || '', value: null,
    published: observedAt, closes: parseWaDate(row.closes), status: 'active',
  };
}

// Two-step: GET the search page (fresh session + nonce), then GET the
// advertised-results action with that nonce and the session cookie.
export async function fetchWaTenders({ timeoutMs = 45000 } = {}) {
  const formUrl = 'https://www.tenders.wa.gov.au/watenders/tender/search/tender-search.action?action=advanced-tender-search-new-tenders';
  const r1 = await fetch(formUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!r1.ok) throw new Error(`wa_form_http_${r1.status}`);
  const cookies = (r1.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const formHtml = await r1.text();
  const nonce = formHtml.match(/CSRFNONCE=([A-Z0-9]+)/)?.[1];
  if (!nonce) throw new Error('wa_nonce_missing');
  const resUrl = `https://www.tenders.wa.gov.au/watenders/tender/search/tender-search.action?action=advanced-tender-search-open-tender&CSRFNONCE=${nonce}`;
  const r2 = await fetch(resUrl, { headers: { 'User-Agent': UA, ...(cookies ? { Cookie: cookies } : {}) }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!r2.ok) throw new Error(`wa_results_http_${r2.status}`);
  const html = await r2.text();
  const rows = parseWaRows(html);
  if (!rows.length) throw new Error('wa_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.viewId, r])).values()];
  return { rows: deduped, total: deduped.length };
}
export function waMapper(r, observedAt = new Date().toISOString()) {
  return mapWaTender(r, observedAt);
}

// ---------- QLD: QTenders Blazor SPA (rendered by the GitHub Actions worker) ----------
// The worker (scripts/qtenders-extract.mjs) renders the SPA with Playwright and
// POSTs raw card texts to /api/cron/ingest-qld; the parsing lives HERE so it
// stays unit-testable against scripts/fixtures/qld-card.json.

export const QLD_SOURCE = 'qld-qtenders';

export function parseQldCardText(row) {
  const text = String(row.text || '');
  const grab = re => { const m = text.match(re); return m ? m[1].trim() : null; };
  return {
    title: (row.title || grab(/^([^\n]{6,300})$/m) || '').trim(),
    href: row.href || null,
    ref: grab(/Reference number:\s*([^\n]+)/),
    buyer: grab(/Issued by:\s*([^\n]+)/),
    description: grab(/Details:\s*\n?\s*([\s\S]{10,400}?)\n\s*\n\s*Categories:/),
    category: grab(/Categories:\s*\n?\s*([^\n]+)/),
    region: grab(/Regions?:\s*\n?\s*([^\n]+)/),
    status: grab(/\n(Open|Closed|Cancelled|Awarded|Approaching[^\n]*)\nOpens:/),
    opens: grab(/Opens:\s*(\d{1,2}\/\d{1,2}\/\d{4})/),
    closes: grab(/Closes:\s*(\d{1,2}\/\d{1,2}\/\d{4}[^\n]*)/),
  };
}

export function mapQldTender(row, observedAt = new Date().toISOString()) {
  const card = parseQldCardText(row);
  if (!card.title) throw new Error('qld_schema_invalid');
  if (card.status && card.status !== 'Open') return null; // only live listings
  const ref = card.ref || card.title.slice(0, 40).replace(/\s+/g, '-');
  return {
    ocid: `qld-qtenders-${ref}`,
    ocidDerived: true, portalId: ref, source: QLD_SOURCE,
    sourceUrl: 'https://qtenders.hpw.qld.gov.au/search?keywords=',
    sourceDetailUrl: card.href || 'https://qtenders.hpw.qld.gov.au/search?keywords=',
    sourceObservedAt: observedAt, sourceStatus: card.status || 'Open',
    sourceDates: { published: card.opens, closes: card.closes, timeZone: 'Australia/Brisbane' },
    ref, title: card.title,
    description: (card.description || card.title).trim(),
    buyer: card.buyer || 'Queensland Government',
    province: 'QLD',
    category: card.category || '',
    value: null, // the public list does not publish values — never guessed
    published: parseDmDateOnly(card.opens, 10) || observedAt,
    closes: parseDmDate(card.closes, 10),
    status: 'active',
  };
}

// ---------- store rows (same contract as the other adapters) ----------

export function asStateStoreRow(t, existing = {}, observedAt = new Date().toISOString()) {
  const data = { ...existing, ...t, value: existing.value ?? t.value ?? null };
  return {
    ocid: data.ocid, title: data.title, buyer: data.buyer, province: data.province,
    category: data.category || null, value: data.value, published: data.published,
    closes: data.closes, status: data.status, data, updated_at: observedAt,
  };
}
