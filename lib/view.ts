// lib/view.ts
// הגדרת Eta עם תיקיית views כך ש-includeFile יעבוד (layout וכו')

import { Eta } from "@eta/eta";

// ב-Deno Deploy ה-CWD הוא /src, אז זה יצביע על /src/templates
const VIEWS_DIR = `${Deno.cwd()}/templates`;

export const eta = new Eta({
  views: VIEWS_DIR,  // חשוב: מאפשר includeFile("layout")
  cache: true,       // אפשר cache לקבצים בפרודקשן
});

/**
 * מרנדר תבנית לפי שם קובץ בלי סיומת (למשל "index", "login")
 * מעדכן Content-Type ומדפיס שגיאה מפורטת ללוג במקרה הצורך.
 */
export async function render(
  ctx: any,
  template: string,
  data: Record<string, unknown> = {},
) {
  try {
    // נרנדר לפי שם קובץ בתוך /templates (index.eta, login.eta, ...)
    const html = await eta.renderAsync(template, {
      ...data,
      user: ctx.state?.user ?? null,
      ctx,
    });
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html ?? "";
  } catch (err) {
    console.error(
      "Template render error:",
      err?.stack ?? err,
      "\nviews dir:", VIEWS_DIR,
      "\nrequested template:", template,
    );
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error (template)";
  }
}
