// Multi-source ingest orchestrator for the AU market.
//
// Sources:
//   autender-ocds   — federal contract notices via api.tenders.gov.au (primary)
//   autender-atm    — federal open opportunities via AusTender ATM list
//   nsw-etendering  — NSW RFT/Scheme tenders via tenders.nsw.gov.au (may be IP-
//                     blocked from datacenter egress; errors are caught per-
//                     source so one outage never fails the whole run)
//   vic/act-tsearch — state open tenders via the TenderSearch portals
//                     (tenders.vic.gov.au / tenders.act.gov.au), Firecrawl
//   nt-qtol         — NT open tenders via tendersonline.nt.gov.au, Firecrawl
//
// Each source maps through its own adapter into the same vula_tenders row
// shape, then upserts. A shared feed lease (vula_tender_feed_state) prevents
// parallel cold starts from double-crawling the same source.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  fetchPortalPage, mapPortalTender, asStoreRow, PORTAL_SOURCE,
} from './etenders-portal.mjs';
import {
  fetchNswTenders, mapNswTender, asStoreRow as asNswStoreRow, NSW_SOURCE,
} from './nsw-etendering.mjs';
import {
  mapAtmTender, asStoreRow as asAtmStoreRow, ATM_SOURCE,
} from './autender-atm.mjs';
import { fetchAtmOpen } from './atm-rss.mjs';
import {
  fetchVicTenders, vicMapper, fetchActTenders, actMapper,
  fetchNtTenders, ntMapper, fetchTasTenders, tasMapper,
  fetchVendorpanelTenders, vpMapper, fetchWaTenders, waMapper, asStateStoreRow,
  VIC_SOURCE, ACT_SOURCE, NT_SOURCE, TAS_SOURCE, VP_SOURCE, WA_SOURCE,
} from './state-portals.mjs';

export function feedClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('tender_store_not_configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function runSourceIngest(sb, source, fetcher, mapper, rowMapper, { budgetMs = 45000, force = false } = {}) {
  const token = randomUUID(), started = Date.now();
  const { data: claimed, error: claimError } = await sb.rpc('vula_claim_tender_feed', { p_token: token, p_source: source, p_force: force });
  if (claimError) throw new Error('feed_lease_failed');
  if (!claimed?.length) return { ok: true, source, status: 'cooldown_or_running' };
  const state = claimed[0];
  const seen = new Set(state.seen_ids || []);
  const written = state.rows_written || 0;
  async function checkpoint(patch) {
    const { data, error } = await sb.from('vula_tender_feed_state').update(patch)
      .eq('source', source).eq('lease_token', token).select('source');
    if (error || data?.length !== 1) throw new Error('feed_checkpoint_failed');
  }
  try {
    const scanStart = new Date().toISOString();
    await checkpoint({ scan_started_at: scanStart, rows_written: written });
    const result = await fetcher();
    if (result.status === 'rejected') throw result.reason;
    const page = result;
    if (!page.rows.length && page.empty) {
      // Source answered "no new records": healthy, nothing to write.
      await checkpoint({
        status: 'complete', last_success_at: new Date().toISOString(),
        cursor_offset: 0, expected_total: null, rows_written: 0, scan_started_at: null,
        seen_ids: [], lease_token: null, lease_until: null, last_error: null,
      });
      return { ok: true, source, status: 'complete', written: 0, pages: 1, empty: true };
    }
    if (!page.rows.length) throw new Error('portal_empty_snapshot');
    const observedAt = new Date().toISOString();
    const tenders = [...new Map(page.rows.map(r => { const t = mapper(r, observedAt); return [t.ocid, t]; })).values()];
    if (tenders.length !== page.rows.length) throw new Error('portal_duplicate_restart');
    const { data: old, error: readError } = await sb.from('vula_tenders').select('ocid,data').in('ocid', tenders.map(t => t.ocid));
    if (readError) throw new Error('tender_store_read_failed');
    const existing = new Map((old || []).map(r => [r.ocid, r.data]));
    const rows = tenders.map(t => rowMapper(t, existing.get(t.ocid), observedAt));
    const { error: writeError } = await sb.from('vula_tenders').upsert(rows, { onConflict: 'ocid' });
    if (writeError) throw new Error('tender_store_write_failed');
    rows.forEach(t => seen.add(t.ocid));
    const totalWritten = written + rows.length;
    // award upsert for comparables
    const awardRows = tenders.flatMap(t => (t.awards || []).map(a => ({ ocid: t.ocid, ...a })));
    if (awardRows.length) {
      const { error: awardError } = await sb.from('vula_awards').upsert(awardRows, { onConflict: 'ocid,award_id' });
      if (awardError) console.error('[au-ingest] awards_write_failed', awardError.message);
    }
    await checkpoint({
      status: 'complete', last_success_at: new Date().toISOString(),
      last_complete_started_at: scanStart,
      cursor_offset: 0, expected_total: null, rows_written: 0, scan_started_at: null,
      seen_ids: [], lease_token: null, lease_until: null, last_error: null,
    });
    return { ok: true, source, status: 'complete', written: totalWritten, pages: 1 };
  } catch (e) {
    // Keep the real message (typed codes pass through; anything else is
    // underscore-joined rather than collapsed - a raw 'fetch failed' hides
    // whether it was DNS, reset, or timeout, which costs debugging time).
    const raw = String(e?.message || 'unknown').replace(/\s+/g, ' ').trim();
    const reason = /^[a-z_0-9:]+$/.test(raw) ? raw.slice(0, 60) : raw.replace(/\s+/g, '_').slice(0, 90);
    await checkpoint({ status: 'error', last_error: reason, lease_token: null, lease_until: null });
    console.error(`[au-ingest:${source}]`, reason);
    return { ok: false, source, status: 'error', reason, written };
  }
}

