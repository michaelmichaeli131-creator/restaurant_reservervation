import { Router } from "@oak/oak";
import { kv, createRestaurant } from "../database.ts";
import { renderFile } from "@eta/eta";
import { requireOwner } from "../lib/auth.ts";

export const ownerRouter = new Router();

async function render(ctx: any, tpl: string, data: Record<string, unknown> = {}) {
  const html = await renderFile(`${Deno.cwd()}/templates/${tpl}.eta`, { ...data, user: ctx.state.user ?? null });
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html;
}

ownerRouter.get("/owner", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const myRestaurants: any[] = [];
  const ownerId = (ctx.state as any).user.id;
  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = (await kv.get(["restaurant", rid])).value;
    if (r) myRestaurants.push(r);
  }
  await render(ctx, "owner_dashboard", { myRestaurants });
});

ownerRouter.post("/owner/restaurant/new", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const body = await ctx.request.body({ type: "form" }).value;
  const id = crypto.randomUUID();
  const obj = {
    id,
    ownerId: (ctx.state as any).user.id,
    name: body.get("name")?.toString() ?? "New Restaurant",
    city: body.get("city")?.toString() ?? "",
    address: body.get("address")?.toString() ?? "",
    phone: body.get("phone")?.toString() ?? "",
    hours: body.get("hours")?.toString() ?? "",
    description: body.get("description")?.toString() ?? "",
    menu: [],
  };
  await createRestaurant(obj as any);
  ctx.response.redirect("/owner");
});
