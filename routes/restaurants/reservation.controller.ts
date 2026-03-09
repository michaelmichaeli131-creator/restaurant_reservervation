// src/routes/restaurants/reservation.controller.ts
import { Status } from "jsr:@oak/oak";
import {
  checkAvailability, checkRoomCapacity, createReservation, createReservationSafe, getRestaurant, getUserById,
  listSmartAvailabilitySuggestions,
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
import { listFloorLayouts } from "../../services/floor_service.ts";

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
  return "en";
}
function getT(ctx: any): (k: string, fb?: string) => string {
  const t = ctx.state?.t;
  if (typeof t === "function") return t;
  return (_k: string, fb?: string) => (fb ?? "");
}
function getDir(lang: string): "rtl" | "ltr" { return lang === "he" ? "rtl" : "ltr"; }
function appendLang(u: URL, lang: string) { if (lang) u.searchParams.set("lang", lang); return u; }
function tr(lang: string, values: { en: string; he: string; ka: string }): string {
  return lang === "he" ? values.he : lang === "ka" ? values.ka : values.en;
}
function trf(
  lang: string,
  values: { en: string; he: string; ka: string },
  vars: Record<string, string | number> = {},
): string {
  return tr(lang, values).replace(/\{(\w+)\}/g, (_m, key) => String(vars[key] ?? ""));
}
function paymentMethodLabel(lang: string, key: string): string {
  switch (key) {
    case "stripe":
      return tr(lang, { en: "Card Payment (Stripe)", he: "תשלום בכרטיס (Stripe)", ka: "ბარათით გადახდა (Stripe)" });
    case "sumup":
      return tr(lang, { en: "SumUp", he: "SumUp", ka: "SumUp" });
    case "paypal":
      return tr(lang, { en: "PayPal", he: "PayPal", ka: "PayPal" });
    case "revolut":
      return tr(lang, { en: "Revolut", he: "Revolut", ka: "Revolut" });
    default:
      return key;
  }
}

/* ====================== API: availability check ====================== */
export async function checkApi(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) { ctx.response.status = Status.NotFound; ctx.response.body = "restaurant not found"; return; }

  const { payload, dbg } = await readBody(ctx);
  const { date, time } = extractDateAndTime(ctx, payload);
  const people = toIntLoose((payload as any).people) ?? 2;
  const preferredLayoutId = String((payload as any).preferredLayoutId ?? "").trim();

  const hasDay = hasScheduleForDate(restaurant.weeklySchedule, date);
  const windows = getWindowsForDate(restaurant.weeklySchedule, date);
  const within = isWithinSchedule(restaurant.weeklySchedule, date, time);

  debugLog("[restaurants][POST /api/.../check] input", {
    rid, date, time, people, preferredLayoutId,
    body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : [],
    hasDay, windows, within
  });

  const bad = (m: string) => {
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg }, null, 2);
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad date (YYYY-MM-DD expected)");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("bad time (HH:mm expected)");

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.body = JSON.stringify({ ok:false, reason: hasDay ? "closed" : "unspecified", suggestions }, null, 2);
    return;
  }

  const layouts = await listFloorLayouts(rid).catch(() => []);
  const hasRooms = layouts.length > 0;
  const roomSuggestions = await listSmartAvailabilitySuggestions(rid, date, time, people, preferredLayoutId, 8);

  if (hasRooms && !preferredLayoutId) {
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.body = JSON.stringify({ ok: false, reason: "room_required", suggestions: roomSuggestions }, null, 2);
    return;
  }

  if (preferredLayoutId) {
    const roomCheck = await checkRoomCapacity(rid, preferredLayoutId, date, time, people);
    if (!roomCheck.ok) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.headers.set("Cache-Control", "no-store");
      ctx.response.body = JSON.stringify({
        ok: false,
        reason: "room_full",
        roomLabel: roomCheck.roomLabel,
        capacity: roomCheck.capacity,
        alreadyBooked: roomCheck.alreadyBooked,
        remaining: roomCheck.remaining,
        suggestions: roomSuggestions,
      }, null, 2);
      return;
    }
  }

  const result = await checkAvailability(rid, date, time, people);
  const around = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.headers.set("Cache-Control", "no-store");
  if (asOk(result)) {
    ctx.response.body = JSON.stringify({
      ok: true,
      scope: preferredLayoutId ? "room" : "restaurant",
      availableSlots: preferredLayoutId ? roomSuggestions : around.slice(0,4),
    }, null, 2);
  } else {
    const reason = (result as any)?.reason ?? "unavailable";
    ctx.response.body = JSON.stringify({
      ok: false,
      reason,
      suggestions: preferredLayoutId ? roomSuggestions : around.slice(0,4),
    }, null, 2);
  }
}

