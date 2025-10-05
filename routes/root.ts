// src/routes/root.ts
// עמוד הבית: מפנה משתמשים מחוברים ל-/owner, ואורחים רואים את index.eta

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";

const rootRouter = new Router();

rootRouter.get("/", async (ctx) => {
  const user = (ctx.state as any)?.user ?? null;
  if (user) {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", "/owner");
    return;
  }
  await render(ctx, "index", { title: "GeoTable — ניהול והזמנות", page: "home" });
});

export default rootRouter;
export { rootRouter };
