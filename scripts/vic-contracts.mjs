// Buying for Victoria CONTRACT REGISTER -> vula_awards (state-level award values).
// Public data (no login): tenders.vic.gov.au/contract/search lists awarded contracts with
// Total Value; the detail page carries Public Body (buyer), Suppliers, UNSPSC and dates.
// Driven through the TinyFish cloud browser (VIC's CDN blocks datacenter IPs).
//
// env: TINYFISH_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY  VIC_CONTRACTS_LIMIT (details/run, default 60)
// run: node scripts/vic-contracts.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const E = process.env;
const LIMIT = Number(E.VIC_CONTRACTS_LIMIT || 60);
const START_FROM = E.VIC_CONTRACTS_FROM || "01/01/2025";
if (!E.TINYFISH_KEY || !E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) { console.error("missing env"); process.exit(1); }
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSession() {
  for (const f of [E.VIC_SESSION_FILE].filter(Boolean)) {
    try {
      const s = JSON.parse((await import("fs")).readFileSync(f, "utf8"));
      const b = await chromium.connectOverCDP(s.cdp_url, { timeout: 30000 }).catch(() => null);
      if (b) { console.log("reused cloud session"); return b; }
    } catch {}
  }
  const r = await fetch("https://api.browser.tinyfish.ai", { method: "POST", headers: { "X-API-Key": E.TINYFISH_KEY, "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("tinyfish session failed " + r.status);
  const s = await r.json();
  console.log("new cloud session:", s.session_id);
  return chromium.connectOverCDP(s.cdp_url, { timeout: 90000 });
}

const num = (s) => { const n = Number(String(s ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const clean = (s) => String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const browser = await openSession();
const ctx = browser.contexts()[0];
const p = ctx.pages()[0] || await ctx.newPage();
let stored = 0, checked = 0;

try {
  // Monthly windows: the register has no pager links, so narrow searches are the only way
  // to see everything (each month returns <25 rows, the page size).
  const rows = [];
  const fromYM = E.VIC_CONTRACTS_FROM_YM || "2025-01";
  const [fy, fm] = fromYM.split("-").map(Number);
  const now = new Date();
  for (let y = fy, m = fm; y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1); m++) {
    if (m > 12) { m = 1; y++; }
    const from = `01/${String(m).padStart(2, "0")}/${y}`;
    const last = new Date(y, m, 0).getDate();
    const to = `${String(last).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
    await p.goto(`https://www.tenders.vic.gov.au/contract/search?minCost=1&startDateFrom=${encodeURIComponent(from)}&startDateTo=${encodeURIComponent(to)}`, { timeout: 90000, waitUntil: "load" }).catch(() => {});
    await p.waitForTimeout(2200);
    const pageRows = await p.evaluate(() => Array.from(document.querySelectorAll("table tbody tr")).map((tr) => {
      const a = tr.querySelector("a[href*='/contract/view?id=']");
      const tds = Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.replace(/\s+/g, " ").trim());
      return { href: a ? a.getAttribute("href") : "", cells: tds };
    }).filter((r) => r.href));
    if (pageRows.length) console.log(`  ${y}-${String(m).padStart(2, "0")}: ${pageRows.length} rows`);
    rows.push(...pageRows);
    if (rows.length > 400) break;
  }
  const uniq = [...new Map(rows.map((r) => [r.href, r])).values()];
  console.log(`list rows: ${rows.length} (unique ${uniq.length})`);

  for (const row of uniq) {
    if (stored >= LIMIT) break;
    const id = (row.href.match(/id=(\d+)/) || [])[1];
    if (!id) continue;
    const ocid = `vic-contracts-${id}`;
    const { data: exists } = await sb.from("vula_awards").select("ocid").eq("ocid", ocid).maybeSingle();
    if (exists) continue;
    checked++;
    try {
      await p.goto(`https://www.tenders.vic.gov.au/contract/view?id=${id}`, { timeout: 90000, waitUntil: "load" });
      await p.waitForTimeout(1200);
      const d = await p.evaluate(() => {
        const t = document.body.innerText.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
        const grab = (re) => { const m = t.match(re); return m ? m[1].trim() : ""; };
        return {
          number: grab(/Contract Number\s+([A-Z0-9\-\/]+)/i),
          title: grab(/Title\s+([^\n]{3,140})/i),
          publicBody: grab(/Public Body\s+([^\n]{2,90})/i),
          suppliers: (t.match(/Suppliers?\s+([\s\S]{0,200}?)State Government of Victoria/) || [])[1] || "",
          value: grab(/Total Value of the Contract\s+\$\s?([\d,]+(?:\.\d{2})?)/i),
          start: grab(/Starting Date\s+([\d]{1,2}\s+\w+\s+\d{4})/i),
          expiry: grab(/Expiry Date\s+([\d]{1,2}\s+\w+\s+\d{4})/i),
          status: grab(/Status\s+(\w+)/i),
          type: grab(/Type\s+([^\n]{2,60})/i),
          category: grab(/UNSPSC\s+([^\n]{2,80})/i),
        };
      });
      const value = num(d.value);
      if (!value) { console.log(`  ${id}: no value, skip`); continue; }
      const supplier = clean(d.suppliers)
        .replace(/^Information\s*\d*\s*/i, "")
        .replace(/^\d+\s+/, "")
        .split(/\bABN\b|\bACN\b/i)[0]
        .replace(/[,\s]+$/, "")
        .slice(0, 120);
      const rowOut = {
        ocid, award_id: ocid,
        buyer: clean(d.publicBody) || null,
        supplier: supplier || null,
        province: "VIC",
        category: d.category ? `UNSPSC ${d.category}`.slice(0, 80) : null,
        value, currency: "AUD",
        award_date: d.start ? new Date(d.start).toISOString().slice(0, 10) : null,
        title: clean(d.title) || clean(row.cells[1]) || null,
        status: /current/i.test(d.status) ? "active" : (d.status || null).toLowerCase() || null,
        data: { source: "vic-contracts", contractNumber: d.number || row.cells[0], type: d.type || null, expiry: d.expiry || null, url: `https://www.tenders.vic.gov.au/contract/view?id=${id}` },
      };
      const { error } = await sb.from("vula_awards").upsert(rowOut, { onConflict: "ocid,award_id" });
      if (error) console.log(`  ${id}: upsert err ${error.message.slice(0, 60)}`);
      else { stored++; console.log(`  ${id}: ${rowOut.buyer || "?"} | ${rowOut.supplier || "?"} | A$${value.toLocaleString()}`); }
    } catch (e) { console.log(`  ${id}: err ${String(e.message).slice(0, 60)}`); }
    await sleep(400);
  }
  console.log(`DONE: checked ${checked}, stored ${stored}`);
} finally {
  try { await ctx.close(); } catch {}
  try { await fetch(`https://api.browser.tinyfish.ai/${E.VIC_SESSION_ID || ""}`, { method: "DELETE", headers: { "X-API-Key": E.TINYFISH_KEY } }); } catch {}
}
process.exit(0);
