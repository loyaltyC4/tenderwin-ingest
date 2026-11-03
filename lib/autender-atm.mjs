// AusTender ATM (Approach to Market) adapter — the OPEN OPPORTUNITY source.
//
// The OCDS contractPublished feed only carries contract AWARDS (~20/day). The
// live opportunities a bidder can actually act on are ATMs: 99+ currently
// listed across 7 paginated pages at tenders.gov.au/atm.
//
// ACCESS: tenders.gov.au 403s datacenter IPs (CloudFront) — including Vercel's.
// This adapter routes through Firecrawl (FIRECRAWL_API_KEY), proxy:auto, which
// fetches from residential exits. Each list page costs 1 Firecrawl credit;
// a full catalogue sync is 7 credits. At one sync per day that's ~210
// credits/month — inside the hobby Firecrawl plan. The OCDS award ingest
// stays direct (api.tenders.gov.au has no such block, zero credits).
//
// Each list page yields ~15 records with: title, ATM ID, close date+time,
// agency, category, description excerpt, and the /Atm/Show/{uuid} detail URL.
// State comes from the title suffix (", WA.", ", QLD", ", SA" — Commonwealth
// practice) or the detail page; we parse the cheap title hints first and
// enrich from detail pages only for NEW ATMs (lazy enrichment in the ingest
// route, cached in the data blob).

import { mergeEnriched } from './enrich.mjs';

export const ATM_SOURCE = 'autender-atm';
export const ATM_LIST_URL = 'https://www.tenders.gov.au/atm';
export const ATM_PAGES = 7; // 99 records / 15 per page — check pagination anyway
export const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT']);

// ---------- Firecrawl-backed fetcher ----------
// Kept as a separate injectable function so tests can stub it.

function firecrawlKey() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('firecrawl_not_configured');
  return key;
}

export async function fetchFirecrawl(url, { timeoutMs = 30000, formats = ['markdown'] } = {}) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${firecrawlKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats, proxy: 'auto', maxAge: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`firecrawl_http_${res.status}`);
  const j = await res.json();
  if (!j?.success) throw new Error('firecrawl_scrape_failed');
  return j.data?.markdown || j.data?.rawHtml || '';
}

// ---------- parsers (pure, testable) ----------

// "6-Oct-2026 2:00 pm (ACT Local Time)" -> ISO
export function parseAuCloseDate(s, fallbackYear) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const month = months[m[2].toLowerCase()];
  if (month == null) return null;
  let hour = parseInt(m[4], 10);
  const isPm = /pm/i.test(m[6]);
  if (isPm && hour < 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  // "(ACT Local Time)" is AEST/AEDT; +10 is close enough outside the ~1h DST window,
  // and closings are always midday/afternoon so the risk window is tiny.
  const d = new Date(Date.UTC(+m[3], month, +m[1], hour - 10, +m[5]));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Infer state from the ATM title's suffix hint ("..., WA." / "..., QLD") or
// known agency/locations. Returns the AU state code or "NATIONAL".
export function stateFromTitle(title) {
  const t = String(title || '');
  for (const st of AU_STATES) {
    // e.g. "..., WA." / "..., QLD" / "...(SA)" / "..., SA\n"
    if (new RegExp(`[,\\s(]${st}\\b[.)]?`, 'i').test(t)) return st;
  }
  return 'NATIONAL';
}

// Parse ONE list-page markdown into ATM rows. The list renders each record as
// a repeated block: title, then "ATM ID:" / [id](show-url), "Close Date & Time:",
// "Agency:", "Category:", "Description:".
export function parseAtmListPage(markdown, { observedAt } = {}) {
  const md = String(markdown || '');
  const out = [];
  // Split on "ATM ID:" blocks — each record contains exactly one.
  const blocks = md.split(/ATM ID:\s*\n/).slice(1);
  for (const block of blocks) {
    // title: the line before "ATM ID:" was consumed by split; recover from the
    // preceding heading — instead capture forward.
    const idM = block.match(/\[([^\]]+)\]\(https:\/\/www\.tenders\.gov\.au\/Atm\/Show\/([0-9a-f-]{36})\)/i);
    if (!idM) continue;
    const atmId = idM[1].trim();
    const uuid = idM[2];

    const closeM = block.match(/Close Date & Time:\s*\n\s*\n?([^\n]+\([^\n]+\))/i);
    const closes = parseAuCloseDate(closeM?.[1]);

    const agencyM = block.match(/Agency:\s*\n\s*\n([^\n]+)/i);
    const agency = agencyM?.[1]?.trim() || '';

    const catM = block.match(/Category:\s*\n\s*\n([^\n]+)/i);
    const category = catM?.[1]?.trim() || '';

    // title: find the last heading-like line before "ATM ID:" in the raw md.
    // Simpler: the block after Description always repeats the title; fall back
    // to the ATM ID itself.
    const descM = block.match(/Description:\s*\n\s*\n([^\n]+)/i);
    const description = (descM?.[1] || '').trim();

    out.push({
      atmId,
      uuid,
      title: '', // filled by caller from the markdown heading
      description,
      agency,
      category,
      closes,
      detailUrl: `https://www.tenders.gov.au/Atm/Show/${uuid}`,
      observedAt,
    });
  }
  // second pass: recover titles — the markdown shows the title as its own line
  // directly above each "ATM ID:" occurrence.
  const titleByUuid = {};
  const re = /([^\n]+)\n\s*\n?ATM ID:\s*\n\s*\n?\[[^\]]+\]\(https:\/\/www\.tenders\.gov\.au\/Atm\/Show\/([0-9a-f-]{36})\)/gi;
  let m;
  while ((m = re.exec(md))) {
    titleByUuid[m[2]] = m[1].trim();
  }
  for (const row of out) row.title = titleByUuid[row.uuid] || row.atmId;

  return out;
}

