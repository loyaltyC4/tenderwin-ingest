// AusTender planned procurements -> vula_planned. Free, no Firecrawl: one HTML page + ~143 small spreadsheets.
// Idempotent upsert on id. A plan that vanished from the latest download is marked 'Removed' (never deleted),
// so the page can say "withdrawn" instead of silently dropping a row someone was tracking.
import { fetchAgencies, fetchPlan } from '../lib/austender-app.mjs';
import { feedClient } from '../lib/tender-feed.js';

const sb = feedClient();
const agencies = await fetchAgencies();
if (agencies.length < 50) { console.error(JSON.stringify({ stage: 'app', ok: false, reason: `only ${agencies.length} agencies` })); process.exit(1); }
const seen = new Set(); const all = []; let failed = 0;
const queue = [...agencies];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let a; (a = queue.shift());) {
    try { const p = await fetchPlan(a); for (const r of p.rows) { if (!seen.has(r.id)) { seen.add(r.id); all.push(r); } } }
    catch (e) { failed++; console.log(JSON.stringify({ stage: 'app', agency: a.name, error: String(e.message).slice(0, 80) })); }
    await new Promise((r) => setTimeout(r, 250));
  }
}));
if (failed > agencies.length * 0.2) { console.error(JSON.stringify({ stage: 'app', ok: false, reason: `${failed} agency downloads failed` })); process.exit(1); }
const now = new Date().toISOString();
for (let i = 0; i < all.length; i += 200) {
  const { error } = await sb.from('vula_planned').upsert(all.slice(i, i + 200).map((r) => ({ ...r, last_seen: now })), { onConflict: 'id' });
  if (error) { console.error(JSON.stringify({ stage: 'app', ok: false, reason: error.message })); process.exit(1); }
}
// Only mark removals when the run was complete.
if (!failed) await sb.from('vula_planned').update({ status: 'Removed' }).lt('last_seen', now).neq('status', 'Removed');
console.log(JSON.stringify({ stage: 'app', ok: true, agencies: agencies.length, failed, rows: all.length }));
