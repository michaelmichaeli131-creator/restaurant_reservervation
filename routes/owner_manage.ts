// src/routes/owner_manage.ts
// דשבורד + עריכת פרטי מסעדה
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
import { requireAuth, requireOwner } from "../lib/auth.ts";
import { requireRestaurantAccess } from "../services/authz.ts";

function trim(s?: string | null) { return (s ?? "").trim(); }
const pad2 = (n: number) => String(n).padStart(2, "0");
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const ownerManageRouter = new Router();

/* ───────────────────────── דשבורד ───────────────────────── */

ownerManageRouter.get("/owner/manage", async (ctx) => {
  // עמוד הבית החדש לניהול: מפנה לדשבורד המסעדה (העמוד החדש והמעוצב)
  if (!requireAuth(ctx)) return;

  const user = (ctx.state as any)?.user;
  const date = ctx.request.url.searchParams.get("date") || todayISO();

  // Staff: תמיד למסעדה שנעולה בהקשר
  if (user?.role === "staff") {
    const rid = (ctx.state as any).staffRestaurantId as string | null;
    if (!rid) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = "Forbidden";
      return;
    }
    ctx.response.redirect(`/owner/restaurants/${encodeURIComponent(rid)}/manage?date=${encodeURIComponent(date)}`);
    return;
  }

  // Owner: למסעדה הראשונה (מעבר בין מסעדות יתבצע מה-Switcher בעמוד)
  if (user?.role === "owner") {
    const all = await listRestaurants("", /*onlyApproved*/ false);
    const mine = all.filter((r) => r.ownerId === user.id);
    if (!mine.length) {
      ctx.response.redirect(`/owner/restaurants/new`);
      return;
    }
    ctx.response.redirect(`/owner/restaurants/${encodeURIComponent(mine[0].id)}/manage?date=${encodeURIComponent(date)}`);
    return;
  }

  ctx.response.status = Status.Forbidden;
  ctx.response.body = "Forbidden";
});

