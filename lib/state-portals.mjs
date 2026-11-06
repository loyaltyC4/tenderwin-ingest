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
import { mergeEnriched } from './enrich.mjs';

// ---------- TinyFish page fetch (2026-11-03) ----------
// Free fallback for pages an AWS WAF challenges from datacenter/residential
// exits (buy.nsw detail pages). TINYFISH_API_KEYS: comma-separated pool; the
// service answers ~150 req/min per key, far above our scan volume. Never the
// first choice: direct fetch stays primary, TinyFish second, Firecrawl (paid)
// last.
const TF_KEYS = String(process.env.TINYFISH_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
let tfIdx = 0;
export async function fetchViaTinyfish(url, { timeoutMs = 30000 } = {}) {
  if (!TF_KEYS.length) throw new Error('tinyfish_not_configured');
  const key = TF_KEYS[tfIdx++ % TF_KEYS.length];
  const res = await fetch('https://api.fetch.tinyfish.ai', {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [url] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`tinyfish_http_${res.status}`);
  const j = await res.json().catch(() => null);
  const arr = Array.isArray(j) ? j : (j?.results || []);
  const page = arr.find((r) => r && (r.url === url || true));
  const content = page && (page.content || page.text || page.markdown || '');
  if (!content) throw new Error('tinyfish_empty');
  return content;
}

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

// VIC and ACT sit behind a Cloudflare interstitial: without a render wait Firecrawl can return
// <body></body> (it did for VIC, 2026-11-05, so VIC was not scanned). Wait for the real page up front.
const NEEDS_RENDER_WAIT = /(^|\.)tenders\.(vic|act)\.gov\.au$/i;
export const renderWaitFor = (url) => { try { return NEEDS_RENDER_WAIT.test(new URL(url).hostname) ? 4000 : 0; } catch { return 0; } };

export async function fetchViaFirecrawl(url, { timeoutMs = 45000, maxAgeMs = 12 * 60 * 60 * 1000, waitFor = 0, attempt = 0 } = {}) {
  const key = firecrawlKey();
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['html'], proxy: 'auto', maxAge: maxAgeMs, ...(waitFor ? { waitFor } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 402 || res.status === 401) {
    deadFirecrawlKeys.add(key);
    return fetchViaFirecrawl(url, { timeoutMs, maxAgeMs, waitFor, attempt }); // next key, or firecrawl_http_402 when none left
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) { await sleep(12000 * (attempt + 1)); return fetchViaFirecrawl(url, { timeoutMs, maxAgeMs, waitFor, attempt: attempt + 1 }); }
    throw new Error(`firecrawl_http_${res.status}`);
  }
  if (!res.ok) throw new Error(`firecrawl_http_${res.status}`);
  const j = await res.json().catch(() => null);
  if (!j?.success) throw new Error('firecrawl_scrape_failed');
  const html = j.data?.html;
  if (!html || html.length < 400) {
    // A cached or too-early snapshot: try ONCE more, fresh (bypassing the cache) and with a render wait.
    if (maxAgeMs || waitFor < 4000) return fetchViaFirecrawl(url, { timeoutMs: Math.max(timeoutMs, 60000), maxAgeMs: 0, waitFor: 4000, attempt });
    throw new Error('firecrawl_empty_page');
  }
  return html;
}

// Portal page fetch: direct (free) first; Firecrawl fallback only if the
// portal blocks the direct call (WAF/datacenter rules). Returns RAW HTML/XML.
// fetchTierStats counts which tier served each page, so a run's log shows exactly what it cost.
export const fetchTierStats = { direct: 0, firecrawl: 0 };
export async function fetchStatePortalPage(url, opts = {}) {
  try { const t = await fetchDirect(url, opts); fetchTierStats.direct++; return t; }
  catch { fetchTierStats.firecrawl++; return fetchViaFirecrawl(url, { ...opts, waitFor: renderWaitFor(url) }); }
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
  row = { ...row }; // below mutates nothing the caller holds
  if (!row.viewId || !row.title) throw new Error('nt_schema_invalid');
  return {
    ocid: `${NT_SOURCE}-${row.viewId}`,
    ocidDerived: true, portalId: row.ref, source: NT_SOURCE,
    sourceUrl: 'https://tendersonline.nt.gov.au/Tender/Search/Current',
    sourceDetailUrl: row.detailUrl, sourceObservedAt: observedAt,
    sourceStatus: 'Current',
    sourceDates: { published: null, closes: row.closes, timeZone: 'Australia/Darwin' },
    ref: row.ref, title: row.title, description: row.description || row.title,
    buyer: row.buyer || 'NT Government', province: 'NT',
    category: row.category || '', value: null,
    docs: [{ title: 'Download tender from Quotations and Tenders Online', url: `https://tendersonline.nt.gov.au/Tender/DownloadProfile/${row.viewId}`, format: 'link', type: 'Official portal documents' }],
    contact: { name: row.contact?.name || '', email: row.contact?.email || '', phone: row.contact?.phone || '' },
    published: observedAt, closes: parseDmDate(row.closes, 9, 30), status: 'active',
  };
}

// Returns RAW parsed rows; ntMapper binds the rest.
// ---------- NT detail enrichment (2026-11-03) ----------
// Plain server-rendered detail pages: description block, enquiries contact and
// a public "Download tender" route (/Tender/DownloadProfile/{id}).
export function parseNtDetail(html) {
  const h = String(html || '');
  const grab = (re) => { const m = h.match(re); return m ? strip(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')) : null; };
  const description = grab(/<div[^>]*id="tenderDescription"[^>]*>([\s\S]*?)<\/div>/i);
  const body = strip(h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const email = (body.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [])[0]?.toLowerCase() || '';
  const phone = (body.match(/(?:\(0\d\)\s?\d{4}\s?\d{4}|0\d\s\d{4}\s\d{4}|\+61[\s-]?\d[\d\s-]{7,9})/) || [])[0] || '';
  // "For further enquiries, please contact the Darwin Procurement Office"
  const cm = body.match(/For further enquiries, please contact the\s+(?:([A-Z][A-Za-z .'-]{3,60}?))\s+(?:team|office|unit|on|at)\b/i)
    || body.match(/contact(?:ed)? (?:officer|person):?\s*([A-Z][A-Za-z .'-]{3,60})/i);
  const name = cm ? cm[1].trim() : '';
  return {
    description: description ? description.slice(0, 4000) : null,
    contact: (name || email || phone) ? { name, email, phone } : null,
  };
}

async function enrichNtDetails(rows, { timeoutMs = 20000, concurrency = 4 } = {}) {
  let enriched = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    await Promise.all(rows.slice(i, i + concurrency).map(async (row) => {
      try {
        const html = await fetchStatePortalPage(row.detailUrl, { timeoutMs });
        const d = parseNtDetail(html);
        if (d.description) row.description = d.description;
        if (d.contact) row.contact = d.contact;
        enriched += 1;
      } catch (e) { errors.push(`${row.viewId}:${e.message}`); }
    }));
  }
  return { enriched, errors };
}

export async function fetchNtTenders({ maxPages = 7, timeoutMs = 30000, detail = true } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://tendersonline.nt.gov.au/Tender/Search/Current${page > 1 ? `?page=${page}` : ''}`;
    const html = await fetchStatePortalPage(url, { timeoutMs });
    const before = rows.length;
    rows.push(...parseNtCards(html));
    if (page > 1 && rows.length === before) break; // past the last page
  }
  let detailRes = { enriched: 0, errors: [] };
  if (detail && rows.length) {
    try { detailRes = await enrichNtDetails(rows); } catch { /* list-only scan */ }
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

// ---------- TAS detail enrichment (2026-11-03) ----------
// The public detail page carries the contact officer, the real description and
// the download-files route. Plain HTML, no WAF, ~45 open tenders: enrich them all.
export function parseTasDetail(html) {
  const h = String(html || '');
  // Contact block: "or contact: </li> </ul> <div class="editor-field-list-box"><ul><li>Name - Title</li></ul></div> Email: <a href="Mailto:x@y">"
  let contact = null;
  const cm = h.match(/or contact:\s*<\/li>[\s\S]{0,200}?<li>([^<]{3,120})<\/li>[\s\S]{0,200}?Mailto:([\w.+-]+@[\w.-]+\.\w+)/i);
  if (cm) {
    const name = strip(cm[1]).split(/\s+-\s+/)[0].trim();
    const email = cm[2].toLowerCase();
    if (name || email) contact = { name, email, phone: '' };
  }
  const dm = h.match(/<label for="Description">[\s\S]*?<div class="richTextDisplay">([\s\S]*?)<\/div>/i);
  const description = dm
    ? strip(dm[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"))
      .slice(0, 4000)
    : '';
  return { contact, description: description || null };
}

async function enrichTasDetails(rows, { timeoutMs = 20000, concurrency = 4 } = {}) {
  let enriched = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    await Promise.all(rows.slice(i, i + concurrency).map(async (row) => {
      try {
        const html = await fetchStatePortalPage(row.detailUrl, { timeoutMs });
        const d = parseTasDetail(html);
        if (d.contact) row.contact = d.contact;
        if (d.description) row.description = d.description;
        enriched += 1;
      } catch (e) { errors.push(`${row.viewId}:${e.message}`); }
    }));
  }
  return { enriched, errors };
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
    ref: row.ref, title: row.title, description: row.description || row.title,
    buyer: 'Tasmanian Government', province: 'TAS',
    docs: [{ title: 'Download files from Tasmanian Tenders', url: `https://www.tenders.tas.gov.au/OpenForBids/Downloadables/${row.viewId}`, format: 'link', type: 'Official portal documents' }],
    contact: { name: row.contact?.name || '', email: row.contact?.email || '', phone: row.contact?.phone || '' },
    category: row.category || '', value: null,
    published: parseDmDateOnly(row.published) || observedAt, closes: parseDmDate(row.closes, 10), status: 'active',
  };
}

export async function fetchTasTenders({ timeoutMs = 30000 } = {}) {
  const html = await fetchStatePortalPage('https://www.tenders.tas.gov.au/OpenForBids/List/Public/Agency', { timeoutMs });
  const rows = parseTasRows(html);
  if (!rows.length) throw new Error('tas_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.viewId, r])).values()];
  // Best-effort detail pass; failures leave the list-only row intact.
  let detail = { enriched: 0, errors: [] };
  try { detail = await enrichTasDetails(deduped); } catch { /* list-only scan */ }
  return { rows: deduped, total: deduped.length, detail };
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
    ref, title: row.title, description: row.description || row.title,
    buyer: row.buyer || 'Local council (VendorPanel)',
    contact: { name: row.contact?.name || '', email: row.contact?.email || '', phone: row.contact?.phone || '' },
    timeline: row.timeline || null,
    enquiryEnd: row.timeline?.enquiryEnd || null,
    buyerAddress: row.address || null,
    buyerWebsite: row.website || null,
    province: row.province, // null when the tz label is absent — never guessed
    category: row.category || '', value: null,
    published: observedAt, closes: row.closes, status: 'active',
  };
}

// ---------- VendorPanel preview enrichment (2026-11-03) ----------
// The RSS link lands on a PUBLIC preview page (tsi.axd) with the full request
// description, buyer address/website, contact details (unless the buyer hid
// them) and the supplier-query / expected-decision dates. ~450 open rows, so
// the detail pass rotates (hash slot) instead of reading everything per run.
export function parseVpPreview(html) {
  const h = String(html || '');
  // Markup uses single-quoted attributes: <div class='opportunityPreviewMinHeading'>Label</div>
  // followed by <div class='opportunityPreviewContent'>value</div>
  const cell = (heading) => {
    const re = new RegExp(`opportunityPreviewMinHeading['\\"]?>(?:<[^>]+>)*${heading}(?:<[^>]+>)*<\\/div>\\s*<div class=['\\"]?opportunityPreviewContent['\\"]?>([\\s\\S]*?)<\\/div>`, 'i');
    const m2 = h.match(re);
    return m2 ? m2[1] : null;
  };
  const txt = (x) => x ? strip(x.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')) : null;
  const description = txt(cell('Details'));
  const address = txt(cell('Location'));
  const website = txt(cell('WebSite:'));
  const contactRaw = txt(cell('Contact Details')) || '';
  const hidden = /elected to have their personal and contact details hidden/i.test(contactRaw);
  const email = (contactRaw.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [])[0]?.toLowerCase() || '';
  const phone = (contactRaw.match(/(?:\(0\d\)\s?\d{4}\s?\d{4}|04\d{2}[\s-]?\d{3}[\s-]?\d{3}|0\d{8}|\+61[\s-]?\d[\d\s-]{7,9})/) || [])[0] || '';
  const name = !hidden && !email && !phone ? contactRaw.slice(0, 60) : '';
  const contact = !hidden && (email || phone || name) ? { name, email, phone } : null;
  // "Monday 16 November 2026 02:00 PM (E. Australia Standard Time)" — AEST +10.
  const parseVpLong = (v) => {
    const m = String(v || '').match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
    if (!m) return null;
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month == null) return null;
    let hour = m[4] ? parseInt(m[4], 10) % 12 : 12;
    if (m[4] && /pm/i.test(m[6] || '')) hour += 12;
    const d = new Date(Date.UTC(+m[3], month, +m[1], hour - 10, m[5] ? +m[5] : 0));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const timeline = {};
  const q = parseVpLong(txt(cell('Supplier query cut-off')));
  const dec = parseVpLong(txt(cell('Expected decision')));
  if (q) timeline.enquiryEnd = q;
  if (dec) timeline.decision = dec;
  return {
    description: description ? description.slice(0, 4000) : null,
    address: address ? address.slice(0, 160) : null,
    website,
    contact,
    timeline: Object.keys(timeline).length ? timeline : null,
  };
}

const vpHash = (ref) => [...String(ref)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export async function enrichVpDetails(rows, { timeoutMs = 25000, maxDetails = 80, concurrency = 4 } = {}) {
  const buckets = Math.max(1, Math.ceil(rows.length / maxDetails));
  const slot = Math.floor(Date.now() / 864e5) % buckets;
  const pool = rows.filter((r) => vpHash(r.ref) % buckets === slot).slice(0, maxDetails);
  let enriched = 0;
  const errors = [];
  for (let i = 0; i < pool.length; i += concurrency) {
    await Promise.all(pool.slice(i, i + concurrency).map(async (row) => {
      try {
        // The RSS deep link (tsi.axd) is often a registration wall; the same id
        // under PublicTenderPreviewPop.aspx serves the public preview when the
        // buyer allows one. Try the preview variant; walled notices just skip.
        const previewUrl = String(row.detailUrl).replace('/tsi.axd?id=', '/PublicTenderPreviewPop.aspx?id=');
        const html = await fetchStatePortalPage(previewUrl === row.detailUrl ? row.detailUrl : previewUrl, { timeoutMs });
        if (!/opportunityPreview/i.test(html)) return; // registration wall — nothing public
        const d = parseVpPreview(html);
        if (d.description) row.description = d.description;
        if (d.address) row.address = d.address;
        if (d.website) row.website = d.website;
        if (d.contact) row.contact = d.contact;
        if (d.timeline) row.timeline = d.timeline;
        enriched += 1;
      } catch (e) { errors.push(`${row.ref}:${e.message}`); }
    }));
  }
  return { enriched, errors, considered: pool.length };
}

export async function fetchVendorpanelTenders({ timeoutMs = 45000, detail = true } = {}) {
  const xml = await fetchStatePortalPage('https://www.vendorpanel.com.au/PublicTendersRssV2.aspx?mode=all', { timeoutMs });
  const rows = parseVendorPanelItems(xml);
  if (!rows.length) throw new Error('vp_portal_no_rows');
  const deduped = [...new Map(rows.map(r => [r.ref, r])).values()];
  let detailRes = { enriched: 0, errors: [] };
  if (detail) {
    try { detailRes = await enrichVpDetails(deduped); } catch { /* list-only scan */ }
  }
  return { rows: deduped, total: deduped.length, detail: detailRes };
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

// ---------- QLD detail enrichment (2026-11-03) ----------
// The Playwright worker also visits detail pages and posts detailText plus the
// document anchors it finds (Blazor renders them; plain fetch cannot).
export function parseQldDetailText(text) {
  const t = String(text || '');
  const email = (t.match(/[\w.+-]+@[\w.-]+\.\w{2,}/) || [])[0]?.toLowerCase() || '';
  const phone = (t.match(/(?:\(0\d\)\s?\d{3}\s?\d{3}|\(07\)\s?\d{4}\s?\d{4}|07\s\d{4}\s\d{4}|13\s?\d{2}\s?\d{2}|1300\s?\d{3}\s?\d{3}|04\d{2}[\s-]?\d{3}[\s-]?\d{3})/) || [])[0] || '';
  // Prefer the explicit label; the fallback requires a Phone/Email line right
  // after the name so label lines like "Contact Officer" never pass as names.
  const nm = t.match(/Contact (?:Officer|Person)\s*:\s*([A-Z][A-Za-z .'-]{3,60})/)
    || t.match(/([A-Z][a-z]+\s[A-Z][a-z]+)\s*\n\s*(?:Phone|Email)/);
  let name = nm ? nm[1].trim() : '';
  if (/^(contact|enquir|procurement|officer)/i.test(name)) name = '';
  if (/^(none|n\/?a|not provided|nil|-)\b/i.test(name)) name = ''; // the portal prints these literally
  const dm = t.match(/Description\s*\n([\s\S]{30,4000}?)(?:\n\s*(?:Enquir|Categor|Clos|Publish|Document|Issued|Procure|Suitable)\b|$)/i);
  const description = dm ? dm[1].replace(/\s+/g, ' ').trim() : '';
  return {
    contact: (name || email || phone) ? { name, email, phone } : null,
    description: description || null,
  };
}

export function mapQldTender(row, observedAt = new Date().toISOString()) {
  const card = parseQldCardText(row);
  const detail = row.detailText ? parseQldDetailText(row.detailText) : null;
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
    description: ((detail?.description && detail.description.length > (card.description || '').length ? detail.description : card.description) || card.title).trim(),
    buyer: card.buyer || 'Queensland Government',
    province: 'QLD',
    docs: (row.docLinks || []).length
      ? row.docLinks.map((d) => ({ title: d.title || 'Tender document', url: d.href, format: /\.pdf(\?|$)/i.test(d.href || '') ? 'pdf' : 'link' }))
      // QTenders serves documents from the notice's own page (Blazor); deep-link it.
      : (card.href ? [{ title: 'Tender documents on QTenders', url: card.href, format: 'link', type: 'Official portal documents' }] : []),
    contact: detail?.contact || { name: '', email: '', phone: '' },
    category: card.category || '',
    value: null, // the public list does not publish values — never guessed
    published: parseDmDateOnly(card.opens, 10) || observedAt,
    closes: parseDmDate(card.closes, 10),
    status: 'active',
  };
}

// ---------- store rows (same contract as the other adapters) ----------

export function asStateStoreRow(t, existing = {}, observedAt = new Date().toISOString()) {
  // Enrichment-first merge: list-only scans must never erase what detail pages
  // gave us. Rules: null/undefined never overwrites; a title-only description
  // never overwrites a real one; docs/contact/addendum/timeline go through
  // mergeEnriched (per-field, addenda-aware).
  const kept = mergeEnriched(t, existing, observedAt);
  const data = { ...existing };
  for (const [k, v] of Object.entries(t)) {
    if (v == null) continue;
    if (k === 'description') {
      const real = v && v !== data.title;
      const have = data.description && data.description !== data.title;
      data.description = real ? v : (have ? data.description : v);
      continue;
    }
    if (k === 'docs' || k === 'contact' || k === 'addendum' || k === 'timeline') continue;
    data[k] = v;
  }
  data.docs = kept.docs; data.contact = kept.contact;
  data.addendum = kept.addendum; data.timeline = kept.timeline || data.timeline || null;
  data.value = existing.value ?? t.value ?? null;
  return {
    ocid: data.ocid, title: data.title, buyer: data.buyer, province: data.province,
    category: data.category || null, value: data.value, published: data.published,
    closes: data.closes, status: data.status, data, updated_at: observedAt,
  };
}
