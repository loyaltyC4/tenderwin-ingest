// NSW adapter: buy.nsw.gov.au open opportunities (RFT, EOI, schemes, proposed).
//
// The old NSW eTendering API (www.tenders.nsw.gov.au) is gone: that host now redirects
// to buy.nsw.gov.au, which has no public API for suppliers. Its search page is
// server-rendered HTML, 10 cards per page (?page=N), reachable with a browser
// User-Agent from ordinary connections. Nothing to log in to, no Firecrawl needed.
//
// Card markup (one <li> per opportunity):
//   <h3>title</h3> <p><b>Closes:</b> 30-Nov-2026 15:00</p> <p class="subcat">category</p>
//   <ul class="pills"><li>reference</li></ul> <p class="limit">description</p>
//   <dl><dt>Opportunity type</dt><dd>..</dd><dt>Agency</dt><dd>..</dd></dl>
//   <a href="/prcOpportunity/{id}">See details</a>
import { sydneyToIso, decodeEntities } from './atm-rss.mjs';
import { fetchStatePortalPage, fetchViaFirecrawl } from './state-portals.mjs';
import { mergeEnriched } from './enrich.mjs';
import { fetchViaTinyfish } from './state-portals.mjs';

export const NSW_SOURCE = 'nsw-etendering';
export const NSW_BASE = 'https://buy.nsw.gov.au';
export const NSW_ENDPOINT = `${NSW_BASE}/opportunity/search/`;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const text = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// "30-Nov-2026 15:00" (Sydney time, 24h) -> ISO
export function parseNswClose(s) {
  const m = String(s || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
  return sydneyToIso(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
}

// One search page -> { total, rows }
export function parseNswPage(html) {
  const html0 = String(html || '');
  const totalM = html0.match(/Displaying\s+\d+-\d+\s+of\s+(\d+)\s+results/i);
  const rows = [];
  // Cards start at '<li><h3>'; pills inside a card also use <li>, so split on that opener only.
  for (const card of html0.split(/<li>\s*(?=<h3>)/).slice(1)) {
    const href = (card.match(/href="(?:https?:\/\/[^"\/]+)?\/prcOpportunity\/([^"]+)"/) || [])[1];
    const title = text((card.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!href || !title) continue;
    const dd = (label) => text((card.match(new RegExp(`<dt>\\s*${label}\\s*<\\/dt>\\s*<dd>([\\s\\S]*?)<\\/dd>`, 'i')) || [])[1]);
    rows.push({
      id: href,
      title,
      closesText: text((card.match(/<b>\s*Closes:\s*<\/b>([\s\S]*?)<\/p>/i) || [])[1]),
      category: text((card.match(/<p class="subcat">([\s\S]*?)<\/p>/) || [])[1]),
      ref: text((card.match(/<ul class="pills">\s*<li>([\s\S]*?)<\/li>/) || [])[1]),
      description: text((card.match(/<p class="limit[^"]*">([\s\S]*?)<\/p>/) || [])[1]),
      type: dd('Opportunity type'),
      agency: dd('Agency'),
    });
  }
  return { total: totalM ? +totalM[1] : null, rows };
}

// ---------- detail-page enrichment (2026-11-03) ----------
// "02-Dec-2026 3:00 PM" (Sydney) or date-only -> ISO; date-only lands at midday.
export function parseNswDate(v) {
  const m = String(v || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm))?/i);
  if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
  let hh = m[4] ? parseInt(m[4], 10) % 12 : 12;
  if (m[4] && /pm/i.test(m[6] || '')) hh += 12;
  return sydneyToIso(+m[3], MONTHS[m[2].toLowerCase()], +m[1], m[4] ? hh : 12, m[5] ? +m[5] : 0);
}
// The search list carries neither the contact officer nor the document links;
// the public detail page carries both, plus the portal's own publish, decision
// and completion dates. buy.nsw is server-rendered, so a plain browser-UA fetch
// reads it — until the AWS WAF warms up, which is why the phase is capped,
// rotates deterministically across runs and aborts on challenges. Direct only:
// detail pages never spend Firecrawl credits.

// Detail value cells are pairs: <span class="font-weight--heading">Label:</span>
// ... <div class="col-lg-8 nsw-table-cell">value</div>
export function parseNswDetail(html) {
  // Works on rendered markdown (TinyFish) and raw HTML alike: strip markup and
  // read the label/value pairs the page prints ("Primary contact: Name email
  // phone", "Estimated decision date: 09-Dec-2026").
  const h = text(String(html || ''));
  const line = (label) => {
    const m = h.match(new RegExp(`${label}\\s*:\\s*([^:]{2,160})`, 'i'));
    return m ? m[1].trim() : '';
  };
  const pc = line('Primary contact');
  const email = (pc.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
  const phone = (pc.match(/(?:\+61[\s-]?\d[\d\s-]{7,9}|0\d{3}[\s-]?\d{3}[\s-]?\d{3})/) || [])[0] || '';
  const name = email ? pc.split(/[\w.+-]+@/)[0].trim() : pc.split(/(?:\+61|0\d{3})[\s-]?\d/)[0].trim();
  const t = {};
  for (const [k, label] of [['published', 'Publish date'], ['decision', 'Estimated decision date'], ['completion', 'Completion date']]) {
    const d = parseNswDate(line(label)); if (d) t[k] = d;
  }
  return {
    contact: (name || email || phone) ? { name: name.slice(0, 80), email, phone } : null,
    timeline: Object.keys(t).length ? t : null,
    locations: line('Locations').slice(0, 80),
  };
}

const hashId = (id) => [...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

// A page that reaches the server has the detail table; a WAF challenge does not.
const isDetailPage = (html) => /Primary contact|Close date|Opportunity ID/i.test(String(html || ''));

// One NSW detail page: direct first, TinyFish when the WAF challenges.
// Never Firecrawl — detail volume would burn credits the list scan needs.
export async function getDetail(id, { timeoutMs }) {
  const url = `${NSW_BASE}/prcOpportunity/${id}`;
  try {
    const direct = await fetchStatePortalPage(url, { timeoutMs });
    if (isDetailPage(direct)) return { html: direct, via: 'direct' };
  } catch { /* fall through */ }
  const tf = await fetchViaTinyfish(url, { timeoutMs });
  if (!isDetailPage(tf)) throw new Error('nsw_detail_challenge');
  return { html: tf, via: 'tinyfish' };
}

export async function enrichNswDetails(rows, { timeoutMs = 20000, maxDetails = 24, concurrency = 4, challengeLimit = 2 } = {}) {
  // Rotate ~1/Nth of open tenders per run so every detail is re-read across runs
  // (addenda and contact changes get picked up) without hammering the portal.
  const buckets = Math.max(1, Math.ceil(rows.length / maxDetails));
  const slot = Math.floor(Date.now() / 864e5) % buckets;
  const pool = rows.filter((r) => hashId(r.id) % buckets === slot).slice(0, maxDetails);
  const errors = [];
  let challenges = 0, stopped = false;
  for (let i = 0; i < pool.length && !stopped; i += concurrency) {
    await Promise.all(pool.slice(i, i + concurrency).map(async (row) => {
      if (stopped) return;
      try {
        const { html } = await getDetail(row.id, { timeoutMs });
        challenges = 0;
        const d = parseNswDetail(html);
        if (d.contact) row.contact = d.contact;
        if (d.timeline) row.timeline = d.timeline;
        if (d.locations) row.locations = d.locations;
        if (d.type && !row.type) row.type = d.type;
        row.enriched = true;
      } catch (e) { errors.push(`${row.id}:${e.message}`); }
    }));
  }
  return { enriched: pool.filter(r => r.enriched).length, errors, challenged: stopped };
}

export function mapNswTender(r, observedAt = new Date().toISOString()) {
  if (!r?.id || !r?.title) throw new Error('nsw_schema_invalid');
  const closes = parseNswClose(r.closesText);
  const type = r.type || 'Opportunity';
  return {
    ocid: `ocds-nsw-${r.id}`,
    ocidDerived: true,
    portalId: r.id,
    source: NSW_SOURCE,
    sourceUrl: NSW_ENDPOINT,
    sourceDetailUrl: `${NSW_BASE}/prcOpportunity/${r.id}`,
    sourceObservedAt: observedAt,
    sourceStatus: /proposed/i.test(type) ? 'Proposed' : 'Open',
    sourceDates: { closes: r.closesText || null, timeZone: 'Australia/Sydney' },
    ref: r.ref || r.id,
    title: r.title,
    description: r.description || r.title,
    buyer: r.agency || 'NSW Government',
    province: 'NSW',
    category: r.category || '',
    method: type,
    published: r.timeline?.published || observedAt,
    closes,
    opens: null,
    status: 'active',
    eSub: true,
    submission: 'Electronic submission via buy.nsw',
    specialConditions: '',
    delivery: '',
    value: null,
    awards: [],
    docs: [],
    briefing: null,
    contact: { name: r.contact?.name || '', email: r.contact?.email || '', phone: r.contact?.phone || '' },
    timeline: r.timeline || null,
    locations: r.locations || '',
  };
}

// buy.nsw.gov.au sits behind an AWS WAF JavaScript challenge: plain HTTP gets an empty 202
// ("x-amzn-waf-action: challenge") after the first few requests. fetchStatePortalPage tries a
// direct request (free) and falls back to Firecrawl, which renders the page past the challenge
// (1 credit per page, ~19 pages per full scan). The scan therefore runs only from the
// scheduled state ingest, never from a visitor-triggered refresh.
const isResults = (html) => /Displaying\s+\d+-\d+\s+of/i.test(html || '');
async function getPage(page, { timeoutMs }) {
  // Stable A-Z order: the default 'last updated' order reshuffles between page fetches and drops rows.
  const url = `${NSW_ENDPOINT}?sort=AtoZ&page=${page}`;
  // The WAF sometimes answers 200 with a challenge page instead of results, so validate the
  // content, not just the status, before accepting a direct fetch.
  try {
    const direct = await fetchStatePortalPage(url, { timeoutMs });
    if (isResults(direct)) return direct;
  } catch { /* fall through to Firecrawl */ }
  const html = await fetchViaFirecrawl(url, { timeoutMs });
  if (!isResults(html)) throw new Error('nsw_challenge_page');
  return html;
}

export async function fetchNswTenders({ timeoutMs = 45000, maxPages = 30, concurrency = 5 } = {}) {
  const first = parseNswPage(await getPage(1, { timeoutMs }));
  if (!first.rows.length) throw new Error('nsw_schema_invalid');
  const pages = Math.min(maxPages, Math.ceil((first.total || first.rows.length) / Math.max(first.rows.length, 1)));
  const rows = [...first.rows];
  const errors = [];
  for (let p = 2; p <= pages; p += concurrency) {
    await Promise.all(Array.from({ length: Math.min(concurrency, pages - p + 1) }, (_, i) => p + i).map(async (n) => {
      try { rows.push(...parseNswPage(await getPage(n, { timeoutMs })).rows); }
      catch (e) { errors.push(`page_${n}:${e.message}`); }
    }));
  }
  // A partial scan would hide the missing pages' tenders (freshness gate), so fail it instead.
  if (errors.length) throw new Error(`nsw_partial_${errors.length}_of_${pages}:${errors[0]}`.slice(0, 90));
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  // Detail enrichment is best-effort: failures never fail the list scan.
  let detail = { enriched: 0, errors: [], challenged: false };
  try { detail = await enrichNswDetails(unique); } catch { /* list-only scan */ }
  return { rows: unique, total: unique.length, expected: first.total, detail };
}

export function asStoreRow(t, existing = {}, observedAt = new Date().toISOString()) {
  // 'published' on this portal is first-seen time: keep the earliest we recorded.
  // Docs/contacts arrive from detail enrichment and must survive list-only scans.
  const kept = mergeEnriched(t, existing, observedAt);
  const data = { ...existing, ...t, docs: kept.docs, contact: kept.contact, addendum: kept.addendum, timeline: kept.timeline, // Keep the earliest publish date we have seen (first-seen or the portal's own date).
  published: [existing.published, t.published].filter(Boolean).sort()[0] || t.published, value: existing.value ?? t.value ?? null };
  return {
    ocid: data.ocid, title: data.title, buyer: data.buyer, province: data.province,
    category: data.category || null, value: data.value, published: data.published,
    closes: data.closes, status: data.status, data, updated_at: observedAt,
  };
}
