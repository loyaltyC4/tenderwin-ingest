// AusTender Annual Procurement Plans: the federal forward pipeline (2026-11-19).
//
// Every agency publishes the significant procurements it plans to take to market in the next twelve months
// (subject matter, UNSPSC category, estimated quarter). tenders.gov.au serves a free spreadsheet per agency at
// /App/Download/{agencyUuid}; the agency list is the dropdown on /App/List. No login, plain HTTP with a browser
// User-Agent. Pure parsing lives here so it can be tested without the network.
import * as XLSX from 'xlsx';

const BASE = 'https://www.tenders.gov.au';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Australian financial year: Quarter 1 = Jul-Sep ... Quarter 4 = Apr-Jun. "Quarter 2 2026/2027" -> 2026-10-01.
export function quarterStart(text) {
  const m = String(text || '').match(/Quarter\s*([1-4])\s*(20\d{2})\s*\/\s*(20\d{2})/i);
  if (!m) return null;
  const q = Number(m[1]), fy1 = Number(m[2]), fy2 = Number(m[3]);
  const [y, mo] = q === 1 ? [fy1, 7] : q === 2 ? [fy1, 10] : q === 3 ? [fy2, 1] : [fy2, 4];
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

// "10-Dec-2025 6:02 pm (ACT Local Time)" -> ISO (Canberra is UTC+11 in summer, UTC+10 in winter; day precision is enough).
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseUpdated(s) {
  const m = String(s || '').match(/(\d{1,2})-([A-Za-z]{3})-(20\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), MON[m[2].toLowerCase()], Number(m[1]))).toISOString();
}

const first = (v) => String(v ?? '').split('\n')[0].trim();
const clean = (v) => String(v ?? '').replace(/ /g, ' ').trim();

// -> { agency, rows: [...] } from one agency spreadsheet buffer. No rows is normal (many agencies publish none).
export function parsePlan(buf, agencyUuid, agencyName) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { agency: agencyName, rows: [] };
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const title = clean(aoa[0]?.[0]).replace(/^Annual Procurement Plan View\s*-\s*/i, '');
  const agency = title || agencyName;
  const h = aoa.findIndex((r) => r.some((c) => /agency reference/i.test(String(c))));
  if (h < 0) return { agency, rows: [] };
  const col = {};
  aoa[h].forEach((c, i) => { const k = String(c).toLowerCase().trim(); if (k) col[k] = i; });
  const g = (r, k) => r[col[k]] ?? '';
  const rows = [];
  for (const r of aoa.slice(h + 1)) {
    const description = first(g(r, 'description'));
    if (!description) continue;
    const ref = first(g(r, 'agency reference'));
    const cat = first(g(r, 'category'));
    const cm = cat.match(/^(\d{6,8})\s*-\s*(.+)$/);
    const est = first(g(r, 'estimated date of approach to market'));
    const atm = clean(g(r, "atm's"));
    rows.push({
      id: `${agencyUuid}:${ref || description.slice(0, 60)}`,
      agency, agency_uuid: agencyUuid, ref: ref || null,
      description,
      category_code: cm ? cm[1] : null,
      category: cm ? cm[2].trim() : (cat || null),
      est_quarter: est || null,
      est_start: quarterStart(est),
      multi_agency: /^yes/i.test(clean(g(r, 'multi agency access'))),
      status: clean(g(r, 'status')) || 'As Published',
      change_comment: clean(g(r, 'change comments')) || null,
      atm_text: atm || null,
      contact: first(g(r, 'contact')) || null,
      source_updated: parseUpdated(g(r, 'last updated')),
    });
  }
  return { agency, rows };
}

export function parseAgencies(html) {
  const out = [];
  for (const m of String(html).matchAll(/<option[^>]*value="([0-9a-f-]{36})"[^>]*>([^<]+)<\/option>/g)) out.push({ uuid: m[1], name: m[2].replace(/&amp;/g, '&').trim() });
  return out;
}

const get = async (path, binary = false) => {
  const r = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
};

export async function fetchAgencies() { return parseAgencies(await get('/App/List?Tab=List%20By%20Agency')); }
export async function fetchPlan(a) { return parsePlan(await get(`/App/Download/${a.uuid}`, true), a.uuid, a.name); }
