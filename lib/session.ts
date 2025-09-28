// lib/session.ts
// Middleware סשן מבוסס Cookie + Deno KV.
// יוצר sid בעוגייה ומחזיק state בספריית KV תחת ["session", sid].
// בנוסף, אם שמור userId בסשן – נטען את המשתמש מה-DB ונשים ב-ctx.state.user.

import type { Application, Context } from "jsr:@oak/oak";
import { kv, getUserById } from "../database.ts"; // <<< שים לב: getUserById (לא getUser)

type SessionData = Record<string, unknown>;

function isHttps(ctx: Context) {
  return ctx.request.url.protocol === "https:";
}

export async function initSession(app: Application) {
  app.use(async (ctx, next) => {
    // שליפת/יצירת sid מה-cookie
    let sid = await ctx.cookies.get("sid");
    if (!sid) {
      sid = crypto.randomUUID().replace(/-/g, "");
      await ctx.cookies.set("sid", sid, {
        httpOnly: true,
        sameSite: "Lax",
        secure: isHttps(ctx), // ב־Deploy זה יהיה true; לוקאלית http זה false
        path: "/",
      });
    }

    const key = ["session", sid] as const;

    // טען את נתוני הסשן מה-KV (או צור אובייקט ריק)
    let data = (await kv.get<SessionData>(key)).value ?? {};

    // עטיפת API נוחה לסט/גט/ניקוי
    const session = {
      async get<T = unknown>(k: string): Promise<T | undefined> {
        return data[k] as T | undefined;
      },
      async set(k: string, v: unknown) {
        data[k] = v;
        await kv.set(key, data);
      },
      async delete(k: string) {
        delete data[k];
        await kv.set(key, data);
      },
      async destroy() {
        data = {};
        await kv.delete(key);
        // מחיקת cookie (לא חובה)
        await ctx.cookies.set("sid", "", {
          httpOnly: true,
          sameSite: "Lax",
          secure: isHttps(ctx),
          path: "/",
          expires: new Date(0),
        });
      },
    };

    // חשוף ב־ctx.state
    (ctx.state as any).session = session;

    // אם יש userId בסשן – טען את המשתמש והדבק ב־ctx.state.user
    const userId = (await session.get<string>("userId")) ?? null;
    if (userId) {
      const user = await getUserById(userId); // <<< כאן
      if (user) (ctx.state as any).user = user;
    }

    await next();
  });
}
