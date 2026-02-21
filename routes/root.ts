// src/routes/root.ts
import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { listRestaurants, listRestaurantsByCategory, type KitchenCategory } from "../database.ts";

const rootRouter = new Router();

function photoStrings(photos: unknown): string[] {
  const arr = Array.isArray(photos) ? photos : [];
  return arr.map((p: any) => (typeof p === "string" ? p : p?.dataUrl)).filter(Boolean);
}

function coverUrl(r: any): string {
  const photos = photoStrings(r.photos);
  return r.coverUrl || photos[0] || "/public/img/placeholder-restaurant.jpg";
}

rootRouter.get("/", async (ctx) => {
  const user = (ctx.state as any)?.user ?? null;
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
    const items = await listRestaurantsByCategory(category as KitchenCategory, true);
    restaurants = items.map((r) => ({
      ...r,
      photos: photoStrings(r.photos),
    }));
  } else if (search === "1" || (q && q.trim())) {
    const items = await listRestaurants(q, true);
    restaurants = items.map((r) => ({
      ...r,
      photos: photoStrings(r.photos),
    }));
  }

  // Load featured restaurants from DB (approved, sorted by rating)
  const allApproved = await listRestaurants("", true);
  const featured = allApproved
    .sort((a: any, b: any) => (b.averageRating || 0) - (a.averageRating || 0))
    .slice(0, 8)
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      cover: coverUrl(r),
      rating: r.averageRating,
      reviewCount: r.reviewCount,
      kitchenCategories: r.kitchenCategories || [],
    }));

  const t = (ctx.state as any)?.t;
  const pageTitle = t ? t("home.hero.title") : "Reserve a Table";

  await render(ctx, "index", {
    title: `SpotBook — ${pageTitle}`,
    page: "home",
    q,
    search,
    category,
    restaurants,
    featured,
  });
});

export default rootRouter;
export { rootRouter };
