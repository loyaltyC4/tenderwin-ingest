// Buying for Victoria (tenders.vic.gov.au / Consolidated Tenders) document helpers.
// VIC hands files only to a logged-in supplier, and both the portal and its CDN block datacenter
// IPs (Cloudflare) — so the scheduled runner (scripts/vic-docs.mjs) drives a TinyFish cloud browser
// through the login + download flow, captures the pack ZIP via CDP response interception, stores the
// files in the private `vic-docs` Storage bucket and writes `docs` rows carrying `vicFile`
// (see enrich.mjs isPortalFile). The site then streams them to signed-in TenderWin users.
//
// COPY NOTICE: also lives in bidcheck-au/lib so the tests can run there. Keep byte-identical.

const txt = (s) => String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// VIC view URL from an ocid ("vic-tendersearch-334124" -> 334124).
export const vicViewId = (ocid) => (String(ocid || "").match(/^vic-tendersearch-(\d+)$/) || [])[1] || "";

// Identity of a pack: changes when a file is added, removed or re-versioned (an addendum).
export const vicSignature = (files) => (files || []).map((f) => `${f.name}|${f.size || ""}`).sort().join("\n");

// Storage object key (mirrors waStorageKey).
export const vicStorageKey = (ocid, index, name) => `${ocid}/${index}-${String(name).replace(/[^\w.\- ]+/g, "_")}`;

// docs row carried on the tender (waFile pattern -> vicFile).
export function buildVicRows(ocid, files) {
  return (files || []).map((f, i) => ({
    title: f.name, url: f.url || `https://www.tenders.vic.gov.au/tender/view?id=${vicViewId(ocid)}`,
    format: (f.name.match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toUpperCase().slice(0, 4) || "FILE",
    type: "Tender document (public)", source: "vic-tendersearch",
    vicFile: vicStorageKey(ocid, i, f.name), vicName: f.name, vicSize: f.size || 0,
  }));
}

export const VIC_BUCKET = "vic-docs";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function contentTypeFor(name) {
  const ext = String(name || "").match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const map = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip", txt: "text/plain" };
  return map[ext] || "application/octet-stream";
}

export function contentDisposition(name, fallback) {
  return `attachment; filename="${String(name || fallback).replace(/[^\w.\- ()]+/g, "_").slice(0, 120)}"`;
}

// Due-list picker (mirrors pickWaDue): soonest-closing first.
export function pickVicDue(rows, { now = Date.now(), limit = 1000 } = {}) {
  return (rows || []).filter(Boolean).sort((a, b) => (Date.parse(a.closes) || Infinity) - (Date.parse(b.closes) || Infinity)).slice(0, limit);
}
