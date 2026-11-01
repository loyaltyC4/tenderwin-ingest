// TenderWin ingest runner. Runs on GitHub Actions (free), writes straight to Supabase.
// Schedule (UTC, set in the workflow: 00:15, 06:15, 12:15, 18:15):
//   every run  federal: AusTender ATMs (RSS) + contract awards (free, no Firecrawl)
//   00:15, 12:15  state portals (VIC, ACT, NT, TAS, VendorPanel, WA)   ~15 Firecrawl credits
//   00:15 only    NSW (buy.nsw.gov.au)                                   ~19 Firecrawl credits
// Override with RUN_STATES=1 / RUN_NSW=1 (manual dispatch).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FIRECRAWL_API_KEYS (comma-separated; 402 keys are skipped)
import { runPortalIngest, runStatePortalsIngest, runNswIngest } from './lib/tender-feed.js';

const hour = new Date().getUTCHours();
const runStates = process.env.RUN_STATES === '1' || hour % 12 < 6;
const runNsw = process.env.RUN_NSW === '1' || hour < 6;

const summarise = (res) => (res.sources || []).map((s) => ({ source: s.source, ok: s.ok, status: s.status, written: s.written, reason: s.reason }));
const log = (stage, r) => console.log(JSON.stringify({ stage, ...r }));

async function main() {
  const t0 = Date.now();
  const all = [];
  const federal = summarise(await runPortalIngest({ force: true }));
  federal.forEach((r) => log('federal', r)); all.push(...federal);
  if (runStates) { const s = summarise(await runStatePortalsIngest({ force: true })); s.forEach((r) => log('states', r)); all.push(...s); }
  if (runNsw) { const n = summarise(await runNswIngest({ force: true })); n.forEach((r) => log('nsw', r)); all.push(...n); }
  const ok = all.filter((r) => r.ok).length;
  console.log(JSON.stringify({ stage: 'done', ok, failed: all.length - ok, runStates, runNsw, ms: Date.now() - t0 }));
  // Fail the run (so GitHub emails you) when the main product source, open ATMs, did not succeed.
  const atm = all.find((r) => r.source === 'autender-atm');
  process.exit(atm && atm.ok ? 0 : 1);
}
main().catch((e) => { console.error('fatal', e?.message || e); process.exit(1); });
