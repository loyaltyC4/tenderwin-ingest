// Tenders WA documents: log in once, read each open tender's file list, download only packs that are new or
// changed, store the files in a private Supabase Storage bucket and persist `docs` rows (waFile) on the tender.
// Paced and capped: a handful of downloads per run, soonest-closing first. Never fails the workflow run.
//
// env: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY WA_USER WA_PASS GMAIL_USER GMAIL_APP_PASS
//      WA_DOCS_LIMIT (downloads per run, default 15)  WA_CHECK_HOURS (re-check a list after, default 20)  WA_DRY=1
import { createClient } from "@supabase/supabase-js";
import { unzipSync } from "fflate";
import { WaSession, sleep } from "../lib/wa-session.mjs";
import { mergeEnriched } from "../lib/enrich.mjs";
import { waViewId, waSignature, buildWaRows, waStorageKey, contentTypeFor, WA_BUCKET, MAX_FILE_BYTES, pickWaDue } from "../lib/wa-docs.mjs";

const E = process.env;
const LIMIT = Number(E.WA_DOCS_LIMIT || 15), CHECK_MS = Number(E.WA_CHECK_HOURS || 20) * 3600e3, DRY = E.WA_DRY === "1";
const BUDGET_MS = Number(E.WA_BUDGET_MIN || 14) * 60e3, started = Date.now();
const warn = (m) => console.log(`::warning::WA docs: ${m}`);
if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) { warn("no Supabase credentials"); process.exit(0); }
if (!E.WA_USER || !E.WA_PASS || !E.GMAIL_USER || !E.GMAIL_APP_PASS) { warn("WA/Gmail secrets not set, skipping"); process.exit(0); }
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: cands, error } = await sb.from("vula_tenders")
  .select("ocid,closes,sig:data->>waDocsSig,checked:data->>waDocsCheckedAt,seen:data->>sourceObservedAt")
  .like("ocid", "wa-tenders-%").eq("status", "active").limit(1000);
if (error) { warn("candidate query failed: " + error.message); process.exit(0); }
const now = Date.now();
// Only tenders the latest scan still saw: rows the portal has dropped stay "active" in the table but return an empty page.
const SEEN_MS = 3 * 864e5;
const live = cands.filter((r) => r.seen && now - Date.parse(r.seen) < SEEN_MS);
const due = pickWaDue(live, { now, limit: 1000 }).filter((r) => !r.checked || now - Date.parse(r.checked) > CHECK_MS);
console.log(`WA docs: ${cands.length} active rows, ${live.length} seen in the last scan, ${due.length} due a file-list check, download cap ${LIMIT}`);
if (!due.length) process.exit(0);

const wa = new WaSession();
// WA's site blocks some runner IPs now and then (the page comes back without a login nonce); a fresh session a
// little later usually gets through. Three tries, 40s apart, then give up quietly until the next run.
let loggedIn = false;
for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
  try {
    await wa.login({ user: E.WA_USER, pass: E.WA_PASS, gmailUser: E.GMAIL_USER, gmailPass: E.GMAIL_APP_PASS });
    loggedIn = true;
  } catch (e) {
    console.log(`WA docs: login attempt ${attempt} failed: ${e.message}`);
    if (/wa_not_configured|wa_login_rejected|wa_token_rejected/.test(e.message)) break; // retrying a rejected password risks a lock-out
    if (attempt < 3) { wa.jar.clear(); await sleep(40000); }
  }
}
if (!loggedIn) { warn("login failed after retries"); process.exit(0); }
console.log("WA docs: logged in");

if (!DRY) { const { error: be } = await sb.storage.createBucket(WA_BUCKET, { public: false }); if (be && !/already exists|duplicate/i.test(be.message)) warn("bucket: " + be.message); }

// optimistic read-modify-write, never bumps updated_at (it means "last scan")
async function persist(ocid, build) {
  for (let i = 0; i < 3; i++) {
    const { data: row } = await sb.from("vula_tenders").select("data,updated_at").eq("ocid", ocid).maybeSingle();
    if (!row?.data) return false;
    const next = build(row.data);
    const { data: hit, error: ue } = await sb.from("vula_tenders").update({ data: next }).eq("ocid", ocid).eq("updated_at", row.updated_at).select("ocid");
    if (!ue && hit?.length) return true;
  }
  return false;
}

const stat = { checked: 0, unchanged: 0, downloaded: 0, files: 0, skippedBig: 0, failed: 0 };
let downloads = 0;
for (const r of due) {
  if (Date.now() - started > BUDGET_MS) { warn("time budget reached"); break; }
  const id = waViewId(r.ocid);
  if (!id) continue;
  try {
    const files = await wa.fileList(id);
    stat.checked++;
    const sig = waSignature(files);
    const stamp = new Date().toISOString();
    if (!files.length || sig === r.sig) { // nothing new: just stamp the check
      stat.unchanged++;
      if (!DRY) await persist(r.ocid, (d) => ({ ...d, waDocsCheckedAt: stamp }));
      await sleep(700);
      continue;
    }
    if (downloads >= LIMIT) { await sleep(400); continue; } // over the cap: left for the next run
    await sleep(1500);
    const zip = await wa.downloadZip(id);
    downloads++;
    const entries = unzipSync(new Uint8Array(zip));
    const stored = [];
    let idx = 0;
    for (const f of files) {
      const hit = Object.entries(entries).find(([n]) => n.split("/").pop() === f.name) || Object.entries(entries)[idx];
      idx++;
      if (!hit) continue;
      const bytes = hit[1];
      if (bytes.length > MAX_FILE_BYTES) { stat.skippedBig++; continue; }
      const key = waStorageKey(r.ocid, stored.length, f.name);
      if (!DRY) {
        const { error: ue } = await sb.storage.from(WA_BUCKET).upload(key, bytes, { contentType: contentTypeFor(f.name), upsert: true });
        if (ue) throw new Error("upload: " + ue.message);
      }
      stored.push({ name: f.name, key, size: bytes.length, ver: f.ver });
    }
    if (!stored.length) throw new Error("no files in zip");
    if (!DRY) {
      const ok = await persist(r.ocid, (d) => {
        const rows = buildWaRows(stored, d.sourceDetailUrl);
        const m = mergeEnriched({ docs: rows, contact: d.contact }, d, stamp);
        return { ...d, docs: rows, addendum: m.addendum, docsFetchedAt: stamp, docsFetchedCount: rows.length, waDocsSig: sig, waDocsCheckedAt: stamp };
      });
      if (!ok) throw new Error("persist conflict");
    }
    stat.downloaded++; stat.files += stored.length;
    console.log(`WA docs: ${r.ocid} ${stored.length} file(s)`);
    await sleep(3000);
  } catch (e) {
    stat.failed++;
    console.log(`WA docs: ${r.ocid} failed: ${e.message}`);
    // stamp the check so a stubborn tender is retried after the normal interval, not on every run
    if (!DRY && !/wa_session_lost|wa_login/.test(e.message)) await persist(r.ocid, (d) => ({ ...d, waDocsCheckedAt: new Date().toISOString(), waDocsError: String(e.message).slice(0, 60) })).catch(() => {});
    if (/wa_session_lost|wa_login/.test(e.message)) { warn("session lost, stopping"); break; }
    await sleep(2000);
  }
}
console.log("WA docs:", JSON.stringify(stat), `${Math.round((Date.now() - started) / 1000)}s`);
