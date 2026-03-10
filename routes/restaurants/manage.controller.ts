// src/routes/restaurants/manage.controller.ts
import { Status } from "jsr:@oak/oak";
import { verifyReservationToken } from "../../lib/token.ts";
import { getReservationById, getRestaurant, updateReservation, enrichReservationWithRoomMeta } from "../../database.ts";
import { render } from "../../lib/view.ts";
import { extractFromReferer, readBody } from "./_utils/body.ts";
import { pickNonEmpty } from "./_utils/datetime.ts";
import { photoStrings } from "./_utils/misc.ts";
import { debugLog } from "../../lib/debug.ts";

function getLang(ctx: any): string {
  return ctx.state?.lang || ctx.request.url.searchParams.get("lang") || ctx.cookies?.get?.("lang") || "en";
}
function tt(ctx: any, key: string, fallback: string): string {
  const t = ctx.state?.t;
  if (typeof t === "function") {
    const value = t(key);
    if (value && value !== key && value !== `(${key})`) return value;
  }
  return fallback;
}

export async function manageGet(ctx: any) {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) { const lang = getLang(ctx); ctx.response.status = Status.NotFound; ctx.response.body = lang === "he" ? "הקישור לא תקין או שפג תוקפו" : lang === "ka" ? "ბმული არასწორია ან ვადა გაუვიდა" : "Invalid or expired link"; return; }

  const reservationRaw = await getReservationById(payload.rid);
  if (!reservationRaw) { const lang = getLang(ctx); ctx.response.status = Status.NotFound; ctx.response.body = lang === "he" ? "ההזמנה לא נמצאה" : lang === "ka" ? "ჯავშანი ვერ მოიძებნა" : "Reservation not found"; return; }
  const reservation = await enrichReservationWithRoomMeta(reservationRaw.restaurantId, reservationRaw as any);

  const restaurant = await getRestaurant(reservation.restaurantId);
  const photos = photoStrings(restaurant?.photos);

  const allowConfirm = reservation.status !== "confirmed" && reservation.status !== "canceled";
  const allowCancel  = reservation.status !== "canceled";

  await render(ctx, "reservation_manage", {
    page: "reservation_manage",
    title: tt(ctx, "manage.title", "Manage Reservation · SpotBook"),
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
  if (!payload) { const lang = getLang(ctx); ctx.response.status = Status.BadRequest; ctx.response.body = lang === "he" ? "הקישור לא תקין או שפג תוקפו" : lang === "ka" ? "ბმული არასწორია ან ვადა გაუვიდა" : "Invalid or expired link"; return; }

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

  const reservationRaw = await getReservationById(payload.rid);
  if (!reservationRaw) { const lang = getLang(ctx); ctx.response.status = Status.NotFound; ctx.response.body = lang === "he" ? "ההזמנה לא נמצאה" : lang === "ka" ? "ჯავშანი ვერ მოიძებნა" : "Reservation not found"; return; }
  const reservation = await enrichReservationWithRoomMeta(reservationRaw.restaurantId, reservationRaw as any);

  const restaurant = await getRestaurant(reservation.restaurantId);
  if (!restaurant) { const lang = getLang(ctx); ctx.response.status = Status.NotFound; ctx.response.body = lang === "he" ? "המסעדה לא נמצאה" : lang === "ka" ? "რესტორანი ვერ მოიძებნა" : "Restaurant not found"; return; }

  const photos = photoStrings(restaurant.photos);
  const renderBack = async (flash: any) => {
    const freshRaw = await getReservationById(payload.rid);
    const fresh = freshRaw ? await enrichReservationWithRoomMeta(freshRaw.restaurantId, freshRaw as any) : freshRaw;
    const allowConfirm = fresh?.status !== "confirmed" && fresh?.status !== "canceled";
    const allowCancel  = fresh?.status !== "canceled";
    await render(ctx, "reservation_manage", {
      page: "reservation_manage",
      title: tt(ctx, "manage.title", "Manage Reservation · SpotBook"),
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
    if (reservation.status === "canceled") { await renderBack({ error: tt(ctx, "manage.flash.cannotConfirmCanceled", "The reservation is canceled and cannot be confirmed.") }); return; }
    if (reservation.status === "confirmed") { await renderBack({ ok: tt(ctx, "manage.flash.alreadyConfirmed", "The reservation is already confirmed.") }); return; }
    await updateReservation(reservation.id, { status: "confirmed" }).catch(() => {});
    await renderBack({ ok: tt(ctx, "manage.flash.confirmed", "Your attendance was confirmed. See you soon!") });
    return;
  }

  if (action === "cancel") {
    if (reservation.status === "canceled") { await renderBack({ ok: tt(ctx, "manage.flash.alreadyCanceled", "The reservation is already canceled.") }); return; }
    await updateReservation(reservation.id, { status: "canceled" }).catch(() => {});
    await renderBack({ ok: tt(ctx, "manage.flash.canceled", "The reservation was canceled.") });
    return;
  }

  await renderBack({ error: tt(ctx, "manage.flash.unknownAction", "Unknown action") });
}
