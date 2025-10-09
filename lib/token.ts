// src/lib/token.ts
// יצירת/אימות טוקן חתום (HMAC-SHA256) לצורך קישורי הזמנה מאובטחים

const SECRET = (Deno.env.get("TOKEN_SECRET") ?? Deno.env.get("ADMIN_SECRET") ?? "").trim();
if (!SECRET) {
  console.warn("[token] WARNING: TOKEN_SECRET/ADMIN_SECRET not set. Tokens will be insecure!");
}

type TokenPayload = {
  rid: string;          // reservation id
  email?: string;       // אופציונלי: אימייל המשתמש
  exp: number;          // timestamp (ms) תוקף
};

function b64url(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return b64url(bytes);
}
function b64urlDecodeToString(b64u: string): string {
  const b64 = b64u.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

/** צור טוקן חתום להזמנה (ברירת מחדל: תוקף 14 יום) */
export async function makeReservationToken(rid: string, email?: string, expiresInDays = 14): Promise<string> {
  const payload: TokenPayload = {
    rid,
    email,
    exp: Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
  };
  const json = JSON.stringify(payload);
  const p = b64urlEncode(json);
  const s = await hmac(p);
  return `${p}.${s}`;
}

/** אמת טוקן והחזר payload אם תקין, אחרת null */
export async function verifyReservationToken(token: string): Promise<TokenPayload | null> {
  try {
    const [p, s] = token.split(".");
    if (!p || !s) return null;
    const expected = await hmac(p);
    if (expected !== s) return null;
    const payload = JSON.parse(b64urlDecodeToString(p)) as TokenPayload;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    if (!payload.rid) return null;
    return payload;
  } catch {
    return null;
  }
}
