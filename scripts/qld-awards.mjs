// QLD awarded tenders from QTenders' own public search API:
//   POST https://qtenders.hpw.qld.gov.au/api/search/tenders {"pageNumber":N,"pageSize":50}
// Pages the whole corpus (status filters are ignored server-side), keeps only rows with
// tenderStatus=Awarded or a non-empty awardedSuppliers, and inserts them into vula_awards
// insert-only (ocid prefix ocds-qld-awards-, ON CONFLICT DO NOTHING). Open rows untouched.
//
// Writes go through the Supabase *management* SQL endpoint because the project's REST data
// plane is 402-restricted (egress quota); same database, service-role bypassed only in transport.
// env: QLD_OUT (optional JSON dump) · QLD_DRY=1 (collect only, no DB write)
// run: node scripts/qld-awards.mjs
import fs from "node:fs";
import os from "node:os";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const API = "https://qtenders.hpw.qld.gov.au/api/search/tenders";
// TenderWin lives in lwwahygviakbccwoqvfo (Sydney, "bidcheck AUS").
// dtjydsaoatddghbuqlyv is the SOUTH AFRICAN project — writing there is what put AU/NZ
// rows in the wrong database on 2026-11-14. Override only deliberately.
const PROJECT = process.env.TW_PROJECT_ID || "lwwahygviakbccwoqvfo";
const OCID_PREFIX = "ocds-qld-awards-";
const SOURCE = "qld-qtenders-awards";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mgmtToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const env = fs.readFileSync(`${os.homedir()}/AutoClaw/Shared/.secrets/keys.env`, "utf8");
  const m = env.match(/^SUPABASE_ACCESS_TOKEN=(.*)$/m);
  if (!m) throw new Error("no SUPABASE_ACCESS_TOKEN");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${mgmtToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`sql_http_${r.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body || "[]");
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const nil = (v) => (v == null || v === "" ? "null" : q(v));

async function pageOnce(page, pageSize) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ pageNumber: page, pageSize }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error("qld_api_http_" + r.status);
  return r.json();
}

// The API 500s under sustained paging: back off and keep whatever we got, never abort the sweep.
async function fetchAll(pageSize = 50, maxPages = 200) {
  const all = [];
  const failed = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    let d = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { d = await pageOnce(page, pageSize); break; }
      catch (e) {
        if (attempt === 4) failed.push(`p${page}:${e.message}`);
        else await sleep(1500 * attempt * attempt);
      }
    }
    if (!d) continue;
    total = d.totalCount ?? total;
    const rows = d.tenders || [];
    all.push(...rows);
    if (!rows.length || !d.hasNextPage) break;
    await sleep(350);
  }
  return { rows: all, total, failed };
}

// Money lives per supplier: awardedSuppliers[].priceExGst (ex-GST, sometimes 0). Sum the real
// ones; fall back to a top-level money field if the API ever adds one.
function awardValue(t) {
  const sum = (t.awardedSuppliers || []).reduce((acc, s) => {
    const n = Number(s?.priceExGst);
    return Number.isFinite(n) && n > 0 ? acc + n : acc;
  }, 0);
  if (sum > 0) return Math.round(sum * 100) / 100;
  for (const k of ["awardValue", "awardedValue", "contractValue", "awardAmount", "value", "amount"]) {
    const raw = t[k];
    const n = Number(String(raw?.amount ?? raw ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const supplierName = (s) => (typeof s === "string" ? s : s?.supplierName || s?.name || s?.businessName || null);

function mapRow(t, observedAt) {
  const id = String(t.id);
  const ocid = OCID_PREFIX + id;
  const buyer = t.businessName || t.issuerName || null;
  const cats = t.categories || [];
  const closes = t.closes ? String(t.closes).slice(0, 19) : null;
  const suppliers = (t.awardedSuppliers || []).map(supplierName).filter(Boolean);
  const value = awardValue(t);
  return {
    ocid,
    award_id: id + "-award",
    buyer,
    supplier: suppliers.length ? suppliers.join("; ").slice(0, 500) : null,
    suppliers: suppliers.length
      ? t.awardedSuppliers.map((s) => ({ name: supplierName(s), priceExGst: Number(s?.priceExGst) || null }))
      : null,
    province: "QLD",
    category: cats[0] || null,
    value,
    currency: value ? "AUD" : null,
    award_date: closes ? closes.slice(0, 10) : null,
    title: (t.title || "").slice(0, 240) || null,
    status: "awarded",
    data: {
      ocid,
      source: SOURCE,
      ref: t.buyersReference || t.vpReference || id,
      tenderStatus: t.tenderStatus || null,
      categories: cats,
      locations: t.locations || [],
      productsServices: t.productsServices || [],
      opened: t.opens ? String(t.opens).slice(0, 19) : null,
      closes,
      awardDateBasis: "tender_closes",
      valueBasis: value ? "sum(awardedSuppliers[].priceExGst), ex-GST" : null,
      awardedSuppliersRaw: t.awardedSuppliers || [],
      description: (t.details || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
      url: t.tenderPreviewUrl || `https://qtenders.hpw.qld.gov.au/tender/${id}`,
      sourceUrl: "https://qtenders.hpw.qld.gov.au/search?keywords=",
      sourceObservedAt: observedAt,
      docs: [],
    },
    updated_at: observedAt,
  };
}

