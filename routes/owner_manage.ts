// src/routes/owner_manage.ts
// דשבורד + עריכת פרטי מסעדה — בעלים בלבד
// - /owner/manage : דשבורד מסעדות עם קיצור ל-Calendar וסיכומים יומיים
// - /owner/restaurants/:id/edit : טופס עריכה (GET)
// - /owner/restaurants/:id/edit/save : שמירה ב-GET דרך url.searchParams (ללא body)
// - POST /owner/restaurants/:id/edit : תאימות לאחור → מפנה למסלול השמירה

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import {
  getRestaurant,
  updateRestaurant,
  listRestaurants,
  listReservationsFor,
  computeOccupancy,
  type Restaurant,
} from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

function trim(s?: string | null) { return (s ?? "").trim(); }
const pad2 = (n: number) => String(n).padStart(2, "0");
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const ownerManageRouter = new Router();

/* ───────────────────────── דשבורד בעלים ───────────────────────── */

ownerManageRouter.get("/owner/manage", async (ctx) => {
  // שמירה על דפוס האפליקציה: הפונקציה מחזירה false אם אין הרשאה וכבר כתבה תגובה
  if (!requireOwner(ctx)) return;

  const user = (ctx.state as any)?.user;
  const all = await listRestaurants("", /*onlyApproved*/ false);
  const mine = all.filter(r => r.ownerId === user.id);

  const date = ctx.request.url.searchParams.get("date") || todayISO();

  // מביאים סטטוסים יומיים (מס' הזמנות, סועדים, Peak Occupancy) + קישור ל-Calendar
  const restaurants = await Promise.all(mine.map(async (r) => {
    const reservations = await listReservationsFor(r.id, date);
    const peopleToday = reservations.reduce((acc, x) => acc + (x.people || 0), 0);
    const occMap = await computeOccupancy(r, date); // Map<HH:MM, usedSeats>
    let peakUsed = 0;
    for (const used of occMap.values()) peakUsed = Math.max(peakUsed, used);
    const capacity = Math.max(1, Number(r.capacity || 0));
    const peakPct = Math.min(100, Math.round((peakUsed / capacity) * 100));

    // Normalize photos so template can use .dataUrl if נשלח כמחרוזת
    const photos = Array.isArray(r.photos) ? r.photos : [];
    const normPhotos = photos.map((p: any) =>
      typeof p === "string" ? { dataUrl: p, alt: "" } : p
    );

    return {
      ...r,
      photos: normPhotos,
      _today: date,
      _reservationsCount: reservations.length,
      _peopleToday: peopleToday,
      _peakOccupancyPct: peakPct,
      _calendarUrl: `/owner/restaurants/${r.id}/calendar?date=${encodeURIComponent(date)}`,
    };
  }));

  await render(ctx, "owner_manage", {
    title: "דשבורד בעלים",
    page: "owner_manage",
    user,
    restaurants,
  });
});

/** הפניה נוחה לשורש אזור הבעלים */
ownerManageRouter.get("/owner", (ctx) => {
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", "/owner/manage");
});

/* ──────────────────────── טופס עריכת פרטים ─────────────────────── */

ownerManageRouter.get("/owner/restaurants/:id/edit", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  await render(ctx, "owner_restaurant_edit", {
    title: `עריכת פרטים — ${r.name}`,
    page: "owner_edit",
    restaurant: r,
    saved: ctx.request.url.searchParams.get("saved") === "1",
  });
});

// GET: שמירת פרטים (עוקף-פרסרים)
ownerManageRouter.get("/owner/restaurants/:id/edit/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  const sp = ctx.request.url.searchParams;

  // ניקוי וגבולות בסיסיים
  const getStr = (key: string, min = 0, max = 1000) => {
    if (!sp.has(key)) return undefined; // לא לגעת בשדה אם לא נשלח
    const v = trim(sp.get(key));
    if (v.length < min) return "";       // ערך קצר מדי → נחשב ריק
    return v.slice(0, max);
  };

  const patch: Partial<Restaurant> = {};
  const name = getStr("name", 1, 120);
  const city = getStr("city", 1, 80);
  const address = getStr("address", 1, 160);
  const phone = getStr("phone", 0, 40);
  const description = getStr("description", 0, 1000);

  if (typeof name !== "undefined") patch.name = name || r.name;
  if (typeof city !== "undefined") patch.city = city || r.city;
  if (typeof address !== "undefined") patch.address = address || r.address;
  if (typeof phone !== "undefined") patch.phone = phone || "";
  if (typeof description !== "undefined") patch.description = description || "";

  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/edit?saved=1`);
});

// POST: תאימות לאחור — מפנים למסלול ה-GET בלי לנסות לקרוא body
ownerManageRouter.post("/owner/restaurants/:id/edit", async (ctx) => {
  const id = ctx.params.id!;
  // אם במקרה הגיעו query params, נשמר אותם; אחרת פשוט נכוון למסך השמירה
  const sp = ctx.request.url.searchParams;
  const qs = sp.toString();
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    `/owner/restaurants/${encodeURIComponent(id)}/edit/save${qs ? "?" + qs : ""}`,
  );
});

export default ownerManageRouter;
export { ownerManageRouter };
