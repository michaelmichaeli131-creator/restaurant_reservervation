// src/lib/mail.ts
// שליחת אימיילים דרך Resend עם אכיפה על MAIL_FROM תקין,
// תמיכת DRY-RUN נשלטת, ולוגים ברורים.
// כולל תבניות HTML מעוצבות (Luxury Dark) ותמיכה מלאה ברב־לשוניות (he/en/ka)
// בהתאם לשפת ההקלקה/הקשר הנשלחת לפונקציות.
//
// **פיצ'רים עיקריים**
// - כפתור ניהול הזמנה עם קישור ישיר (manageUrl) + הזרקת ?lang=...
// - אנטי-קליפינג בג'ימייל (תוכן מזהה גלוי)
// - טקסט/HTML תואמי שפה, כולל כיווניות dir=rtl/ltr
// - הצגת הערות הלקוח (note) גם במייל הלקוח וגם במייל הבעלים
// - verify/reset/reminder/reservation/owner notifications רב־לשוניים (ברירת מחדל he)
// - עטיפה אחידה בסגנון כהה יוקרתי התואם לאתר

/* ======================= ENV ======================= */
const ENV = {
  BASE_URL: (Deno.env.get("BASE_URL") || "").trim(),
  RESEND_API_KEY: (Deno.env.get("RESEND_API_KEY") || "").trim(),
  MAIL_FROM: (Deno.env.get("MAIL_FROM") || "").trim(), // חובה: דומיין מאומת
  DRY_RUN: (Deno.env.get("RESEND_DRY_RUN") || "").toLowerCase() === "1",
};

/* ======================= Lang / i18n ======================= */
type Lang = "he" | "en" | "ka";
const SUPPORTED: Lang[] = ["he", "en", "ka"];
function normLang(l?: string | null): Lang {
  const v = String(l || "").toLowerCase();
  // Default language is English
  return (SUPPORTED as string[]).includes(v) ? (v as Lang) : "en";
}
function dirByLang(l: Lang): "rtl" | "ltr" {
  return l === "he" ? "rtl" : "ltr";
}

