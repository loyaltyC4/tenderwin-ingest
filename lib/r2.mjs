// Cloudflare R2 document store (2026-11-20). 10 GB free, no download fees, S3-compatible.
// Used for tender documents so the 1 GB Supabase plan only has to hold the database.
// Env: R2_ACCOUNT_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_DOCS_BUCKET. Server-only; never import in client code.
import { AwsClient } from 'aws4fetch';

let client;
export const r2Enabled = () => !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ENDPOINT && process.env.R2_DOCS_BUCKET);
const aws = () => (client ||= new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }));
const base = () => `${String(process.env.R2_ACCOUNT_ENDPOINT).replace(/\/$/, '')}/${process.env.R2_DOCS_BUCKET}`;
const objUrl = (key) => `${base()}/${String(key).split('/').map(encodeURIComponent).join('/')}`;

export async function r2Put(key, bytes, contentType = 'application/octet-stream') {
  const r = await aws().fetch(objUrl(key), { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType } });
  if (!r.ok) throw new Error(`r2_put_${r.status}`);
}
// Returns the raw Response (stream) so callers can pipe it; 404 means gone.
export const r2Get = (key, signal) => aws().fetch(objUrl(key), { signal });
export async function r2Delete(key) {
  const r = await aws().fetch(objUrl(key), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`r2_delete_${r.status}`);
}
// -> [{ key, size }] for every object under a prefix.
export async function r2List(prefix = '') {
  const out = []; let token = '';
  for (let i = 0; i < 200; i++) {
    const q = `list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const r = await aws().fetch(`${base()}?${q}`);
    if (!r.ok) throw new Error(`r2_list_${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1]; const s = Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] || 0);
      if (k) out.push({ key: k.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), size: s });
    }
    token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] || '';
    if (!token) break;
  }
  return out;
}
