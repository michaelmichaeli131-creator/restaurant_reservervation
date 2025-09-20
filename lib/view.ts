// lib/view.ts
import { Eta } from "@eta/eta";

export const eta = new Eta({
  // תיקיית התבניות
  views: `${Deno.cwd()}/templates`,
});

// פונקציית רינדור אחידה לכל האפליקציה
export async function render(
  ctx: any,
  template: string,
  data: Record<string, unknown> = {},
) {
  const html = await eta.renderAsync(template, {
    ...data,
    user: ctx.state?.user ?? null,
    ctx,
  });

  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
  ctx.response.body = html;
}
