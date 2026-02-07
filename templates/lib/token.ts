// src/lib/token.ts
// יצירת/אימות טוקן חתום (HMAC-SHA256) לקישורי הזמנה מאובטחים + עמיד יותר לשינויים עתידיים

/** ---------------- Environment & Defaults ---------------- **/
const SECRET = (Deno.env.get("TOKEN_SECRET") ?? Deno.env.get("ADMIN_SECRET") ?? "").trim();
if (!SECRET) {
  console.warn("[token] WARNING: TOKEN_SECRET/ADMIN_SECRET not set. Tokens will be insecure!");
}
const DEFAULT_EXP_DAYS = Number(Deno.env.get("TOKEN_EXP_DAYS") ?? "14");
const CLOCK_SKEW_MS = Number(Deno.env.get("TOKEN_CLOCK_SKEW_MS") ?? "30000"); // 30s גרייס

/** גרסה (לרוטציות עתידיות של פורמט/אלגוריתם) */
const TOKEN_VERSION = 1;

/** ---------------- Types ---------------- **/
export type TokenPayload = {
  v: number;          // token version
  rid: string;        // reservation id
  email?: string;     // אימייל הלקוח (אופציונלי)
  exp: number;        // timestamp (ms) תוקף
};

/** ---------------- Base64url helpers ---------------- **/
function b64url(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return b64url(bytes);
}
function b64urlToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecodeToString(b64u: string): string {
  return new TextDecoder().decode(b64urlToBytes(b64u));
}

/** ---------------- HMAC helpers (with key caching) ---------------- **/
let _hmacKey: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  _hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return _hmacKey;
}
async function hmacSign(message: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}
async function hmacVerify(message: string, sigB64u: string): Promise<boolean> {
  const key = await getKey();
  const sigBytes = b64urlToBytes(sigB64u);
  return await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(message));
}

/** ---------------- Public API ---------------- **/

/**
 * צור טוקן חתום להזמנה.
 * @param rid מזהה הזמנה
 * @param email אימייל (אופציונלי, לצורך קידום אבטחה/בקרה)
 * @param expiresInDays זמן תוקף בימים (ברירת מחדל מתוך ENV או 14)
 */
export async function makeReservationToken(
  rid: string,
  email?: string,
  expiresInDays: number = DEFAULT_EXP_DAYS,
): Promise<string> {
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    rid,
    email,
    exp: Date.now() + Math.max(1, expiresInDays) * 24 * 60 * 60 * 1000,
  };
  const p = b64urlEncode(JSON.stringify(payload));
  const s = await hmacSign(p);
  return `${p}.${s}`;
}

/**
 * אמת טוקן והחזר payload אם תקין אחרת null.
 * בודק חתימה, גרסה, תוקף (עם CLOCK_SKEW_MS).
 */
export async function verifyReservationToken(token: string): Promise<TokenPayload | null> {
  try {
    const [p, s] = token.split(".");
    if (!p || !s) return null;

    // אימות חתימה בצורה קבועת-זמן דרך WebCrypto
    const ok = await hmacVerify(p, s);
    if (!ok) return null;

    const payload = JSON.parse(b64urlDecodeToString(p)) as TokenPayload;

    // בדיקות סכימה בסיסיות
    if (!payload || typeof payload !== "object") return null;
    if (payload.v !== TOKEN_VERSION) return null;
    if (!payload.rid || typeof payload.rid !== "string") return null;
    if (typeof payload.exp !== "number") return null;

    // בדיקת תוקף עם גרייס קל לשעון
    if (Date.now() - CLOCK_SKEW_MS > payload.exp) return null;

    // בדיקת אימייל בסיסית אם קיים (לא חוסם טוקן אם לא תקין — רק משפר איכות נתונים)
    if (payload.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
      // לא מפיל, רק מנקה כדי שלא נשתמש בכתובת לא חוקית
      delete (payload as any).email;
    }

    return payload;
  } catch {
    return null;
  }
}

/** כלי עזר: הפקת URL לקישור ניהול מהטוקן וה-origin הנתון */
export function buildManageUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/r/${encodeURIComponent(token)}`;
}

/* -------------------- Review Tokens -------------------- */

export type ReviewTokenPayload = {
  v: number;              // token version
  reservationId: string;  // ID of the reservation being reviewed
  restaurantId: string;   // ID of the restaurant
  userId: string;         // ID of the customer
  exp: number;            // expiration timestamp (ms)
};

/**
 * Create a signed token for leaving a review.
 * @param reservationId The reservation ID
 * @param restaurantId The restaurant ID
 * @param userId The customer's user ID
 * @param expiresInDays Validity period in days (default 7)
 */
export async function makeReviewToken(
  reservationId: string,
  restaurantId: string,
  userId: string,
  expiresInDays: number = 7,
): Promise<string> {
  const payload: ReviewTokenPayload = {
    v: TOKEN_VERSION,
    reservationId,
    restaurantId,
    userId,
    exp: Date.now() + Math.max(1, expiresInDays) * 24 * 60 * 60 * 1000,
  };
  const p = b64urlEncode(JSON.stringify(payload));
  const s = await hmacSign(p);
  return `${p}.${s}`;
}

/**
 * Verify review token and return payload if valid, otherwise null.
 * Checks signature, version, and expiration (with clock skew tolerance).
 */
export async function verifyReviewToken(token: string): Promise<ReviewTokenPayload | null> {
  try {
    const [p, s] = token.split(".");
    if (!p || !s) return null;

    // Verify signature using constant-time comparison via WebCrypto
    const ok = await hmacVerify(p, s);
    if (!ok) return null;

    const payload = JSON.parse(b64urlDecodeToString(p)) as ReviewTokenPayload;

    // Basic schema validation
    if (!payload || typeof payload !== "object") return null;
    if (payload.v !== TOKEN_VERSION) return null;
    if (!payload.reservationId || typeof payload.reservationId !== "string") return null;
    if (!payload.restaurantId || typeof payload.restaurantId !== "string") return null;
    if (!payload.userId || typeof payload.userId !== "string") return null;
    if (typeof payload.exp !== "number") return null;

    // Check expiration with grace period for clock skew
    if (Date.now() - CLOCK_SKEW_MS > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Helper: build review URL from token and origin */
export function buildReviewUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/review/${encodeURIComponent(token)}`;
}
