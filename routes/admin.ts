// src/routes/admin.ts
import { Router } from "jsr:@oak/oak";
import { kv, updateRestaurant, getRestaurant } from "../database.ts";
import { render } from "../lib/view.ts";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";

function requireAdmin(ctx: any): boolean {
  const key = ctx.request.url.searchParams.get("key") ?? "";
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    ctx.response.status = 401;
    ctx.response.body = "Unauthorized";
    return false;
  }
  return true;
}

export const adminRouter = new Router();

adminRouter.get("/admin", async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const unapproved: any[] = [];
  for await (const e of kv.list<any>({ prefix: ["restaurant"] })) {
    const r = e.value as any;
    if (r && !r.approved) unapproved.push(r);
  }
  await render(ctx, "admin_dashboard", { unapproved, title: "אישור מסעדות" });
});

adminRouter.post("/admin/approve/:id", async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const id = ctx.params.id!;
  const r = await getRestaurant(id);
  if (!r) { ctx.response.status = 404; ctx.response.body = "Not found"; return; }
  await updateRestaurant(id, { approved: true });
  const key = ctx.request.url.searchParams.get("key") ?? "";
  ctx.response.redirect(`/admin?key=${encodeURIComponent(key)}`);
});
