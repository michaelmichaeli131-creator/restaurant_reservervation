// lib/session.ts
// Session פשוט המבוסס על קוקיז + Deno KV (ללא oak_sessions)

import { Application } from "@oak/oak";
import { kv, getUser } from "../database.ts";

const COOKIE_NAME = "sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 יום

type SessionRecord = {
  data: Record<string, unknown>;
  // לשימוש עתידי (ניקוי/תוקף)
  expiresAt: number;
};

function newSessionId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function initSession(app: Application) {
  app.use(async (ctx, next) => {
    // קרא/צור sid מהעוגיה
    let sid = await ctx.cookies.get(COOKIE_NAME);
    const isHttps = ctx.request.url.protocol === "https:";
    if (!sid) {
      sid = newSessionId();
      await ctx.cookies.set(COOKIE_NAME, sid, {
        httpOnly: true,
        sameSite: "Lax",
        secure: isHttps, // ב-Deploy זה true; בלוקאלי זה יהיה false (http)
        path: "/",
      });
    }

    // טען את הרשומה מה-KV (או התחל ריק)
    const key = ["session", sid] as const;
    const stored = (await kv.get<SessionRecord>(key)).value;
    let session: SessionRecord = stored ?? {
      data: {},
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    // API של session: get/set/destroy
    const api = {
      async get<T = unknown>(name: string): Promise<T | undefined> {
        return session.data[name] as T | undefined;
      },
      async set(name: string, value: unknown): Promise<void> {
        session.data[name] = value;
        session.expiresAt = Date.now() + SESSION_TTL_MS;
        await kv.set(key, session);
      },
      async destroy(): Promise<void> {
        await kv.delete(key);
        await ctx.cookies.set(COOKIE_NAME, "", {
          httpOnly: true,
          sameSite: "Lax",
          secure: isHttps,
          path: "/",
          expires: new Date(0),
        });
      },
    };

    // חשוף ב-ctx.state.session
    (ctx.state as any).session = api;

    // אם יש userId בסשן — טען את המשתמש ושמור ב-ctx.state.user
    try {
      const userId = (await api.get<string>("userId")) ?? null;
      if (userId) {
        const user = await getUser(userId);
        if (user) (ctx.state as any).user = user;
      }
    } catch (e) {
      console.error("[ERR] session load user failed:", e?.stack ?? e);
    }

    await next();
  });
}
