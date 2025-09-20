// lib/view.ts
import { Eta } from "@eta/eta";

const eta = new Eta();

/** רנדר תבנית מהדיסק: templates/<name>.eta */
export async function render(
  ctx: any,
  templateName: string,
  data: Record<string, unknown> = {},
) {
  try {
    const filePath = `${Deno.cwd()}/templates/${templateName}.eta`;
    const tpl = await Deno.readTextFile(filePath);   // ← טוען את הקובץ ממש
    const html = await eta.renderAsync(tpl, {
      ...data,
      user: ctx.state?.user ?? null,
      ctx,
    });
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.body = html ?? "";
  } catch (err) {
    console.error("Template render error:", err);
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error (template)";
  }
}
