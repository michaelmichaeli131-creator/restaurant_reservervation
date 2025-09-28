// routes/owner.ts
import { Router } from "@oak/oak";
import { kv, createRestaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { render } from "../lib/view.ts";

export const ownerRouter = new Router();

ownerRouter.get("/owner", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const myRestaurants: any[] = [];
  const ownerId = (ctx.state as any).user.id;
  for await (const key of kv.list({ prefix: ["restaurant_by_owner", ownerId] })) {
    const rid = key.key[key.key.length - 1] as string;
    const r = (await kv.get(["restaurant", rid])).value;
    if (r) myRestaurants.push(r);
  }
  await render(ctx, "owner_dashboard", { myRestaurants, page: "owner" });
});

ownerRouter.post("/owner/restaurant/new", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const form = await ctx.request.formData();
  const id = crypto.randomUUID();
  const obj = {
    id,
    ownerId: (ctx.state as any).user.id,
    name: form.get("name")?.toString() ?? "New Restaurant",
    city: form.get("city")?.toString() ?? "",
    address: form.get("address")?.toString() ?? "",
    phone: form.get("phone")?.toString() ?? "",
    hours: form.get("hours")?.toString() ?? "",
    description: form.get("description")?.toString() ?? "",
    menu: [],
  };
  await createRestaurant(obj as any);
  ctx.response.redirect("/owner");
});
