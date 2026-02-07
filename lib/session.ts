// src/lib/session.ts
import type { Context } from "jsr:@oak/oak";

/**
 * Session storage
 *
 * - Prefer Deno KV when available.
 * - Fall back to in-memory storage when KV isn't configured/available.
 *
 * This prevents the whole app from crashing in environments where Deno KV
 * isn't set up (e.g., missing transaction domain / tokens).
 */
let kv: Deno.Kv | null = null;
const memoryStore = new Map<string, Record<string, unknown>>();
let warnedKvUnavailable = false;

async function getKv(): Promise<Deno.Kv | null> {
  if (kv) return kv;
  try {
    kv = await Deno.openKv();
    return kv;
  } catch (_err) {
    if (!warnedKvUnavailable) {
      warnedKvUnavailable = true;
      console.warn(
        "[session] Deno KV unavailable. Falling back to in-memory sessions. " +
          "(Set up Deno KV/txnproxy to enable persistent sessions.)",
      );
    }
    return null;
  }
}
type SessionData = Record<string, unknown>;

// זיהוי HTTPS מאחורי פרוקסי + אופציית אובררייד במשתנה סביבה
function isHttps(ctx: Context): boolean {
  // אם רוצים לאלץ ידנית:
  const override = Deno.env.get("COOKIE_SECURE");
  if (override === "true") return true;
  if (override === "false") return false;

  // זיהוי אוטומטי:
  if ((ctx.request as any).secure) return true;
  const xf = ctx.request.headers.get("x-forwarded-proto");
  if (xf && xf.toLowerCase() === "https") return true;
  try {
    return ctx.request.url.protocol === "https:";
  } catch {
    return false;
  }
}

async function loadSession(sid: string): Promise<SessionData> {
  const kvh = await getKv();
  if (kvh) {
    try {
      const v = await kvh.get<SessionData>(["sess", sid]);
      return v.value ?? {};
    } catch {
      // If KV fails at runtime, still don't crash requests.
      return memoryStore.get(sid) ?? {};
    }
  }
  return memoryStore.get(sid) ?? {};
}
async function saveSession(sid: string, data: SessionData) {
  const kvh = await getKv();
  if (kvh) {
    try {
      await kvh.set(["sess", sid], data);
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryStore.set(sid, { ...data });
}
async function destroySession(sid: string) {
  const kvh = await getKv();
  if (kvh) {
    try {
      await kvh.delete(["sess", sid]);
    } catch {
      // ignore
    }
  }
  memoryStore.delete(sid);
}

export default async function sessionMiddleware(ctx: Context, next: () => Promise<unknown>) {
  const cookieName = "sid";
  let sid = await ctx.cookies.get(cookieName);
  let isNew = false;

  if (!sid) {
    sid = crypto.randomUUID().replace(/-/g, "");
    isNew = true;
  }

  let data = await loadSession(sid);

  (ctx.state as any).session = {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (data[key] as T) ?? null;
    },
    async set(key: string, value: unknown) {
      data[key] = value;
      await saveSession(sid!, data);
    },
    async delete(key: string) {
      delete data[key];
      await saveSession(sid!, data);
    },
    async destroy() {
      data = {};
      await destroySession(sid!);
      await ctx.cookies.delete(cookieName, { path: "/" });
    },
    _all(): SessionData {
      return { ...data };
    },
  };

  // קביעת secure לעוגייה:
  // ברירת מחדל — לפי isHttps(ctx); ניתן לאלץ עם COOKIE_SECURE=true/false
  const secure = isHttps(ctx);

  await ctx.cookies.set(cookieName, sid, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure, // אם false — לא תיזרק השגיאה על חיבור לא מוצפן
  });

  try {
    await next();
  } finally {
    if (isNew && Object.keys(data).length === 0) {
      await saveSession(sid!, {});
    }
  }
}