async function existingOcids() {
  const out = new Set();
  for (let from = 0; ; from += 1000) {
    const rows = await sql(
      `select ocid from vula_awards where ocid like ${q(OCID_PREFIX + "%")} order by ocid limit 1000 offset ${from}`,
    );
    for (const r of rows) out.add(r.ocid);
    if (rows.length < 1000) break;
  }
  return out;
}

function insertSql(rows) {
  const cols = ["ocid", "award_id", "buyer", "supplier", "suppliers", "province", "category", "value", "currency", "award_date", "title", "status", "data", "updated_at"];
  const vals = rows.map((r) => `(${[
    q(r.ocid), q(r.award_id), nil(r.buyer), nil(r.supplier),
    r.suppliers ? `${q(JSON.stringify(r.suppliers))}::jsonb` : "null",
    q(r.province), nil(r.category), r.value ?? "null", nil(r.currency),
    r.award_date ? `${q(r.award_date)}::date` : "null", nil(r.title), q(r.status),
    `${q(JSON.stringify(r.data))}::jsonb`, q(r.updated_at),
  ].join(",")})`).join(",");
  return `insert into vula_awards (${cols.join(",")}) values ${vals} on conflict (ocid, award_id) do nothing returning ocid`;
}

const isMain = import.meta.url === "file://" + process.argv[1];
if (isMain) {
  const observedAt = new Date().toISOString();
  const { rows, total, failed } = await fetchAll();
  if (failed.length) console.log(`partial: ${failed.length} page(s) failed -> ${failed.slice(0, 3).join(", ")}`);

  const awarded = rows.filter((t) => String(t.tenderStatus || "").toLowerCase() === "awarded" || (t.awardedSuppliers || []).length);
  const mapped = awarded.map((t) => mapRow(t, observedAt));
  // one row per award: same tender id can appear across pages if the corpus shifts mid-sweep
  const byOcid = new Map(mapped.map((r) => [r.ocid, r]));
  const keep = [...byOcid.values()];
  const withValue = keep.filter((r) => r.value != null);
  const withSupplier = keep.filter((r) => r.supplier);

  console.log(`fetched ${rows.length}/${total ?? "?"} | awarded ${awarded.length} | kept ${keep.length} | with supplier ${withSupplier.length} | with value ${withValue.length}`);
  if (process.env.QLD_OUT) {
    fs.writeFileSync(process.env.QLD_OUT, JSON.stringify(keep, null, 1));
    console.log("wrote " + process.env.QLD_OUT);
  }
  if (process.env.QLD_DRY) process.exit(0);

  const have = await existingOcids();
  const fresh = keep.filter((r) => !have.has(r.ocid));
  console.log(`already present ${keep.length - fresh.length} | to insert ${fresh.length}`);

  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = fresh.slice(i, i + 200);
    const done = await sql(insertSql(batch));
    inserted += done.length;
    console.log(`  batch ${i / 200 + 1}: +${done.length} (running total ${inserted})`);
    await sleep(400);
  }
  const insertedValue = await sql(
    `select count(*)::int n from vula_awards where ocid like ${q(OCID_PREFIX + "%")} and value is not null`,
  );
  const insertedSup = await sql(
    `select count(*)::int n from vula_awards where ocid like ${q(OCID_PREFIX + "%")} and supplier is not null`,
  );
  console.log(`DONE fetched ${rows.length} | kept ${keep.length} | inserted ${inserted} | skipped ${keep.length - inserted} | value-bearing rows now ${insertedValue[0].n} | supplier-bearing rows now ${insertedSup[0].n}`);
}
