
// routes/host.ts
// Host dashboard: live map + seat from today's reservations

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireStaff } from "../lib/auth.ts";
import { getRestaurant, listReservationsByRestaurant } from "../database.ts";
import { seatReservation, isTableSeated } from "../services/seating_service.ts";
import { todayISO } from "./restaurants/_utils/datetime.ts";

export const hostRouter = new Router();

// Host page
hostRouter.get("/host/:rid", async (ctx) => {
  if (!requireStaff(ctx)) return; // host is a staff member
  const rid = ctx.params.rid!;
  const r = await getRestaurant(rid);
  if (!r) ctx.throw(Status.NotFound);
  await render(ctx, "host_seating", {
    page: "host_seating",
    title: `מארחת · ${r.name}`,
    rid,
    restaurant: r,
  });
});

// List today's bookable reservations
hostRouter.get("/api/host/:rid/reservations", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const rid = ctx.params.rid!;
  const date = String(ctx.request.url.searchParams.get("date") || todayISO());
  const all = await listReservationsByRestaurant(rid, date);
  // Allow only reservations in states that mean booked/not seated
  const allowed = (all || []).filter((r: any) => {
    const st = String(r.status || "new").toLowerCase();
    return ["new","approved","confirmed"].includes(st);
  }).map((r: any) => ({
    id: r.id,
    time: r.time,
    people: r.people,
    name: (r.firstName || "") + " " + (r.lastName || ""),
    phone: r.phone || "",
    status: r.status || "new",
  }));
  ctx.response.headers.set("Content-Type","application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, reservations: allowed, date });
});

// Seat a reservation to a table (host only)
hostRouter.post("/api/host/seat", async (ctx) => {
  if (!requireStaff(ctx)) return;
  const body = await ctx.request.body.json();
  const restaurantId = String(body.restaurantId || "");
  const reservationId = String(body.reservationId || "");
  const table = Number(body.table || 0);

  if (!restaurantId || !reservationId || !table) ctx.throw(Status.BadRequest, "missing fields");

  // Make sure table not already seated
  if (await isTableSeated(restaurantId, table)) {
    ctx.throw(Status.Conflict, "table already seated");
  }

  const data = await seatReservation({ restaurantId, reservationId, table });

  ctx.response.headers.set("Content-Type","application/json; charset=utf-8");
  ctx.response.body = JSON.stringify({ ok: true, seat: data });
});

export default hostRouter;