const I18N = {
  brand: { he: "SpotBook", en: "SpotBook", ka: "SpotBook" },
  // generic labels
  hello: { he: "שלום", en: "Hello", ka: "გამარჯობა" },
  date: { he: "תאריך", en: "Date", ka: "თარიღი" },
  time: { he: "שעה", en: "Time", ka: "დრო" },
  guests: { he: "אורחים", en: "Guests", ka: "სტუმრები" },
  dayLabel: { he: "יום / ת׳", en: "Day / D/M", ka: "დღე / D/M" },
  noteTitle: { he: "הערות/בקשות הלקוח:", en: "Customer notes/requests:", ka: "კლიენტის შენიშვნები/მოთხოვნები:" },
  manageCta: { he: "ניהול ההזמנה (אישור/ביטול/שינוי)", en: "Manage reservation (confirm/cancel/reschedule)", ka: "ჯავშნის მართვა (დადასტ./გაუქმ./დროის შეცვლა)" },
  directLink: { he: "קישור ישיר", en: "Direct link", ka: "პირდაპირი ბმული" },
  footerAuto: {
    he: "האימייל נשלח אוטומטית. אין להשיב להודעה זו.",
    en: "This email was sent automatically. Please do not reply.",
    ka: "ეს წერილი ავტომატურად გაიგზავნა. გთხოვთ, არ უპასუხოთ."
  },
  // subjects & leads
  verifyTitle: { he: "ברוכים הבאים ל-SpotBook", en: "Welcome to SpotBook", ka: "მოგესალმებათ SpotBook" },
  verifyLead: { he: "נשאר רק לאמת את כתובת הדוא״ל שלך.", en: "Please verify your email address to continue.", ka: "გთხოვთ, დაადასტუროთ ელფოსტა." },
  verifyCta: { he: "אימות חשבון", en: "Verify account", ka: "ანგარიშის დადასტურება" },
  verifySubject: {
    he: `אימות כתובת דוא"ל – SpotBook`,
    en: `Email verification — SpotBook`,
    ka: `ელფოსტის დადასტურება — SpotBook`,
  },

  resetTitle: { he: "איפוס סיסמה", en: "Reset password", ka: "პაროლის აღდგენა" },
  resetLead: { he: "לחצי/לחץ על הכפתור כדי להגדיר סיסמה חדשה.", en: "Click the button to set a new password.", ka: "დააჭირეთ ღილაკს ახალი პაროლის დასაყენებლად." },
  resetCta: { he: "איפוס סיסמה", en: "Reset password", ka: "პაროლის აღდგენა" },
  resetSubject: {
    he: "שחזור סיסמה – SpotBook",
    en: "Password reset — SpotBook",
    ka: "პაროლის აღდგენა — SpotBook",
  },

  reservationLead: {
    he: "פרטי ההזמנה שלך. ניתן לאשר/לבטל/לשנות מועד דרך הקישור למטה.",
    en: "Your reservation details. You can confirm/cancel/reschedule via the link below.",
    ka: "ჯავშნის დეტალები. შეგიძლიათ დადასტურება/გაუქმება/დროის შეცვლა ქვემოთ მოცემული ბმით."
  },
  reservationSubject: {
    he: (r: string) => `אישור הזמנה – ${r}`,
    en: (r: string) => `Reservation confirmed — ${r}`,
    ka: (r: string) => `ჯავშანი დადასტურებულია — ${r}`,
  },
  reservationBodyLines: {
    he: [
      "🎉 הזמנתך נקלטה. נשמח לאשר הגעה כמה דקות לפני.",
      "🚗 חניה מוזלת ללקוחות המסעדה בסופי שבוע החל מ-18:00.",
      "⏱️ השולחן יישמר 15 דקות.",
      "מחכים לראותכם ❤️",
    ],
    en: [
      "🎉 Your reservation was received. Please confirm your arrival a few minutes in advance.",
      "🚗 Discounted parking for restaurant guests on weekends from 18:00.",
      "⏱️ Your table will be held for 15 minutes.",
      "See you soon ❤️",
    ],
    ka: [
      "🎉 თქვენი ჯავშანი მიღებულია. გთხოვთ, დაევიდასტუროთ მოსვლა რამდენიმე წუთით ადრე.",
      "🚗 შეღავათიანი პარკინგი შაბათ-კვირას 18:00-დან.",
      "⏱️ მაგიდა შენახულია 15 წუთით.",
      "გელოდებით ❤️",
    ],
  },

  ownerNewTitle: { he: "התקבלה הזמנה חדשה", en: "New reservation received", ka: "ახალი ჯავშანი მიიღეს" },
  ownerSubject: {
    he: (r: string) => `הזמנה חדשה – ${r}`,
    en: (r: string) => `New reservation — ${r}`,
    ka: (r: string) => `ახალი ჯავშანი — ${r}`,
  },

  reminderTitle: { he: "תזכורת להזמנה", en: "Reservation reminder", ka: "შეხსენება ჯავშანზე" },
  reminderLead: { he: "נא אשר/י הגעה בלחיצה:", en: "Please confirm your attendance:", ka: "გთხოვთ, დაადასტუროთ მოსვლა:" },
  reminderCta: { he: "אישור הגעה", en: "Confirm attendance", ka: "მოსვლის დადასტურება" },
  reminderSubject: {
    he: "תזכורת להזמנה – נא אשר/י הגעה",
    en: "Reservation reminder — please confirm",
    ka: "შეხსენება — გთხოვთ, დაადასტუროთ",
  },

  reviewTitle: { he: "נשמח לשמוע ממך!", en: "We'd love your feedback!", ka: "გვინდა თქვენი აზრი!" },
  reviewLead: {
    he: "ביקרת לאחרונה ב-{restaurant}. ספר/י לנו על החוויה שלך.",
    en: "You recently visited {restaurant}. Tell us about your experience.",
    ka: "თქვენ ახლახანს ეწვიეთ {restaurant}-ს. გვითხარით გამოცდილებაზე."
  },
  reviewCta: { he: "השאר ביקורת", en: "Leave a Review", ka: "დატოვეთ მიმოხილვა" },
  reviewSubject: {
    he: (r: string) => `איך היה? ספר/י על ${r}`,
    en: (r: string) => `How was it? Share your experience at ${r}`,
    ka: (r: string) => `როგორ იყო? გაგვიზიარეთ გამოცდილება — ${r}`,
  },
};

function t<K extends keyof typeof I18N>(k: K, l: Lang): (typeof I18N)[K][Lang] {
  // @ts-ignore
  const v = I18N[k][l];
  // @ts-ignore
  return v ?? I18N[k]["he"];
}

