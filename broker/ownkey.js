/* A visitor's own Tenki key. The site asks for one, and their machines run in their
 * workspace on their balance, so no house key or quota is spent on them.
 *
 * The broker has to act on those machines after the browser has gone (a seat splits,
 * a deadline passes, a machine is stopped), so it holds the key while they run. It is
 * only ever at rest sealed with AES-256-GCM under KEY_SEAL_SECRET, which lives in
 * broker/.env. It never enters a sandbox, a log line, or the browser's URL. */
import crypto from "node:crypto";

// Sent as x-visitor-key: Tenki's preview gateway strips x-tenki-* headers.
const VISITOR_KEY = /^tk_[A-Za-z0-9_-]{8,200}$/;

// The key as pasted, or "" when it isn't one. Quotes and whitespace around it are forgiven.
export const tidyKey = (raw) => {
  const s = typeof raw === "string" ? raw.trim().replace(/^["']|["']$/g, "").trim() : "";
  return VISITOR_KEY.test(s) ? s : "";
};

export const sealReady = () => (process.env.KEY_SEAL_SECRET || "").length >= 32;
const aesKey = () => crypto.createHash("sha256").update(`tenki-key:${process.env.KEY_SEAL_SECRET}`).digest();

// iv ‖ tag ‖ ciphertext, base64url, with a fresh iv every time.
export function sealKey(key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const enc = Buffer.concat([c.update(key, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

// The key back out, or "" for anything tampered with or sealed under another secret.
export function openKey(sealed) {
  try {
    const b = Buffer.from(String(sealed), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return tidyKey(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  } catch { return ""; }
}

// Tells one visitor's sessions from another's without keeping the key to compare.
export const keyId = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
