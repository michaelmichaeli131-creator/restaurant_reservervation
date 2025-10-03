// src/routes/restaurants.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  listRestaurants,
  getRestaurant,
  checkAvailability,
  listAvailableSlotsAround,
  createReservation,
  getUserById,
  type Reservation,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { sendReservationEmail, notifyOwnerEmail } from "../lib/mail.ts";

// ---------- Utils ----------
function pad2(n: number) { return n.toString().padStart(2, "0"); }
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nextQuarterHour(): string {
  const d = new Date();
  const mins = d.getMinutes();
  const add = 15 - (mins % 15 || 15);
  d.setMinutes(mins + add, 0, 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function normalizeDate(input: unknown): string {
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return todayISO();
}
function normalizeTime(input: unknown): string {
  if (typeof input === "string" && /^\d{2}:\d{2}$/.test(input)) return input;
  return nextQuarterHour();
}
function toInt(v: unknown, def = 2): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Body reader that supports JSON, x-www-form-urlencoded, multipart/form-data
async function readFields(ctx: any): Promise<Record<string, unknown>> {
  // Oak had API differences across versions. We try the safest routes first.
  const ct = (ctx.request.headers.get("content-type") || "").toLowerCase();

  // Prefer Oak's body readers when available
  const hasBodyMethod = typeof ctx.request.body === "function";
  const fields: Record<string, unknown> = {};

  try {
    if (ct.includes("application/json")) {
      if (hasBodyMethod) {
        const b = await ctx.request.body({ type: "json" }).value;
        Object.assign(fields, b ?? {});
      } else if (ctx.request.originalRequest?.json) {
        const b = await ctx.request.originalRequest.json();
        Object.assign(fields, b ?? {});
      }
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      if (hasBodyMethod) {
        const b: URLSearchParams = await ctx.request.body({ type: "form" }).value;
        for (const [k, v] of b.entries()) fields[k] = v;
      } else if (ctx.request.originalRequest?.formData) {
        const fd = await ctx.request.originalRequest.formData();
        for (const [k, v] of fd.entries()) fields[k] = typeof v === "string" ? v : v.name;
      }
    } else if (ct.includes("multipart/form-data")) {
      if (hasBodyMethod) {
        const formData = await ctx.request.body({ type: "form-data" }).value.read();
        Object.assign(fields, formData.fields ?? {});
      } else if (ctx.request.originalRequest?.formData) {
        const fd = await ctx.request.originalRequest.formData();
        for (const [k, v] of fd.entries()) fields[k] = typeof v === "string" ? v : v.name;
      }
    } else {
      // Fallback: try JSON first then form
      if (hasBodyMethod) {
        try {
          const b = await ctx.request.body({ type: "json" }).value;
          Object.assign(fields, b ?? {});
        } catch {
          try {
            const b: URLSearchParams = await ctx.request.body({ type: "form" }).value;
            for (const [k, v] of b.entries()) fields[k] = v;
          } catch {
            // ignore
          }
        }
      }
    }
  } catch (e) {
    // Attach minimal debug info for admin only route/logging
    ctx.state?.logger?.warn?.("readFields error", { e: String(e), ct });
  }

  return fields;
}

// ---------- Router ----------
const router = new Router();

// List restaurants (public)
router.get("/restaurants", async (ctx) => {
  const q = (ctx.request.url.searchParams.get("q") || "").trim();
  const city = (ctx.request.url.searchParams.get("city") || "").trim();
  const items = await listRestaurants({ q, city });
  await render(ctx, "restaurants/index", { items, q, city });
});

// Restaurant details page (public)
router.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = "Restaurant not found";
    return;
  }

  const date = normalizeDate(ctx.request.url.searchParams.get("date"));
  const time = normalizeTime(ctx.request.url.searchParams.get("time"));
  const people = toInt(ctx.request.url.searchParams.get("people"), 2);

  const avail = await checkAvailability(r, { date, time, people });
  const around = await listAvailableSlotsAround(r, { date, time, people });

  await render(ctx, "restaurants/show", {
    restaurant: r,
    date,
    time,
    people,
    availability: avail,
    around,
  });
});

// Create reservation (public)
router.post("/restaurants/:id/reserve", async (ctx) => {
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) {
    ctx.response.status = Status.NotFound;
    ctx.response.body = { ok: false, error: "מסעדה לא נמצאה" };
    return;
  }

  const fields = await readFields(ctx);

  // Normalization & defaults
  const date = normalizeDate(fields.date);
  const time = normalizeTime(fields.time);
  const people = toInt(fields.people, 2);

  // Support both raw and normalized keys
  const customerName = String(fields.customerName ?? fields.name ?? "").trim();
  const customerPhone = String(fields.customerPhone ?? fields.phone ?? "").trim();
  const customerEmail = String(fields.customerEmail ?? fields.email ?? "").trim();

  const dbg = {
    ct: (ctx.request.headers.get("content-type") || "").toLowerCase(),
    phases: [
      { name: "body.reader", data: true },
    ],
    keys: Object.keys(fields),
  };

  // Validation (same semantics, but now fields are populated correctly)
  if (!customerName) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "נא להזין שם", dbg, fields: { date, time, people, customerName, customerPhone, customerEmail } };
    return;
  }
  if (!customerPhone && !customerEmail) {
    ctx.response.status = Status.BadRequest;
    ctx.response.body = { ok: false, error: "נא להזין טלפון או אימייל", dbg };
    return;
  }

  // Check availability before creating
  const available = await checkAvailability(r, { date, time, people });
  if (!available?.ok) {
    const around = await listAvailableSlotsAround(r, { date, time, people });
    ctx.response.status = Status.Conflict;
    ctx.response.body = { ok: false, error: "הסלוט שנבחר אינו זמין", around, dbg };
    return;
  }

  // Prepare reservation
  const reservation: Omit<Reservation, "id" | "createdAt"> = {
    restaurantId: r.id,
    date,
    time,
    people,
    customerName,
    customerPhone,
    customerEmail,
    notes: String((fields.notes ?? "")).slice(0, 500),
    status: "confirmed",
    source: "web",
  };

  const created = await createReservation(reservation);

  // Fire-and-forget emails (don’t block response)
  try {
    await sendReservationEmail({
      to: customerEmail,
      reservation: { ...created, restaurant: r },
    });
  } catch (_e) {
    // log-only; email failures shouldn’t fail booking
  }
  try {
    await notifyOwnerEmail({
      restaurant: r,
      reservation: created,
    });
  } catch (_e) {
    // ignore
  }

  // If the client expects JSON (AJAX), return JSON; otherwise redirect to a success page
  const accept = (ctx.request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json") || accept.includes("text/json")) {
    ctx.response.body = { ok: true, reservation: created };
  } else {
    // Render a confirmation page
    await render(ctx, "restaurants/confirmation", {
      restaurant: r,
      reservation: created,
    });
  }
});

export default router;
