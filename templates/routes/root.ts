// src/routes/root.ts
import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { listRestaurants, listRestaurantsByCategory, type KitchenCategory } from "../database.ts";

const rootRouter = new Router();

function photoStrings(photos: unknown): string[] {
  const arr = Array.isArray(photos) ? photos : [];
  return arr.map((p: any) => (typeof p === "string" ? p : p?.dataUrl)).filter(Boolean);
}

rootRouter.get("/", async (ctx) => {
  const user = (ctx.state as any)?.user ?? null;
  // אם יש דשבורד לבעלים – השאר, אחרת אפשר להסיר את ההפניה
  if (user && user.role === "owner") {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", "/owner");
    return;
  }

  const q = ctx.request.url.searchParams.get("q") ?? "";
  const search = ctx.request.url.searchParams.get("search") ?? "";
  const category = ctx.request.url.searchParams.get("category") ?? "";
  let restaurants: any[] = [];

  if (category && category.trim()) {
    // Filter by category
    const items = await listRestaurantsByCategory(category as KitchenCategory, true);
    restaurants = items.map((r) => ({
      ...r,
      photos: photoStrings(r.photos),
    }));
  } else if (search === "1" || (q && q.trim())) {
    // Text search
    const items = await listRestaurants(q, true);
    restaurants = items.map((r) => ({
      ...r,
      photos: photoStrings(r.photos),
    }));
  }

  await render(ctx, "index", {
    title: "SpotBook — מצא/י מסעדה והזמינו מקום",
    page: "home",
    q,
    search,
    category,
    restaurants,
  });
});

export default rootRouter;
export { rootRouter };
