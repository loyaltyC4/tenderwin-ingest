// AusTender open approaches to market (ATMs) from the official public RSS feed,
// with per-ATM detail enrichment. No Firecrawl, no paging, no login.
//
// Why this exists: the old adapter scraped the HTML list through Firecrawl, which
// ran out of credits (402) and only read 7 pages (105 of 121 open ATMs).
// tenders.gov.au/public_data/rss/rss.xml lists every open ATM in one request.
// Detail pages (/Atm/Show/{uuid}) carry agency, category, close time and contact.
// Both are served to a browser User-Agent; a bare bot UA gets 403.

export const ATM_RSS_URL = 'https://www.tenders.gov.au/public_data/rss/rss.xml';
export const ATM_DETAIL_BASE = 'https://www.tenders.gov.au/Atm/Show/';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const HEADERS = { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-AU,en;q=0.9' };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Sydney wall-clock -> UTC ISO, honouring AEST/AEDT for that exact date.
export function sydneyToIso(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (shown - guess)).toISOString();
}

// "2-Nov-2026 12:00 pm" -> ISO (Sydney time). Returns null when unparseable.
export function parseAtmCloseText(s) {
  const m = String(s || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
  let h = parseInt(m[4], 10) % 12;
  if (/pm/i.test(m[6])) h += 12;
  return sydneyToIso(+m[3], MONTHS[m[2].toLowerCase()], +m[1], h, +m[5]);
}

// RSS -> [{ atmId, uuid, title, state, pubDate, detailUrl, description }]
export function parseAtmRss(xml) {
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || [];
  const out = [];
  for (const item of items) {
    const raw = (tag) => {
      const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? decodeEntities(m[1]).trim() : '';
    };
    const title = raw('title');
    const link = raw('link');
    const uuid = (link.match(/\/Atm\/Show\/([0-9a-f-]{36})/i) || [])[1];
    if (!uuid) continue;
    // "S-EST10852: Mount Stuart ..., QLD"
    const idMatch = title.match(/^([^:]+):\s*(.+)$/);
    const atmId = idMatch ? idMatch[1].trim() : uuid;
    const shortTitle = idMatch ? idMatch[2].trim() : title;
    const state = (shortTitle.match(/[,\s(](NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\)?\.?\s*$/i) || [])[1];
    const pub = raw('pubDate');
    out.push({
      atmId, uuid, title: shortTitle,
      state: state ? state.toUpperCase() : undefined,
      pubDate: pub ? new Date(pub).toISOString() : null,
      detailUrl: ATM_DETAIL_BASE + uuid,
      description: stripTags(raw('description')),
    });
  }
  return out;
}

// Detail page text is "Label : value Label : value ..." on shared lines, so match
// each label against the known label set and stop at the next one.
const DETAIL_LABELS = [
  'Tender Administrator', 'Email Address', 'Contact Details', 'ATM Documents', 'Lodgement Page', 'ATM ID',
  'Agency', 'Category', 'Close Date & Time', 'Show close time for other time zones', 'Publish Date', 'Location',
  'ATM Type', 'APP Reference', 'Multi Agency Access', 'Panel Arrangement', 'Multi-stage', 'Description',
  'Other Information', 'Special Conditions', 'Delivery',
];

export function parseAtmDetail(html) {
  const text = decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const escape = (l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stops = DETAIL_LABELS.map((l) => escape(l)).join('|');
  const grab = (label) => {
    const re = new RegExp(`(?:^|\\s)${escape(label)}\\s*:\\s*(.+?)(?=\\s(?:${stops})\\s*:|$)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const closeRaw = grab('Close Date & Time');
  const pub = grab('Publish Date');
  const pubDate = pub ? new Date(pub) : null;
  // Contact box (left column): "Contact Details : Contracting Officer Email Address : x@y".
  // The role or officer name sits between the heading and the email label; some
  // agencies publish a person, most publish the role. Phones appear occasionally.
  // The contact box strips to "Contact Details <name-or-role> Email Address : x@y".
  // The heading carries no colon on current pages, so match with one optional.
  const cm = text.match(/Contact Details\s*:?\s*(.*?)\s*(?:Email Address|Telephone|Phone)\s*:/);
  const contactName = (cm ? cm[1].trim() : '').slice(0, 60);
  const contactPhone = (text.match(/(?:\(0\d\)\s?\d{3}[\s-]?\d{3}|\+61[\s-]?\d[\d\s-]{7,9}|0\d{3}[\s-]?\d{3}[\s-]?\d{3})/) || [''])[0].trim();
  return {
    agency: grab('Agency'),
    category: grab('Category'),
    closes: parseAtmCloseText(closeRaw),
    closeText: closeRaw,
    published: pubDate && Number.isFinite(pubDate.getTime()) ? pubDate.toISOString() : null,
    location: grab('Location'),
    atmType: grab('ATM Type'),
    contactName: /^[A-Z][A-Za-z .'-]{2,60}$/.test(contactName) ? contactName : '',
    contactEmail: (text.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '',
    contactPhone,
  };
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`austender_http_${res.status}`);
  return res.text();
}

// Enrich rows in small concurrent batches. Failures keep the RSS-only row.
async function enrich(rows, { concurrency = 10, timeoutMs = 8000, maxDetails = 150 } = {}) {
  const errors = [];
  const todo = rows.slice(0, maxDetails);
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async (row) => {
      try {
        Object.assign(row, parseAtmDetail(await get(row.detailUrl, timeoutMs)));
        // Titles often omit the state; the detail page's Location has it.
        if (!row.state && /^(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)$/i.test(row.location || '')) row.state = row.location.toUpperCase();
        row.enriched = true;
      } catch (e) {
        errors.push(`${row.atmId}:${e.message}`);
      }
    }));
  }
  return errors;
}

export async function fetchAtmOpen({ timeoutMs = 20000, detail = true, maxDetails = 150 } = {}) {
  const observedAt = new Date().toISOString();
  const xml = await get(ATM_RSS_URL, timeoutMs);
  const rows = parseAtmRss(xml);
  if (!rows.length) throw new Error('atm_rss_empty');
  const errors = detail ? await enrich(rows, { maxDetails }) : [];
  return { rows, errors, total: rows.length, observedAt };
}
