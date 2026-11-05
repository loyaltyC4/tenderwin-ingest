// Age-based scheduling for the ingest runner (2026-11-06).
//
// The runner used to decide what to scan from the CLOCK ("hour % 12 < 6"). GitHub's scheduler
// does not fire at 00:15/12:15; it ran at ~06:47 and ~19:45 UTC, so the clock rule was never true
// and VIC/ACT/NT/TAS/NSW were not scanned for days. A scan is now due when the source's last
// successful scan is older than its TTL, whatever the hour: cache semantics, so a source is
// refreshed no more often than it needs to be and never goes silently stale.
//
// TTLs sit just under the cadence so GitHub's jitter cannot skip a whole cycle.
//   free sources (direct fetch)             ~11h  -> about every other run, twice a day
//   VIC / ACT (Cloudflare 403s every direct fetch; Firecrawl render, ~6 credits/scan)  -> daily
//   NSW (buy.nsw.gov.au pages + packs)       -> daily
// Federal AusTender (ATM + contract notices) is free and runs on every run, outside this table.
export const SOURCE_TTL_H = {
  'nt-qtol': 11,
  'tas-tenders': 11,
  'vendorpanel-rss': 11,
  'vic-tendersearch': 23,
  'act-tendersearch': 23,
  'nsw-etendering': 23,
};

// states: rows of vula_tender_feed_state ({ source, last_success_at }).
// -> sources due now. `force` (manual dispatch) makes every source due.
export function dueSources(states, ttlH = SOURCE_TTL_H, now = Date.now(), { force = false } = {}) {
  const last = new Map((states || []).map((s) => [s.source, Date.parse(s.last_success_at || '') || 0]));
  return Object.entries(ttlH)
    .filter(([src, h]) => force || !last.get(src) || now - last.get(src) >= h * 3600e3)
    .map(([src]) => src);
}
