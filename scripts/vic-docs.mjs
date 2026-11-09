// Buying for Victoria documents: drives a TinyFish cloud browser through tenders.vic.gov.au
// login + each open tender's "Download for Tender Documents" form, captures the pack ZIP via CDP
// response interception, unzips, stores files in the private `vic-docs` Storage bucket and persists
// `docs` rows carrying `vicFile`. Paced and capped; never fails the workflow run.
//
// VIC's CDN (Cloudflare on consolidatedtenders.com) blocks datacenter IPs at the WAF for anything
// but plain GETs, so the detail+download flow runs INSIDE the TinyFish cloud browser session
// (residential-grade egress), while storage/DB writes run from the runner.
//
// env: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TINYFISH_KEY VIC_USER VIC_PASS
//      VIC_DOCS_LIMIT (packs per run, default 12)  VIC_CHECK_HOURS (re-check after, default 20)  VIC_DRY=1
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { unzipSync } from "fflate";
import { vicViewId, vicSignature, buildVicRows, vicStorageKey, contentTypeFor, VIC_BUCKET, MAX_FILE_BYTES, pickVicDue } from "../lib/vic-docs.mjs";
import { mergeEnriched } from "../lib/enrich.mjs";

const E = process.env;
const LIMIT = Number(E.VIC_DOCS_LIMIT || 12), CHECK_MS = Number(E.VIC_CHECK_HOURS || 20) * 3600e3, DRY = E.VIC_DRY === "1";
const BUDGET_MS = Number(E.VIC_BUDGET_MIN || 12) * 60e3, started = Date.now();
const warn = (m) => console.log(`::warning::VIC docs: ${m}`);
if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) { warn("no Supabase credentials"); process.exit(0); }
if (!E.TINYFISH_KEY || !E.VIC_USER || !E.VIC_PASS) { warn("TinyFish/VIC secrets not set, skipping"); process.exit(0); }
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: cands, error } = await sb.from("vula_tenders")
  .select("ocid,closes,data").like("ocid", "vic-tendersearch-%").eq("status", "active").limit(1000);
if (error) { warn("candidate query failed: " + error.message); process.exit(0); }
const now = Date.now();
const SEEN_MS = 3 * 864e5;
const live = cands.filter((r) => r.data?.sourceObservedAt && now - Date.parse(r.data.sourceObservedAt) < SEEN_MS);
const due = pickVicDue(live.map((r) => ({ ocid: r.ocid, closes: r.closes, data: r.data })), { now, limit: 1000 })
  .filter((r) => { const c = Number(r.data?.vicDocsCheckedAt || 0); return !c || now - c > CHECK_MS; })
  .filter((r) => !(r.data?.docs || []).some((d) => d.vicFile));
console.log(`VIC docs: ${cands.length} active rows, ${live.length} seen in the last scan, ${due.length} due a pack download, cap ${LIMIT}`);
const queue = due.slice(0, LIMIT);
if (!queue.length) process.exit(0);

// ---- TinyFish cloud browser session ----
const sessRes = await fetch("https://api.browser.tinyfish.ai", {
  method: "POST",
  headers: { "X-API-Key": E.TINYFISH_KEY, "content-type": "application/json" },
  body: JSON.stringify({}),
});
if (!sessRes.ok) { warn("tinyfish session failed: " + sessRes.status); process.exit(0); }
const sess = await sessRes.json();
console.log(`tinyfish session: ${sess.session_id}`);
const deadline = Date.now() + BUDGET_MS;

