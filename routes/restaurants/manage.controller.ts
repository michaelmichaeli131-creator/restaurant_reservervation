// src/routes/restaurants/manage.controller.ts
import { Status } from "jsr:@oak/oak";
import { verifyReservationToken } from "../../lib/token.ts";
import { getReservationById, getRestaurant, updateReservation } from "../../database.ts";
import { render } from "../../lib/view.ts";
import { extractFromReferer, readBody } from "./_utils/body.ts";
import { pickNonEmpty } from "./_utils/datetime.ts";
import { photoStrings } from "./_utils/misc.ts";
import { debugLog } from "../../lib/debug.ts";

export async function manageGet(ctx: any) {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) { ctx.response.status = Status.NotFound; ctx.response.body = "Invalid or expired link"; return; }

  const reservation = await getReservationById(payload.rid);
  if (!reservation) { ctx.response.status = Status.NotFound; ctx.response.body = "Reservation not found"; return; }

  const restaurant = await getRestaurant(reservation.restaurantId);
  const photos = photoStrings(restaurant?.photos);

  const allowConfirm = reservation.status !== "confirmed" && reservation.status !== "canceled";
  const allowCancel  = reservation.status !== "canceled";

  await render(ctx, "reservation_manage", {
    page: "reservation_manage",
    title: "ניהול הזמנה",
    token,
    reservation,
    restaurant: restaurant ? { ...restaurant, photos } : null,
    flash: null,
    suggestions: [],
    allowConfirm,
    allowCancel,
  });
}

export async function managePost(ctx: any) {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) { ctx.response.status = Status.BadRequest; ctx.response.body = "Invalid or expired link"; return; }

  const { payload: body, dbg } = await readBody(ctx);

  const qs = ctx.request.url.searchParams;
  const ref = extractFromReferer(ctx);
  let action = pickNonEmpty(
    (body as any).action,
    (body as any)._action,
    (body as any).__action,
    (body as any).op,
    qs.get("action"),
    qs.get("op"),
    (body as any).confirm ? "confirm" : "",
    (body as any).cancel ? "cancel" : "",
    (qs.get("confirm") ? "confirm" : ""),
    (qs.get("cancel") ? "cancel" : ""),
    (ref as any)["action"] || "",
    (ref as any)["op"] || "",
    ((ref as any)["confirm"] ? "confirm" : ""),
    ((ref as any)["cancel"] ? "cancel" : ""),
  ).toLowerCase();

  if (!action) {
    const keys = Object.keys(body || {});
    if (keys.length === 1 && (keys[0] === "confirm" || keys[0] === "cancel")) {
      action = keys[0];
    }
  }

  debugLog("[reservation.manage][POST] action detect", {
    body_keys: Object.keys(body || {}),
    qs: Object.fromEntries(qs.entries()),
    ref,
    action,
    ct: dbg?.ct,
  });

  const reservation = await getReservationById(payload.rid);
  if (!reservation) { ctx.response.status = Status.NotFound; ctx.response.body = "Reservation not found"; return; }

  const restaurant = await getRestaurant(reservation.restaurantId);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

  const photos = photoStrings(restaurant.photos);
  const renderBack = async (flash: any) => {
    const fresh = await getReservationById(payload.rid);
    const allowConfirm = fresh?.status !== "confirmed" && fresh?.status !== "canceled";
    const allowCancel  = fresh?.status !== "canceled";
    await render(ctx, "reservation_manage", {
      page: "reservation_manage",
      title: "ניהול הזמנה",
      token,
      reservation: fresh,
      restaurant: { ...restaurant, photos },
      flash,
      suggestions: [],
      allowConfirm,
      allowCancel,
    });
  };

  if (action === "confirm") {
    if (reservation.status === "canceled") { await renderBack({ error: "ההזמנה מבוטלת ולא ניתן לאשר אותה." }); return; }
    if (reservation.status === "confirmed") { await renderBack({ ok: "ההזמנה כבר מאושרת." }); return; }
    await updateReservation(reservation.id, { status: "confirmed" }).catch(() => {});
    await renderBack({ ok: "ההגעה אושרה. נתראה!" });
    return;
  }

  if (action === "cancel") {
    if (reservation.status === "canceled") { await renderBack({ ok: "ההזמנה כבר בוטלה." }); return; }
    await updateReservation(reservation.id, { status: "canceled" }).catch(() => {});
    await renderBack({ ok: "ההזמנה בוטלה." });
    return;
  }

  await renderBack({ error: "פעולה לא מוכרת" });
}
