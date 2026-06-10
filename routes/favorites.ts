// routes/favorites.ts — user favorites (saved restaurants)
import { Router, Status } from "jsr:@oak/oak";
import { listFavoriteRestaurants, toggleFavorite } from "../database.ts";
import { render } from "../lib/view.ts";
import { photoStrings } from "./restaurants/_utils/misc.ts";

export const favoritesRouter = new Router();

// Toggle favorite (AJAX) — returns the new state
favoritesRouter.post("/api/favorites/:rid/toggle", async (ctx) => {
  const user = (ctx.state as any).user;
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: false, reason: "auth_required" });
    return;
  }
  const rid = String(ctx.params.rid ?? "");
  if (!rid) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = JSON.stringify({ ok: false, reason: "missing_rid" });
    return;
  }
  const favorite = await toggleFavorite(user.id, rid);
  ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, favorite });
});

// Favorites page
favoritesRouter.get("/favorites", async (ctx) => {
  const user = (ctx.state as any).user;
  if (!user) {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", "/auth/login?redirect=/favorites");
    return;
  }
  const restaurants = (await listFavoriteRestaurants(user.id)).map((r: any) => ({
    ...r,
    photos: photoStrings(r.photos),
  }));
  const t = (ctx.state as any)?.t;
  await render(ctx, "favorites", {
    page: "favorites",
    title: t ? (t("favorites.title") || "My favorites") : "My favorites",
    restaurants,
  });
});