function weekdayShortByLang(l: Lang, d: Date): string {
  try {
    const locale = l === "he" ? "he-IL" : l === "ka" ? "ka-GE" : "en-US";
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  } catch {
    const en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return en[d.getDay()] || "";
  }
}

/* ======================= Utils ======================= */
function ensureFrom(): string {
  // חייבים MAIL_FROM עם @ ושאינו example.com
  if (!ENV.MAIL_FROM || !ENV.MAIL_FROM.includes("@")) {
    throw new Error(
      "MAIL_FROM is missing or invalid. Set MAIL_FROM to a verified address, e.g. 'SpotBook <no-reply@spotbook.rest>'."
    );
  }
  const lower = ENV.MAIL_FROM.toLowerCase();
  if (lower.includes("@example.com")) {
    throw new Error(
      "MAIL_FROM uses example.com which is not a verified domain. Set MAIL_FROM to your verified domain."
    );
  }
  return ENV.MAIL_FROM;
}

function buildUrl(path: string, lang?: Lang) {
  const base = ENV.BASE_URL.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = base ? `${base}${p}` : p;
  if (!lang) return url;
  try {
    const u = new URL(url, "http://local");
    u.searchParams.set("lang", lang);
    const out = base ? u.toString() : `${u.pathname}${u.search}`;
    return out;
  } catch {
    return url;
  }
}

type MailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  fromOverride?: string;
};

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h\d>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendViaResend(p: MailParams) {
  const apiKey = ENV.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");

  const from = p.fromOverride || ensureFrom();
  const toArr = Array.isArray(p.to) ? p.to : [p.to];
  const body = {
    from,
    to: toArr,
    subject: p.subject,
    html: p.html,
    text: p.text || htmlToText(p.html),
    headers: p.headers,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${msg || res.statusText}`);
  }
  return await res.json().catch(() => ({}));
}

function logDry(label: string, p: MailParams) {
  const to = Array.isArray(p.to) ? p.to.join(", ") : p.to;
  console.warn(
    `[mail][DRY] ${label}: to=${to} subj="${p.subject}" from="${
      p.fromOverride || ENV.MAIL_FROM || "(unset)"
    }"`
  );
  console.warn(`[mail][DRY] text:\n${p.text || htmlToText(p.html)}\n`);
}

/* ======================= Public send wrapper ======================= */
export async function sendMailAny(p: MailParams) {
  try {
    ensureFrom();
  } catch (e) {
    console.error("[mail] config error:", String(e));
    return { ok: false, reason: String(e) };
  }

  if (ENV.DRY_RUN || !ENV.RESEND_API_KEY) {
    logDry(ENV.DRY_RUN ? "RESEND_DRY_RUN=1" : "RESEND_API_KEY missing", p);
    return { ok: true, dryRun: true };
  }

  try {
    const data = await sendViaResend(p);
    console.log("[mail] sent via Resend:", {
      to: p.to,
      subject: p.subject,
      id: (data as any)?.id,
    });
    return { ok: true };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error("[mail] Resend error:", msg);
    return { ok: false, reason: msg };
  }
}

/* --------- Backward-compatible helper (string 'to') ---------- */
export async function sendMail(
  to: string | string[],
  subject: string,
  html: string,
  text?: string
) {
  return await sendMailAny({
    to,
    subject,
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
  });
}

/* =================== עיצוב Luxury Dark =================== */
const palette = {
  bg: "#0b1120",
  surface: "#0f172a",
  card: "#111827",
  text: "#e5e7eb",
  sub: "#9aa3b2",
  btn: "#3b82f6",
  btnText: "#ffffff",
  border: "#1f2937",
  link: "#93c5fd",
};

function baseWrap(htmlInner: string, lang: Lang) {
  const dir = dirByLang(lang);
  const brand = t("brand", lang);
  const footer = t("footerAuto", lang);
  return `
  <div dir="${dir}" style="background:${palette.bg};padding:28px 0;">
    <table align="center" role="presentation" width="100%" style="
      max-width:640px;margin:auto;background:${palette.card};
      border:1px solid ${palette.border};border-radius:16px;
      box-shadow:0 2px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.03);
      font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      color:${palette.text}; line-height:1.6;">
      <tr>
        <td style="padding:22px 24px 6px;border-bottom:1px solid ${palette.border};background:${palette.surface}">
          <h1 style="margin:0;font-size:26px;font-weight:800;letter-spacing:.2px;">${brand}</h1>
          <p style="margin:6px 0 0;color:${palette.sub};font-size:15px;">reservation@spotbook.rest</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 24px 22px;">
          ${htmlInner}
          <p style="margin:24px 0 0;color:${palette.sub};font-size:12px;">${footer}</p>
        </td>
      </tr>
    </table>
    <div style="display:none !important;visibility:hidden;opacity:0;overflow:hidden;height:0;width:0;line-height:0;">
      ${brand} — ${footer}
    </div>
  </div>`;
}

