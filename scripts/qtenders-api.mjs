// QLD QTenders — full collector on the site's own public API.
// Replaces the Playwright card-scrape (which only ever saw the first rendered page → 112 rows).
//
//   POST https://qtenders.hpw.qld.gov.au/api/search/tenders  {"pageNumber":N,"pageSize":50}
//   -> { tenders:[{id,title,businessName,buyersReference,opens,closes,details,
//                  tenderPreviewUrl,tenderStatus,isOpen,isClosed,categories,locations,...}],
//        totalCount,pageNumber,pageSize,totalPages,hasNextPage }
//
// Status filters are ignored server-side (always 2,170), so we page through everything and keep
// what we want locally. Read-only, no auth.
//
// env: QLD_MODE=open|all (default open)   QLD_OUT=path (optional JSON dump)
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const API = "https://qtenders.hpw.qld.gov.au/api/search/tenders";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// The API throttles/500s under sustained paging: retry with backoff, keep whatever we got.
async function fetchAll(pageSize = 50, maxPages = 80) {
  const all = [];
  let page = 1;
  let total = null;
  const failed = [];
  while (page <= maxPages) {
    let d = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { d = await pageOnce(page, pageSize); break; }
      catch (e) {
        if (attempt === 4) failed.push("p" + page + ":" + e.message);
        else await sleep(1500 * attempt * attempt);
      }
    }
    if (!d) { page++; continue; }
    total = d.totalCount ?? total;
    const rows = d.tenders || [];
    all.push(...rows);
    if (!rows.length || !d.hasNextPage) break;
    page++;
    await sleep(350);
  }
  return { rows: all, total, failed };
}

export function mapQldApiRow(t, observedAt = new Date().toISOString()) {
  const id = String(t.id);
  const closes = t.closes ? String(t.closes).slice(0, 19) : null;
  const opens = t.opens ? String(t.opens).slice(0, 19) : null;
  const ocid = "qld-qtenders-" + id;
  return {
    ocid,
    title: (t.title || "").slice(0, 240),
    buyer: t.businessName || t.issuerName || null,
    province: "QLD",
    category: (t.categories || [])[0] || null,
    value: null,
    published: opens,
    closes,
    status: String(t.tenderStatus || "").toLowerCase() === "open" ? "active" : String(t.tenderStatus || "").toLowerCase() || null,
    data: {
      ocid, source: "qld-qtenders",
      ref: t.buyersReference || t.vpReference || id,
      title: t.title, buyer: t.businessName || t.issuerName || null,
      province: "QLD", category: (t.categories || [])[0] || null,
      categories: t.categories || [], locations: t.locations || [],
      productsServices: t.productsServices || [],
      published: opens, closes, status: t.tenderStatus || null,
      isOpen: !!t.isOpen, isClosed: !!t.isClosed,
      description: (t.details || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000),
      url: t.tenderPreviewUrl || ("https://qtenders.hpw.qld.gov.au/tender/" + id),
      sourceDetailUrl: t.tenderPreviewUrl || null,
      sourceUrl: "https://qtenders.hpw.qld.gov.au/search?keywords=",
      sourceObservedAt: observedAt,
      awardedSuppliers: t.awardedSuppliers || null,
      docs: [],
    },
    updated_at: observedAt,
  };
}

const isMain = import.meta.url === "file://" + process.argv[1];
if (isMain) {
  const mode = process.env.QLD_MODE || "open";
  const { rows, total, failed } = await fetchAll();
  if (failed.length) console.log("partial: " + failed.length + " page(s) failed -> " + failed.slice(0, 3).join(", "));
  const now = Date.now();
  const mapped = rows.map((t) => mapQldApiRow(t));
  const keep = mode === "all" ? mapped
    : mapped.filter((r) => r.data.isOpen && (!r.closes || Date.parse(r.closes) > now));
  console.log("fetched " + rows.length + "/" + total + " | kept " + keep.length + " (mode=" + mode + ")");
  console.log("quality: buyer " + keep.filter((r) => r.buyer).length + "/" + keep.length +
    " | close date " + keep.filter((r) => r.closes).length + "/" + keep.length);
  if (process.env.QLD_OUT) {
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.QLD_OUT, JSON.stringify(keep, null, 1));
    console.log("wrote " + process.env.QLD_OUT);
  }
}
