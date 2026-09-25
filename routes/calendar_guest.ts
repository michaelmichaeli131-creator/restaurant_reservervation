import { Router } from "jsr:@oak/oak";
import { kv, getRestaurant, openingWindowsForDate } from "../database.ts";
import { render } from "../lib/view.ts";
import { readBody } from "./restaurants/_utils/body.ts";
import { createCalendarWaitlist, validateWaitlistInput } from "../services/calendar_waitlist.ts";

export const calendarGuestRouter = new Router();

function georgianWaitlistError(lang: string | undefined, message: string): string {
  if (lang !== "ka") return message;
  const copy: Record<string, string> = {
    "Refresh the form and try again": "განაახლეთ ფორმა და ხელახლა სცადეთ",
    "Please agree to be contacted about this request": "გთხოვთ, დაეთანხმოთ ამ მოთხოვნასთან დაკავშირებით დაკავშირებას",
    "Choose a date within the next six months": "აირჩიეთ თარიღი მომდევნო ექვსი თვის განმავლობაში",
    "Please choose a time during opening hours": "აირჩიეთ დრო სამუშაო საათებში",
    "Too many requests. Please try again later": "მოთხოვნების რაოდენობა ძალიან დიდია. მოგვიანებით სცადეთ",
    "This form was already submitted": "ეს ფორმა უკვე გაგზავნილია",
    "Please wait before submitting another request": "სხვა მოთხოვნის გაგზავნამდე ცოტა ხანს დაელოდეთ",
    "This form was already submitted. Refresh before trying again": "ეს ფორმა უკვე გაგზავნილია. ხელახლა ცდამდე განაახლეთ გვერდი",
    "Invalid date": "თარიღი არასწორია",
    "Invalid time": "დრო არასწორია",
    "Invalid name": "სახელი არასწორია",
    "Invalid phone": "ტელეფონის ნომერი არასწორია",
    "Invalid party size": "სტუმრების რაოდენობა არასწორია",
    "Invalid area": "დარბაზის დასახელება არასწორია",
    "Invalid notes": "შენიშვნები არასწორია",
    "Could not create waitlist entry": "მოთხოვნის შექმნა ვერ მოხერხდა",
  };
  return copy[message] || message;
}

calendarGuestRouter.get("/restaurants/:rid/waitlist", async ctx => {
  const r = await getRestaurant(ctx.params.rid);
  if (!r?.approved) ctx.throw(404, ctx.state.lang === "ka" ? "რესტორანი ვერ მოიძებნა" : "Restaurant not found");
  const nonce = crypto.randomUUID();
  await ctx.state.session.set("calendarWaitlistNonce", nonce);
  await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce, done: false, error: "" });
});
calendarGuestRouter.post("/restaurants/:rid/waitlist", async ctx => {
  const rid = ctx.params.rid;
  const r = await getRestaurant(rid);
  if (!r?.approved) ctx.throw(404, ctx.state.lang === "ka" ? "რესტორანი ვერ მოიძებნა" : "Restaurant not found");
  const { payload: input } = await readBody(ctx);
  const nonce = String(input?.nonce || "");
  let error = "";
  let responseStatus = 400;
  try {
    if (nonce !== await ctx.state.session.get("calendarWaitlistNonce") || !nonce) ctx.throw(403, "Refresh the form and try again");
    if (input.website || input.consent !== "yes") throw new RangeError("Please agree to be contacted about this request");
    const data = validateWaitlistInput(input);
    const today = new Date().toISOString().slice(0,10);
    if (data.date < today || data.date > new Date(Date.now()+180*86400000).toISOString().slice(0,10)) throw new RangeError("Choose a date within the next six months");
    if (!openingWindowsForDate(r, data.date).some(w => data.time >= w.open && data.time < w.close)) throw new RangeError("Please choose a time during opening hours");
    const phoneHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data.phone.replace(/\D/g,""))))).map(b=>b.toString(16).padStart(2,"0")).join("");
    const client = String(ctx.request.ip || 'unknown');
    const clientHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(client)))).map(b=>b.toString(16).padStart(2,"0")).join("");
    const ipRate = await kv.get(["calendar_waitlist_ip", rid, clientHash]);
    if (Number(ipRate.value || 0) >= 20) throw new RangeError("Too many requests. Please try again later");
    const used = await kv.get(["calendar_waitlist_nonce", nonce]);
    const rate = await kv.get(["calendar_waitlist_rate", rid, phoneHash]);
    if (used.value) throw new RangeError("This form was already submitted");
    const counter = Number(rate.value || 0);
    if (counter >= 3) throw new RangeError("Please wait before submitting another request");
    const tx = await kv.atomic().check(used).check(rate).check(ipRate).set(ipRate.key, Number(ipRate.value || 0)+1, {expireIn:3600000}).set(used.key, true, {expireIn: 3600000}).set(rate.key, counter+1, {expireIn: 3600000}).commit();
    if (used.value || !tx.ok) throw new RangeError("This form was already submitted. Refresh before trying again");
    await createCalendarWaitlist(rid, data, "guest");
    await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce: "", done: true, error: "" });
    return;
  } catch (e) {
    const status = Number((e as { status?: number })?.status || 0);
    if (!(e instanceof RangeError) && status !== 403) throw e;
    responseStatus = status || 400;
    error = georgianWaitlistError(ctx.state.lang, String((e as Error).message || e));
  }
  ctx.response.status = responseStatus;
  const fresh = crypto.randomUUID();
  await ctx.state.session.set("calendarWaitlistNonce", fresh);
  await render(ctx, "calendar_waitlist_guest", { title: r.name, restaurant: r, nonce: fresh, done: false, error });
});
