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
export function mergeEnriched(t, existing = {}, observedAt = new Date().toISOString()) {
  const tDocs = Array.isArray(t?.docs) && t.docs.length ? t.docs : null;
  const exDocs = Array.isArray(existing?.docs) && existing.docs.length ? existing.docs : null;
  const docs = tDocs || exDocs || [];
  const exKeys = new Set((exDocs || []).map((d) => d.url || d.title));
  const added = tDocs && exDocs ? tDocs.filter((d) => !exKeys.has(d.url || d.title)).length : 0;
  let addendum = existing?.addendum || null;
  if (tDocs && exDocs && added > 0) {
    addendum = { addedAt: observedAt, addedDocs: added, revisions: (existing?.addendum?.revisions || 0) + 1 };
  }
  const tc = t?.contact || {}, ec = existing?.contact || {};
  const contact = { name: tc.name || ec.name || '', email: tc.email || ec.email || '', phone: tc.phone || ec.phone || '' };
  const timeline = { ...(existing?.timeline || {}), ...(t?.timeline || {}) };
  return { docs, contact, addendum, timeline: Object.keys(timeline).length ? timeline : null };
}
