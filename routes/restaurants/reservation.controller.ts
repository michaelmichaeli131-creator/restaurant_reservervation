// src/routes/restaurants/reservation.controller.ts
import { Status } from "jsr:@oak/oak";
import {
  checkAvailability, createReservation, getRestaurant, getUserById,
  type Reservation,
} from "../../database.ts";
import { render } from "../../lib/view.ts";
import { sendReservationEmail, notifyOwnerEmail } from "../../lib/mail.ts";
import { debugLog } from "../../lib/debug.ts";
import { makeReservationToken } from "../../lib/token.ts";
import { todayISO, normalizeDate, normalizeTime, toIntLoose, pickNonEmpty } from "./_utils/datetime.ts";
import { readBody, extractDateAndTime } from "./_utils/body.ts";
import { isWithinSchedule, hasScheduleForDate, getWindowsForDate, suggestionsWithinSchedule } from "./_utils/hours.ts";
import { normalizePlain, sanitizeEmailMinimal, sanitizeNote, isValidEmailStrict } from "./_utils/rtl.ts";
import { asOk, photoStrings } from "./_utils/misc.ts";

/* ====================== i18n helpers ====================== */
function getLang(ctx: any): string {
  const q = ctx.request.url.searchParams.get("lang");
  if (q) return q;
  const c = ctx.cookies?.get?.("lang");
  if (c) return c;
  const al = ctx.request.headers.get("accept-language") || "";
  if (/^en/i.test(al)) return "en";
  if (/^ka/i.test(al)) return "ka";
  if (/^he/i.test(al)) return "he";
  return "he";
}
function getT(ctx: any): (k: string, fb?: string) => string {
  const t = ctx.state?.t;
  if (typeof t === "function") return t;
  return (_k: string, fb?: string) => (fb ?? "");
}
function getDir(lang: string): "rtl" | "ltr" { return lang === "he" ? "rtl" : "ltr"; }
function appendLang(u: URL, lang: string) { if (lang) u.searchParams.set("lang", lang); return u; }

/* ====================== API: availability check ====================== */
export async function checkApi(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = toIntLoose((payload as any).people) ?? 2;

  const hasDay = hasScheduleForDate(restaurant.weeklySchedule, date);
  const windows = getWindowsForDate(restaurant.weeklySchedule, date);
  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);

  debugLog("[restaurants][POST /api/.../check] input", {
    rid, date, time, people,
    body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : [],
    hasDay, windows, within
  });

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, reason: hasDay ? "closed" : "unspecified", suggestions }, null, 2);
    return;
  }

  const result = await checkAvailability(rid, date, time, people);
  const around = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  if (asOk(result)) {
    ctx.response.body = JSON.stringify({ ok: true, availableSlots: around.slice(0,4) }, null, 2);
  } else {
    const reason = (result as any)?.reason ?? "unavailable";
    ctx.response.body = JSON.stringify({ ok: false, reason, suggestions: around.slice(0,4) }, null, 2);
  }
}

/* ====================== POST /restaurants/:id/reserve ====================== */
export async function reservePost(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = toIntLoose((payload as any).people) ?? 2;

  // i18n context & optional cookie
  const lang = ctx.state?.lang ?? getLang(ctx);
  if (ctx.request.url.searchParams.has("lang")) {
    await ctx.cookies?.set?.("lang", lang, { httpOnly: false, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
  }

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);
  debugLog("[restaurants][POST reserve] before-redirect", {
    rid, date, time, within, body_ct: dbg.ct,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    debugLog("[restaurants][POST reserve] invalid-format", { date, time, dbg });
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:"אנא בחר/י תאריך ושעה תקינים" }, null, 2);
    return;
  }

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (suggestions.length) url.searchParams.set("suggest", suggestions.join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    url.searchParams.set("people", String(people));
    appendLang(url, lang);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
    url.searchParams.set("conflict", "1");
    if (suggestions.length) url.searchParams.set("suggest", suggestions.join(","));
    url.searchParams.set("date", date);
    url.searchParams.set("time", time);
    url.searchParams.set("people", String(people));
    appendLang(url, lang);
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", url.pathname + url.search);
    return;
  }

  const u = new URL(`/restaurants/${encodeURIComponent(rid)}/details`, "http://local");
  u.searchParams.set("date", date);
  u.searchParams.set("time", time);
  u.searchParams.set("people", String(people));
  appendLang(u, lang);
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", u.pathname + u.search);
}

