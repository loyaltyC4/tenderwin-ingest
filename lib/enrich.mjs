// Enrichment merge shared by the tender store-row mappers.
//
// List-page scans carry neither documents nor buyer contacts; those arrive from
// detail-page enrichment (or an earlier run) and must survive later list-only
// scans — an empty scan result must never erase what we already know.
//
// When a tender's document list grows between scans we stamp an `addendum`
// record: portals publish addenda as new files on the same notice, and no
// Australian aggregator surfaces that. `revisions` counts observed changes so
// the UI can say "3 addenda" and `addedAt` drives "Addendum added <date>".
//
// COPY NOTICE: this file exists in both bidcheck-au/lib and tenderwin-ingest/lib
// and MUST stay byte-identical — the ingest copy runs the scheduled scans, so a
// guard that exists only in the site copy protects nothing (that gap wiped every
// open AusTender file list and stamped 110 false "addendum" pills, Nov 2026).

// A "documents live on the portal" stub row (format "link"), not a real file.
export const isPlaceholderDoc = (d) => d?.format === "link";
// Rows written by the /api/documents routes: they carry the ids needed to stream bytes.
// waFile = a Tenders WA file the ingest runner downloaded and stored (WA gives files only to a logged-in supplier).
export const isPortalFile = (d) => !!(d && (d.vpFileId || d.atFile || d.waFile));

// Stable identity of a document row. File rows persisted by the document routes
// all share ONE portal url, so `url` alone cannot tell two files apart (it made
// every new attachment look "already seen").
export function docKey(d) {
  if (!d) return "";
  if (d.vpFileId) return `vp:${d.vpFileId}`;
  if (d.waFile) return `wa:${d.waName || d.title || ""}:${d.waVer || ""}`; // a new version of a file is a new key: that is an addendum
  if (d.atFile) return `at:${d.atDocType || ""}:${d.atAddendaId || ""}:${d.atName || d.title || ""}`;
  return d.url || d.title || "";
}

export function mergeEnriched(t, existing = {}, observedAt = new Date().toISOString()) {
  const tDocsRaw = Array.isArray(t?.docs) && t.docs.length ? t.docs : null;
  const exDocs = Array.isArray(existing?.docs) && existing.docs.length ? existing.docs : null;
  const exHasPortalFiles = !!exDocs && exDocs.some(isPortalFile);
  const exHasRealDocs = !!exDocs && exDocs.some((d) => isPortalFile(d) || !isPlaceholderDoc(d));

  // 1) Once the document routes have persisted real portal files, a list scan
  //    never replaces them — scans cannot produce portal file rows, so anything
  //    they carry is at best a stub or a coarser view of the same notice.
  // 2) A stub-only scan never clobbers any real file list either.
  const tDocs = tDocsRaw && exDocs && (
    (exHasPortalFiles && !tDocsRaw.some(isPortalFile))
    || (exHasRealDocs && tDocsRaw.every(isPlaceholderDoc))
  ) ? null : tDocsRaw;

  const docs = tDocs || exDocs || [];

  // An addendum is a REAL document we had not seen, on a notice where we already
  // held real documents. A stub turning into the first real list is a discovery,
  // not an addendum.
  let addendum = existing?.addendum || null;
  if (exDocs && !exHasRealDocs) addendum = null; // self-heal stamps left by the old stub-vs-file flip-flop
  if (tDocs && exHasRealDocs) {
    const exKeys = new Set(exDocs.filter((d) => !isPlaceholderDoc(d) || isPortalFile(d)).map(docKey));
    const added = tDocs.filter((d) => (!isPlaceholderDoc(d) || isPortalFile(d)) && !exKeys.has(docKey(d))).length;
    if (added > 0) {
      addendum = { addedAt: observedAt, addedDocs: added, revisions: (existing?.addendum?.revisions || 0) + 1 };
    }
  }
  const tc = t?.contact || {}, ec = existing?.contact || {};
  const contact = { name: tc.name || ec.name || '', email: tc.email || ec.email || '', phone: tc.phone || ec.phone || '' };
  const timeline = { ...(existing?.timeline || {}), ...(t?.timeline || {}) };
  return { docs, contact, addendum, timeline: Object.keys(timeline).length ? timeline : null };
}