// Map an ATM row into the store-row shape the rest of the pipeline expects.
export function mapAtmTender(row, observedAt = new Date().toISOString()) {
  if (!row?.uuid) throw new Error('atm_schema_invalid');
  const title = String(row.title || row.atmId).trim().replace(/\s+/g, ' ');
  return {
    ocid: `ocds-au-atm-${row.uuid}`,
    ocidDerived: true,
    portalId: row.atmId,
    source: ATM_SOURCE,
    sourceUrl: ATM_LIST_URL,
    sourceDetailUrl: row.detailUrl,
    sourceObservedAt: observedAt,
    sourceStatus: 'Published',
    sourceDates: { published: row.pubDate || null, closes: row.closes, timeZone: 'Australia/Sydney' },
    ref: row.atmId,
    title,
    description: row.description || title,
    buyer: row.agency || 'Australian Government agency',
    province: row.state || stateFromTitle(title),
    category: row.category || '',
    method: 'Approach to Market',
    published: row.pubDate || observedAt,
    closes: row.closes || null,
    opens: null,
    status: 'active', // list only shows currently-open ATMs
    eSub: true,
    submission: 'Electronic submission via AusTender',
    specialConditions: row.conditions || '',
    delivery: '',
    value: row.valueFrom != null ? row.valueFrom : null,
    awards: [],
    docs: (row.docs || []).length
      ? row.docs.map((d) => ({ title: d.title || 'Tender document', format: d.format || 'html', url: d.url, sourceDocumentId: d.id || null, sourceModifiedAt: null }))
      // The ATM detail page links a public documents page per notice; give every
      // federal tender a working documents row even before file-level parsing.
      : (row.uuid ? [{ title: 'Tender documents on AusTender', url: `https://www.tenders.gov.au/Atm/ViewDocuments/${row.uuid}`, format: 'link', type: 'Official portal documents' }] : []),
    briefing: null,
    contact: { name: row.contactName || '', email: row.contactEmail || '', phone: row.contactPhone || '' },
  };
}

export function asStoreRow(t, existing = {}, observedAt = new Date().toISOString()) {
  // A missing field in this run (failed detail fetch) must not erase what we already know.
  const known = Object.fromEntries(Object.entries(t).filter(([, v]) => v != null && v !== ''));
  // Docs/contacts arrive from detail enrichment and must survive list-only scans.
  const kept = mergeEnriched(t, existing, observedAt);
  const data = { ...existing, ...known, docs: kept.docs, contact: kept.contact, addendum: kept.addendum, timeline: kept.timeline, value: existing.value ?? t.value ?? null };
  return {
    ocid: data.ocid, title: data.title, buyer: data.buyer, province: data.province,
    category: data.category || null, value: data.value, published: data.published,
    closes: data.closes, status: data.status, data, updated_at: observedAt,
  };
}

// ---------- fetcher: all list pages ----------
export async function fetchAllAtmPages({ fetcher = fetchFirecrawl, pages = ATM_PAGES, timeoutMs = 30000 } = {}) {
  const observedAt = new Date().toISOString();
  const results = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) => fetcher(`${ATM_LIST_URL}?category=&filterby=published&orderby=CloseDate&page=${i + 1}`, { timeoutMs }))
  );
  const rows = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const parsed = parseAtmListPage(r.value, { observedAt });
      if (parsed.length === 0) errors.push(`page_${i + 1}_empty`);
      rows.push(...parsed);
    } else {
      errors.push(`page_${i + 1}_${r.reason?.message || 'failed'}`);
    }
  }
  if (!rows.length && errors.length) throw new Error(`atm_all_pages_failed:${errors[0]}`);
  return { rows, errors, total: rows.length, observedAt };
}