/* ====================== GET /api/restaurants/:id/room-occupancy ====================== */
export async function roomOccupancyApi(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const sp = ctx.request.url.searchParams;
  const layoutId = (sp.get("layoutId") ?? "").trim();
  const date = (sp.get("date") ?? "").trim();
  const time = (sp.get("time") ?? "").trim();
  const people = Math.max(1, Number(sp.get("people") ?? "1") || 1);

  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  if (!layoutId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = JSON.stringify({ ok: false, error: "layoutId, date (YYYY-MM-DD), time (HH:mm) required" });
    return;
  }

  const result = await checkRoomCapacity(rid, layoutId, date, time, people);
  ctx.response.body = JSON.stringify({
    ok: true,
    capacity: result.capacity,
    alreadyBooked: result.alreadyBooked,
    remaining: result.remaining,
    roomLabel: result.roomLabel,
    roomFull: !result.ok,
  });
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
    ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "Please select a valid date and time", he: "נא לבחור תאריך ושעה תקינים", ka: "გთხოვთ აირჩიოთ სწორი თარიღი და დრო" }) }, null, 2);
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

  const preferredLayoutId = String((payload as any).preferredLayoutId ?? "").trim();

  // Per-room capacity check — redirect back with room_full message
  if (preferredLayoutId) {
    const roomCheck = await checkRoomCapacity(rid, preferredLayoutId, date, time, people);
    if (!roomCheck.ok) {
      const url = new URL(`/restaurants/${encodeURIComponent(rid)}`, "http://local");
      url.searchParams.set("conflict", "1");
      url.searchParams.set("room_full", roomCheck.roomLabel);
      url.searchParams.set("date", date);
      url.searchParams.set("time", time);
      url.searchParams.set("people", String(people));
      appendLang(url, lang);
      ctx.response.status = Status.SeeOther;
      ctx.response.headers.set("Location", url.pathname + url.search);
      return;
    }
  }

  const u = new URL(`/restaurants/${encodeURIComponent(rid)}/details`, "http://local");
  u.searchParams.set("date", date);
  u.searchParams.set("time", time);
  u.searchParams.set("people", String(people));
  if (preferredLayoutId) u.searchParams.set("preferredLayoutId", preferredLayoutId);
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
  const preferredLayoutId = ctx.request.url.searchParams.get("preferredLayoutId") ?? "";

  debugLog("[restaurants][GET details]", {
    id, date, time, people, preferredLayoutId,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const photos = photoStrings(restaurant.photos);

  // i18n context
  const lang = ctx.state?.lang ?? getLang(ctx);
  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  // Deposit info for display
  const hasDeposit = canAcceptDeposits(restaurant);
  const depositAmount = hasDeposit ? (restaurant.depositAmount || 0) / 100 : null;
  const depositCurrency = restaurant.depositCurrency || 'EUR';
  const currencySymbols: Record<string, string> = { EUR: '€', GBP: '£', USD: '$' };

  await render(ctx, "reservation_details", {
    page: "details",
    lang, dir, t,
    title: `${t("details.header.title","Reservation Details")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos, openingHours: restaurant.weeklySchedule },
    date, time, people,
    // Deposit info
    hasDeposit,
    depositAmount,
    depositCurrency,
    depositSymbol: currencySymbols[depositCurrency] || '€',
    preferredLayoutId,
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
  const preferredLayoutId = (sp.get("preferredLayoutId") ?? "").trim();

  const customerName  = normalizePlain(customerNameRaw ?? "");
  const customerPhone = normalizePlain(customerPhoneRaw ?? "");
  const emailRaw = String(customerEmailRaw ?? "");
  const customerEmail = sanitizeEmailMinimal(emailRaw);
  const customerNote = sanitizeNote(customerNoteRaw);
  const lang = ctx.state?.lang ?? getLang(ctx);

  debugLog("[restaurants][GET confirm] input", {
    rid, date, time, people, within, preferredLayoutId,
    hasNote: !!customerNote, noteLen: customerNote.length,
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const bad = (m: string, extra?: unknown) => {
    const dbgObj = { ct: "querystring", phases: [], keys: Array.from(sp.keys()), extra };
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: dbgObj }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(tr(lang, { en: "Invalid date", he: "תאריך לא תקין", ka: "არასწორი თარიღი" }));
  if (!/^\d{2}:\d{2}$/.test(time))       return bad(tr(lang, { en: "Invalid time", he: "שעה לא תקינה", ka: "არასწორი დრო" }));
  if (people < 1 || people > 100)        return bad(tr(lang, { en: "Invalid guest count (1-100)", he: "מספר סועדים לא תקין (1-100)", ka: "სტუმრების რაოდენობა არასწორია (1-100)" }));
  if (!customerName)                     return bad(tr(lang, { en: "Please enter your name", he: "נא להזין שם", ka: "გთხოვთ მიუთითოთ სახელი" }));
  if (customerName.length > 100)         return bad(tr(lang, { en: "Name is too long (up to 100 characters)", he: "שם ארוך מדי (עד 100 תווים)", ka: "სახელი ძალიან გრძელია (მაქს. 100 სიმბოლო)" }));
  if (customerNote.length > 500)         return bad(tr(lang, { en: "Note is too long (up to 500 characters)", he: "הערה ארוכה מדי (עד 500 תווים)", ka: "შენიშვნა ძალიან გრძელია (მაქს. 500 სიმბოლო)" }));
  if (!customerPhone && !customerEmail)  return bad(tr(lang, { en: "Please enter a phone number or email", he: "נא להזין טלפון או אימייל", ka: "გთხოვთ მიუთითოთ ტელეფონი ან ელფოსტა" }));
  if (customerEmail && !isValidEmailStrict(customerEmail))
    return bad(tr(lang, { en: "Please enter a valid email", he: "נא להזין אימייל תקין", ka: "გთხოვთ მიუთითოთ სწორი ელფოსტა" }), { customerEmail });

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "The restaurant is closed at the selected time", he: "המסעדה סגורה בשעה שנבחרה", ka: "რესტორანი დახურულია არჩეულ დროს" }), suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "No availability at your selected time", he: "אין זמינות במועד שבחרת", ka: "არჩეულ დროს თავისუფალი ადგილი არ არის" }), suggestions }, null, 2);
    return;
  }

  // Per-room capacity check
  if (preferredLayoutId) {
    const roomCheck = await checkRoomCapacity(rid, preferredLayoutId, date, time, people);
    if (!roomCheck.ok) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: trf(lang, { en: "The selected room \"{room}\" is full at this time", he: "החלל \"{room}\" מלא במועד שבחרת", ka: "არჩეული სივრცე \"{room}\" ამ დროს სავსეა" }, { room: roomCheck.roomLabel }) }, null, 2);
      return;
    }
  }

  // --- יצירת הזמנה ושמירתה ---
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
  const reservationNote = [
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`,
    `Email: ${customerEmail}`,
    ...(preferredLayoutId ? [`PreferredRoomId: ${preferredLayoutId}`] : []),
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
    ...(preferredLayoutId ? { preferredLayoutId } : {}),
    createdAt: Date.now(),
  };
  try {
    await createReservationSafe(reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "room_full") {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "There is not enough space in the selected room at this time", he: "אין מספיק מקום בחדר שבחרת במועד הזה", ka: "არჩეულ სივრცეში ამ დროს საკმარისი ადგილი არ არის" }) }, null, 2);
      return;
    }
    if (message === "no_availability") {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "No availability at your selected time", he: "אין זמינות במועד שבחרת", ka: "არჩეულ დროს თავისუფალი ადგილი არ არის" }) }, null, 2);
      return;
    }
    throw error;
  }

  // --- שפה/קישורי ניהול (רב-לשוני) ---
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
      lang,
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
    title: `${t("confirm.header.title","Reservation Confirmed ✔")} — ${restaurant.name}`,
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
  const preferredLayoutIdPost = String((payload as any).preferredLayoutId ?? ctx.request.url.searchParams.get("preferredLayoutId") ?? "").trim();

  debugLog("[restaurants][POST confirm] input", {
    rid, date, time, people, preferredLayoutId: preferredLayoutIdPost,
    within, hasNote: !!customerNoteRaw, body_ct: dbg.ct, body_keys: Object.keys(payload),
    weeklyKeys: restaurant.weeklySchedule ? Object.keys(restaurant.weeklySchedule as any) : []
  });

  const customerName  = normalizePlain(customerNameRaw);
  const customerPhone = normalizePlain(customerPhoneRaw);
  const emailRaw = String(customerEmailRaw ?? "");
  const customerEmail = sanitizeEmailMinimal(emailRaw);
  const customerNote = sanitizeNote(customerNoteRaw);
  const lang = ctx.state?.lang ?? getLang(ctx);

  const bad = (m: string, extra?: unknown) => {
    const keys = Object.keys(payload ?? {});
    const dbg2 = { ...dbg, keys };
    if (extra) (dbg2 as any).extra = extra;
    ctx.response.status = Status.BadRequest;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok:false, error:m, dbg: dbg2 }, null, 2);
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(tr(lang, { en: "Invalid date", he: "תאריך לא תקין", ka: "არასწორი თარიღი" }));
  if (!/^\d{2}:\d{2}$/.test(time))       return bad(tr(lang, { en: "Invalid time", he: "שעה לא תקינה", ka: "არასწორი დრო" }));
  if (people < 1 || people > 100)        return bad(tr(lang, { en: "Invalid guest count (1-100)", he: "מספר סועדים לא תקין (1-100)", ka: "სტუმრების რაოდენობა არასწორია (1-100)" }));
  if (!customerName)                     return bad(tr(lang, { en: "Please enter your name", he: "נא להזין שם", ka: "გთხოვთ მიუთითოთ სახელი" }));
  if (customerName.length > 100)         return bad(tr(lang, { en: "Name is too long (up to 100 characters)", he: "שם ארוך מדי (עד 100 תווים)", ka: "სახელი ძალიან გრძელია (მაქს. 100 სიმბოლო)" }));
  if (customerNote.length > 500)         return bad(tr(lang, { en: "Note is too long (up to 500 characters)", he: "הערה ארוכה מדי (עד 500 תווים)", ka: "შენიშვნა ძალიან გრძელია (მაქს. 500 სიმბოლო)" }));
  if (!customerPhone && !customerEmail)  return bad(tr(lang, { en: "Please enter a phone number or email", he: "נא להזין טלפון או אימייל", ka: "გთხოვთ მიუთითოთ ტელეფონი ან ელფოსტა" }));
  if (customerEmail && !isValidEmailStrict(customerEmail)) return bad(tr(lang, { en: "Please enter a valid email", he: "נא להזין אימייל תקין", ka: "გთხოვთ მიუთითოთ სწორი ელფოსტა" }), { customerEmail, note: "strict check" });

  if (!within) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "The restaurant is closed at the selected time", he: "המסעדה סגורה בשעה שנבחרה", ka: "რესტორანი დახურულია არჩეულ დროს" }), suggestions }, null, 2);
    return;
  }

  const avail = await checkAvailability(rid, date, time, people);
  if (!asOk(avail)) {
    const suggestions = await suggestionsWithinSchedule(rid, date, time, people, restaurant.weeklySchedule);
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.status = Status.Conflict;
    ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "No availability at your selected time", he: "אין זמינות במועד שבחרת", ka: "არჩეულ დროს თავისუფალი ადგილი არ არის" }), suggestions }, null, 2);
    return;
  }

  // Per-room capacity check
  if (preferredLayoutIdPost) {
    const roomCheck = await checkRoomCapacity(rid, preferredLayoutIdPost, date, time, people);
    if (!roomCheck.ok) {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: trf(lang, { en: "The selected room \"{room}\" is full at this time", he: "החלל \"{room}\" מלא במועד שבחרת", ka: "არჩეული სივრცე \"{room}\" ამ დროს სავსეა" }, { room: roomCheck.roomLabel }) }, null, 2);
      return;
    }
  }

  // --- Check if deposit payment is required ---
  if (canAcceptDeposits(restaurant)) {
    // Encode customer data into token and redirect to payment page
    const token = encodePaymentToken({
      rid,
      date,
      time,
      people,
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
      note: customerNote,
      preferredLayoutId: preferredLayoutIdPost || undefined,
      ts: Date.now(),
    });
    const lang = ctx.state?.lang ?? getLang(ctx);
    const paymentUrl = new URL(`/restaurants/${rid}/payment`, ctx.request.url.origin);
    paymentUrl.searchParams.set("token", token);
    appendLang(paymentUrl, lang);
    ctx.response.redirect(paymentUrl.toString());
    return;
  }

  // --- יצירת הזמנה ושמירתה (no deposit required) ---
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
  const reservationNote = [
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`,
    `Email: ${customerEmail}`,
    ...(preferredLayoutIdPost ? [`PreferredRoomId: ${preferredLayoutIdPost}`] : []),
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
    ...(preferredLayoutIdPost ? { preferredLayoutId: preferredLayoutIdPost } : {}),
    createdAt: Date.now(),
  };
  try {
    await createReservationSafe(reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "room_full") {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "There is not enough space in the selected room at this time", he: "אין מספיק מקום בחדר שבחרת במועד הזה", ka: "არჩეულ სივრცეში ამ დროს საკმარისი ადგილი არ არის" }) }, null, 2);
      return;
    }
    if (message === "no_availability") {
      ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ ok:false, error: tr(lang, { en: "No availability at your selected time", he: "אין זמינות במועד שבחרת", ka: "არჩეულ დროს თავისუფალი ადგილი არ არის" }) }, null, 2);
      return;
    }
    throw error;
  }

  // --- שפה/קישורי ניהול (רב-לשוני) ---
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
      lang,
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
    title: `${t("confirm.header.title","Reservation Confirmed ✔")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos },
    date, time, people,
    customerName, customerPhone, customerEmail,
    reservationId: reservation.id,
    note: customerNote,
  });
}

