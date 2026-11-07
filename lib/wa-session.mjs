// Logged-in Tenders WA client for the ingest runner. Login = username + password, then an emailed token
// that scripts/wa-token.py reads from the supplier mailbox (read-only IMAP). Then the portal's own
// "Download for Tender Documents" flow. One session per run; paced by the caller.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWaFileList, waLoggedIn, parseNonceLink, parseRequestForm, parseRecipientsConsent } from "./wa-docs.mjs";

const ORIGIN = "https://www.tenders.wa.gov.au";
const B = `${ORIGIN}/watenders/`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const enc = (o) => new URLSearchParams(o).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WaSession {
  constructor() { this.jar = new Map(); }
  _store(r) { for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
  _cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async req(url, o = {}) {
    const u = url.startsWith("http") ? url : url.startsWith("/") ? ORIGIN + url : B + url;
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(60000), ...o, headers: { "User-Agent": UA, Cookie: this._cookie(), ...(o.headers || {}) } });
    this._store(r);
    return r;
  }
  // GET following redirects (a browser would), returns the final response
  async get(url, referer, hops = 6) {
    let r = await this.req(url, { headers: referer ? { Referer: referer } : {} });
    for (let i = 0; i < hops && r.status >= 300 && r.status < 400 && r.headers.get("location"); i++) {
      r = await this.req(new URL(r.headers.get("location"), B).toString(), { headers: referer ? { Referer: referer } : {} });
    }
    return r;
  }

  async login({ user, pass, gmailUser, gmailPass }) {
    if (!user || !pass || !gmailUser || !gmailPass) throw new Error("wa_not_configured");
    const t0 = Date.now() / 1000 - 5;
    const page = await (await this.req("tender/search/tender-search.action?action=advanced-tender-search-new-tenders")).text();
    const nonce = page.match(/var nonce = "(CSRFNONCE=[A-Z0-9]+)"/)?.[1];
    if (!nonce) throw new Error("wa_nonce_missing");
    const hdr = { ...FORM, "X-Requested-With": "XMLHttpRequest" };
    const base = { lfReferrer: "", lfCurrentPage: "", tenderDisplayId: "", submitResponse: "", username: user, password: pass };
    const v = (await (await this.req(`login.action?action=ajaxValidate&${nonce}`, { method: "POST", headers: hdr, body: enc(base) })).text()).trim();
    let body = enc(base);
    if (v === "MFA_REQUIRED") {
      let token = "";
      try {
        token = execFileSync("python3", [fileURLToPath(new URL("../scripts/wa-token.py", import.meta.url)), String(t0)], { encoding: "utf8", env: { ...process.env, GMAIL_USER: gmailUser, GMAIL_APP_PASS: gmailPass }, stdio: ["ignore", "pipe", "pipe"], timeout: 130000 }).trim();
      } catch (e) { throw new Error("wa_token_unavailable"); }
      body = enc({ ...base, mfaToken: token });
      const c = (await (await this.req(`login.action?action=ajaxConfirmToken&${nonce}`, { method: "POST", headers: hdr, body })).text()).trim();
      if (c !== "SUCCESS") throw new Error("wa_token_rejected");
    } else if (v !== "SUCCESS") {
      throw new Error(v === "PRIMARY_EMAIL_REQUIRED" ? "wa_primary_email_required" : "wa_login_rejected");
    }
    let r = await this.req(`login.action?action=login&${nonce}`, { method: "POST", headers: FORM, body });
    const trace = [`login ${r.status} ${(r.headers.get("location") || "").replace(/CSRFNONCE=\w+/, "N").slice(0, 80)}`];
    // The portal shows "confirm your details are current" after every login; the login is incomplete until it is submitted.
    const loc = r.headers.get("location") || "";
    if (/confirmContactDetails/.test(loc)) {
      const cp = await this.get(loc);
      const cn = (await cp.text()).match(/var nonce = "(CSRFNONCE=[A-Z0-9]+)"/)?.[1];
      r = await this.req(`info/confirmContactDetails.action?${cn}`, { method: "POST", headers: FORM, body: enc({ action: "correct", businessId: "" }) });
      trace.push(`confirm ${r.status} ${(r.headers.get("location") || "").replace(/CSRFNONCE=\w+/, "N").slice(0, 80)}`);
      if (r.headers.get("location")) await this.get(new URL(r.headers.get("location"), B).toString());
    }
    const cr = await this.get("tender/search/tender-search.action?action=advanced-tender-search-new-tenders");
    const check = await cr.text();
    if (!waLoggedIn(check)) throw new Error(`wa_login_incomplete (${trace.join("; ")}; check ${cr.status} ${check.length}b cookies=${[...this.jar.keys()].join(",")})`);
  }

  detailUrl(id) { return `${B}tender/display/tender-details.action?id=${id}&action=display-tender-details`; }

  // file names + versions for one tender (cheap, read-only)
  async fileList(id) {
    const r = await this.get(this.detailUrl(id));
    const html = await r.text();
    if (r.status !== 200 || !html) throw new Error("wa_detail_empty");
    if (!waLoggedIn(html)) throw new Error("wa_session_lost");
    return parseWaFileList(html);
  }

  // the portal's download flow -> the zip Buffer
  async downloadZip(id) {
    const ref = this.detailUrl(id);
    let r = await this.get(`tender/downloadspecs.action?id=${id}&method=downloadViaHTML`, ref);
    let html = await r.text();
    const link = parseNonceLink(html);
    if (link) { r = await this.get(link, ref); html = await r.text(); }
    // "your details will be published on the recipients list": submit with the box unticked (publicOk omitted)
    const consent = parseRecipientsConsent(html);
    if (consent) {
      r = await this.req(consent.action.startsWith("http") ? consent.action : ORIGIN + consent.action, { method: "POST", headers: { ...FORM, Referer: ref }, body: enc(consent.fields) });
      for (let i = 0; i < 5 && r.status >= 300 && r.status < 400 && r.headers.get("location"); i++) r = await this.req(new URL(r.headers.get("location"), B).toString(), { headers: { Referer: ref } });
      html = await r.text();
      const again = parseNonceLink(html); if (again) { r = await this.get(again, ref); html = await r.text(); }
    }
    const form = parseRequestForm(html);
    if (!form) throw new Error("wa_request_form_missing");
    const body = { action: "downloadViaHTML", psfId: form.psfId };
    for (let i = 0; i < form.count; i++) body[`documentRequested[${i}]`] = "true";
    const z = await this.req(ORIGIN + form.action, { method: "POST", headers: { ...FORM, Referer: ORIGIN + "/watenders/tender/request/request-spec-docs.action" }, body: enc(body) });
    if (z.status !== 200 || !/zip|octet/i.test(z.headers.get("content-type") || "")) throw new Error(`wa_download_${z.status}`);
    const buf = Buffer.from(await z.arrayBuffer());
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error("wa_not_a_zip");
    return buf;
  }
}
export { sleep };