function formatDM(iso: string) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "";
  return `${d}/${m}`;
}

/* =============== Sanitizers for note (הערות) =============== */
function sanitizeNoteRaw(raw?: string | null): string {
  const s = String(raw ?? "").replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E\u0590-\u05FF\u0600-\u06FF]/g, "").trim();
}
function clampNoteLen(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
function noteAsHtml(note?: string | null, lang: Lang = "he"): string {
  const title = t("noteTitle", lang);
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  if (!clean) return "";
  const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBr = esc.replace(/\n/g, "<br/>");
  return `
    <div style="margin-top:14px;border:1px solid ${palette.border};border-radius:12px;background:${palette.surface};padding:12px 14px;">
      <div style="font-weight:800;margin-bottom:6px;color:${palette.text}">${title}</div>
      <div style="white-space:pre-wrap;line-height:1.5;color:${palette.sub}">${withBr}</div>
    </div>`;
}
function noteAsText(note?: string | null, lang: Lang = "he"): string {
  const title = t("noteTitle", lang);
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  return clean ? `\n${title}\n${clean}\n` : "";
}

/* =================== Verify Email =================== */
export async function sendVerifyEmail(to: string, token: string, lang?: string | null) {
  const L = normLang(lang);
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`, L);
  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${t("verifyTitle", L)}</h2>
    <p style="margin:0 0 12px 0;color:${palette.sub};">${t("verifyLead", L)}</p>
    <div style="text-align:center;margin:16px 0 18px;">
      <a href="${link}" style="
        display:inline-block;background:${palette.btn};color:${palette.btnText};
        padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
        ${t("verifyCta", L)}
      </a>
    </div>
    <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">
      ${t("directLink", L)}: <a href="${link}" style="color:${palette.link}">${link}</a>
    </p>
  `, L);

  return await sendMail(to, t("verifySubject", L), html);
}

/* =================== Reset Email =================== */
export async function sendResetEmail(to: string, token: string, lang?: string | null) {
  const L = normLang(lang);
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`, L);
  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${t("resetTitle", L)}</h2>
    <p style="margin:0 0 12px 0;color:${palette.sub};">${t("resetLead", L)}</p>
    <div style="text-align:center;margin:16px 0 18px;">
      <a href="${link}" style="
        display:inline-block;background:${palette.btn};color:${palette.btnText};
        padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
        ${t("resetCta", L)}
      </a>
    </div>
    <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">
      ${t("directLink", L)}: <a href="${link}" style="color:${palette.link}">${link}</a>
    </p>
  `, L);

  return await sendMail(to, t("resetSubject", L), html);
}