/* ====================== GET /restaurants/:id/details ====================== */
export async function detailsGet(ctx: any) {
  const id = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "Restaurant not found"; return; }

  const date = normalizeDate(ctx.request.url.searchParams.get("date") ?? "") || todayISO();
  const time = normalizeTime(ctx.request.url.searchParams.get("time") ?? "");
  const people = Number(ctx.request.url.searchParams.get("people") ?? "2") || 2;

  debugLog("[restaurants][GET details]", {
    id, date, time, people,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const photos = photoStrings(restaurant.photos);

  // i18n context
  const lang = ctx.state?.lang ?? getLang(ctx);
  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  await render(ctx, "reservation_details", {
    page: "details",
    lang, dir, t,
    title: `${t("details.header.title","פרטי הזמנה")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos, openingHours: restaurant.weeklySchedule },
    date, time, people,
  });
}

/* ====================== GET /restaurants/:id/confirm ====================== */
export async function confirmGet(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const sp = ctx.request.url.searchParams;
  const { date, time } = extractDateAndTime(ctx, Object.fromEntries(sp.entries()));
  const people = toIntLoose(sp.get("people")) ?? 2;

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);
  const customerNameRaw =
    sp.get("name") ?? sp.get("customerName") ?? sp.get("fullName") ?? sp.get("customer_name") ?? sp.get("full_name");
  const customerPhoneRaw =
    sp.get("phone") ?? sp.get("tel") ?? sp.get("customerPhone") ?? sp.get("customer_phone");
  const customerEmailRaw =
    sp.get("email") ?? sp.get("customerEmail") ?? sp.get("customer_email");
  const customerNoteRaw =
    sp.get("note") ?? sp.get("comments") ?? sp.get("special_requests") ?? sp.get("specialRequests") ?? "";

  const customerName  = normalizePlain(customerNameRaw ?? "");
  const customerPhone = normalizePlain(customerPhoneRaw ?? "");
  const emailRaw = String(customerEmailRaw ?? "");
  const customerEmail = sanitizeEmailMinimal(emailRaw);
  const customerNote = sanitizeNote(customerNoteRaw);

  debugLog("[restaurants][GET confirm] input", {
    rid, date, time, people, within,
    hasNote: !!customerNote, noteLen: customerNote.length,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const bad = (m: string, extra?: unknown) => {
    const dbgObj = { ct: "querystring", phases: [], keys: Array.from(sp.keys()), extra };
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: dbgObj }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time))       return bad("שעה לא תקינה");
  if (!customerName)                     return bad("נא להזין שם");
  if (!customerPhone && !customerEmail)  return bad("נא להזין טלפון או אימייל");
  if (customerEmail && !isValidEmailStrict(customerEmail))
    return bad("נא להזין אימייל תקין", { customerEmail });

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"המסעדה סגורה בשעה שנבחרה", suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions }, null, 2);
    return;
  }

  // --- יצירת הזמנה ושמירתה ---
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
  const reservationNote = [
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`,
    `Email: ${customerEmail}`,
    ...(customerNote ? [`Note: ${customerNote}`] : []),
  ].join("; ");

  const reservation: Reservation = {
    id: crypto.randomUUID(),
    restaurantId: rid,
    userId,
    date,
    time,
    people,
    status: "new",
    note: reservationNote,
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  // --- שפה/קישורי ניהול (רב-לשוני) ---
  const lang = ctx.state?.lang ?? getLang(ctx);
  const origin = (Deno.env.get("APP_BASE_URL") || Deno.env.get("BASE_URL") || `${ctx.request.url.protocol}//${ctx.request.url.host}`).replace(/\/+$/, "");
  const token = await makeReservationToken(reservation.id, customerEmail);
  const manageUrlBase = new URL(`/r/${encodeURIComponent(token)}`, origin);
  appendLang(manageUrlBase, lang);
  const manageUrl = manageUrlBase.toString();

  debugLog("[mail.to][GET confirm] about to sendReservationEmail", {
    reservationId: reservation.id,
    raw: emailRaw,
    final: customerEmail,
    lang,
  });

  if (customerEmail) {
    await sendReservationEmail({
      to: customerEmail,
      restaurantName: restaurant.name,
      date, time, people,
      customerName,
      manageUrl,
      reservationId: reservation.id,
      note: customerNote,
      lang, // ← חשוב: מייל לפי שפת ההקלקה
    }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));
  }

  const owner = await getUserById(restaurant.ownerId).catch(() => null);
  if (owner?.email) {
    await notifyOwnerEmail({
      to: owner.email,
      restaurantName: restaurant.name,
      customerName,
      customerPhone,
      customerEmail,
      date,
      time,
      people,
    }).catch((e) => console.warn("[mail] notifyOwnerEmail failed:", e));
  } else {
    console.log("[mail] owner email not found; skipping owner notification");
  }

  const photos = photoStrings(restaurant.photos);

  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  await render(ctx, "reservation_confirmed", {
    page: "confirm",
    lang, dir, t,
    title: `${t("confirm.header.title","הזמנה אושרה ✔")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos },
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
    note: customerNote,
  });
}

/* ====================== POST /restaurants/:id/confirm ====================== */
export async function confirmPost(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = toIntLoose(pickNonEmpty((payload as any).people, ctx.request.url.searchParams.get("people"))) ?? 2;

  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);

  const customerNameRaw  =
    (payload as any).name ?? (payload as any).customerName ?? (payload as any).fullName ??
    (payload as any)["customer_name"] ?? (payload as any)["full_name"];
  const customerPhoneRaw =
    (payload as any).phone ?? (payload as any).tel ?? (payload as any).customerPhone ?? (payload as any)["customer_phone"];
  const customerEmailRaw =
    (payload as any).email ?? (payload as any).customerEmail ?? (payload as any)["customer_email"];
  const customerNoteRaw =
    (payload as any).note ?? (payload as any).comments ?? (payload as any)["special_requests"] ?? (payload as any).specialRequests ?? "";

  debugLog("[restaurants][POST confirm] input", {
    rid, date, time, people,
    within, hasNote: !!customerNoteRaw, body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const customerName  = normalizePlain(customerNameRaw);
  const customerPhone = normalizePlain(customerPhoneRaw);
  const emailRaw = String(customerEmailRaw ?? "");
  const customerEmail = sanitizeEmailMinimal(emailRaw);
  const customerNote = sanitizeNote(customerNoteRaw);

  const bad = (m: string, extra?: unknown) => {
    const keys = Object.keys(payload ?? {});
    const dbg2 = { ...dbg, keys };
    if (extra) (dbg2 as any).extra = extra;
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: dbg2 }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("תאריך לא תקין");
  if (!/^\d{2}:\d{2}$/.test(time))       return bad("שעה לא תקינה");
  if (!customerName)                     return bad("נא להזין שם");
  if (!customerPhone && !customerEmail)  return bad("נא להזין טלפון או אימייל");
  if (customerEmail && !isValidEmailStrict(customerEmail)) return bad("נא להזין אימייל תקין", { customerEmail, note: "strict check" });

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"המסעדה סגורה בשעה שנבחרה", suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error:"אין זמינות במועד שבחרת", suggestions }, null, 2);
    return;
  }

  // --- יצירת הזמנה ושמירתה ---
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
  const reservationNote = [
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`,
    `Email: ${customerEmail}`,
    ...(customerNote ? [`Note: ${customerNote}`] : []),
  ].join("; ");

  const reservation: Reservation = {
    id: crypto.randomUUID(),
    restaurantId: rid,
    userId,
    date,
    time,
    people,
    status: "new",
    note: reservationNote,
    createdAt: Date.now(),
  };
  await createReservation(reservation);

  // --- שפה/קישורי ניהול (רב-לשוני) ---
  const lang = ctx.state?.lang ?? getLang(ctx);
  const origin = (Deno.env.get("APP_BASE_URL") || Deno.env.get("BASE_URL") || `${ctx.request.url.protocol}//${ctx.request.url.host}`).replace(/\/+$/, "");
  const token = await makeReservationToken(reservation.id, customerEmail);
  const manageUrlBase = new URL(`/r/${encodeURIComponent(token)}`, origin);
  appendLang(manageUrlBase, lang);
  const manageUrl = manageUrlBase.toString();

  debugLog("[mail.to][POST confirm] about to sendReservationEmail", {
    reservationId: reservation.id,
    raw: emailRaw,
    final: customerEmail,
    lang,
  });

  if (customerEmail) {
    await sendReservationEmail({
      to: customerEmail,
      restaurantName: restaurant.name,
      date, time, people,
      customerName,
      manageUrl,
      reservationId: reservation.id,
      note: customerNote,
      lang, // ← חשוב: מייל לפי שפת ההקלקה
    }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));
  }

  const owner = await getUserById(restaurant.ownerId).catch(() => null);
  if (owner?.email) {
    await notifyOwnerEmail({
      to: owner.email,
      restaurantName: restaurant.name,
      customerName, customerPhone, customerEmail,
      date, time, people,
    }).catch((e) => console.warn("[mail] notifyOwnerEmail failed:", e));
  } else {
    console.log("[mail] owner email not found; skipping owner notification");
  }

  const photos = photoStrings(restaurant.photos);

  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  await render(ctx, "reservation_confirmed", {
    page: "confirm",
    lang, dir, t,
    title: `${t("confirm.header.title","הזמנה אושרה ✔")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos },
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
    note: customerNote,
  });
}
