// src/routes/opening.ts
import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant } from "../database.ts";
import { openingWindowsForDate } from "../database.ts";
import { debugLog } from "../lib/debug.ts";

const openingRouter = new Router();

/**
 * GET /restaurants/:id/opening?date=YYYY-MM-DD
 * מחזיר: { openingWindows: [{open,close}], slotIntervalMinutes: number }
 */
openingRouter.get("/restaurants/:id/opening", async (ctx) => {
  const id = ctx.params.id!;
  const date = ctx.request.url.searchParams.get("date") || "";

  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.type = "json";
    ctx.response.body = { error: "not_found" };
    return;
  }

  // תמיד פירוש לפי התאריך שהלקוח ביקש:
  const openingWindows = openingWindowsForDate(r, date);
  const slotIntervalMinutes = r.slotIntervalMinutes || 15;

  debugLog("[opening.api]", { id, date, openingWindows, slotIntervalMinutes });

  ctx.response.headers.set("Cache-Control", "no-store, max-age=0");
  ctx.response.headers.set("Pragma", "no-cache");
  ctx.response.headers.set("Expires", "0");

  ctx.response.status = Status.OK;
  ctx.response.type = "json";
  ctx.response.body = { openingWindows, slotIntervalMinutes };
});

export default openingRouter;
export { openingRouter };
