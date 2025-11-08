// lib/auth.ts
// -------------------------------------------------------------
// Password hashing (PBKDF2), constant-time verify,
// minimal auth guards, and signed tokens for:
// - email verification
// - password reset
// Includes thin helpers that send localized emails via lib/mail.ts
// -------------------------------------------------------------

import { sendVerifyEmail, sendResetEmail } from "./mail.ts";

/* ===================== PBKDF2 (unchanged) ===================== */
const ITERATIONS = 120_000;
const KEY_LEN = 32;
const ALGO = "SHA-256";

function toUint8(s: string) { return new TextEncoder().encode(s); }

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations = ITERATIONS, length = KEY_LEN) {
  const key = await crypto.subtle.importKey("raw", toUint8(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: ALGO, salt, iterations }, key, length * 8);
  return new Uint8Array(bits);
}
function constTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false; let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(plain, salt);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(dk)}`;
}
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!iterations || !saltB64 || !hashB64) return false;
    const salt = fromB64url(saltB64);
    const expected = fromB64url(hashB64);
    const got = await pbkdf2(plain, salt, iterations, expected.length);
    return constTimeEqual(got, expected);
  } catch { return false; }
}

/* ===================== Simple guards (unchanged) ===================== */
export function requireAuth(ctx: any) {
  if (!ctx.state.user) { ctx.response.redirect("/login"); return false; }
  return true;
}
export function requireOwner(ctx: any) {
  if (!ctx.state.user || ctx.state.user.role !== "owner") {
    ctx.response.status = 403; ctx.response.body = "Forbidden"; return false;
  }
  return true;
}

/* ===================== Signed tokens (new) ===================== */
/**
 * We sign compact tokens using HMAC-SHA256 over:
 * base64url(JSON payload) + "." + iat + "." + rnd
 * Token format (all base64url-safe, joined by "."):
 *   payloadB64 . iatB64 . rndB64 . sigB64
 *
 * Payload example:
 * { t: "verify" | "reset", uid: string, em: string, exp: number, iat: number, rnd: string }
 */
const AUTH_TOKEN_SECRET = (Deno.env.get("AUTH_TOKEN_SECRET") || "").trim();
function requireSecret(): Uint8Array {
  if (!AUTH_TOKEN_SECRET) {
    throw new Error("AUTH_TOKEN_SECRET is missing. Set a strong secret in env.");
  }
  return toUint8(AUTH_TOKEN_SECRET);
}

type TokenType = "verify" | "reset";
type TokenPayload = {
  t: TokenType;       // token type
  uid: string;        // user id
  em: string;         // user email (normalized lower-case)
  exp: number;        // unix seconds
  iat: number;        // unix seconds
  rnd: string;        // random entropy tag
};

function nowSec(): number { return Math.floor(Date.now() / 1000); }
function normEmail(e: string): string { return String(e || "").trim().toLowerCase(); }

async function hmacSign(parts: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", requireSecret(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, toUint8(parts));
  return b64url(sig);
}

async function hmacVerify(parts: string, sigB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", requireSecret(), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  try {
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sigB64), toUint8(parts));
    return ok;
  } catch {
    return false;
  }
}

export async function makeAuthToken(
  type: TokenType,
  userId: string,
  email: string,
  ttlSeconds = type === "verify" ? 60 * 60 * 24 * 7 : 60 * 60 * 2, // verify: 7d, reset: 2h
): Promise<string> {
  const iat = nowSec();
  const exp = iat + Math.max(60, ttlSeconds);
  const rnd = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const payload: TokenPayload = {
    t: type,
    uid: String(userId),
    em: normEmail(email),
    exp,
    iat,
    rnd,
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const iatB64 = b64url(toUint8(String(iat)));
  const rndB64 = b64url(toUint8(rnd));
  const toSign = `${payloadB64}.${iatB64}.${rndB64}`;
  const sig = await hmacSign(toSign);
  return `${toSign}.${sig}`;
}

export function parseAuthTokenUnsafe(token: string): TokenPayload | null {
  try {
    const [pB64, iB64, rB64] = token.split("."); // ignore sig here
    const json = new TextDecoder().decode(fromB64url(pB64));
    const obj = JSON.parse(json) as TokenPayload;
    if (!obj || !obj.t || !obj.uid || !obj.em) return null;
    return obj;
  } catch { return null; }
}

export async function verifyAuthToken(token: string, expectedType: TokenType): Promise<null | TokenPayload> {
  try {
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [pB64, iB64, rB64, sigB64] = parts;
    const toSign = `${pB64}.${iB64}.${rB64}`;
    const ok = await hmacVerify(toSign, sigB64);
    if (!ok) return null;

    const payloadJson = new TextDecoder().decode(fromB64url(pB64));
    const payload = JSON.parse(payloadJson) as TokenPayload;
    if (!payload || payload.t !== expectedType) return null;
    if (!payload.uid || !payload.em || !payload.exp || !payload.iat) return null;
    if (payload.exp < nowSec()) return null; // expired

    return payload;
  } catch {
    return null;
  }
}

/* ===================== Email triggers (new) ===================== */
/**
 * Call these from your routes:
 *   - On user signup: await sendVerificationEmailFor({ id, email }, lang)
 *   - On forgot password: await sendPasswordResetEmailFor({ id, email }, lang)
 *
 * The mail.ts will localize the content (he/en/ka) and inject ?lang=... to links.
 */

export async function sendVerificationEmailFor(
  user: { id: string; email: string },
  lang?: string | null,
) {
  const token = await makeAuthToken("verify", user.id, user.email);
  // mail.ts builds the proper /auth/verify?token=... URL and localizes by lang
  return await sendVerifyEmail(user.email, token, lang);
}

export async function sendPasswordResetEmailFor(
  user: { id: string; email: string },
  lang?: string | null,
) {
  const token = await makeAuthToken("reset", user.id, user.email);
  // mail.ts builds the proper /auth/reset?token=... URL and localizes by lang
  return await sendResetEmail(user.email, token, lang);
}

/* ===================== Small helper (optional) ===================== */
/**
 * Basic util to extract lang preference (keep in sync with your i18n mw if needed).
 * Use in routes if you don't already have ctx.state.lang.
 */
export function pickLangFrom(ctx: any): "he" | "en" | "ka" {
  const q = ctx?.request?.url?.searchParams?.get?.("lang");
  if (q === "en" || q === "ka" || q === "he") return q;
  const c = ctx?.cookies?.get?.("lang");
  if (c === "en" || c === "ka" || c === "he") return c;
  const al = ctx?.request?.headers?.get?.("accept-language") || "";
  if (/^en/i.test(al)) return "en";
  if (/^ka/i.test(al)) return "ka";
  return "he";
}