/* =================== Reservation Confirmation (Customer) =================== */
export async function sendReservationEmail(opts: {
  to: string;
  restaurantName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  people: number;
  customerName?: string;
  manageUrl?: string;      // קישור לניהול — יוזר
  reservationId?: string;  // לאנטי-קליפינג
  note?: string | null;    // הערות הלקוח
  lang?: string | null;    // שפת המייל
}) {
  const L = normLang(opts.lang);
  const {
    to, restaurantName, date, time, people,
    customerName, reservationId, note,
  } = opts;

  // הבטחת ?lang בקישור הניהול אם קיים
  const manageUrl =
    opts.manageUrl
      ? ((): string => {
          try {
            const u = new URL(opts.manageUrl, "http://local");
            u.searchParams.set("lang", L);
            const base = ENV.BASE_URL ? u.toString() : `${u.pathname}${u.search}`;
            return base;
          } catch { return opts.manageUrl!; }
        })()
      : undefined;

  const d = new Date(`${date}T12:00:00`);
  const dayShort = isNaN(d.getTime()) ? "" : weekdayShortByLang(L, d);
  const dm = formatDM(date);

  const shortId =
    (reservationId && reservationId.slice(-6)) ||
    (manageUrl?.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(-6)) ||
    "";

  const detailsCard = `
    <div style="
      background:${palette.surface};color:${palette.text};
      border-radius:16px;padding:16px 14px;max-width:520px;margin:10px auto 6px;
      border:1px solid ${palette.border};">
      <table role="presentation" width="100%" style="border-collapse:collapse;color:${palette.text}">
        <tr>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">${t("dayLabel", L)}</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${dayShort} ${dm}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">${t("time", L)}</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${time}</div>
          </td>
          <td style="width:33%;text-align:center;">
            <div style="opacity:.8;font-size:13px;color:${palette.sub}">${t("guests", L)}</div>
            <div style="font-size:20px;font-weight:800;letter-spacing:.3px;">${people}</div>
          </td>
        </tr>
      </table>
      ${
        shortId
          ? `<div style="margin-top:8px;text-align:center;font-size:12px;color:${palette.sub}">
               ID: <strong style="letter-spacing:.4px;color:${palette.text}">${shortId}</strong>
             </div>`
          : ""
      }
    </div>`;

  const lines = I18N.reservationBodyLines[L] ?? I18N.reservationBodyLines.he;
  const notesHtml = noteAsHtml(note, L);

  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${restaurantName}</h2>
    <p style="margin:0 0 12px 0;color:${palette.sub};">${t("reservationLead", L)}</p>
    ${detailsCard}
    <div style="padding:6px 4px 0;">
      ${customerName ? `<p style="margin:8px 0 0;">${t("hello", L)} ${customerName},</p>` : ""}
      ${lines.map((x) => `<p style="margin:6px 0 0;">${x}</p>`).join("")}
    </div>
    ${notesHtml}
    <div style="text-align:center;margin:16px 0 0;">
      ${
        manageUrl
          ? `<a href="${manageUrl}" style="
                display:inline-block;background:${palette.btn};color:${palette.btnText};
                padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
                ${t("manageCta", L)}
             </a>`
          : ""
      }
    </div>
    ${
      manageUrl
        ? `<p style="margin:14px 0 0;color:${palette.sub};font-size:14px;word-break:break-all">
             ${t("directLink", L)}: <a href="${manageUrl}" style="color:${palette.link}">${manageUrl}</a>
           </p>`
        : ""
    }
  `, L);

  const text = [
    t("reservationSubject", L)(restaurantName),
    customerName ? `${t("hello", L)} ${customerName},` : "",
    `${t("date", L)}: ${date} | ${t("time", L)}: ${time} | ${t("guests", L)}: ${people}`,
    shortId ? `ID: ${shortId}` : "",
    ...(I18N.reservationBodyLines[L] ?? I18N.reservationBodyLines.he),
    noteAsText(note, L).trim(),
    manageUrl ? `${t("manageCta", L)}: ${manageUrl}` : "",
  ].filter(Boolean).join("\n");

  return await sendMailAny({
    to,
    subject: t("reservationSubject", L)(restaurantName),
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
  });
}

/* =================== Owner Notification =================== */
export async function notifyOwnerEmail(opts: {
  to: string | string[];
  restaurantName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  date: string;
  time: string;
  people: number;
  note?: string | null;
  lang?: string | null; // אם יש לכם העדפת שפה לבעלים
}) {
  const L = normLang(opts.lang);
  const {
    to, restaurantName, customerName, customerPhone, customerEmail,
    date, time, people, note,
  } = opts;

  const notesHtml = noteAsHtml(note, L);

  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${t("ownerNewTitle", L)}</h2>
    <p style="margin:0 0 10px 0;color:${palette.sub};">${restaurantName}</p>
    <div style="background:${palette.surface};border:1px solid ${palette.border};
      color:${palette.text};border-radius:14px;padding:12px 14px;">
      <p style="margin:0;">
        <strong>${t("date", L)}:</strong> ${date} · <strong>${t("time", L)}:</strong> ${time} · <strong>${t("guests", L)}:</strong> ${people}
      </p>
    </div>
    <div style="margin-top:12px;">
      <p style="margin:0;"><strong>${t("hello", L)}:</strong> ${customerName}</p>
      <p style="margin:0;"><strong>Phone:</strong> ${customerPhone || "-"}</p>
      <p style="margin:0;"><strong>Email:</strong> ${customerEmail || "-"}</p>
    </div>
    ${notesHtml}
  `, L);

  const text =
    `${t("ownerNewTitle", L)} — ${restaurantName}\n` +
    `${t("date", L)}: ${date} | ${t("time", L)}: ${time} | ${t("guests", L)}: ${people}\n` +
    `Customer: ${customerName} | Phone: ${customerPhone || "-"} | Email: ${customerEmail || "-"}\n` +
    (noteAsText(note, L) || "");

  return await sendMailAny({
    to,
    subject: (I18N.ownerSubject[L] ?? I18N.ownerSubject.he)(restaurantName),
    html,
    text,
  });
}

