// src/lib/session.ts
import type { Context } from "jsr:@oak/oak";

const kv = await Deno.openKv();

type SessionData = Record<string, unknown>;

function isHttps(ctx: Context): boolean {
  // Oak v17: ctx.request.secure קיים בפרוטוקול HTTPS
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

async function saveSession(sid: string, data: SessionData): Promise<void> {
  await kv.set(["sess", sid], data);
}

async function destroySession(sid: string): Promise<void> {
  await kv.delete(["sess", sid]);
}

// יוצא ברירת מחדל (default)
export default async function sessionMiddleware(ctx: Context, next: () => Promise<unknown>) {
  const cookieName = "sid";

  // נסה לקבל sid מהעוגייה
  let sid = await ctx.cookies.get(cookieName);
  let isNew = false;

  if (!sid) {
    sid = crypto.randomUUID().replace(/-/g, "");
    isNew = true;
  }

  // טען/צור נתוני סשן מה-KV
  let data = await loadSession(sid);

  // הוסף ל-state API נוח
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
      // ננקה גם את העוגייה בדפדפן
      await ctx.cookies.delete(cookieName, { path: "/" });
    },
    // שימוש פנימי (אם תרצה)
    _all(): SessionData {
      return { ...data };
    },
  };

  // קבע/רענן עוגיית sid
  // חשוב: secure=true רק תחת HTTPS כדי להימנע מ-"Cannot send secure cookie over unencrypted connection"
  const secure = isHttps(ctx);
  await ctx.cookies.set(cookieName, sid, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    // אפשר גם maxAge או expires אם תרצה התנהגות מתקדמת
  });

  try {
    await next();
  } finally {
    // אם היתה יצירה חדשה ולא נשמר כלום — עדיין העוגייה נשלחה כבר למעלה
    // אם תרצה, תוכל לשמור heartbeat קטן:
    if (isNew && Object.keys(data).length === 0) {
      await saveSession(sid, {});
    }
  }
}