try {
  const browser = await chromium.connectOverCDP(sess.cdp_url, { timeout: 90000 });
  const ctx = browser.contexts()[0];
  const p = ctx.pages()[0] || await ctx.newPage();

  // login
  await p.goto("https://www.tenders.vic.gov.au/login/", { timeout: 90000, waitUntil: "load" }).catch(() => {});
  for (let i = 0; i < 12; i++) { await p.waitForTimeout(2500); const t = await p.title().catch(() => ""); if (!/just a moment|attention required/i.test(t)) break; }
  await p.waitForTimeout(1500);
  await p.fill('input[name="username"], #username', E.VIC_USER).catch(() => {});
  await p.fill('input[type="password"], input[name="password"]', E.VIC_PASS).catch(() => {});
  await p.evaluate(() => { const e = Array.from(document.querySelectorAll("button,input[type=submit]")).find(x => /log ?in/i.test((x.textContent || x.value || ""))); if (e) e.click(); });
  await p.waitForTimeout(7000);
  const body1 = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200));
  if (!/Charles Morrison|log\s?out/i.test(body1)) throw new Error("vic_login_failed");
  console.log("VIC logged in");

  let stored = 0, packs = 0, skippedNoDocs = 0;
  for (const t of queue) {
    if (Date.now() - started > BUDGET_MS) { console.log("budget reached"); break; }
    const id = vicViewId(t.ocid);
    if (!id) continue;
    try {
      // load the pack form (challenge auto-passes in the cloud browser)
      await p.goto(`https://www.tenders.vic.gov.au/secure/tender/downloadSpecDocs?tenderId=${id}&method=downloadViaHTML`, { timeout: 90000, waitUntil: "load" }).catch(() => {});
      await p.waitForTimeout(6000);
      const boxInfo = await p.evaluate(() => Array.from(document.querySelectorAll('#spec input[name="ids[]"]')).map((c) => ({ v: c.value, label: (c.closest("label") || c.parentElement || { textContent: "" }).textContent.replace(/\s+/g, " ").trim().slice(0, 120) })));
      if (!boxInfo.length) { console.log(`${t.ocid}: no pack form (no docs)`); skippedNoDocs++; continue; }
      console.log(`${t.ocid}: ${boxInfo.length} files on the form`);

      // arm CDP response capture for the POST
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*downloadSpecDocs*", requestStage: "Response" }] });
      let captured = null;
      cdp.on("Fetch.requestPaused", async (ev) => {
        try {
          const body = await cdp.send("Fetch.getResponseBody", { requestId: ev.requestId });
          const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "utf8");
          captured = bytes;
          const headers = (ev.responseHeaders || []).map((h) => ({ name: h.name, value: h.value }));
          headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
          await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: ev.responseStatusCode || 200, responseHeaders: headers, body: body.base64Encoded ? body.body : Buffer.from(body.body, "utf8").toString("base64") });
        } catch (e) { try { await cdp.send("Fetch.continueRequest", { requestId: ev.requestId }); } catch {} }
      });
      await p.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => /download documents/i.test((x.textContent || "").trim())); if (b) b.click(); else { const f = document.getElementById("spec"); if (f) f.submit(); } });
      for (let w = 0; w < 20 && !captured; w++) await p.waitForTimeout(1000);
      try { await cdp.detach(); } catch {}
      if (!captured || captured.length < 2000) { console.log(`${t.ocid}: capture empty`); continue; }
      if (captured.slice(0, 2).toString() !== "PK") { console.log(`${t.ocid}: capture not a zip`); continue; }

      const files = unzipSync(captured);
      const names = Object.keys(files).filter((n) => !n.endsWith("/"));
      if (DRY) { console.log(`${t.ocid}: DRY — ${names.length} files would be stored`); continue; }
      const { error: be } = await sb.storage.createBucket(VIC_BUCKET, { public: false });
      if (be && !/already exists|duplicate/i.test(be.message)) warn("bucket: " + be.message);

      // optimistic read-modify-write, never bumps updated_at
      let persisted = false;
      for (let i = 0; i < 3; i++) {
        const { data: row } = await sb.from("vula_tenders").select("data,updated_at").eq("ocid", t.ocid).maybeSingle();
        if (!row?.data) break;
        const storedDocs = [];
        const base = row.data;
        for (let fi = 0; fi < names.length; fi++) {
          const name = names[fi].split("/").pop();
          const key = vicStorageKey(t.ocid, fi, name);
          const bytes = files[names[fi]];
          const { error: ue } = await sb.storage.from(VIC_BUCKET).upload(key, bytes, { contentType: contentTypeFor(name), upsert: true });
          if (ue) { console.log("  upload err:", String(ue.message).slice(0, 60)); continue; }
          storedDocs.push({ title: name.replace(/\.[a-z0-9]{2,4}$/i, ""), url: base.sourceDetailUrl || `https://www.tenders.vic.gov.au/tender/view?id=${id}`, format: (name.match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toUpperCase().slice(0, 4) || "FILE", type: "Tender document (public)", vicFile: key, vicName: name });
        }
        if (!storedDocs.length) break;
        const next = mergeEnriched({ docs: storedDocs.map((d) => ({ ...d, vicFile: d.vicFile })) }, base, new Date().toISOString());
        const nextData = { ...base, docs: next.docs, contact: next.contact, addendum: next.addendum, timeline: next.timeline, vicDocsCheckedAt: new Date().toISOString(), vicDocsSig: vicSignature(storedDocs.map((d) => ({ name: d.vicName, size: d.vicSize }))) };
        const { data: hit, error: ue2 } = await sb.from("vula_tenders").update({ data: nextData }).eq("ocid", t.ocid).eq("updated_at", row.updated_at).select("ocid");
        if (!ue2 && hit?.length) { persisted = true; stored += storedDocs.length; packs++; break; }
      }
      if (persisted) console.log(`${t.ocid}: stored ${"pack"} ok`);
      else console.log(`${t.ocid}: optimistic persist failed after retries`);
    } catch (e) { console.log(`${t.ocid}: err ${String(e.message).slice(0, 70)}`); }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`VIC done: ${packs} packs, ${stored} files stored`);
} finally {
  try { await fetch(`https://api.browser.tinyfish.ai/${sess.session_id}`, { method: "DELETE", headers: { "X-API-Key": E.TINYFISH_KEY } }); } catch {}
}
process.exit(0);
