// TenderWin ingest runner. Runs on GitHub Actions (free), writes straight to Supabase.
// What runs is decided by AGE, not by the clock (lib/schedule.mjs): GitHub's scheduler drifts, so a
// "run states at 00:15/12:15" rule never fired. A source is scanned when its last successful scan is
// older than its TTL.
//   every run   federal: AusTender ATMs (RSS) + contract awards (free, no Firecrawl)
//   when due    NT, TAS, VendorPanel (free direct fetch, ~11h) / VIC, ACT (Firecrawl, daily) / NSW (daily)
//   every run   NSW tender packs: up to 20 new packs read and stored (lib/nsw-pack.mjs)
// Override with RUN_STATES=1 / RUN_NSW=1 (manual dispatch).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FIRECRAWL_API_KEYS (comma-separated; 402 keys are skipped)
import { runPortalIngest, runStatePortalsIngest, runNswIngest, feedClient } from './lib/tender-feed.js';
import { readNswPacks } from './lib/nsw-pack.mjs';
import { dueSources } from './lib/schedule.mjs';
import { fetchTierStats } from './lib/state-portals.mjs';

const summarise = (res) => (res.sources || []).map((s) => ({ source: s.source, ok: s.ok, status: s.status, written: s.written, reason: s.reason }));
const log = (stage, r) => console.log(JSON.stringify({ stage, ...r }));

async function main() {
  const t0 = Date.now();
  const all = [];
  const federal = summarise(await runPortalIngest({ force: true }));
  federal.forEach((r) => log('federal', r)); all.push(...federal);
  // What is due is a function of each source's last successful scan, read in one tiny query.
  let states = [];
  try { states = (await feedClient().from('vula_tender_feed_state').select('source,last_success_at')).data || []; } catch { /* unknown: treat everything as due */ }
  const due = dueSources(states, undefined, Date.now(), { force: process.env.RUN_STATES === '1' });
  const stateDue = due.filter((s) => s !== 'nsw-etendering');
  const runNsw = process.env.RUN_NSW === '1' || due.includes('nsw-etendering');
  console.log(JSON.stringify({ stage: 'schedule', stateDue, runNsw, lastSuccess: Object.fromEntries(states.map((s) => [s.source, s.last_success_at])) }));
  // WA blocks GitHub's IP range (403), so a small Vercel route covers it: skip it here.
  if (stateDue.length) { const s = summarise(await runStatePortalsIngest({ force: true, only: stateDue })); s.forEach((r) => log('states', r)); all.push(...s); }
  if (runNsw) { const n = summarise(await runNswIngest({ force: true })); n.forEach((r) => log('nsw', r)); all.push(...n); }
  // NSW tender packs: download, read the bid documents, store the text for the site's AI read.
  // Every run, newest tenders first, capped by count and time. Never fails the run.
  try { log('nsw-packs', await readNswPacks(feedClient(), { max: Number(process.env.PACK_MAX || 20) })); }
  catch (e) { log('nsw-packs', { ok: false, reason: String(e?.message || e).slice(0, 80) }); }
  // A failed state/NSW source no longer hides inside a green run: it becomes a GitHub warning annotation.
  for (const r of all.filter((x) => !x.ok)) console.log(`::warning title=ingest ${r.source}::${r.reason || r.status || 'failed'}`);
  const ok = all.filter((r) => r.ok).length;
  console.log(JSON.stringify({ stage: 'done', ok, failed: all.length - ok, stateDue, runNsw, pagesDirect: fetchTierStats.direct, pagesFirecrawl: fetchTierStats.firecrawl, ms: Date.now() - t0 }));
  // Fail the run (so GitHub emails you) when the main product source, open ATMs, did not succeed.
  const atm = all.find((r) => r.source === 'autender-atm');
  process.exit(atm && atm.ok ? 0 : 1);
}
main().catch((e) => { console.error('fatal', e?.message || e); process.exit(1); });
