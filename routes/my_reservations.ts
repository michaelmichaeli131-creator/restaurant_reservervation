// routes/my_reservations.ts — the signed-in user's reservations
import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, listReservationsByUser } from "../database.ts";
import { makeReservationToken } from "../lib/token.ts";
import { render } from "../lib/view.ts";

export const myReservationsRouter = new Router();

// My reservations page
myReservationsRouter.get("/my-reservations", async (ctx) => {
  const user = (ctx.state as any).user;
  if (!user) {
    ctx.response.status = Status.SeeOther;
    ctx.response.headers.set("Location", "/auth/login?redirect=/my-reservations");
    return;
  }

  const reservations = await listReservationsByUser(user.id);

  // Resolve restaurant names (cache per restaurant) + signed manage links
  const restaurantCache = new Map<string, any>();
  const items: any[] = [];
  for (const r of reservations) {
    let restaurant = restaurantCache.get(r.restaurantId);
    if (restaurant === undefined) {
      restaurant = await getRestaurant(r.restaurantId);
      restaurantCache.set(r.restaurantId, restaurant);
    }
    const manageToken = await makeReservationToken(r.id, user.email);
    items.push({
      ...r,
      restaurantName: restaurant?.name || "",
      manageUrl: `/r/${encodeURIComponent(manageToken)}`,
    });
  }

  // Split: upcoming first (date+time ascending), then past (descending)
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const nowKey =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const keyOf = (r: any) => `${r.date || ""} ${r.time || ""}`;
  const upcoming = items.filter((r) => keyOf(r) >= nowKey)
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const past = items.filter((r) => keyOf(r) < nowKey)
    .sort((a, b) => keyOf(b).localeCompare(keyOf(a)));

  const t = (ctx.state as any)?.t;
  await render(ctx, "my_reservations", {
    page: "my_reservations",
    title: t ? (t("myReservations.title") || "My reservations") : "My reservations",
    upcoming,
    past,
  });
});
