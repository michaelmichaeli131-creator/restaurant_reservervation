import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant } from "../database.ts";
import { requireRestaurantAccess } from "../services/authz.ts";
import {
  buildLocalIso,
  getRestaurantSystemNow,
  getRestaurantSystemTimeState,
  getRestaurantSystemTimezone,
  resetRestaurantSystemTime,
  setRestaurantSystemTime,
  splitIsoParts,
  updateRestaurantSystemTimezone,
} from "../services/system_time.ts";

export const systemTimeRouter = new Router();

function json(ctx: any, body: unknown, status = Status.OK) {
  ctx.response.status = status;
  ctx.response.type = "application/json; charset=utf-8";
  ctx.response.body = body;
}

async function readBody(ctx: any) {
  try {
    const b = ctx.request.body({ type: "json" });
    return await b.value;
  } catch {
    try {
      const b = ctx.request.body({ type: "form" });
      const form = await b.value;
      return Object.fromEntries(form.entries());
    } catch {
      return {};
    }
  }
}

async function ensureAccess(ctx: any, rid: string) {
  const r = await getRestaurant(rid);
  if (!r) {
    json(ctx, { ok: false, error: "restaurant_not_found" }, Status.NotFound);
    return null;
  }
  if (!(await requireRestaurantAccess(ctx, rid))) return null;
  return r;
}

systemTimeRouter.get("/restaurants/:rid/system-time", async (ctx) => {
  const rid = String(ctx.params.rid || "");
  const restaurant = await ensureAccess(ctx, rid);
  if (!restaurant) return;
  const state = await getRestaurantSystemTimeState(rid);
  const now = await getRestaurantSystemNow(rid);
  const parts = splitIsoParts(now);
  await render(ctx, "restaurant_system_time", {
    page: "restaurant_system_time",
    title: `Restaurant Time · ${restaurant.name}`,
    restaurant,
    rid,
    systemNowIso: parts.iso,
    systemNowDate: parts.date,
    systemNowTime: parts.time,
    systemTimeEnabled: !!state?.enabled,
    systemTimeMode: state?.enabled ? "manual" : "realtime",
    systemTimeTimezone: (await getRestaurantSystemTimezone(rid)) || "",
  });
});

systemTimeRouter.get("/api/restaurants/:rid/system-time", async (ctx) => {
  const rid = String(ctx.params.rid || "");
  if (!(await ensureAccess(ctx, rid))) return;
  const state = await getRestaurantSystemTimeState(rid);
  const now = await getRestaurantSystemNow(rid);
  const parts = splitIsoParts(now);
  json(ctx, {
    ok: true,
    restaurantId: rid,
    enabled: !!state?.enabled,
    source: state?.enabled ? "manual" : "realtime",
    timezone: (await getRestaurantSystemTimezone(rid)) || null,
    ...parts,
    updatedAt: state?.updatedAt ?? null,
  });
});

systemTimeRouter.post("/api/restaurants/:rid/system-time", async (ctx) => {
  const rid = String(ctx.params.rid || "");
  if (!(await ensureAccess(ctx, rid))) return;
  const body = await readBody(ctx);
  const mode = String(body?.mode ?? "set").trim().toLowerCase();
  const timezone = String(body?.timezone ?? "").trim();

  if (mode === "timezone") {
    const state = await updateRestaurantSystemTimezone(rid, timezone || null);
    const now = await getRestaurantSystemNow(rid, timezone || null);
    const parts = splitIsoParts(now);
    json(ctx, {
      ok: true,
      restaurantId: rid,
      enabled: !!state?.enabled,
      source: state?.enabled ? "manual" : "realtime",
      timezone: (await getRestaurantSystemTimezone(rid)) || null,
      ...parts,
      updatedAt: state.updatedAt,
    });
    return;
  }

  if (mode === "reset" || mode === "realtime") {
    const state = await resetRestaurantSystemTime(rid, timezone || null);
    const now = await getRestaurantSystemNow(rid, timezone || null);
    const parts = splitIsoParts(now);
    json(ctx, {
      ok: true,
      restaurantId: rid,
      enabled: false,
      source: "realtime",
      timezone: (await getRestaurantSystemTimezone(rid)) || null,
      ...parts,
      updatedAt: state.updatedAt,
    });
    return;
  }

  try {
    let iso = String(body?.iso ?? "").trim();
    if (!iso) {
      const date = String(body?.date ?? "").trim();
      const time = String(body?.time ?? "").trim();
      iso = buildLocalIso(date, time);
    }
    const saved = await setRestaurantSystemTime(rid, iso, timezone || null);
    const parts = splitIsoParts(saved.iso);
    json(ctx, {
      ok: true,
      restaurantId: rid,
      enabled: true,
      source: "manual",
      timezone: (await getRestaurantSystemTimezone(rid)) || null,
      ...parts,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    console.error("[system-time] invalid payload", { rid, body, error: String(err) });
    json(ctx, { ok: false, error: "invalid_datetime" }, Status.BadRequest);
  }
});
