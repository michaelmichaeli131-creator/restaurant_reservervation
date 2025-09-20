import { Router } from "@oak/oak";
import { kv, getRestaurant, createReservation } from "../database.ts";
import { renderFile } from "@eta/eta";
import { requireAuth } from "../lib/auth.ts";

export const restaurantsRouter = new Router();

async function render(ctx: any, tpl: string, data: Record<string, unknown> = {}) {
  const html = await renderFile(`${Deno.cwd()}/templates/${tpl}.eta`, { ...data, user: ctx.state.user ?? null });
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html;
}

restaurantsRouter.get("/restaurants/:id", async (ctx) => {
  const id = ctx.params.id!;
  const restaurant = await getRestaurant(id);
  if (!restaurant) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  await render(ctx, "restaurant_detail", { restaurant });
});

restaurantsRouter.post("/restaurants/:id/reserve", async (ctx) => {
  if (!requireAuth(ctx)) return;
  const id = ctx.params.id!;
  const body = await ctx.request.body({ type: "form" }).value;
  const date = body.get("date")?.toString() ?? "";
  const time = body.get("time")?.toString() ?? "";
  const people = Number(body.get("people") ?? 2);
  const note = body.get("note")?.toString();

  const resv = {
    id: crypto.randomUUID(),
    restaurantId: id,
    userId: (ctx.state as any).user.id,
    date, time, people, note,
    createdAt: Date.now()
  };
  await createReservation(resv as any);
  ctx.response.redirect(`/restaurants/${id}`);
});
