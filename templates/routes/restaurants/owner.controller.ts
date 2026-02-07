// src/routes/restaurants/owner.controller.ts
import { Status } from "jsr:@oak/oak";
import { debugLog } from "../../lib/debug.ts";
import { ensureWeeklyHours } from "./_utils/hours.ts";
import { toIntLoose } from "./_utils/datetime.ts";

export async function saveHours(ctx: any) {
  const rid = String(ctx.params.id ?? "");

  const bodyText = await ctx.request.body?.({ type: "text" })?.value?.catch?.(() => "") || "";
  let payload: Record<string, unknown> = {};
  try {
    if (bodyText && bodyText.trim().startsWith("{")) payload = JSON.parse(bodyText);
    else payload = Object.fromEntries(new URLSearchParams(bodyText));
  } catch {
    payload = Object.fromEntries(new URLSearchParams(bodyText));
  }

  debugLog("[restaurants][POST hours] input]", {
    rid,
    body_ct: ctx.request.headers.get("content-type") || "",
    body_keys: Object.keys(payload),
  });

  const capacity = Math.max(1, toIntLoose((payload as any).capacity ?? (payload as any).maxConcurrent) ?? 1);
  const slotIntervalMinutes = Math.max(5, toIntLoose((payload as any).slotIntervalMinutes ?? (payload as any).slot) ?? 15);
  const serviceDurationMinutes = Math.max(30, toIntLoose((payload as any).serviceDurationMinutes ?? (payload as any).span) ?? 120);

  const weeklyCandidate =
    (payload as any).weeklySchedule ??
    (payload as any).hours ??
    (payload as any).weeklyHours ??
    (payload as any).openingHours ??
    null;

  const normalizedMap = ensureWeeklyHours(weeklyCandidate, payload);

  const normalized: any = {};
  for (let d = 0; d <= 6; d++) {
    const row = (normalizedMap as any)[d] ?? null;
    normalized[d] = row && row.open && row.close ? { open: row.open, close: row.close } : null;
  }

  debugLog("[restaurants][POST hours] normalized", {
    capacity,
    slotIntervalMinutes,
    serviceDurationMinutes,
    weeklySchedule: normalized,
  });

  const db = await import("../../database.ts");
  const updater = (db as any).updateRestaurant;

  if (!updater) { ctx.response.status = Status.InternalServerError; ctx.response.body = "No DB updater found"; return; }

  try {
    await updater(rid, {
      weeklySchedule: normalized,
      capacity,
      slotIntervalMinutes,
      serviceDurationMinutes,
    });
    debugLog("[restaurants][POST hours] saved OK", { rid });
  } catch (e) {
    console.error("[hours.save] DB update failed", e);
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = "DB update failed: " + String(e);
    return;
  }

  const wantsJson =
    (ctx.request.headers.get("accept") || "").includes("application/json") ||
    (ctx.request.headers.get("content-type") || "").includes("application/json");

  if (wantsJson) {
    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, weeklySchedule: normalized, capacity, slotIntervalMinutes, serviceDurationMinutes }, null, 2);
  } else {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", `/restaurants/${encodeURIComponent(rid)}`);
  }
}