/* ====================== Payment Token Helpers ====================== */
interface PaymentTokenData {
  rid: string;
  date: string;
  time: string;
  people: number;
  name: string;
  phone: string;
  email: string;
  note: string;
  preferredLayoutId?: string;
  ts: number; // timestamp for expiry
}

function encodePaymentToken(data: PaymentTokenData): string {
  const json = JSON.stringify(data);
  // Base64 encode (URL-safe)
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodePaymentToken(token: string): PaymentTokenData | null {
  try {
    // Restore base64 padding and decode
    let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = atob(b64);
    const data = JSON.parse(json);
    // Check expiry (1 hour)
    if (Date.now() - data.ts > 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// Check if restaurant has deposits enabled and configured
function canAcceptDeposits(restaurant: { depositEnabled?: boolean; depositAmount?: number; paymentMethods?: any }): boolean {
  if (!restaurant.depositEnabled) return false;
  if (!restaurant.depositAmount || restaurant.depositAmount <= 0) return false;
  const pm = restaurant.paymentMethods;
  if (!pm) return false;
  return !!(pm.stripePaymentLink || pm.sumupPaymentLink || pm.paypalMe || pm.revolutLink);
}

// Get enabled payment methods with normalized URLs
function getEnabledPaymentMethods(restaurant: { paymentMethods?: any; depositAmount?: number; depositCurrency?: string }, lang: string) {
  const pm = restaurant.paymentMethods || {};
  const methods: { key: string; label: string; url: string }[] = [];
  const amount = (restaurant.depositAmount || 0) / 100;
  const currency = restaurant.depositCurrency || 'EUR';

  if (pm.stripePaymentLink) {
    methods.push({ key: 'stripe', label: paymentMethodLabel(lang, 'stripe'), url: pm.stripePaymentLink });
  }
  if (pm.sumupPaymentLink) {
    methods.push({ key: 'sumup', label: paymentMethodLabel(lang, 'sumup'), url: pm.sumupPaymentLink });
  }
  if (pm.paypalMe) {
    let url = pm.paypalMe;
    if (!url.startsWith('http')) {
      url = `https://paypal.me/${url.replace(/^@/, '')}/${amount}${currency}`;
    }
    methods.push({ key: 'paypal', label: paymentMethodLabel(lang, 'paypal'), url });
  }
  if (pm.revolutLink) {
    let url = pm.revolutLink;
    if (!url.startsWith('http')) {
      url = `https://revolut.me/${url.replace(/^@/, '')}`;
    }
    methods.push({ key: 'revolut', label: paymentMethodLabel(lang, 'revolut'), url });
  }

  return methods;
}

/* ====================== GET /restaurants/:id/payment ====================== */
export async function paymentGet(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "Restaurant not found", he: "המסעדה לא נמצאה", ka: "რესტორანი ვერ მოიძებნა" });
    return;
  }

  const sp = ctx.request.url.searchParams;
  const token = sp.get("token") || "";
  const tokenData = decodePaymentToken(token);

  if (!tokenData || tokenData.rid !== rid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "Invalid or expired payment session", he: "סשן התשלום לא תקין או שפג תוקפו", ka: "გადახდის სესია არასწორია ან ვადა გაუვიდა" });
    return;
  }

  // Double-check deposits are still enabled
  if (!canAcceptDeposits(restaurant)) {
    // Redirect to confirm without payment
    const confirmUrl = new URL(`/restaurants/${rid}/confirm`, ctx.request.url.origin);
    confirmUrl.searchParams.set("date", tokenData.date);
    confirmUrl.searchParams.set("time", tokenData.time);
    confirmUrl.searchParams.set("people", String(tokenData.people));
    confirmUrl.searchParams.set("name", tokenData.name);
    confirmUrl.searchParams.set("phone", tokenData.phone);
    confirmUrl.searchParams.set("email", tokenData.email);
    confirmUrl.searchParams.set("note", tokenData.note);
    if (tokenData.preferredLayoutId) confirmUrl.searchParams.set("preferredLayoutId", tokenData.preferredLayoutId);
    appendLang(confirmUrl, ctx.state?.lang ?? getLang(ctx));
    ctx.response.redirect(confirmUrl.toString());
    return;
  }

  const lang = ctx.state?.lang ?? getLang(ctx);
  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  const photos = photoStrings(restaurant.photos);
  const paymentMethods = getEnabledPaymentMethods(restaurant, lang);

  await render(ctx, "reservation_payment", {
    page: "payment",
    lang, dir, t,
    title: `${t("payment.header.title", "Complete Your Deposit")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos },
    date: tokenData.date,
    time: tokenData.time,
    people: tokenData.people,
    name: tokenData.name,
    phone: tokenData.phone,
    email: tokenData.email,
    note: tokenData.note,
    token,
    depositAmount: (restaurant.depositAmount || 0) / 100,
    depositCurrency: restaurant.depositCurrency || 'EUR',
    paymentMethods,
  });
}

/* ====================== GET /restaurants/:id/confirm-payment ====================== */
export async function confirmPaymentGet(ctx: any) {
  const rid = String(ctx.params.id ?? "");
  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "Restaurant not found", he: "המסעדה לא נמצאה", ka: "რესტორანი ვერ მოიძებნა" });
    return;
  }

  const sp = ctx.request.url.searchParams;
  const token = sp.get("token") || "";
  const paymentMethod = sp.get("paymentMethod") || "";
  const tokenData = decodePaymentToken(token);

  if (!tokenData || tokenData.rid !== rid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "Invalid or expired payment session", he: "סשן התשלום לא תקין או שפג תוקפו", ka: "გადახდის სესია არასწორია ან ვადა გაუვიდა" });
    return;
  }

  // Validate payment method
  const validMethods = ["stripe", "sumup", "paypal", "revolut"];
  if (!validMethods.includes(paymentMethod)) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "Invalid payment method", he: "אמצעי התשלום לא תקין", ka: "გადახდის მეთოდი არასწორია" });
    return;
  }

  // Re-check availability
  const avail = await checkAvailability(rid, tokenData.date, tokenData.time, tokenData.people);
  if (!asOk(avail)) {
    ctx.response.status = Status.Conflict;
    ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "The selected time slot is no longer available", he: "השעה שנבחרה כבר אינה זמינה", ka: "არჩეული დრო უკვე აღარ არის ხელმისაწვდომი" });
    return;
  }

  if (tokenData.preferredLayoutId) {
    const roomCheck = await checkRoomCapacity(rid, tokenData.preferredLayoutId, tokenData.date, tokenData.time, tokenData.people);
    if (!roomCheck.ok) {
      ctx.response.status = Status.Conflict;
      ctx.response.body = trf(ctx.state?.lang ?? getLang(ctx), { en: "The selected room \"{room}\" is full at this time", he: "החלל \"{room}\" מלא במועד זה", ka: "არჩეული სივრცე \"{room}\" ამ დროს სავსეა" }, { room: roomCheck.roomLabel });
      return;
    }
  }

  // --- Create reservation with deposit status ---
  const user = (ctx.state as any)?.user ?? null;
  const userId: string = user?.id ?? `guest:${crypto.randomUUID().slice(0, 8)}`;
  const reservationNote = [
    `Name: ${tokenData.name}`,
    `Phone: ${tokenData.phone}`,
    `Email: ${tokenData.email}`,
    ...(tokenData.preferredLayoutId ? [`PreferredRoomId: ${tokenData.preferredLayoutId}`] : []),
    ...(tokenData.note ? [`Note: ${tokenData.note}`] : []),
  ].join("; ");

  const hasDeposit = canAcceptDeposits(restaurant);
  const reservation: Reservation = {
    id: crypto.randomUUID(),
    restaurantId: rid,
    userId,
    date: tokenData.date,
    time: tokenData.time,
    people: tokenData.people,
    status: "new",
    note: reservationNote,
    ...(tokenData.preferredLayoutId ? { preferredLayoutId: tokenData.preferredLayoutId } : {}),
    // Payment tracking fields
    depositStatus: hasDeposit ? "pending" : "not_required",
    depositAmount: hasDeposit ? restaurant.depositAmount : undefined,
    depositCurrency: hasDeposit ? restaurant.depositCurrency : undefined,
    paymentMethod: hasDeposit ? (paymentMethod as any) : undefined,
    createdAt: Date.now(),
  };
  try {
    await createReservationSafe(reservation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "room_full") {
      ctx.response.status = Status.Conflict;
      ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "The selected room is full at this time", he: "החלל שנבחר מלא במועד זה", ka: "არჩეული სივრცე ამ დროს სავსეა" });
      return;
    }
    if (message === "no_availability") {
      ctx.response.status = Status.Conflict;
      ctx.response.body = tr(ctx.state?.lang ?? getLang(ctx), { en: "The selected time slot is no longer available", he: "השעה שנבחרה כבר אינה זמינה", ka: "არჩეული დრო უკვე აღარ არის ხელმისაწვდომი" });
      return;
    }
    throw error;
  }

  // --- Send emails ---
  const lang = ctx.state?.lang ?? getLang(ctx);
  const origin = (Deno.env.get("APP_BASE_URL") || Deno.env.get("BASE_URL") || `${ctx.request.url.protocol}//${ctx.request.url.host}`).replace(/\/+$/, "");
  const manageToken = await makeReservationToken(reservation.id, tokenData.email);
  const manageUrlBase = new URL(`/r/${encodeURIComponent(manageToken)}`, origin);
  appendLang(manageUrlBase, lang);
  const manageUrl = manageUrlBase.toString();

  if (tokenData.email) {
    await sendReservationEmail({
      to: tokenData.email,
      restaurantName: restaurant.name,
      date: tokenData.date,
      time: tokenData.time,
      people: tokenData.people,
      customerName: tokenData.name,
      manageUrl,
      reservationId: reservation.id,
      note: tokenData.note,
      lang,
    }).catch((e) => console.warn("[mail] sendReservationEmail failed:", e));
  }

  const owner = await getUserById(restaurant.ownerId).catch(() => null);
  if (owner?.email) {
    await notifyOwnerEmail({
      to: owner.email,
      restaurantName: restaurant.name,
      customerName: tokenData.name,
      customerPhone: tokenData.phone,
      customerEmail: tokenData.email,
      date: tokenData.date,
      time: tokenData.time,
      people: tokenData.people,
      lang,
    }).catch((e) => console.warn("[mail] notifyOwnerEmail failed:", e));
  }

  const photos = photoStrings(restaurant.photos);
  const t = getT(ctx);
  const dir = ctx.state?.dir ?? getDir(lang);

  await render(ctx, "reservation_confirmed", {
    page: "confirm",
    lang, dir, t,
    title: `${t("confirm.header.title", "Reservation Confirmed")} — ${restaurant.name}`,
    restaurant: { ...restaurant, photos },
    date: tokenData.date,
    time: tokenData.time,
    people: tokenData.people,
    customerName: tokenData.name,
    customerPhone: tokenData.phone,
    customerEmail: tokenData.email,
    reservationId: reservation.id,
    note: tokenData.note,
    // Payment info for display
    depositStatus: reservation.depositStatus,
    depositAmount: hasDeposit ? (restaurant.depositAmount || 0) / 100 : null,
    depositCurrency: restaurant.depositCurrency,
    paymentMethod,
  });
}
