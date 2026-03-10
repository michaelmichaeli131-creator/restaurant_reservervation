import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant } from "../database.ts";
import { requireRestaurantAccess } from "../services/authz.ts";
import {
  getRestaurantSystemNow,
  getRestaurantSystemTimeState,
  resetRestaurantSystemTime,
  setRestaurantSystemTime,
  splitIsoParts,
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
    return {};
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
    ...parts,
    updatedAt: state?.updatedAt ?? null,
  });
});

systemTimeRouter.post("/api/restaurants/:rid/system-time", async (ctx) => {
  const rid = String(ctx.params.rid || "");
  if (!(await ensureAccess(ctx, rid))) return;
  const body = await readBody(ctx);
  const mode = String(body?.mode ?? "set").trim().toLowerCase();

  if (mode === "reset" || mode === "realtime") {
    const state = await resetRestaurantSystemTime(rid);
    const parts = splitIsoParts(state.iso);
    json(ctx, {
      ok: true,
      restaurantId: rid,
      enabled: false,
      source: "realtime",
      ...parts,
      updatedAt: state.updatedAt,
    });
    return;
  }

  let iso = String(body?.iso ?? "").trim();
  if (!iso) {
    const date = String(body?.date ?? "").trim();
    const time = String(body?.time ?? "").trim();
    if (date && time) iso = `${date}T${time}:00`;
  }

  try {
    const saved = await setRestaurantSystemTime(rid, iso);
    const parts = splitIsoParts(saved.iso);
    json(ctx, {
      ok: true,
      restaurantId: rid,
      enabled: true,
      source: "manual",
      ...parts,
      updatedAt: saved.updatedAt,
    });
  } catch {
    json(ctx, { ok: false, error: "invalid_datetime" }, Status.BadRequest);
  }
});