// שמרנו את הדשבורד הישן (רשימת מסעדות) למסלול נפרד – למי שרוצה
ownerManageRouter.get("/owner/restaurants", async (ctx) => {
  if (!requireAuth(ctx)) return;
  const user = (ctx.state as any)?.user;
  if (user?.role !== "owner") {
    ctx.response.redirect("/owner/manage");
    return;
  }

  const date = ctx.request.url.searchParams.get("date") || todayISO();
  const all = await listRestaurants("", /*onlyApproved*/ false);
  const mine = all.filter((r) => r.ownerId === user.id);

  const restaurants = await Promise.all(mine.map(async (r) => {
    const reservations = await listReservationsFor(r.id, date);
    const peopleToday = reservations.reduce((acc, x) => acc + (x.people || 0), 0);
    const occMap = await computeOccupancy(r, date);
    let peakUsed = 0;
    for (const used of occMap.values()) peakUsed = Math.max(peakUsed, used);
    const capacity = Math.max(1, Number(r.capacity || 0));
    const peakPct = Math.min(100, Math.round((peakUsed / capacity) * 100));

    const photos = Array.isArray(r.photos) ? r.photos : [];
    const normPhotos = photos.map((p: any) => (typeof p === "string" ? { dataUrl: p, alt: "" } : p));

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

  await render(ctx, "owner_dashboard", {
    title: "המסעדות שלי",
    page: "owner_dashboard",
    user,
    restaurants,
  });
});


/* ────────────────────── דשבורד מסעדה ספציפית ────────────────────── */

ownerManageRouter.get("/owner/restaurants/:id/manage", async (ctx) => {
  if (!requireAuth(ctx)) return;

  const user = (ctx.state as any)?.user;
  const id = ctx.params.id!;
  const date = ctx.request.url.searchParams.get("date") || todayISO();

  // Staff: מותר רק למסעדה שמוגדרת בהקשר
  if (user?.role === "staff") {
    const rid = (ctx.state as any).staffRestaurantId as string | null;
    if (!rid || rid !== id) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = "Forbidden";
      return;
    }
    if (!(await requireRestaurantAccess(ctx, id))) return;
  }

  // Owner: בדיקת בעלות
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה." });
    return;
  }

  if (user?.role === "owner" && r.ownerId !== user.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  // Switcher: רשימת מסעדות לבעלים (לעובד – רק מסעדה אחת)
  let switcherRestaurants: any[] = [];
  if (user?.role === "owner") {
    const all = await listRestaurants("", /*onlyApproved*/ false);
    switcherRestaurants = all
      .filter((x) => x.ownerId === user.id)
      .map((x) => ({ id: x.id, name: x.name }));
  } else {
    switcherRestaurants = [{ id: r.id, name: r.name }];
  }

  const reservations = await listReservationsFor(r.id, date);
  const peopleToday = reservations.reduce((acc, x) => acc + (x.people || 0), 0);
  const occMap = await computeOccupancy(r, date);
  let peakUsed = 0;
  for (const used of occMap.values()) peakUsed = Math.max(peakUsed, used);
  const capacity = Math.max(1, Number(r.capacity || 0));
  const peakPct = Math.min(100, Math.round((peakUsed / capacity) * 100));

  const photos = Array.isArray(r.photos) ? r.photos : [];
  const normPhotos = photos.map((p: any) => (typeof p === "string" ? { dataUrl: p, alt: "" } : p));

  // Preview: upcoming reservations for this date (first 6 by time)
  const reservationsPreview = [...reservations]
    .sort((a: any, b: any) => String(a.time || "").localeCompare(String(b.time || "")))
    .slice(0, 6)
    .map((x: any) => ({
      id: x.id,
      time: x.time,
      people: x.people,
      status: x.status || "confirmed",
      name: [x.firstName, x.lastName].filter(Boolean).join(" ") || x.note || "לקוח/ה",
      phone: x.phone || "",
    }));

  // Simple tasks/alerts derived from today's data (placeholder until full task engine)
  const pending = reservations.filter((x: any) => (x.status || "").toLowerCase() === "new").length;
  const tasks: Array<{ title: string; desc?: string; href?: string; tone?: string }> = [];
  if (pending > 0) {
    tasks.push({
      title: `יש ${pending} הזמנות חדשות לבדיקה`,
      desc: "בדוק/י את היומן ואשר/י אם צריך.",
      href: `/owner/restaurants/${encodeURIComponent(r.id)}/calendar?date=${encodeURIComponent(date)}`,
      tone: "warn",
    });
  }
  tasks.push({
    title: "עדכון סידור שולחנות", 
    desc: "בדוק/י התאמה של פלור לעומס היום.",
    href: `/owner/restaurants/${encodeURIComponent(r.id)}/floor`,
    tone: "info",
  });
  if (peakPct >= 85) {
    tasks.push({
      title: "Peak תפוסה גבוה", 
      desc: "שקול/י להוסיף צוות / לחזק ניהול תורים.",
      href: `/owner/restaurants/${encodeURIComponent(r.id)}/shifts`,
      tone: "danger",
    });
  }

  const alerts: Array<{ title: string; tone?: string }> = [];
  if (capacity <= 1) alerts.push({ title: "הקיבולת במסעדה לא מוגדרת (capacity)", tone: "warn" });

  const viewModel = {
    ...r,
    photos: normPhotos,
    _today: date,
    _reservationsCount: reservations.length,
    _peopleToday: peopleToday,
    _peakOccupancyPct: peakPct,
    _reservationsPreview: reservationsPreview,
    _tasks: tasks,
    _alerts: alerts,
    _urls: {
      manage: `/owner/restaurants/${encodeURIComponent(r.id)}/manage?date=${encodeURIComponent(date)}`,
      calendar: `/owner/restaurants/${encodeURIComponent(r.id)}/calendar?date=${encodeURIComponent(date)}`,
      floor: `/owner/restaurants/${encodeURIComponent(r.id)}/floor`,
      shifts: `/owner/restaurants/${encodeURIComponent(r.id)}/shifts`,
      staff: `/owner/staff?restaurantId=${encodeURIComponent(r.id)}`,
      time: `/owner/time?restaurantId=${encodeURIComponent(r.id)}`,
      payroll: `/owner/payroll?restaurantId=${encodeURIComponent(r.id)}`,
      hours: `/owner/restaurants/${encodeURIComponent(r.id)}/hours`,
      photos: `/owner/restaurants/${encodeURIComponent(r.id)}/photos`,
      edit: `/owner/restaurants/${encodeURIComponent(r.id)}/edit`,
      inventory: `/owner/${encodeURIComponent(r.id)}/inventory/stock`,
      stats: `/owner/${encodeURIComponent(r.id)}/stats`,
      // operational screens (host/waiter/kitchen)
      host: `/host/${encodeURIComponent(r.id)}`,
      waiter: `/waiter/${encodeURIComponent(r.id)}`,
      waiterMap: `/waiter-map/${encodeURIComponent(r.id)}`,
      kitchen: `/kitchen/${encodeURIComponent(r.id)}`,
      bar: `/bar/${encodeURIComponent(r.id)}`,
      menu: `/owner/${encodeURIComponent(r.id)}/menu`,
      bills: `/owner/${encodeURIComponent(r.id)}/bills`,
    },
  };

  await render(ctx, "owner_restaurant_manage", {
    title: `ניהול — ${r.name}`,
    page: "owner_restaurant_manage",
    user,
    restaurant: viewModel,
    restaurants: switcherRestaurants,
    createRestaurantUrl: "/owner/restaurants/new",
  });
});

// דף יצירת מסעדה (GET) – כדי לאפשר "+ מסעדה חדשה" מה-Switcher
ownerManageRouter.get("/owner/restaurants/new", async (ctx) => {
  if (!requireOwner(ctx)) return;
  await render(ctx, "owner_restaurant_new", {
    title: "פתיחת מסעדה חדשה",
    page: "owner_restaurant_new",
    postUrl: "/owner/restaurant/new",
    backUrl: "/owner/manage",
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

  const getStr = (key: string, min = 0, max = 1000) => {
    if (!sp.has(key)) return undefined;
    const v = trim(sp.get(key));
    if (v.length < min) return "";
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

  if (sp.has("categories")) {
    const categories = sp.getAll("categories").filter(Boolean);
    if (categories.length > 0) patch.kitchenCategories = categories as any;
  }

  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/edit?saved=1`);
});

// POST: תאימות לאחור — מפנים למסלול ה-GET בלי לנסות לקרוא body
ownerManageRouter.post("/owner/restaurants/:id/edit", async (ctx) => {
  const id = ctx.params.id!;
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
