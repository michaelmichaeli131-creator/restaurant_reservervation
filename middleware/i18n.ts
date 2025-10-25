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
function cacheKey(locale: Locale, page?: string) {
  return `${locale}::${page || "-"}`;
}

/* ---------- נתיבי קבצים ---------- */
function filePath(rel: string) {
  try { return new URL(rel, import.meta.url).pathname; }
  catch { return rel.replace(/^\.\.\//, "./"); }
}

/** נתיב לקובץ מילון כללי: i18n/<locale>.json */
function baseDictPath(locale: Locale): string {
  return filePath(`../i18n/${locale}.json`);
}

/** מועמדים לקובץ מילון עמוד */
function pageDictCandidates(page: string, locale: Locale): string[] {
  return [
    filePath(`../i18n/${page}.${locale}.json`),   // A: i18n/home.he.json
    filePath(`../i18n/${locale}/${page}.json`),   // B: i18n/he/home.json
    filePath(`../i18n/${page}/${locale}.json`),   // C: i18n/home/he.json
  ];
}

/* ---------- I/O ---------- */
async function tryReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const txt = await Deno.readTextFile(path);
    return JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ---------- Merge helpers ---------- */
/** מיזוג עומק ללא דריסה (לא מחליף ערכים קיימים; רק משלים חסרים) */
function deepMergeNoOverwrite<T extends Record<string, unknown>>(base: T, extra: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(extra)) {
    const bv = base[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      bv && typeof bv === "object" && !Array.isArray(bv)
    ) {
      // @ts-ignore - two objects
      base[k] = deepMergeNoOverwrite(bv as Record<string, unknown>, v as Record<string, unknown>);
    } else if (bv === undefined) {
      // @ts-ignore - fill only if missing
      base[k] = v;
    }
    // אם יש כבר ערך ב-base – לא נוגעים (אין דריסה)
  }
  return base;
}

/* ---------- Utils ---------- */
function getPath(obj: any, path: string, fallback?: string) {
  const v = path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
  return v ?? fallback ?? `(${path})`;
}
function interpolate(s: string, vars?: Record<string, unknown>) {
  return !vars ? s : s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
function norm(code?: string | null): Locale {
  const c = (code || "").toLowerCase().slice(0, 2);
  return (SUPPORTED as readonly string[]).includes(c) ? (c as Locale) : DEFAULT;
}
function fromAcceptLanguage(header: string | null): Locale | undefined {
  if (!header) return undefined;
  const raw = header.toLowerCase();
  if (raw.includes("he")) return "he";
  if (raw.includes("en")) return "en";
  if (raw.includes("ka")) return "ka";
  return undefined;
}
function isSecure(ctx: Context): boolean {
  // @ts-ignore - Oak לפעמים לא מקליד secure
  if ((ctx.request as any).secure) return true;
  const xf = ctx.request.headers.get("x-forwarded-proto");
  if (xf && xf.toLowerCase() === "https") return true;
  try { return ctx.request.url.protocol === "https:"; } catch { return false; }
}

/** שמירת שפה ב־cookie (גם lang וגם sb_lang) עם Fallback */
async function persistLangCookie(ctx: Context, lang: Locale) {
  const base = { httpOnly: false, sameSite: "Lax" as const, path: "/", maxAge: 60 * 60 * 24 * 180 };
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

/** ניסיון קריאת/כתיבת שפה מה־session אם קיים */
async function getLangFromSession(ctx: Context): Promise<string | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any)?.session;
    return session ? await session.get("lang") : null;
  } catch { return null; }
}
async function setLangToSession(ctx: Context, lang: Locale) {
  try {
    // deno-lint-ignore no-explicit-any
    const session = (ctx.state as any)?.session;
    await session?.set("lang", lang);
  } catch { /* ignore */ }
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
  return "common";
}

/* ---------- טעינת מילון עם Fallbacks חכמים ---------- */
async function loadDict(locale: Locale, page?: string): Promise<Record<string, unknown>> {
  const ckey = cacheKey(locale, page);
  if (IS_PROD && cache.has(ckey)) return cache.get(ckey)!;

  // 1) בסיס (שפה נוכחית; אם אין – ברירת־מחדל)
  let baseDict = await tryReadJson(baseDictPath(locale)) ?? {};
  if (!Object.keys(baseDict).length && locale !== DEFAULT) {
    const fb = await tryReadJson(baseDictPath(DEFAULT));
    if (fb) baseDict = fb;
  }

  // 2) עמוד (שפה נוכחית → אם חסר אז ברירת־מחדל), ו-Merge ללא דריסה
  let pageDict: Record<string, unknown> = {};
  if (page) {
    // נסה מועמדים בשפה הנוכחית
    for (const p of pageDictCandidates(page, locale)) {
      const data = await tryReadJson(p);
      if (data) { pageDict = data; break; }
    }
    // אם לא נמצא, נסה את ברירת־המחדל
    if (!Object.keys(pageDict).length && locale !== DEFAULT) {
      for (const p of pageDictCandidates(page, DEFAULT)) {
        const data = await tryReadJson(p);
        if (data) { pageDict = data; break; }
      }
    }

    // מיזוג עומק *ללא דריסה* לתוך הבסיס
    baseDict = deepMergeNoOverwrite(baseDict, pageDict);
    // וגם זמינות כ- t('page.*')
    (baseDict as any).page = pageDict;
  }

  if (IS_PROD) cache.set(ckey, baseDict);
  return baseDict;
}

/* ---------- ה־middleware הראשי ---------- */
export const i18n: Middleware = async (ctx, next) => {
  // קדימות: ?lang= → cookie (lang/sb_lang) → session → Accept-Language → DEFAULT
  const q = ctx.request.url.searchParams.get("lang") || "";

  let lang: Locale | undefined;
  if (q) lang = norm(q);
  else {
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

  // שם עמוד (אפשר גם לרמוז ידנית לפני ה־i18n: ctx.state.page = 'home')
  // deno-lint-ignore no-explicit-any
  const hintedPage = (ctx.state as any)?.page as string | undefined;
  const page = pageFromPath(ctx.request.url.pathname, hintedPage);

  const dict = await loadDict(lang, page);

  // הזרקה ל־state
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).lang = lang;
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).dir = (ctx.state as any).dir ?? DIR[lang];
  // deno-lint-ignore no-explicit-any
  (ctx.state as any).t = (key: string, vars?: Record<string, unknown>) => {
    const raw = getPath(dict, key, `(${key})`);
    if (raw === `(${key})`) console.warn(`[i18n] missing key: ${key} (page=${page}, lang=${lang})`);
    return typeof raw === "string" ? interpolate(raw, vars) : String(raw);
  };

  // אם הגיעה בקשה עם ?lang=... — נעדכן cookie ו־session לשימור
  if (q) {
    await persistLangCookie(ctx, lang);
    await setLangToSession(ctx, lang);
  } else {
    const hasCookie = (await ctx.cookies.get("lang")) ?? (await ctx.cookies.get("sb_lang"));
    if (!hasCookie) await persistLangCookie(ctx, lang);
  }

  await next();
};
