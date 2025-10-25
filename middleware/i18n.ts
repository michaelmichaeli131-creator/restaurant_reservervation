// /src/middleware/i18n.ts
import type { Context, Middleware } from "jsr:@oak/oak";

export const SUPPORTED = ["he", "en", "ka"] as const;
export type Locale = typeof SUPPORTED[number];

const DEFAULT: Locale = "he";
const DIR: Record<Locale, "rtl" | "ltr"> = { he: "rtl", en: "ltr", ka: "ltr" };

const NODE_ENV = Deno.env.get("NODE_ENV") ?? "production";
const IS_PROD = NODE_ENV === "production";

/** Cache בזיכרון (פר־שפה ועמוד) */
const cache = new Map<string, Record<string, unknown>>();

/** בניית מפתח cache */
function cacheKey(locale: Locale, page?: string) {
  return `${locale}::${page || "-"}`;
}

/** נתיב לקובץ מילון כללי */
function baseDictPath(locale: Locale): string {
  try {
    return new URL(`../i18n/${locale}.json`, import.meta.url).pathname;
  } catch {
    return `./i18n/${locale}.json`;
  }
}

/** נתיב לקובץ מילון עמוד: i18n/<page>.<locale>.json */
function pageDictPath(page: string, locale: Locale): string {
  try {
    return new URL(`../i18n/${page}.${locale}.json`, import.meta.url).pathname;
  } catch {
    return `./i18n/${page}.${locale}.json`;
  }
}

/** shallow merge ללא דריסה: מוסיף מפתחות שחסרים בלבד */
function mergeNoOverwrite<T extends Record<string, unknown>>(base: T, extra: Record<string, unknown>): T {
  for (const k of Object.keys(extra)) {
    if (base[k] === undefined) {
      // @ts-ignore
      base[k] = extra[k];
    }
  }
  return base;
}

/** קריאת מילון: בסיסי + ייעודי לעמוד, עם cache בפרודקשן */
async function loadDict(locale: Locale, page?: string): Promise<Record<string, unknown>> {
  const ckey = cacheKey(locale, page);
  if (IS_PROD && cache.has(ckey)) return cache.get(ckey)!;

  // --- בסיסי ---
  let baseDict: Record<string, unknown> = {};
  const basePath = baseDictPath(locale);
  try {
    const txt = await Deno.readTextFile(basePath);
    baseDict = JSON.parse(txt) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[i18n] failed to load base dict ${basePath} →`, err);
    if (locale !== DEFAULT) {
      // fallback לבסיס בעברית
      try {
        const fbTxt = await Deno.readTextFile(baseDictPath(DEFAULT));
        baseDict = JSON.parse(fbTxt) as Record<string, unknown>;
      } catch {
        baseDict = {};
      }
    }
  }

  // --- עמוד (אופציונלי) ---
  let pageDict: Record<string, unknown> = {};
  if (page) {
    const pPath = pageDictPath(page, locale);
    try {
      const pTxt = await Deno.readTextFile(pPath);
      pageDict = JSON.parse(pTxt) as Record<string, unknown>;
    } catch {
      // אין מילון לעמוד – זה בסדר.
      // console.info(`[i18n] no page dict for ${pPath}`);
    }

    // לא לדרוס את המילון הכללי:
    mergeNoOverwrite(baseDict, pageDict);

    // תמיד זמינות גם תחת t.page.*
    baseDict.page = pageDict;
  }

  if (IS_PROD) cache.set(ckey, baseDict);
  return baseDict;
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

/** Accept-Language בסיסי */
function fromAcceptLanguage(header: string | null): Locale | undefined {
  if (!header) return undefined;
  const raw = header.toLowerCase();
  if (raw.includes("he")) return "he";
  if (raw.includes("en")) return "en";
  if (raw.includes("ka")) return "ka";
  return undefined;
}

// זיהוי אם הבקשה מאובטחת (HTTPS/מאחורי פרוקסי)
function isSecure(ctx: Context): boolean {
  // @ts-ignore oak עשוי לא להקליד secure
  if ((ctx.request as any).secure) return true;
  const xf = ctx.request.headers.get("x-forwarded-proto");
  if (xf && xf.toLowerCase() === "https") return true;
  try {
    return ctx.request.url.protocol === "https:";
  } catch {
    return false;
  }
}

/** שמירת שפה ב־cookie (גם lang וגם sb_lang) עם Fallback */
async function persistLangCookie(ctx: Context, lang: Locale) {
  const base = {
    httpOnly: false,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 180, // 180 ימים
  };
  const firstTry = { ...base, secure: isSecure(ctx) };

  try {
    await ctx.cookies.set("lang", lang, firstTry);
    await ctx.cookies.set("sb_lang", lang, firstTry);
  } catch {
    try {
      const secondTry = { ...base, secure: false };
      await ctx.cookies.set("lang", lang, secondTry);
      await ctx.cookies.set("sb_lang", lang, secondTry);
      console.warn("[i18n] secure cookie failed over HTTP, retried with secure:false");
    } catch (err2) {
      console.error("[i18n] failed to set cookies even after fallback:", err2);
    }
  }
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

/** מיפוי URL → שם עמוד לטעינת מילון ייעודי */
function pageFromPath(pathname: string, hinted?: string): string {
  if (hinted && hinted.trim()) return hinted.trim();
  if (pathname === "/") return "home";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/owner")) return "owner";
  if (pathname.startsWith("/restaurants")) return "restaurant";
  if (pathname.startsWith("/auth")) return "auth";
  if (pathname.startsWith("/opening")) return "opening";
  if (pathname.startsWith("/dashboard")) return "dashboard";
  return "common"; // אפשרות ברירת־מחדל לעמודים כלליים
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

  // זיהוי שם עמוד (אפשר גם לרמוז ידנית לפני ה־i18n: ctx.state.page = 'home' למשל)
  // deno-lint-ignore no-explicit-any
  const hintedPage = (ctx.state as any)?.page as string | undefined;
  const page = pageFromPath(ctx.request.url.pathname, hintedPage);

  // טען מילון: בסיסי + ייעודי לעמוד (ללא דריסה, וזמין גם תחת t.page)
  const dict = await loadDict(lang, page);

  // הזרקה ל־state
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).lang = lang;
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
