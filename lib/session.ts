import { Application, Context } from "@oak/oak";
import { kv, getUser } from "../database.ts";

const COOKIE_NAME = "sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

type SessionRecord = { data: Record<string, unknown>; expiresAt: number; };

function newSessionId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function isHttpsRequest(ctx: Context): boolean {
  const xfProto = ctx.request.headers.get("x-forwarded-proto");
  if (xfProto) return xfProto.toLowerCase() === "https";
  return ctx.request.url.protocol === "https:";
}

async function setSessionCookie(ctx: Context, sid: string, secure: boolean) {
  try {
    await ctx.cookies.set(COOKIE_NAME, sid, {
      httpOnly: true, sameSite: "Lax", secure, path: "/",
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (secure && msg.includes("secure cookie")) {
      console.warn("[WARN] secure cookie failed; retrying with secure=false");
      await ctx.cookies.set(COOKIE_NAME, sid, {
        httpOnly: true, sameSite: "Lax", secure: false, path: "/",
      });
    } else {
      throw err;
    }
  }
}

export async function initSession(app: Application) {
  app.use(async (ctx, next) => {
    const httpsLike = isHttpsRequest(ctx);

    let sid = await ctx.cookies.get(COOKIE_NAME);
    if (!sid) {
      sid = newSessionId();
      await setSessionCookie(ctx, sid, httpsLike);
    }

    const key = ["session", sid] as const;
    const stored = (await kv.get<SessionRecord>(key)).value;
    let session: SessionRecord = stored ?? { data: {}, expiresAt: Date.now() + SESSION_TTL_MS };

    const api = {
      async get<T = unknown>(name: string): Promise<T | undefined> {
        return session.data[name] as T | undefined;
      },
      async set(name: string, value: unknown): Promise<void> {
        session.data[name] = value;
        session.expiresAt = Date.now() + SESSION_TTL_MS;
        await kv.set(key, session);
        await setSessionCookie(ctx, sid!, httpsLike);
      },
      async destroy(): Promise<void> {
        await kv.delete(key);
        await setSessionCookie(ctx, "", httpsLike);
        await ctx.cookies.set(COOKIE_NAME, "", {
          httpOnly: true, sameSite: "Lax", secure: false, path: "/", expires: new Date(0),
        });
      },
    };

    (ctx.state as any).session = api;

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