/* =================== Reminder =================== */
export async function sendReminderEmail(opts: {
  to: string | string[];
  confirmUrl: string;      // קישור אישור/ניהול
  restaurantName: string;
  date: string;
  time: string;
  people: number;
  customerName?: string;
  lang?: string | null;
}) {
  const L = normLang(opts.lang);
  const link = buildUrl(
    opts.confirmUrl.startsWith("http") ? opts.confirmUrl : opts.confirmUrl,
    L
  );

  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${t("reminderTitle", L)}</h2>
    <p style="margin:0 0 10px 0;color:${palette.sub};">${opts.restaurantName}</p>
    <div style="background:${palette.surface};border:1px solid ${palette.border};
      color:${palette.text};border-radius:16px;padding:14px;">
      <p style="margin:0;">
        <strong>${t("date", L)}:</strong> ${opts.date} · <strong>${t("time", L)}:</strong> ${opts.time} · <strong>${t("guests", L)}:</strong> ${opts.people}
      </p>
    </div>
    <div style="margin-top:12px;">
      ${opts.customerName ? `<p style="margin:0;">${t("hello", L)} ${opts.customerName},</p>` : ""}
      <p style="margin:6px 0 0;">${t("reminderLead", L)}</p>
      <div style="text-align:center;margin:12px 0 0;">
        <a href="${link}" style="
          display:inline-block;background:${palette.btn};color:${palette.btnText};
          padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:800;">
          ${t("reminderCta", L)}
        </a>
      </div>
    </div>
  `, L);

  const text =
    `${t("reminderTitle", L)} — ${opts.restaurantName}\n` +
    `${t("date", L)}: ${opts.date} | ${t("time", L)}: ${opts.time} | ${t("guests", L)}: ${opts.people}\n` +
    `${t("reminderCta", L)}: ${link}`;

  return await sendMailAny({
    to: opts.to,
    subject: t("reminderSubject", L),
    html,
    text,
  });
}

/* =================== Post-Visit Review Email =================== */
export async function sendReviewEmail(opts: {
  to: string;
  reviewUrl: string;
  restaurantName: string;
  date: string;        // YYYY-MM-DD of the visit
  customerName?: string;
  lang?: string | null;
}) {
  const L = normLang(opts.lang);
  const { to, restaurantName, customerName, date } = opts;
  const link = opts.reviewUrl;

  const lead = (t("reviewLead", L) as string).replace("{restaurant}", `<strong>${restaurantName}</strong>`);

  const html = baseWrap(`
    <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;">${t("reviewTitle", L)}</h2>
    <p style="margin:0 0 12px 0;color:${palette.sub};">${restaurantName} · ${date}</p>
    ${customerName ? `<p style="margin:0 0 10px 0;">${t("hello", L)} ${customerName},</p>` : ""}
    <p style="margin:0 0 16px 0;color:${palette.sub};">${lead}</p>
    <div style="text-align:center;margin:16px 0 18px;">
      <a href="${link}" style="
        display:inline-block;background:${palette.btn};color:${palette.btnText};
        padding:14px 22px;border-radius:999px;text-decoration:none;font-weight:800;font-size:16px;">
        ⭐ ${t("reviewCta", L)}
      </a>
    </div>
    <p style="margin:0;color:${palette.sub};font-size:14px;word-break:break-all">
      ${t("directLink", L)}: <a href="${link}" style="color:${palette.link}">${link}</a>
    </p>
  `, L);

  const leadText = (t("reviewLead", L) as string).replace("{restaurant}", restaurantName);
  const text = [
    (t("reviewSubject", L) as (r: string) => string)(restaurantName),
    customerName ? `${t("hello", L)} ${customerName},` : "",
    leadText,
    `${t("reviewCta", L)}: ${link}`,
  ].filter(Boolean).join("\n");

  return await sendMailAny({
    to,
    subject: (t("reviewSubject", L) as (r: string) => string)(restaurantName),
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
  });
}
