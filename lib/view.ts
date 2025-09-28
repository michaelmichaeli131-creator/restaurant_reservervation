// lib/view.ts
import { Eta } from "npm:eta@3.5.0"; // או @eta/eta ב-JSR אם אתה כבר עליו
import type { Context } from "jsr:@oak/oak";
import { join } from "jsr:@std/path@1.1.2/join";

const viewsDir = join(Deno.cwd(), "src", "templates");
const eta = new Eta({ views: viewsDir, useWith: true });

export async function render(ctx: Context, template: string, data: Record<string, unknown> = {}) {
  const html = await eta.renderAsync(template, { ...data, user: (ctx.state as any).user });
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html;
}
