// Keeps AusTender / VendorPanel document lists fresh and backfills the ones never fetched.
// Runs on GitHub Actions after the ingest (free minutes). It only asks the site's cached refresh
// route for a few tenders at a time; the route decides what is due (adaptive TTL: closing soon =
// checked more often) and paces itself, so a quiet day costs almost nothing.
// Never fails the run. Needs DOCS_REFRESH_TOKEN (shared secret with the site); without it, no-op.
const token = process.env.DOCS_REFRESH_TOKEN;
if (!token) { console.log(JSON.stringify({ stage: 'docs-refresh', skipped: 'no_token' })); process.exit(0); }
const base = process.env.SITE_URL || 'https://tenderwin.com.au'; // apex: a www->apex redirect would drop the auth header
const maxCalls = Number(process.env.DOCS_MAX_CALLS || 10);
const perCall = Number(process.env.DOCS_PER_CALL || 10);
const sum = { calls: 0, processed: 0, withFiles: 0, empty: 0, failed: 0 };
let last = {};
for (let i = 0; i < maxCalls; i++) {
  // One transient network error (a dropped connection mid-call) is retried after a pause, not fatal.
  let r = null, err = '';
  for (let attempt = 0; attempt < 2 && !r; attempt++) {
    try { r = await fetch(`${base}/api/cron/docs-refresh?limit=${perCall}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(80000) }); }
    catch (e) { err = String(e?.cause?.code || e?.message || e).slice(0, 80); console.log(JSON.stringify({ stage: 'docs-refresh', call: i + 1, attempt: attempt + 1, error: err })); if (attempt === 0) await new Promise((res) => setTimeout(res, 8000)); }
  }
  if (!r) break;
  if (!r.ok) { console.log(JSON.stringify({ stage: 'docs-refresh', call: i + 1, http: r.status })); break; }
  const j = await r.json().catch(() => ({}));
  last = j; sum.calls++;
  for (const k of ['processed', 'withFiles', 'empty', 'failed']) sum[k] += j[k] || 0;
  console.log(JSON.stringify({ stage: 'docs-refresh', call: i + 1, ...j }));
  if (!j.processed || !j.remaining || (j.blocked || []).length >= 2) break; // nothing left, or both portals refusing: stop
}
console.log(JSON.stringify({ stage: 'docs-refresh-done', ...sum, remaining: last.remaining ?? null }));
process.exit(0);
