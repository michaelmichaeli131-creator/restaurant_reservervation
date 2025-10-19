import type { Context } from "jsr:@oak/oak";

const SUPPORTED = ["he", "en", "ka"] as const;
type Locale = typeof SUPPORTED[number];
const DEFAULT: Locale = "he";
const DIR: Record<Locale, "rtl" | "ltr"> = { he: "rtl", en: "ltr", ka: "ltr" };

const cache = new Map<Locale, Record<string, unknown>>();

async function loadDict(locale: Locale) {
  if (cache.has(locale)) return cache.get(locale)!;
  const txt = await Deno.readTextFile(`./i18n/${locale}.json`);
  const dict = JSON.parse(txt);
  cache.set(locale, dict);
  return dict;
}

function getPath(obj: any, path: string, fallback?: string) {
  return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj) ?? fallback ?? `(${path})`;
}

function interpolate(s: string, vars?: Record<string, unknown>) {
  return !vars ? s : s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export async function i18n(ctx: Context, next: () => Promise<unknown>) {
  // קדימות: פרמטר בקשה ?lang= / ואז cookie / ואז Accept-Language / ואז ברירת מחדל
  const q = ctx.request.url.searchParams.get("lang") || "";
  let lang = (q && SUPPORTED.includes(q as Locale) ? q : ctx.cookies.get("sb_lang")) as Locale | undefined;

  if (!lang) {
    const al = (ctx.request.headers.get("accept-language") || "").toLowerCase();
    lang = al.includes("he") ? "he" : "en";
  }
  if (!SUPPORTED.includes(lang!)) lang = DEFAULT;

  const dict = await loadDict(lang!);

  (ctx.state as any).lang = lang!;
  (ctx.state as any).dir = DIR[lang!];
  (ctx.state as any).t = (key: string, vars?: Record<string, unknown>) => {
    const raw = getPath(dict, key, `(${key})`);
    return typeof raw === "string" ? interpolate(raw, vars) : String(raw);
  };

  // אם הגיעה בקשה עם ?lang=... נשמור קבוע בעוגיה (כדי שיהיה חוצה־דפים)
  if (q && SUPPORTED.includes(q as Locale)) {
    ctx.cookies.set("sb_lang", lang!, {
      httpOnly: false,
      sameSite: "Lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 180 // 180 ימים
    });
  }

  await next();
}
