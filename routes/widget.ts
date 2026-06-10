// routes/widget.ts — embeddable booking widget (iframe-able, see CSP in server.ts)
import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, type WeeklySchedule } from "../database.ts";
import { render } from "../lib/view.ts";
import { todayISO, normalizeDate } from "./restaurants/_utils/datetime.ts";
import { hasScheduleForDate, getWindowsForDate } from "./restaurants/_utils/hours.ts";

export const widgetRouter = new Router();

function windowsForDate(restaurant: any, date: string) {
  const schedule = restaurant.weeklySchedule as WeeklySchedule;
  const hasDay = hasScheduleForDate(schedule, date);
  const windows = getWindowsForDate(schedule, date);
  return hasDay ? windows : [];
}

// Widget page (rendered inside an <iframe> on the restaurant's own website)
widgetRouter.get("/widget/:rid", async (ctx) => {
  const rid = String(ctx.params.rid ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant || !(restaurant as any).approved) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  const date = normalizeDate(ctx.request.url.searchParams.get("date") ?? "") || todayISO();
  const theme = ctx.request.url.searchParams.get("theme") === "dark" ? "dark" : "light";
  await render(ctx, "widget", {
    page: "widget",
    title: restaurant.name,
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      city: restaurant.city,
    },
    date,
    theme,
    openingWindows: windowsForDate(restaurant, date),
    slotIntervalMinutes: (restaurant as any).slotIntervalMinutes ?? 15,
  });
});

// Opening windows for a given date (used when the guest changes the date)
widgetRouter.get("/widget/:rid/slots", async (ctx) => {
  const rid = String(ctx.params.rid ?? "");
  const restaurant = await getRestaurant(rid);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  if (!restaurant || !(restaurant as any).approved) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = JSON.stringify({ ok: false, reason: "not_found" });
    return;
  }
  const date = normalizeDate(ctx.request.url.searchParams.get("date") ?? "") || todayISO();
  ctx.response.headers.set("Cache-Control", "public, max-age=60");
  ctx.response.body = JSON.stringify({
    ok: true,
    date,
    windows: windowsForDate(restaurant, date),
    slotIntervalMinutes: (restaurant as any).slotIntervalMinutes ?? 15,
  });
});

// Loader script: <script src="https://.../embed.js" data-spotbook="RID"></script>
widgetRouter.get("/embed.js", async (ctx) => {
  try {
    const js = await Deno.readTextFile(`${Deno.cwd()}/public/embed.js`);
    ctx.response.headers.set("Content-Type", "application/javascript; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "public, max-age=3600");
    ctx.response.body = js;
  } catch {
    ctx.response.status = Status.NotFound;
  }
});
