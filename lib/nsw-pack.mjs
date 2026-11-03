// NSW tender-pack reader (ingest side, runs on the GitHub runner).
//
// buy.nsw publishes every opportunity's full document pack as a public zip on S3
// ("Download opportunity package"), linked from the detail page with a presigned URL
// that expires after an hour. This module fetches the detail page, downloads the zip,
// pulls readable text out of the documents that matter (the RFT, conditions,
// schedules, forms), and stores that text in Supabase Storage. The files themselves
// are never kept. The AI read happens later on Vercel (lib/pack-read.js), which holds
// the free model key; the runner only needs to reach buy.nsw.
import { inflateRawSync } from 'zlib';
import { docxText } from './docx-text.js';
import { getDetail } from './nsw-etendering.mjs';

export const PACK_BUCKET = 'tender-packs';
const S3_HOST = 'nsw-procurement-hub-documents-production.s3.amazonaws.com';
const MAX_ZIP_BYTES = 150 * 1024 * 1024; // a pack bigger than this is mostly drawings
const MAX_FILE_BYTES = 15 * 1024 * 1024;  // one document; bigger files are drawings or scans
const MAX_DOCS = 10;
const MAX_CHARS = 200000;                 // stored text per pack, all documents together

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (h) => decode(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|tr|section)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Document links on a detail page (raw HTML, or markdown when it came through TinyFish).
// -> { packageUrl, files: [{ title, sizeKb }] }. The S3 links are presigned and short-lived,
// so only the package URL is used, straight away, and file titles are kept without URLs.
export function parseNswDocLinks(page) {
  const s = String(page || '');
  const links = [];
  for (const m of s.matchAll(/href="(?:https?:)?\/+([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) links.push({ url: `https://${decode(m[1])}`, text: strip(m[2]) });
  // Markdown links, with absolute, protocol-relative or "https:////" URLs (TinyFish renders all three).
  for (const m of s.matchAll(/\[([^\]]+)\]\(((?:https?:)?\/*[^)\s]+)\)/g)) links.push({ url: `https://${decode(m[2]).replace(/^(?:https?:)?\/+/, '')}`, text: m[1].trim() });
  const onS3 = links.filter((l) => { try { return new URL(l.url).hostname === S3_HOST; } catch { return false; } });
  // Last resort: a bare package URL anywhere in the text.
  const bare = s.match(new RegExp(`${S3_HOST.replace(/\./g, '\\.')}/[^\\s"'<>)]*opportunity-package-[^\\s"'<>)]+`));
  const pkg = onS3.find((l) => /opportunity-package-[^/?]+\.zip/i.test(l.url)) || (bare ? { url: `https://${decode(bare[0])}` } : null);
  const files = onS3
    .filter((l) => l !== pkg && /\/prcOpportunity\//i.test(l.url))
    .map((l) => {
      const m = l.text.match(/^(.*?)\s*\((\d[\d,.]*)\s*KB\)\s*$/i);
      return { title: (m ? m[1] : l.text).trim().slice(0, 160), sizeKb: m ? Math.round(Number(m[2].replace(/,/g, ''))) : null };
    })
    .filter((f) => f.title);
  return { packageUrl: pkg ? pkg.url : null, files };
}

// The notice itself (description, project goals, eligibility, briefing, lodgement, criteria):
// often the clearest statement of the knock-out rules, and readable even when the pack is not.
export function parseNswNotice(page) {
  const t = strip(page);
  const a = t.search(/\bDescription\b/);
  const b = t.search(/Download opportunity package|Log in to respond/);
  const body = t.slice(a >= 0 ? a : 0, b > a ? b : undefined);
  return body.replace(/_{6,}/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

// ---- zip (stored + deflate, central directory; enough for portal packs) ----
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip_no_directory');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const fl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fl).toString('utf8');
    p += 46 + fl + el + cl;
    if (name.endsWith('/')) continue;
    out.push({
      name, size, method,
      read() {
        const lfl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
        const data = buf.slice(off + 30 + lfl + lel, off + 30 + lfl + lel + csize);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data);
        throw new Error(`zip_method_${method}`);
      },
    });
  }
  return out;
}

const base = (name) => name.split('/').pop();
// Which documents decide the bid. Drawings, survey and geotech reports, photos and the
// portal's own generic terms say nothing about returnables or knock-out rules.
const SKIP = /design documentation|drawing|(?:^|[^a-z])(dwg|ifc|ndd|byda)(?:[^a-z]|$)|photo|image|survey|geotech|report|appendix|site[\s_-]*plan|terms-and-conditions|quick reference guide|user guide/i;
const RFX = /(?:^|[^a-z])rf[tqpx](?:[^a-z]|$)|request[\s_-]*for[\s_-]*(tender|quot|proposal)/i;
const KEY = /request for (tender|quot|proposal)|invitation|conditions of (tender|contract)|specification|scope|statement of (work|requirements)|returnable|schedule|annexure|response|criteria|evaluation|declaration|form|questionnaire|pricing|tender document/i;
export function rankEntry(name, size) {
  const b = base(name);
  if (!/\.(pdf|docx|zip)$/i.test(b)) return -1;
  if (SKIP.test(name)) return -1;
  if (size > MAX_FILE_BYTES && !/\.zip$/i.test(b)) return -1;
  if (/^opportunity-[^/]*\.pdf$/i.test(b)) return 1; // buy.nsw's one-page summary: the notice covers it
  let score = 2;
  if (KEY.test(b) || RFX.test(b)) score += 4;
  if (RFX.test(b)) score += 4;
  if (/^\s*1[.\s_-]/.test(b)) score += 1; // packs number the main document first
  return score;
}

async function pdfPages(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => String(p || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  return pages.join('').trim().length >= 40 ? pages : null;
}

// Expand nested zips one level, rank, and read the best documents.
// -> { docs: [{ title, pages? , text? }], skipped: [{ title, why }] }
export async function readZipDocs(buf, { maxDocs = MAX_DOCS, maxChars = MAX_CHARS } = {}) {
  let entries = zipEntries(buf);
  const inner = entries.filter((e) => /\.zip$/i.test(e.name) && rankEntry(e.name, e.size) >= 0);
  for (const z of inner) {
    try { entries = entries.concat(zipEntries(z.read()).map((e) => ({ ...e, name: `${base(z.name)}/${e.name}` }))); } catch { /* unreadable inner zip */ }
  }
  const ranked = entries
    .filter((e) => !/\.zip$/i.test(e.name))
    .map((e) => ({ e, score: rankEntry(e.name, e.size) }))
    .sort((a, b) => b.score - a.score || a.e.size - b.e.size);
  const docs = [], skipped = [];
  let chars = 0;
  for (const { e, score } of ranked) {
    const title = base(e.name);
    if (score < 0) { skipped.push({ title, why: /\.(pdf|docx)$/i.test(title) ? 'not a bid document (drawing, report or generic terms)' : 'file type not read' }); continue; }
    if (docs.length >= maxDocs || chars >= maxChars) { skipped.push({ title, why: 'over the reading budget' }); continue; }
    try {
      const bytes = e.read();
      if (/\.docx$/i.test(title)) {
        const text = docxText(bytes).replace(/\n{3,}/g, '\n\n').trim();
        if (text.length > 80) { docs.push({ title, text: text.slice(0, maxChars - chars) }); chars += Math.min(text.length, maxChars - chars); }
        else skipped.push({ title, why: 'no readable text' });
      } else {
        const pages = await pdfPages(bytes);
        if (!pages) { skipped.push({ title, why: 'scanned pages, no readable text' }); continue; }
        const kept = [];
        for (const pg of pages) { if (chars >= maxChars) break; kept.push(pg); chars += pg.length; }
        docs.push({ title, pages: kept });
      }
    } catch (err) { skipped.push({ title, why: `unreadable (${String(err?.message || err).slice(0, 40)})` }); }
  }
  return { docs, skipped };
}

async function download(url, { timeoutMs = 120000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`pack_http_${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP_BYTES) throw new Error('pack_too_large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error('pack_too_large');
  return buf;
}

// Read one tender: detail page -> notice + package -> text. Never stores anything.
export async function readNswPack(portalId, { timeoutMs = 20000 } = {}) {
  const { html, via } = await getDetail(portalId, { timeoutMs });
  const { packageUrl, files } = parseNswDocLinks(html);
  const notice = parseNswNotice(html);
  const docs = notice ? [{ title: 'buy.nsw notice', text: notice }] : [];
  let skipped = [], bytes = 0, why = null;
  if (packageUrl) {
    try {
      const buf = await download(packageUrl);
      bytes = buf.length;
      const r = await readZipDocs(buf);
      docs.push(...r.docs); skipped = r.skipped;
    } catch (e) { why = String(e?.message || e).slice(0, 60); }
  } else why = 'no_package_link';
  return { files, docs, skipped, bytes, why, via };
}

let bucketReady = false;
async function ensureBucket(sb) {
  if (bucketReady) return;
  const { error } = await sb.storage.createBucket(PACK_BUCKET, { public: false });
  if (error && !/exist/i.test(error.message || '')) throw new Error(`pack_bucket_${error.message}`.slice(0, 60));
  bucketReady = true;
}

// Read up to `max` open NSW tenders whose pack has not been read, newest first, and store
// the text at tender-packs/nsw/<portalId>.json. The row gets data.pack = { path, files, ... }
// so the site knows a read is possible. Failures are recorded on the row and retried
// once a day, three times at most.
export async function readNswPacks(sb, { max = 20, budgetMs = 6 * 60 * 1000 } = {}) {
  const started = Date.now();
  const { data: rows, error } = await sb.from('vula_tenders').select('ocid,data')
    .like('ocid', 'ocds-nsw-%').gte('closes', new Date().toISOString())
    .order('published', { ascending: false }).limit(1000);
  if (error) throw new Error('pack_queue_read_failed');
  const dayAgo = Date.now() - 20 * 3600 * 1000;
  const due = (rows || []).filter(({ data: d }) => d?.portalId && !(d.pack?.path && d.pack?.docsRead)
    && (d.pack?.attempts || 0) < 3 && !(d.pack?.triedAt && Date.parse(d.pack.triedAt) > dayAgo)).slice(0, max);
  await ensureBucket(sb);
  const out = { due: due.length, stored: 0, failed: 0, firstError: null };
  for (const { ocid, data } of due) {
    if (Date.now() - started > budgetMs) break;
    const now = new Date().toISOString();
    let pack;
    try {
      const r = await readNswPack(data.portalId);
      const readable = r.docs.filter((d) => d.title !== 'buy.nsw notice').length;
      const path = `nsw/${data.portalId}.json`;
      const body = JSON.stringify({ ocid, portalId: data.portalId, readAt: now, files: r.files, docs: r.docs, skipped: r.skipped });
      const { error: upErr } = await sb.storage.from(PACK_BUCKET).upload(path, Buffer.from(body), { contentType: 'application/json', upsert: true });
      if (upErr) throw new Error(`pack_upload_${upErr.message}`.slice(0, 60));
      const read = r.docs.filter((d) => d.title !== 'buy.nsw notice').slice(0, 12).map((d) => ({ title: d.title, pages: Array.isArray(d.pages) ? d.pages.length : null }));
      pack = { path, files: r.files, read, docsRead: readable, skipped: r.skipped.length, packMb: Math.round(r.bytes / 1048576), readAt: now, why: r.why, via: r.via,
        // Nothing readable is retried like a failure: once a day, three times at most.
        ...(readable ? {} : { attempts: (data.pack?.attempts || 0) + 1, triedAt: now }) };
      out.stored++;
    } catch (e) {
      const why = String(e?.message || e).slice(0, 60);
      pack = { attempts: (data.pack?.attempts || 0) + 1, triedAt: now, why };
      out.failed++; out.firstError = out.firstError || `${data.portalId}:${why}`;
    }
    // Merge into the latest row so a concurrent list scan is not overwritten.
    const { data: cur } = await sb.from('vula_tenders').select('data').eq('ocid', ocid).maybeSingle();
    if (cur?.data) await sb.from('vula_tenders').update({ data: { ...cur.data, pack } }).eq('ocid', ocid);
  }
  return out;
}
