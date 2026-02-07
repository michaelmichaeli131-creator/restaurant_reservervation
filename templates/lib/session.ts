// src/lib/session.ts
import type { Context } from "jsr:@oak/oak";

const kv = await Deno.openKv();
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
  const v = await kv.get<SessionData>(["sess", sid]);
  return v.value ?? {};
}
async function saveSession(sid: string, data: SessionData) {
  await kv.set(["sess", sid], data);
}
async function destroySession(sid: string) {
  await kv.delete(["sess", sid]);
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
