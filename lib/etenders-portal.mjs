// Official production portal adapter for the AU market.
// Source: AusTender OCDS API (api.tenders.gov.au) — federal contract notices,
// OCDS 1.1 compliant. Retain provenance: this is a release feed, not a scrape.
//
// NSW has a separate public API (tenders.nsw.gov.au, also OCDS-flavoured) and
// state portals (VIC/SA on TenderSearch, WA, TAS) have none — they are read by
// their own adapters and normalised into the same store row shape as this
// module via asStoreRow().

export const PORTAL_SOURCE = 'autender-ocds';
export const PORTAL_ENDPOINT = 'https://api.tenders.gov.au/ocds/findByDates/contractPublished';

// The store's "province" column doubles as the state/territory field in AU.
export const AU_STATES = new Set([
  'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT', 'NATIONAL',
]);

export function localDate(value) {
  if (!value || /^0001-/.test(value)) return null;
  const raw = String(value);
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : raw + '+10:00');
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buyerFromRelease(release) {
  const parties = release.parties || [];
  const buyer = parties.find((p) => (p.roles || []).includes('procuringEntity'));
  if (!buyer) return 'Unknown buyer';
  return buyer.name || 'Unknown buyer';
}

function supplierFromRelease(release) {
  const parties = release.parties || [];
  const sup = parties.find((p) => (p.roles || []).includes('supplier'));
  return sup ? sup.name : null;
}

function stateFromRelease(release) {
  const parties = release.parties || [];
  const buyer = parties.find((p) => (p.roles || []).includes('procuringEntity'));
  const region = buyer?.address?.region || '';
  const up = region.toUpperCase();
  if (AU_STATES.has(up)) return up;
  return 'NATIONAL';
}

function categoryFromRelease(release) {
  const t = release.tender || {};
  if (t.category) return t.category;
  if (t.mainProcurementCategory) return t.mainProcurementCategory;
  const items = t.additionalProcurementCategories || t.items || [];
  return (Array.isArray(items) && items[0]?.classification?.description) || '';
}

function valueFromRelease(release) {
  const t = release.tender || {};
  const awards = release.awards || [];
  const contracts = release.contracts || [];
  if (awards[0]?.value?.amount != null) return awards[0].value.amount;
  if (contracts[0]?.value?.amount != null) return contracts[0].value.amount;
  if (t.value?.amount != null) return t.value.amount;
  return null;
}

function docsFromRelease(release) {
  const t = release.tender || {};
  return (t.documents || []).filter((d) => d.url).map((d) => ({
    title: d.title || 'Tender document',
    format: (d.format || '').replace(/^\./, '') || 'html',
    url: d.url,
    sourceDocumentId: d.id || null,
    sourceModifiedAt: d.dateModified || null,
  }));
}

function awardsFromRelease(release, ocid) {
  const parties = release.parties || [];
  return (release.awards || []).map((a) => {
    const sup = (a.suppliers || [])[0];
    const supParty = sup && parties.find((p) => p.id === sup.id);
    return {
      award_id: a.id || `${ocid}-award`,
      buyer: buyerFromRelease(release),
      supplier: supParty?.name || sup?.name || null,
      value: a.value?.amount ?? null,
      award_date: (a.date || release.date || '').slice(0, 10) || null,
      data: a,
    };
  });
}

