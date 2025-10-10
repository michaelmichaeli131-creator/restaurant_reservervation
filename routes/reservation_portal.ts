// /src/routes/reservation_portal.ts
// דף ניהול הזמנה דרך קישור במייל – משתמש ב-Eta template reservation_manage.eta
// ללא שינוי מועד (reschedule)

import { Router, Status } from "jsr:@oak/oak";
import { verifyReservationToken } from "../lib/token.ts";
import {
  getRestaurant,
  getReservationById,
  updateReservation,
  type Reservation,
} from "../database.ts";
import { render } from "../lib/view.ts";

/* עזר קטן להמרת photos לכל מערך מחרוזות */
function photoStrings(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p: any) => (typeof p === "string" ? p : String(p?.dataUrl || "")))
    .filter(Boolean);
}

const reservationPortal = new Router();

/* GET /r/:token – מציג את דף הניהול מתוך reservation_manage.eta */
reservationPortal.get("/r/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Invalid or expired link";
    return;
  }

  const reservation = await getReservationById(payload.rid);
  if (!reservation) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Reservation not found";
    return;
  }

  const restaurant = await getRestaurant(reservation.restaurantId).catch(() => null);
  const photos = photoStrings(restaurant?.photos);

  // לוגיקת הצגת כפתורים:
  // confirm מותר רק אם לא מאושר ולא מבוטל
  // cancel מותר כל עוד לא מבוטל
  const allowConfirm = reservation.status !== "confirmed" && reservation.status !== "canceled";
  const allowCancel  = reservation.status !== "canceled";

  await render(ctx, "reservation_manage", {
    page: "reservation_manage",
    title: "ניהול הזמנה",
    token,
    reservation,
    restaurant: restaurant ? { ...restaurant, photos } : null,
    flash: null,
    suggestions: [], // אין שינוי מועד → אין הצעות
    allowConfirm,
    allowCancel,
  });
});

/* POST /r/:token – פעולות: confirm | cancel בלבד */
reservationPortal.post("/r/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid or expired link";
    return;
  }

  // קורא גוף בפורמט גמיש (form/json/…)
  async function readBody(ctxAny: any): Promise<Record<string, unknown>> {
    try {
      const b = await ctxAny.request.body?.();
      if (!b) return {};
      const t = b.type;
      if (t === "form")         return Object.fromEntries(await b.value as URLSearchParams);
      if (t === "form-data")    return (await (await b.value).read()).fields ?? {};
      if (t === "json")         return (await b.value) ?? {};
      if (t === "text") {
        const txt = await b.value as string;
        try { return JSON.parse(txt); } catch { return Object.fromEntries(new URLSearchParams(txt)); }
      }
      if (t === "bytes") {
        const u8  = await b.value as Uint8Array;
        const txt = new TextDecoder().decode(u8);
        try { return JSON.parse(txt); } catch { return Object.fromEntries(new URLSearchParams(txt)); }
      }
    } catch {}
    return {};
  }

  const body = await readBody(ctx);
  const action = String((body as any).action ?? "").trim().toLowerCase();

  const reservation = await getReservationById(payload.rid);
  if (!reservation) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Reservation not found";
    return;
  }

  const restaurant = await getRestaurant(reservation.restaurantId).catch(() => null);
  const photos = photoStrings(restaurant?.photos);

  const renderBack = async (flash: any) => {
    const fresh = await getReservationById(payload.rid);
    const allowConfirm = fresh?.status !== "confirmed" && fresh?.status !== "canceled";
    const allowCancel  = fresh?.status !== "canceled";

    await render(ctx, "reservation_manage", {
      page: "reservation_manage",
      title: "ניהול הזמנה",
      token,
      reservation: fresh,
      restaurant: restaurant ? { ...restaurant, photos } : null,
      flash,
      suggestions: [], // אין שינוי מועד
      allowConfirm,
      allowCancel,
    });
  };

  if (action === "confirm") {
    if (reservation.status === "canceled") {
      await renderBack({ error: "ההזמנה מבוטלת — לא ניתן לאשר." });
      return;
    }
    if (reservation.status === "confirmed") {
      await renderBack({ ok: "ההזמנה כבר מאושרת." });
      return;
    }
    await updateReservation(reservation.id, { status: "confirmed" as Reservation["status"] }).catch(() => {});
    await renderBack({ ok: "ההגעה אושרה. נתראה!" });
    return;
  }

  if (action === "cancel") {
    if (reservation.status === "canceled") {
      await renderBack({ ok: "ההזמנה כבר בוטלה." });
      return;
    }
    await updateReservation(reservation.id, { status: "canceled" as Reservation["status"] }).catch(() => {});
    await renderBack({ ok: "ההזמנה בוטלה." });
    return;
  }

  // אין יותר reschedule כאן
  await renderBack({ error: "פעולה לא מוכרת" });
});

export { reservationPortal };
export default reservationPortal;
