// /src/lib/auth.ts
// ------------------------------------------------------------
// Password hashing & verification (PBKDF2-SHA256) + auth guards
// Exports: hashPassword, verifyPassword, requireAuth, requireOwner
// ------------------------------------------------------------

const ITERATIONS = 120_000;
const KEY_LEN = 32; // 256-bit
const ALGO = "SHA-256";

function toUint8(s: string) {
  return new TextEncoder().encode(s);
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
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

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations = ITERATIONS,
  length = KEY_LEN,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toUint8(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: ALGO, salt, iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function constTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

/** Hash password → `pbkdf2$<iterations>$<salt_b64url>$<hash_b64url>` */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(plain, salt);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(dk)}`;
}

/** Verify password against stored hash string produced by hashPassword */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!iterations || !saltB64 || !hashB64) return false;

    const salt = fromB64url(saltB64);
    const expected = fromB64url(hashB64);
    const got = await pbkdf2(plain, salt, iterations, expected.length);
    return constTimeEqual(got, expected);
  } catch {
    return false;
  }
}

/** Guard: require logged-in user; redirects to /auth/login with redirect param */
export function requireAuth(ctx: any): boolean {
  if (!ctx.state?.user) {
    const targetPath = ctx.request?.url?.pathname || "/";
    const target = "/auth/login?redirect=" + encodeURIComponent(targetPath);
    ctx.response.status = 303; // See Other
    ctx.response.headers.set("Location", target);
    return false;
  }
  return true;
}

/** Guard: require owner role; 403 if missing */
export function requireOwner(ctx: any): boolean {
  const user = ctx.state?.user;
  if (!user || user.role !== "owner") {
    ctx.response.status = 403;
    ctx.response.body = "Forbidden";
    return false;
  }
  return true;
}

// ---- explicit re-exports to make bundlers happy (defensive) ----
export const _internal = { ITERATIONS, KEY_LEN, ALGO, b64url, fromB64url };
export { pbkdf2 as _pbkdf2, constTimeEqual as _constTimeEqual };
