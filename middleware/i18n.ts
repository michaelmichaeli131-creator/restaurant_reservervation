// /src/middleware/i18n.ts
import type { Context, Middleware } from "jsr:@oak/oak";

export const SUPPORTED = ["he", "en", "ka"] as const;
export type Locale = typeof SUPPORTED[number];

const DEFAULT: Locale = "he";
const DIR: Record<Locale, "rtl" | "ltr"> = { he: "rtl", en: "ltr", ka: "ltr" };

const NODE_ENV = Deno.env.get("NODE_ENV") ?? "production";
const IS_PROD = NODE_ENV === "production";

/** Cache מילונים בזיכרון (רק בפרודקשן) */
const cache = new Map<Locale, Record<string, unknown>>();

/** נתיב תיקיית המילונים (עמיד יחסית לפריסה ול־CWD) */
function dictPath(locale: Locale): string {
  // קודם כל נסה יחסית לקובץ הזה
  try {
    return new URL(`../i18n/${locale}.json`, import.meta.url).pathname;
  } catch {
    // fallback ל־CWD
    return `./i18n/${locale}.json`;
  }
}

/** קריאת מילון מקובץ JSON עם cache בפרודקשן ו־hot-reload בדיבוג */
async function loadDict(locale: Locale): Promise<Record<string, unknown>> {
  if (IS_PROD && cache.has(locale)) return cache.get(locale)!;
  const path = dictPath(locale);
  try {
    const txt = await Deno.readTextFile(path);
    const dict = JSON.parse(txt) as Record<string, unknown>;
    if (IS_PROD) cache.set(locale, dict);
    return dict;
  } catch (err) {
    console.warn(`[i18n] failed to load ${path} →`, err);
    // נפילה לברירת מחדל אם זה לא הוא עצמו
    if (locale !== DEFAULT) {
      try {
        const fallbackTxt = await Deno.readTextFile(dictPath(DEFAULT));
        const fallback = JSON.parse(fallbackTxt) as Record<string, unknown>;
        if (IS_PROD) cache.set(DEFAULT, fallback);
        return fallback;
      } catch {
        // לבסוף – מילון ריק
        return {};
      }
    }
    return {};
  }
}

function getPath(obj: any, path: string, fallback?: string) {
  return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj) ?? fallback ?? `(${path})`;
}

function interpolate(s: string, vars?: Record<string, unknown>) {
  return !vars ? s : s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** נירמול קוד שפה ל־SUPPORTED */
function norm(code?: string | null): Locale {
  const c = (code || "").toLowerCase().slice(0, 2);
  return (SUPPORTED as readonly string[]).includes(c) ? (c as Locale) : DEFAULT;
}

/** פענוח Accept-Language בסיסי (בחירת שפה מועדפת הנתמכת אצלנו) */
function fromAcceptLanguage(header: string | null): Locale | undefined {
  if (!header) return undefined;
  const raw = header.toLowerCase();

  // ניקח עדיפויות פשוטות: אם יש he → he; אם יש en → en; אם יש ka → ka.
  if (raw.includes("he")) return "he";
  if (raw.includes("en")) return "en";
  if (raw.includes("ka")) return "ka";
  return undefined;
}

// helper לקבוע אם הבקשה מאובטחת (HTTPS/מאחורי פרוקסי)
function isSecure(ctx: Context): boolean {
  // oak לעיתים מגדיר secure, ובפרוקסי נבדוק x-forwarded-proto
  // @ts-ignore - oak עשוי לא להקליד secure
  if ((ctx.request as any).secure) return true;
  const xf = ctx.request.headers.get("x-forwarded-proto");
  if (xf && xf.toLowerCase() === "https") return true;
  try {
    return ctx.request.url.protocol === "https:";
  } catch {
    return false;
  }
}

/** שמירת שפה ב־cookie (גם lang וגם sb_lang לתאימות) */
async function persistLangCookie(ctx: Context, lang: Locale) {
  const cookieOpts = {
    httpOnly: false,
    sameSite: "Lax" as const,
    secure: isSecure(ctx), // ← במקום true קשיח
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // 180 ימים
  };
  await ctx.cookies.set("lang", lang, cookieOpts);
  await ctx.cookies.set("sb_lang", lang, cookieOpts);
}

/** ניסיון קריאת שפה מה־session אם קיים */
async function getLangFromSession(ctx: Context): Promise<string | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any)?.session;
    return session ? await session.get("lang") : null;
  } catch {
    return null;
  }
}

/** כתיבה ל־session (לא חובה אם אין session) */
async function setLangToSession(ctx: Context, lang: Locale) {
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any)?.session;
    await session?.set("lang", lang);
  } catch {
    /* ignore */
  }
}

/** ה־middleware הראשי */
export const i18n: Middleware = async (ctx, next) => {
  // קדימות: ?lang= → cookie (lang/sb_lang) → session → Accept-Language → DEFAULT
  const q = ctx.request.url.searchParams.get("lang") || "";

  let lang: Locale | undefined;

  if (q) {
    lang = norm(q);
  } else {
    const fromCookie = (await ctx.cookies.get("lang")) ?? (await ctx.cookies.get("sb_lang"));
    if (fromCookie) lang = norm(fromCookie);
  }

  if (!lang) {
    const fromSess = await getLangFromSession(ctx);
    if (fromSess) lang = norm(fromSess);
  }

  if (!lang) {
    const fromAL = fromAcceptLanguage(ctx.request.headers.get("accept-language"));
    lang = fromAL ?? DEFAULT;
  }

  // טען מילון
  const dict = await loadDict(lang);

  // הזרקה ל־state
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).lang = lang;
  // אפשר לאפשר override עתידי של dir דרך state, אחרת מחושב מהשפה
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).dir = (ctx.state as any).dir ?? DIR[lang];
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).t = (key: string, vars?: Record<string, unknown>) => {
    const raw = getPath(dict, key, `(${key})`);
    return typeof raw === "string" ? interpolate(raw, vars) : String(raw);
  };

  // אם הגיעה בקשה עם ?lang=... — נעדכן cookie ו־session לשימור
  if (q) {
    await persistLangCookie(ctx, lang);
    await setLangToSession(ctx, lang);
  } else {
    // אם אין cookie בכלל — נבצע ייצוב (שימושי בפעם הראשונה)
    const hasCookie = (await ctx.cookies.get("lang")) ?? (await ctx.cookies.get("sb_lang"));
    if (!hasCookie) await persistLangCookie(ctx, lang);
  }

  await next();
};
