// routes/find_reservation.ts — "Find my reservation" (magic-link pattern)
//
// SECURITY DESIGN (do not weaken):
// - We NEVER display reservations on screen for a typed email address. Anyone can
//   type anyone's email, so the only output channel is the inbox itself.
// - The page always renders the exact same neutral success state whether or not
//   reservations exist (no account/reservation enumeration).
// - The lookup + send runs detached (not awaited) so response timing is uniform.
// - Rate limit: 3 requests / 15 minutes per email-hash AND per client IP, enforced
//   with an atomic KV check-and-increment using expireIn.

import { Router, Status } from "jsr:@oak/oak";
import { getRestaurant, kv, listReservationsByEmail } from "../database.ts";
import { makeReservationToken } from "../lib/token.ts";
import { sendFindReservationsEmail } from "../lib/mail.ts";
import { render } from "../lib/view.ts";
import { isValidEmailStrict, sanitizeEmailMinimal } from "./restaurants/_utils/rtl.ts";

export const findReservationRouter = new Router();

/* ---------------- helpers ---------------- */

const RL_PREFIX = "find_resv_rl";
const RL_LIMIT = 3;
const RL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOOKBACK_DAYS = 30;            // include reservations from the last 30 days onward

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomic check-and-increment rate limit on KV key [RL_PREFIX, scope, id].
 * Returns true if the request is allowed. The counter expires via expireIn.
 */
async function rateLimitAllow(scope: string, id: string): Promise<boolean> {
  const key = [RL_PREFIX, scope, id];
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await kv.get<number>(key);
    const count = typeof cur.value === "number" ? cur.value : 0;
    if (count >= RL_LIMIT) return false;
    const res = await kv.atomic()
      .check(cur) // fails if a concurrent request bumped the counter
      .set(key, count + 1, { expireIn: RL_WINDOW_MS })
      .commit();
    if (res.ok) return true;
  }
  // Could not win the race after retries — fail closed (treat as limited).
  return false;
}

function clientIp(ctx: any): string {
  try {
    const xf = ctx.request.headers.get("x-forwarded-for");
    if (xf) return xf.split(",")[0].trim();
    return String(ctx.request.ip ?? "unknown");
  } catch {
    return "unknown";
  }
}

function cutoffDateIso(): string {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function readForm(ctx: any): Promise<Record<string, string>> {
  const req: any = ctx.request as any;
  try {
    const body = req.body;
    if (body && typeof body.form === "function") {
      const form = await body.form();
      const out: Record<string, string> = {};
      if (form && typeof form.entries === "function") {
        for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : String(v);
      } else if (form && typeof form === "object") {
        for (const [k, v] of Object.entries(form)) out[k] = String(v);
      }
      return out;
    }
  } catch (e) {
    console.warn("[find_resv.readForm] body.form() failed", e);
  }
  try {
    const rawReq: any = (req as any).originalRequest ?? req;
    if (rawReq && typeof rawReq.formData === "function") {
      const fd = await rawReq.formData();
      const out: Record<string, string> = {};
      for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : String(v);
      return out;
    }
  } catch (e) {
    console.warn("[find_resv.readForm] formData() failed", e);
  }
  return {};
}

/**
 * Detached worker: find the email's reservations and, if any exist, send ONE
 * email listing them with /r/:token manage links. Never throws.
 */
async function lookupAndSend(email: string, origin: string, lang: string): Promise<void> {
  try {
    const cutoff = cutoffDateIso();
    const all = await listReservationsByEmail(email);
    const relevant = all.filter((r) => {
      const status = String(r.status ?? "new").toLowerCase();
      if (status === "canceled" || status === "cancelled" || status === "blocked") return false;
      return String(r.date ?? "") >= cutoff; // upcoming + recent (last 30 days)
    });
    if (!relevant.length) return; // silent — same outward behavior as success

    const restaurantCache = new Map<string, any>();
    const items: Array<{ restaurantName: string; date: string; time: string; people: number; manageUrl: string }> = [];
    for (const r of relevant) {
      let restaurant = restaurantCache.get(r.restaurantId);
      if (restaurant === undefined) {
        restaurant = await getRestaurant(r.restaurantId).catch(() => null);
        restaurantCache.set(r.restaurantId, restaurant);
      }
      // Same stateless HMAC token + /r/:token link my_reservations.ts uses.
      const token = await makeReservationToken(r.id, email);
      items.push({
        restaurantName: restaurant?.name || "",
        date: r.date,
        time: r.time,
        people: r.people,
        manageUrl: `${origin}/r/${encodeURIComponent(token)}`,
      });
    }

    await sendFindReservationsEmail({ to: email, items, lang });
  } catch (e) {
    console.warn("[find_resv] lookupAndSend failed:", e);
  }
}

/* ---------------- routes ---------------- */

findReservationRouter.get("/find-reservation", async (ctx) => {
  const t = (ctx.state as any)?.t;
  await render(ctx, "find_reservation", {
    page: "find_reservation",
    title: t ? (t("findResv.title") || "Find my reservation") : "Find my reservation",
    state: "form",
  });
});

findReservationRouter.post("/find-reservation", async (ctx) => {
  const t = (ctx.state as any)?.t;
  const title = t ? (t("findResv.title") || "Find my reservation") : "Find my reservation";

  const b = await readForm(ctx);
  const email = sanitizeEmailMinimal(b.email ?? "").trim().toLowerCase();

  // Rate limit by email-hash and by IP (atomic check-and-increment, expireIn window).
  const emailHash = await sha256Hex(email || "(empty)");
  const ip = clientIp(ctx);
  const [emailOk, ipOk] = await Promise.all([
    rateLimitAllow("email", emailHash),
    rateLimitAllow("ip", ip),
  ]);
  if (!emailOk || !ipOk) {
    ctx.response.status = Status.TooManyRequests;
    await render(ctx, "find_reservation", { page: "find_reservation", title, state: "rate_limited" });
    return;
  }

  // Only do real work for a syntactically valid email; outwardly identical either way.
  if (email && isValidEmailStrict(email)) {
    const origin = (
      Deno.env.get("APP_BASE_URL") ||
      Deno.env.get("BASE_URL") ||
      `${ctx.request.url.protocol}//${ctx.request.url.host}`
    ).replace(/\/+$/, "");
    const lang = (ctx.state as any)?.lang ?? "en";
    // Fire-and-forget so response timing doesn't leak whether reservations exist.
    lookupAndSend(email, origin, lang).catch(() => {});
  }

  // Always the same neutral success state — no enumeration.
  await render(ctx, "find_reservation", { page: "find_reservation", title, state: "sent" });
});
