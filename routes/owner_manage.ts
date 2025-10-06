// src/routes/owner_manage.ts
// עריכת פרטי מסעדה (שם/עיר/כתובת/טלפון/תיאור) — בעלים בלבד
// שמירה ב-GET (/edit/save) דרך url.searchParams (ללא ctx.request.body)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant, type Restaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

function trim(s?: string | null) { return (s ?? "").trim(); }

const ownerManageRouter = new Router();

// GET: טופס עריכת פרטים
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
