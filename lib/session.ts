import { Application } from "@oak/oak";
import { Session } from "oak_sessions";
import { getUser } from "../database.ts";

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") ?? crypto.randomUUID();

export async function initSession(app: Application) {
  app.use(Session.initMiddleware({ secret: SESSION_SECRET }));

  // attach user to ctx.state.user if exists
  app.use(async (ctx, next) => {
    const userId = await (ctx.state as any).session.get("userId");
    if (userId) {
      const user = await getUser(userId);
      if (user) (ctx.state as any).user = user;
    }
    await next();
  });
}