export async function runStatePortalsIngest({ force = true, budgetMs = 240000, client } = {}) {
  const sb = client || feedClient();
  const stateSources = [
    [VIC_SOURCE, () => fetchVicTenders({ timeoutMs: 45000 }), vicMapper],
    [ACT_SOURCE, () => fetchActTenders({ timeoutMs: 45000 }), actMapper],
    [NT_SOURCE, () => fetchNtTenders({ timeoutMs: 45000 }), ntMapper],
    [TAS_SOURCE, () => fetchTasTenders({ timeoutMs: 30000 }), tasMapper],
    [VP_SOURCE, () => fetchVendorpanelTenders({ timeoutMs: 45000 }), vpMapper],
    [WA_SOURCE, () => fetchWaTenders({ timeoutMs: 45000 }), waMapper],
  ];
  const results = [];
  for (const [source, fetcher, mapper, rowMapper] of stateSources) {
    const r = await runSourceIngest(sb, source, fetcher, mapper, rowMapper || asStateStoreRow, { budgetMs, force })
      .catch(e => ({ ok: false, source, status: 'error', reason: String(e?.message || 'unknown').slice(0, 60) }));
    results.push({ status: 'fulfilled', value: r });
  }
  const summary = results.map(r => r.value || { ok: false, reason: 'unknown' });
  return { ok: summary.some(r => r.ok), sources: summary };
}

// NSW (buy.nsw.gov.au): ~19 Firecrawl page renders (about 2 minutes), so it gets its own daily
// function (/api/cron/ingest-nsw) and is never part of the run a page view can trigger.
export async function runNswIngest({ force = true, budgetMs = 240000, client } = {}) {
  const sb = client || feedClient();
  const r = await runSourceIngest(sb, NSW_SOURCE, () => fetchNswTenders({ timeoutMs: 45000 }), mapNswTender, asNswStoreRow, { budgetMs, force })
    .catch(e => ({ ok: false, source: NSW_SOURCE, status: 'error', reason: String(e?.message || 'unknown').slice(0, 60) }));
  return { ok: !!r.ok, sources: [r] };
}

export async function runPortalIngest({ force = false, budgetMs = 45000, client } = {}) {
  const sb = client || feedClient();
  // FEDERAL SOURCES run concurrently (fast; the ATM adapter fires its page
  // scrapes together at t=0). STATE PORTALS run AFTER them, sequentially:
  // the shared Firecrawl key cannot take the ATM burst plus five portal
  // scrapes at once (429s), and the ingest route allows 300s — enough for
  // VIC 3 + ACT 1 + NT 7 sequential scrapes with backoff retries.
  const results = await Promise.allSettled([
    // OPEN OPPORTUNITIES (the main product): AusTender ATM list via Firecrawl.
    // 7 credits/day; this is the source bidders actually act on.
    // Official AusTender RSS (all open ATMs) + detail enrichment. Replaces the
    // Firecrawl list scrape, which hit 402 (no credits) and read only 7 pages.
    runSourceIngest(sb, ATM_SOURCE,
      () => fetchAtmOpen({ timeoutMs: 20000 }),
      mapAtmTender, asAtmStoreRow, { budgetMs, force }),
    // Award history: free, direct from the OCDS API (no Firecrawl needed).
    runSourceIngest(sb, PORTAL_SOURCE,
      () => fetchPortalPage(0, { timeoutMs: 25000 }),
      mapPortalTender, asStoreRow, { budgetMs, force }),
  ]);
  // STATE PORTALS (Oct 2026): VIC + ACT (TenderSearch platform) and NT
  // (Quotations and Tenders Online), all via Firecrawl with a 12h cache.
  // QLD is a Blazor SPA that Firecrawl cannot render — not wired yet.
  const summary = results.map(r => r.value || { ok: false, reason: r.reason?.message || 'unknown' });
  const ok = summary.some(r => r.ok);
  return { ok, sources: summary };
}

