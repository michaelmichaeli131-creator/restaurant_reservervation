// lib/view.ts
import { Eta } from "@eta/eta";

const VIEWS_DIR = `${Deno.cwd()}/templates`;
export const eta = new Eta({ views: VIEWS_DIR, cache: true });

async function statFile(path: string) {
  try { const st = await Deno.stat(path); return { ok: true, size: st.size }; }
  catch { return { ok: false, size: null }; }
}

export async function render(ctx: any, template: string, data: Record<string, unknown> = {}) {
  const innerPath = `${VIEWS_DIR}/${template}.eta`;
  const layoutPath = `${VIEWS_DIR}/layout.eta`;

  const innerStat = await statFile(innerPath);
  const layoutStat = await statFile(layoutPath);

  try {
    const body = await eta.renderAsync(template, { ...data, user: ctx.state?.user ?? null, ctx }) ?? "";
    const html = await eta.renderAsync("layout", { ...data, user: ctx.state?.user ?? null, ctx, body, page: data.page ?? template }) ?? "";

    // כותרות דיבוג+מניעת קאש
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    ctx.response.headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    ctx.response.headers.set("Pragma", "no-cache");
    ctx.response.headers.set("Expires", "0");

    ctx.response.headers.set("X-Render-Template", template);
    ctx.response.headers.set("X-Template-Path", innerPath);
    ctx.response.headers.set("X-Template-Exists", String(innerStat.ok));
    ctx.response.headers.set("X-Template-Size", String(innerStat.size ?? -1));
    ctx.response.headers.set("X-Layout-Path", layoutPath);
    ctx.response.headers.set("X-Layout-Exists", String(layoutStat.ok));
    ctx.response.headers.set("X-Layout-Size", String(layoutStat.size ?? -1));
    ctx.response.headers.set("X-Body-Len", String(body.length));

    // לוגים לשרת
    console.log(
      `[VIEW] tpl=${template} innerExists=${innerStat.ok} size=${innerStat.size} ` +
      `layoutExists=${layoutStat.ok} lsize=${layoutStat.size} bodyLen=${body.length}`
    );

    ctx.response.body = html;
  } catch (err) {
    console.error("Template render error:", err?.stack ?? err,
      "\nviews dir:", VIEWS_DIR, "\nrequested template:", template,
      `\ninnerStat=${JSON.stringify(innerStat)} layoutStat=${JSON.stringify(layoutStat)}`
    );
    ctx.response.status = 500;
    ctx.response.body = "Internal Server Error (template)";
  }
}
