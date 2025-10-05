// src/routes/owner_manage.ts
// עריכת פרטי מסעדה (שם/עיר/כתובת/טלפון) עבור בעלים בלבד — נתיבים ב-/owner/restaurants/:id/edit

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant, type Restaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";

function trim(s?: string) { return (s ?? "").trim(); }

const ownerManageRouter = new Router();

// טופס עריכת פרטים
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

// שמירת פרטים
ownerManageRouter.post("/owner/restaurants/:id/edit", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r || r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", { title: "לא נמצא", message: "מסעדה לא נמצאה או שאין הרשאה." });
    return;
  }

  // urlencoded form
  const body = await (ctx.request.body({ type: "form" }).value) as URLSearchParams;
  const patch: Partial<Restaurant> = {
    name: trim(body.get("name") ?? "") || r.name,
    city: trim(body.get("city") ?? "") || r.city,
    address: trim(body.get("address") ?? "") || r.address,
    phone: trim(body.get("phone") ?? "") || r.phone,
    description: trim(body.get("description") ?? "") || r.description,
  };

  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set("Location", `/owner/restaurants/${encodeURIComponent(id)}/edit?saved=1`);
});

export default ownerManageRouter;
export { ownerManageRouter };