// Map an OCDS release (AusTender flavour) to the portal-tender row shape the
// rest of the ingest pipeline already understands. Checked against live
// api.tenders.gov.au responses (contractPublished feed, Oct 2026).
export function mapPortalTender(r, observedAt = new Date().toISOString()) {
  if (!r || typeof r !== 'object') throw new Error('portal_schema_invalid');
  const ocid = r.ocid || (r.id ? `ocds-au-${r.id}` : null);
  if (!ocid) throw new Error('portal_schema_invalid');

  const published = localDate(r.date);
  if (!published) throw new Error('portal_dates_invalid');

  const t = r.tender || {};
  const contract = (r.contracts || [])[0] || {};
  const period = contract.period || t.tenderPeriod || {};
  const closes = localDate(period.endDate) || null;
  const opens = localDate(period.startDate) || published;

  const title = (t.title || contract.title || r.title || 'Untitled notice').trim().replace(/\s+/g, ' ');
  const description = t.description || title;
  // AusTender contract notices rarely carry a tender.status — infer from dates:
  // a contract period that hasn't ended yet is a live/active notice.
  let status = t.status ? String(t.status).toLowerCase() : '';
  if (!status || status === 'unknown' || status === 'null') {
    const end = period.endDate ? Date.parse(period.endDate) : null;
    status = (end && end > Date.now()) ? 'active' : 'complete';
  }

  const briefing = (t.documents || []).find((d) => /briefing|pre-?tender/i.test(d.title || ''));

  return {
    ocid,
    ocidDerived: !r.ocid,
    portalId: r.id || ocid,
    source: PORTAL_SOURCE,
    sourceUrl: `https://www.tenders.gov.au/`,
    sourceDetailUrl: `https://www.tenders.gov.au/?event=public.adv.view&rftid=${r.id || ''}`,
    sourceObservedAt: observedAt,
    sourceStatus: t.status || r.status,
    sourceDates: { published: r.date, closes: period.endDate, timeZone: 'Australia/Sydney' },
    ref: t.id || r.id || '',
    title,
    description,
    buyer: buyerFromRelease(r),
    supplier: supplierFromRelease(r),
    province: stateFromRelease(r),
    category: categoryFromRelease(r),
    method: t.procurementMethod || '',
    published,
    closes,
    opens,
    status,
    eSub: (t.submissionMethod || []).includes('electronicSubmission'),
    submission: (t.submissionMethod || []).includes('electronicSubmission')
      ? 'Electronic submission via AusTender'
      : 'See official tender documents',
    specialConditions: t.conditions || '',
    delivery: t.placeOfPerformance || '',
    value: valueFromRelease(r),
    awards: awardsFromRelease(r, ocid),
    docs: docsFromRelease(r),
    briefing: briefing
      ? { compulsory: /compulsory/i.test(briefing.title || ''), venue: briefing.description || '', date: briefing.datePublished || null }
      : null,
    contact: {
      name: t.contactPoint?.name || '',
      email: t.contactPoint?.email || '',
      phone: t.contactPoint?.telephone || '',
    },
  };
}

// Windowed fetch: AusTender's findByDates endpoint returns contract notices
// published in a date window — one flat page, no offset pagination. The store
// cursor stays at 0 and the window is the unit of work.
export async function fetchPortalPage(start, { fetcher = fetch, timeoutMs = 15000, windowDays = 3 } = {}) {
  const end = new Date();
  const begin = new Date(end.getTime() - windowDays * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 19) + 'Z';
  const url = `${PORTAL_ENDPOINT}/${fmt(begin)}/${fmt(end)}`;
  const res = await fetcher(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // AusTender answers 400 {"errorCode":100,"message":"No Records found ..."} when the window
    // has no contract notices (weekends, public holidays). That is a valid empty result,
    // not an outage; treating it as an error put the whole feed into 'error'.
    if (res.status === 400) {
      let body = null;
      try { body = await res.json(); } catch { /* fall through */ }
      if (body?.errorCode === 100 || /No Records found/i.test(body?.message || '')) return { rows: [], total: 0, empty: true };
    }
    throw new Error(`portal_http_${res.status}`);
  }
  let j;
  try { j = await res.json(); } catch { throw new Error('portal_schema_invalid'); }
  const releases = Array.isArray(j?.releases) ? j.releases : null;
  if (!releases) throw new Error('portal_schema_invalid');
  return { rows: releases, total: releases.length };
}

export function asStoreRow(t, existing = {}, observedAt = new Date().toISOString()) {
  const data = { ...existing, ...t, value: existing.value ?? t.value ?? null };
  return {
    ocid: data.ocid, title: data.title, buyer: data.buyer, province: data.province,
    category: data.category || null, value: data.value, published: data.published,
    closes: data.closes, status: data.status, data, updated_at: observedAt,
  };
}
