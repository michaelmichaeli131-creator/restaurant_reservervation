// src/lib/view.ts
import { Eta } from "npm:eta@3.5.0";
import type { Context } from "jsr:@oak/oak";
import { join } from "jsr:@std/path@1.1.2/join";

const viewsDir = join(Deno.cwd(), "templates");
console.log("[VIEW] views dir:", viewsDir);

const eta = new Eta({
  views: viewsDir,
  useWith: true,
});

export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
) {
  try {
    const user = (ctx.state as any).user;
    const body = await eta.renderAsync(template, { ...data, user });
    const html = await eta.renderAsync("layout", { ...data, user, body });

    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html;
  } catch (err) {
    console.error("Template render error:", err, "\nviews dir:", viewsDir, "\nrequested template:", template);
    ctx.response.status = 500;
    ctx.response.body = "Template error";
  }
}
