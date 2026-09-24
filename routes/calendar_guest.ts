import { Router } from "jsr:@oak/oak";
import { kv, getRestaurant, openingWindowsForDate } from "../database.ts";
import { render } from "../lib/view.ts";
import { readBody } from "./restaurants/_utils/body.ts";
import { createCalendarWaitlist, validateWaitlistInput } from "../services/calendar_waitlist.ts";

export const calendarGuestRouter = new Router();
calendarGuestRouter.get("/restaurants/:rid/waitlist", async ctx => {
  const r = await getRestaurant(ctx.params.rid);
  if (!r?.approved) ctx.throw(404, "Restaurant not found");
  const nonce = crypto.randomUUID();
  await ctx.state.session.set("calendarWaitlistNonce", nonce);
  await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce, done: false, error: "" });
});
calendarGuestRouter.post("/restaurants/:rid/waitlist", async ctx => {
  const rid = ctx.params.rid;
  const r = await getRestaurant(rid);
  if (!r?.approved) ctx.throw(404, "Restaurant not found");
  const { payload: input } = await readBody(ctx);
  const nonce = String(input?.nonce || "");
  let error = "";
  try {
    if (nonce !== await ctx.state.session.get("calendarWaitlistNonce") || !nonce) ctx.throw(403, "Refresh the form and try again");
    if (input.website || input.consent !== "yes") throw new RangeError("Please agree to be contacted about this request");
    const data = validateWaitlistInput(input);
    const today = new Date().toISOString().slice(0,10);
    if (data.date < today || data.date > new Date(Date.now()+180*86400000).toISOString().slice(0,10)) throw new RangeError("Choose a date within the next six months");
    if (!openingWindowsForDate(r, data.date).some(w => data.time >= w.open && data.time < w.close)) throw new RangeError("Please choose a time during opening hours");
    const phoneHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data.phone.replace(/\D/g,""))))).map(b=>b.toString(16).padStart(2,"0")).join("");
    const used = await kv.get(["calendar_waitlist_nonce", nonce]);
    const rate = await kv.get(["calendar_waitlist_rate", rid, phoneHash]);
    const counter = Number(rate.value || 0);
    if (counter >= 3) throw new RangeError("Please wait before submitting another request");
    const tx = await kv.atomic().check(used).check(rate).set(used.key, true, {expireIn: 3600000}).set(rate.key, counter+1, {expireIn: 3600000}).commit();
    if (used.value || !tx.ok) throw new RangeError("This form was already submitted. Refresh before trying again");
    await createCalendarWaitlist(rid, data, "guest");
    await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce: "", done: true, error: "" });
    return;
  } catch (e) { if (!(e instanceof RangeError)) throw e; error = e.message; }
  ctx.response.status = 400;
  const fresh = crypto.randomUUID();
  await ctx.state.session.set("calendarWaitlistNonce", fresh);
  await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce: fresh, done: false, error });
});
