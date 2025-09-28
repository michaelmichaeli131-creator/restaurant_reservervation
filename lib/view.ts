// lib/view.ts
import { Eta } from "npm:eta@3.5.0"; // או jsr:@eta/eta אם אתה עליו
import type { Context } from "jsr:@oak/oak";
import { join } from "jsr:@std/path@1.1.2/join";

// ב-Deno Deploy: Deno.cwd() == /src (שורש הפרויקט בדיפלוי)
// לכן התיקייה האמיתית של התבניות היא /src/templates, לא /src/src/templates
const viewsDir = join(Deno.cwd(), "templates");

// דיבוג מועיל:
console.log("[VIEW] views dir:", viewsDir);

const eta = new Eta({
  views: viewsDir, // לפי התיעוד: יש להגדיר views לנתיב התבניות
  useWith: true,
});

export async function render(ctx: Context, template: string, data: Record<string, unknown> = {}) {
  try {
    console.log("[VIEW] render:", template);
    const html = await eta.renderAsync(template, { ...data, user: (ctx.state as any).user });
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html;
  } catch (err) {
    console.error("Template render error:", err, "\nviews dir:", viewsDir, "\nrequested template:", template);
    ctx.response.status = 500;
    ctx.response.body = "Template error";
  }
}
