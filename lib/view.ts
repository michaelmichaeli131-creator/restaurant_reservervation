import { Eta } from "@eta/eta";
const VIEWS_DIR = `${Deno.cwd()}/templates`;

export const eta = new Eta({ views: VIEWS_DIR, cache: true });

export async function render(ctx: any, template: string, data: Record<string, unknown> = {}) {
  try {
    const body = await eta.renderAsync(template, { ...data, user: ctx.state?.user ?? null, ctx });
    const html = await eta.renderAsync("layout", { ...data, user: ctx.state?.user ?? null, ctx, body });
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html ?? "";
  } catch (err) {
    console.error("Template render error:", err?.stack ?? err, "\nviews dir:", VIEWS_DIR, "\nrequested template:", template);
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error (template)";
  }
}
