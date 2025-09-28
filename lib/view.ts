// src/lib/view.ts
import { Eta } from "npm:eta@3.5.0"; // אפשר גם jsr, זה בסדר
import type { Context } from "jsr:@oak/oak";
import { join } from "jsr:@std/path@1.1.2/join";

// ב-Deno Deploy Deno.cwd() מצביע לשורש הקוד: /src
// לכן התבניות יושבות ב-/src/templates
const viewsDir = join(Deno.cwd(), "templates");
console.log("[VIEW] views dir:", viewsDir);

const eta = new Eta({
  views: viewsDir,     // חשוב: להגדיר את התיקייה של התבניות
  useWith: true,
});

/**
 * מרנדר תבנית-תוכן (template) => body HTML,
 * ואז מרנדר "layout" ומזריק לתוכו את ה-body.
 * כך הלייאאוט תמיד חל — ואין תלות ב-<% layout(...) %> בתוך העמודים.
 */
export async function render(
  ctx: Context,
  template: string,
  data: Record<string, unknown> = {},
) {
  try {
    const user = (ctx.state as any).user;
    // 1) רנדר תוכן העמוד (body)
    const body = await eta.renderAsync(template, { ...data, user });
    // 2) עטיפה בלייאאוט
    const html = await eta.renderAsync("layout", { ...data, user, body });

    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html;
  } catch (err) {
    console.error("Template render error:", err, "\nviews dir:", viewsDir, "\nrequested template:", template);
    ctx.response.status = 500;
    ctx.response.body = "Template error";
  }
}
