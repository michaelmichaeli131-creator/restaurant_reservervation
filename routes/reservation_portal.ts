// src/routes/reservation_portal.ts
// דף ניהול הזמנה דרך קישור בטוח במייל:
// רנדר של reservation_manage.eta (אין יותר שינוי מועד).

import { Router, Status } from "jsr:@oak/oak";
import { verifyReservationToken } from "../lib/token.ts";
import { getRestaurant } from "../database.ts";
import { render } from "../lib/view.ts";

// נטען פונקציות DB באופן חסין (בפרויקטים שונים שמות קצת שונים)
type Reservation = {
  id: string;
  restaurantId: string;
  userId: string;
  date: string;
  time: string;
  people: number;
  status: "new" | "confirmed" | "canceled" | string;
  note?: string;
  createdAt?: number;
};

type DBExtra = Partial<{
  getReservation: (id: string) => Promise<Reservation | null>;
  getReservationById: (id: string) => Promise<Reservation | null>;
  updateReservation: (id: string, patch: Partial<Reservation>) => Promise<Reservation | null>;
  setReservationStatus: (id: string, status: string) => Promise<boolean>;
}>;

let _db: DBExtra | null = null;
async function db(): Promise<DBExtra> {
  if (_db) return _db;
  const mod = await import("../database.ts");
  _db = {
    getReservation: (mod as any).getReservation,
    getReservationById: (mod as any).getReservationById ?? (mod as any).getReservation,
    updateReservation: (mod as any).updateReservation,
    setReservationStatus: (mod as any).setReservationStatus,
  };
  return _db!;
}

export const reservationPortal = new Router();

/* ---------------- Small utils ---------------- */

function canConfirm(status: string | undefined): boolean {
  return status !== "confirmed" && status !== "canceled";
}
function canCancel(status: string | undefined): boolean {
  return status !== "canceled";
}
async function patchReservation(
  id: string,
  patch: Partial<Reservation>,
  helpers: DBExtra,
): Promise<boolean> {
  const { updateReservation, setReservationStatus } = helpers;
  if (typeof updateReservation === "function") {
    const res = await updateReservation(id, patch);
    return !!res;
  }
  if (typeof setReservationStatus === "function" && patch.status) {
    return await setReservationStatus(id, String(patch.status));
  }
  return false;
}
async function readAction(ctx: any): Promise<string> {
  // פעולה יכולה להגיע ב-query (?action=...) או כ-field בטופס.
  const q = (ctx.request.url.searchParams.get("action") ?? "").toLowerCase();
  if (q) return q;
  try {
    // Oak החדשה: formData()
    const fd = await ctx.request.formData();
    const a = String(fd.get("action") ?? "").toLowerCase();
    if (a) return a;
  } catch { /* ignore */ }
  try {
    // fallback: טקסט/urlencoded
    const t: string = await (ctx.request as any).text?.();
    if (t) {
      const sp = new URLSearchParams(t);
      const a = String(sp.get("action") ?? "").toLowerCase();
      if (a) return a;
    }
  } catch { /* ignore */ }
  return "";
}

/* ---------------- GET: תצוגה ---------------- */

reservationPortal.get("/r/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Invalid or expired link";
    return;
  }

  const { getReservation, getReservationById } = await db();
  const getRes = getReservationById ?? getReservation;
  if (typeof getRes !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "getReservationById/getReservation is not implemented in database.ts";
    return;
  }

  const reservation = await getRes(payload.rid);
  if (!reservation) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Reservation not found";
    return;
  }

  const restaurant = await getRestaurant(reservation.restaurantId).catch(() => null);
  const photos = Array.isArray((restaurant as any)?.photos)
    ? (restaurant as any).photos.map((p: any) => (typeof p === "string" ? p : String(p?.dataUrl || ""))).filter(Boolean)
    : [];

  const allowConfirm = canConfirm(reservation.status);
  const allowCancel = canCancel(reservation.status);

  await render(ctx, "reservation_manage", {
    page: "reservation_manage",
    title: "ניהול הזמנה",
    token,
    reservation,
    restaurant: restaurant ? { ...restaurant, photos } : null,
    flash: null,
    suggestions: [],   // אין שינוי מועד
    allowConfirm,
    allowCancel,
  });
});

/* ---------------- POST: פעולות (אישור/ביטול בלבד) ---------------- */

reservationPortal.post("/r/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();
  const payload = await verifyReservationToken(token);
  if (!payload) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = "Invalid or expired link";
    return;
  }

  const helpers = await db();
  const { getReservation, getReservationById } = helpers;
  const getRes = getReservationById ?? getReservation;
  if (typeof getRes !== "function") {
    ctx.response.status = Status.NotImplemented;
    ctx.response.body = "getReservationById/getReservation is not implemented in database.ts";
    return;
  }

  const reservation = await getRes(payload.rid);
  if (!reservation) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Reservation not found";
    return;
  }

  const restaurant = await getRestaurant(reservation.restaurantId).catch(() => null);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }
  const photos = Array.isArray((restaurant as any)?.photos)
    ? (restaurant as any).photos.map((p: any) => (typeof p === "string" ? p : String(p?.dataUrl || ""))).filter(Boolean)
    : [];

  const action = await readAction(ctx);

  async function renderBack(flash: any) {
    const fresh = await getRes(payload.rid);
    const allowConfirm = canConfirm(fresh?.status);
    const allowCancel  = canCancel(fresh?.status);
    await render(ctx, "reservation_manage", {
      page: "reservation_manage",
      title: "ניהול הזמנה",
      token,
      reservation: fresh,
      restaurant: { ...restaurant, photos },
      flash,
      suggestions: [], // אין שינוי מועד
      allowConfirm,
      allowCancel,
    });
  }

  if (action === "confirm") {
    if (reservation.status === "canceled") {
      await renderBack({ error: "ההזמנה מבוטלת ולא ניתן לאשר אותה." });
      return;
    }
    if (reservation.status === "confirmed") {
      await renderBack({ ok: "ההזמנה כבר מאושרת." });
      return;
    }
    const ok = await patchReservation(reservation.id, { status: "confirmed" }, helpers);
    if (!ok) {
      ctx.response.status = Status.NotImplemented;
      ctx.response.body = "updateReservation/setReservationStatus is not implemented.";
      return;
    }
    await renderBack({ ok: "ההגעה אושרה. נתראה!" });
    return;
  }

  if (action === "cancel") {
    if (reservation.status === "canceled") {
      await renderBack({ ok: "ההזמנה כבר בוטלה." });
      return;
    }
    const ok = await patchReservation(reservation.id, { status: "canceled" }, helpers);
    if (!ok) {
      ctx.response.status = Status.NotImplemented;
      ctx.response.body = "updateReservation/setReservationStatus is not implemented.";
      return;
    }
    await renderBack({ ok: "ההזמנה בוטלה." });
    return;
  }

  // אין יותר reschedule, וכל פעולה אחרת תיחשב לא מוכרת
  await renderBack({ error: "פעולה לא מוכרת" });
});

export default reservationPortal;
