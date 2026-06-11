// src/lib/mail.ts
// שליחת אימיילים דרך Resend עם אכיפה על MAIL_FROM תקין,
// תמיכת DRY-RUN נשלטת, ולוגים ברורים.
// כולל תבניות HTML מודרניות (Light / Clean) ותמיכה מלאה ברב־לשוניות (he/en/ka)
// בהתאם לשפת ההקלקה/הקשר הנשלחת לפונקציות.
//
// **פיצ'רים עיקריים**
// - עטיפה אחידה אחת (renderEmailShell) לכל המיילים: רקע לבן, כרטיס מעוגל,
//   רוחב מקסימלי 600px, CSS inline בלבד, פונט מערכת — בטוח ל-Gmail/Outlook
// - מותג SpotBook עם צבע מבטא #3b82f6
// - כפתור ניהול הזמנה עם קישור ישיר (manageUrl) + הזרקת ?lang=...
// - אנטי-קליפינג בג'ימייל (תוכן מזהה גלוי) + preheader מוסתר
// - טקסט/HTML תואמי שפה, כולל כיווניות dir=rtl/ltr
// - הצגת הערות הלקוח (note) גם במייל הלקוח וגם במייל הבעלים
// - שדות מובְנים חדשים: occasion (אירוע מיוחד) + dietary (העדפות תזונה)
//   מוצגים במייל הלקוח ובמייל הבעלים, מתורגמים he/en/ka
// - verify/reset/reminder/reservation/owner/review רב־לשוניים (ברירת מחדל en)

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
  dayLabel: { he: "יום / ת׳", en: "Day / D/M", ka: "დღე / თვე" },
  noteTitle: { he: "הערות/בקשות הלקוח:", en: "Customer notes/requests:", ka: "სტუმრის შენიშვნები / თხოვნები:" },
  manageCta: { he: "ניהול ההזמנה (אישור/ביטול/שינוי)", en: "Manage reservation (confirm/cancel/reschedule)", ka: "ჯავშნის მართვა (დადასტურება / გაუქმება / დროის შეცვლა)" },
  directLink: { he: "קישור ישיר", en: "Direct link", ka: "პირდაპირი ბმული" },
  customerLabel: { he: "לקוח", en: "Customer", ka: "სტუმარი" },
  phoneLabel: { he: "טלפון", en: "Phone", ka: "ტელეფონი" },
  emailLabel: { he: "אימייל", en: "Email", ka: "ელ-ფოსტა" },
  footerAuto: {
    he: "האימייל נשלח אוטומטית. אין להשיב להודעה זו.",
    en: "This email was sent automatically. Please do not reply.",
    ka: "ეს წერილი ავტომატურად გამოიგზავნა. გთხოვთ, მას არ უპასუხოთ."
  },

  // structured reservation extras
  occasionTitle: { he: "אירוע מיוחד", en: "Special occasion", ka: "განსაკუთრებული შემთხვევა" },
  dietaryTitle: { he: "העדפות תזונה", en: "Dietary preferences", ka: "კვებითი პრეფერენციები" },
  occasionLabels: {
    birthday: { he: "יום הולדת", en: "Birthday", ka: "დაბადების დღე" },
    anniversary: { he: "יום נישואין", en: "Anniversary", ka: "წლისთავი" },
    date: { he: "דייט", en: "Date night", ka: "პაემანი" },
    business: { he: "ארוחה עסקית", en: "Business meal", ka: "საქმიანი შეხვედრა" },
    celebration: { he: "חגיגה", en: "Celebration", ka: "ზეიმი" },
    other: { he: "אחר", en: "Other", ka: "სხვა" },
  },
  dietaryLabels: {
    vegetarian: { he: "צמחוני", en: "Vegetarian", ka: "ვეგეტარიანული" },
    vegan: { he: "טבעוני", en: "Vegan", ka: "ვეგანური" },
    gluten_free: { he: "ללא גלוטן", en: "Gluten-free", ka: "გლუტენის გარეშე" },
    kosher: { he: "כשר", en: "Kosher", ka: "კოშერი" },
    halal: { he: "חלאל", en: "Halal", ka: "ჰალალი" },
    allergies: { he: "אלרגיות", en: "Allergies", ka: "ალერგიები" },
  },

  // subjects & leads
  verifyTitle: { he: "ברוכים הבאים ל-SpotBook", en: "Welcome to SpotBook", ka: "კეთილი იყოს თქვენი მობრძანება SpotBook-ში" },
  verifyLead: { he: "נשאר רק לאמת את כתובת הדוא״ל שלך.", en: "Please verify your email address to continue.", ka: "გასაგრძელებლად დაადასტურეთ თქვენი ელ-ფოსტა." },
  verifyCta: { he: "אימות חשבון", en: "Verify account", ka: "ელ-ფოსტის დადასტურება" },
  verifySubject: {
    he: `אימות כתובת דוא"ל – SpotBook`,
    en: `Email verification — SpotBook`,
    ka: `ელ-ფოსტის დადასტურება — SpotBook`,
  },

  resetTitle: { he: "איפוס סיסמה", en: "Reset password", ka: "პაროლის აღდგენა" },
  resetLead: { he: "לחצי/לחץ על הכפתור כדי להגדיר סיסמה חדשה.", en: "Click the button to set a new password.", ka: "ახალი პაროლის დასაყენებლად დააჭირეთ ქვემოთ მოცემულ ღილაკს." },
  resetCta: { he: "איפוס סיסמה", en: "Reset password", ka: "პაროლის აღდგენა" },
  resetSubject: {
    he: "שחזור סיסמה – SpotBook",
    en: "Password reset — SpotBook",
    ka: "პაროლის აღდგენა — SpotBook",
  },

  reservationLead: {
    he: "פרטי ההזמנה שלך. ניתן לאשר/לבטל/לשנות מועד דרך הקישור למטה.",
    en: "Your reservation details. You can confirm/cancel/reschedule via the link below.",
    ka: "აქ არის თქვენი ჯავშნის დეტალები. ქვემოთ მოცემული ბმულით შეგიძლიათ დაადასტუროთ, გააუქმოთ ან შეცვალოთ ჯავშანი."
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
      "🎉 თქვენი ჯავშანი მიღებულია. გთხოვთ, მოსვლა რამდენიმე წუთით ადრე დაგვიდასტუროთ.",
      "🚗 შაბათ-კვირას 18:00-დან სტუმრებისთვის ხელმისაწვდომია შეღავათიანი პარკინგი.",
      "⏱️ თქვენი მაგიდა 15 წუთით იქნება შენახული.",
      "გელოდებით ❤️",
    ],
  },

  ownerNewTitle: { he: "התקבלה הזמנה חדשה", en: "New reservation received", ka: "მიღებულია ახალი ჯავშანი" },
  ownerSubject: {
    he: (r: string) => `הזמנה חדשה – ${r}`,
    en: (r: string) => `New reservation — ${r}`,
    ka: (r: string) => `ახალი ჯავშანი — ${r}`,
  },

  reminderTitle: { he: "תזכורת להזמנה", en: "Reservation reminder", ka: "ჯავშნის შეხსენება" },
  reminderLead: { he: "נא אשר/י הגעה בלחיצה:", en: "Please confirm your attendance:", ka: "გთხოვთ, დაადასტუროთ სტუმრობა:" },
  reminderCta: { he: "אישור הגעה", en: "Confirm attendance", ka: "მოსვლის დადასტურება" },
  reminderSubject: {
    he: "תזכורת להזמנה – נא אשר/י הגעה",
    en: "Reservation reminder — please confirm",
    ka: "შეხსენება — გთხოვთ, დაადასტუროთ",
  },

  findResvTitle: { he: "ההזמנות שלך ב-SpotBook", en: "Your reservations on SpotBook", ka: "თქვენი ჯავშნები SpotBook-ზე" },
  findResvLead: {
    he: "ביקשת לאתר הזמנות המשויכות לכתובת אימייל זו. אלו ההזמנות שמצאנו:",
    en: "You asked to find reservations linked to this email address. Here is what we found:",
    ka: "თქვენ მოითხოვეთ ამ ელ-ფოსტასთან დაკავშირებული ჯავშნების მოძიება. აი, რა ვიპოვეთ:",
  },
  findResvManageCta: { he: "ניהול ההזמנה", en: "Manage reservation", ka: "ჯავშნის მართვა" },
  findResvIgnore: {
    he: "אם לא ביקשת את האימייל הזה, אפשר להתעלם ממנו בבטחה.",
    en: "If you didn't request this email, you can safely ignore it.",
    ka: "თუ ეს წერილი თქვენ არ მოგითხოვიათ, შეგიძლიათ უგულებელყოთ.",
  },
  findResvSubject: {
    he: "ההזמנות שלך – SpotBook",
    en: "Your reservations — SpotBook",
    ka: "თქვენი ჯავშნები — SpotBook",
  },

  reviewTitle: { he: "נשמח לשמוע ממך!", en: "We'd love your feedback!", ka: "თქვენი აზრი ჩვენთვის მნიშვნელოვანია!" },
  reviewLead: {
    he: "ביקרת לאחרונה ב-{restaurant}. ספר/י לנו על החוויה שלך.",
    en: "You recently visited {restaurant}. Tell us about your experience.",
    ka: "თქვენ ცოტა ხნის წინ ეწვიეთ {restaurant}-ს. გაგვიზიარეთ თქვენი გამოცდილება."
  },
  reviewCta: { he: "השאר ביקורת", en: "Leave a Review", ka: "დატოვეთ შეფასება" },
  reviewSubject: {
    he: (r: string) => `איך היה? ספר/י על ${r}`,
    en: (r: string) => `How was it? Share your experience at ${r}`,
    ka: (r: string) => `როგორი იყო საღამო? — ${r}`,
  },
};

// מפתחות I18N שערכיהם הם מפת שפות ישירה (he/en/ka) — לא קינון נוסף
type FlatI18NKey = {
  [P in keyof typeof I18N]: (typeof I18N)[P] extends Record<Lang, unknown> ? P : never;
}[keyof typeof I18N];

function t<K extends FlatI18NKey>(k: K, l: Lang): (typeof I18N)[K][Lang] {
  // @ts-ignore
  const v = I18N[k][l];
  // @ts-ignore
  return v ?? I18N[k]["he"];
}

/* ===== occasion / dietary translation helpers ===== */
const OCCASION_EMOJI: Record<string, string> = {
  birthday: "🎂",
  anniversary: "💍",
  date: "❤️",
  business: "💼",
  celebration: "🎉",
  other: "✨",
};

function occasionDisplay(key: string | undefined | null, l: Lang): string {
  const k = String(key || "").trim().toLowerCase();
  const labels = I18N.occasionLabels as Record<string, Record<Lang, string>>;
  if (!k || !labels[k]) return "";
  const emoji = OCCASION_EMOJI[k] || "";
  const label = labels[k][l] ?? labels[k].en;
  return `${emoji} ${label}`.trim();
}

function dietaryDisplayList(keys: string[] | undefined | null, l: Lang): string[] {
  const labels = I18N.dietaryLabels as Record<string, Record<Lang, string>>;
  const out: string[] = [];
  for (const raw of keys ?? []) {
    const k = String(raw || "").trim().toLowerCase();
    if (labels[k]) out.push(labels[k][l] ?? labels[k].en);
  }
  return out;
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

/* =================== עיצוב Light / Clean =================== */
// פלטה בהירה ידידותית לכל קליינט מייל. צבע מבטא: #3b82f6 (SpotBook blue).
const palette = {
  page: "#f1f5f9",      // רקע העמוד מסביב לכרטיס
  card: "#ffffff",      // רקע הכרטיס (לבן)
  text: "#0f172a",      // טקסט ראשי
  sub: "#64748b",       // טקסט משני
  accent: "#3b82f6",    // צבע מותג
  accentSoft: "#eff6ff",// רקע עדין בגוון המותג
  soft: "#f8fafc",      // רקע עדין ניטרלי
  btnText: "#ffffff",
  border: "#e2e8f0",
  link: "#2563eb",
};

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

type EmailCta = { label: string; url: string };

/**
 * העטיפה האחידה לכל המיילים.
 * מבנה: פס מבטא עליון → לוגו/שם מותג → כותרת (+תת־כותרת) → גוף → כפתור CTA →
 * פוטר עם קישור ישיר והודעת "נשלח אוטומטית".
 * - inline CSS בלבד, מבוסס טבלאות, max-width 600px — בטוח ל-Gmail/Outlook
 * - dir=rtl לעברית, ltr לשאר
 */
function renderEmailShell(opts: {
  lang: Lang;
  title: string;
  bodyHtml: string;
  subtitle?: string;
  cta?: EmailCta;
  preheader?: string;
}): string {
  const { lang, title, bodyHtml, subtitle, cta, preheader } = opts;
  const dir = dirByLang(lang);
  const brand = t("brand", lang);
  const footer = t("footerAuto", lang);
  const align = dir === "rtl" ? "right" : "left";

  const ctaBlock = cta
    ? `
        <tr>
          <td align="center" style="padding:8px 32px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background:${palette.accent};border-radius:10px;">
                  <a href="${cta.url}" style="display:inline-block;padding:13px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${palette.btnText};text-decoration:none;border-radius:10px;">${cta.label}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
    : "";

  const directLinkBlock = cta
    ? `<p style="margin:0 0 8px;color:${palette.sub};font-size:12px;word-break:break-all;">${t("directLink", lang)}: <a href="${cta.url}" style="color:${palette.link};text-decoration:underline;">${cta.url}</a></p>`
    : "";

  return `
  <div dir="${dir}" style="margin:0;padding:0;background:${palette.page};">
    <div style="display:none!important;visibility:hidden;opacity:0;overflow:hidden;height:0;width:0;max-height:0;max-width:0;mso-hide:all;">
      ${preheader || `${brand} — ${title}`}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${palette.page};">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="max-width:600px;background:${palette.card};border:1px solid ${palette.border};border-radius:16px;overflow:hidden;font-family:${FONT_STACK};color:${palette.text};line-height:1.6;text-align:${align};">
            <tr>
              <td style="height:4px;line-height:4px;font-size:0;background:${palette.accent};">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;">
                <span style="font-family:${FONT_STACK};font-size:22px;font-weight:800;letter-spacing:.3px;color:${palette.text};">Spot<span style="color:${palette.accent};">Book</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px 0;">
                <h1 style="margin:0 0 4px;font-family:${FONT_STACK};font-size:22px;font-weight:800;color:${palette.text};">${title}</h1>
                ${subtitle ? `<p style="margin:0;color:${palette.sub};font-size:15px;">${subtitle}</p>` : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 32px 10px;font-size:15px;">
                ${bodyHtml}
              </td>
            </tr>
            ${ctaBlock}
            <tr>
              <td style="padding:18px 32px 24px;border-top:1px solid ${palette.border};">
                ${directLinkBlock}
                <p style="margin:0;color:${palette.sub};font-size:12px;">${footer}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
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
function noteAsHtml(note?: string | null, lang: Lang = "en"): string {
  const title = t("noteTitle", lang);
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  if (!clean) return "";
  const esc = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBr = esc.replace(/\n/g, "<br/>");
  return `
    <div style="margin-top:14px;border:1px solid ${palette.border};border-radius:12px;background:${palette.soft};padding:12px 16px;">
      <div style="font-weight:700;font-size:13px;color:${palette.sub};margin-bottom:4px;">${title}</div>
      <div style="white-space:pre-wrap;line-height:1.5;color:${palette.text};">${withBr}</div>
    </div>`;
}
function noteAsText(note?: string | null, lang: Lang = "en"): string {
  const title = t("noteTitle", lang);
  const clean = clampNoteLen(sanitizeNoteRaw(note));
  return clean ? `\n${title}\n${clean}\n` : "";
}

/* =============== Occasion & dietary blocks =============== */
function extrasAsHtml(
  occasion: string | undefined | null,
  dietary: string[] | undefined | null,
  lang: Lang
): string {
  const occ = occasionDisplay(occasion, lang);
  const diets = dietaryDisplayList(dietary, lang);
  if (!occ && !diets.length) return "";

  const occBlock = occ
    ? `
      <div style="${diets.length ? "margin-bottom:10px;" : ""}">
        <div style="font-weight:700;font-size:13px;color:${palette.sub};margin-bottom:4px;">${t("occasionTitle", lang)}</div>
        <div style="font-size:15px;color:${palette.text};font-weight:600;">${occ}</div>
      </div>`
    : "";

  const dietChips = diets
    .map(
      (d) =>
        `<span style="display:inline-block;background:${palette.accentSoft};color:${palette.link};border:1px solid #bfdbfe;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600;margin:2px 3px 2px 0;">${d}</span>`
    )
    .join(" ");
  const dietBlock = diets.length
    ? `
      <div>
        <div style="font-weight:700;font-size:13px;color:${palette.sub};margin-bottom:4px;">${t("dietaryTitle", lang)}</div>
        <div>${dietChips}</div>
      </div>`
    : "";

  return `
    <div style="margin-top:14px;border:1px solid ${palette.border};border-radius:12px;background:${palette.soft};padding:12px 16px;">
      ${occBlock}
      ${dietBlock}
    </div>`;
}

function extrasAsText(
  occasion: string | undefined | null,
  dietary: string[] | undefined | null,
  lang: Lang
): string {
  const out: string[] = [];
  const occ = occasionDisplay(occasion, lang);
  if (occ) out.push(`${t("occasionTitle", lang)}: ${occ}`);
  const diets = dietaryDisplayList(dietary, lang);
  if (diets.length) out.push(`${t("dietaryTitle", lang)}: ${diets.join(", ")}`);
  return out.join("\n");
}

/* =============== Reservation details card (shared) =============== */
function reservationDetailsCard(opts: {
  lang: Lang;
  dayShort: string;
  dm: string;
  time: string;
  people: number;
  shortId?: string;
}): string {
  const { lang, dayShort, dm, time, people, shortId } = opts;
  return `
    <div style="border:1px solid ${palette.border};border-radius:12px;background:${palette.accentSoft};padding:16px 12px;margin:6px 0 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td width="33%" align="center" style="font-family:${FONT_STACK};">
            <div style="font-size:12px;color:${palette.sub};text-transform:uppercase;letter-spacing:.5px;">${t("dayLabel", lang)}</div>
            <div style="font-size:19px;font-weight:800;color:${palette.text};">${dayShort} ${dm}</div>
          </td>
          <td width="33%" align="center" style="font-family:${FONT_STACK};border-left:1px solid #dbeafe;border-right:1px solid #dbeafe;">
            <div style="font-size:12px;color:${palette.sub};text-transform:uppercase;letter-spacing:.5px;">${t("time", lang)}</div>
            <div style="font-size:19px;font-weight:800;color:${palette.text};">${time}</div>
          </td>
          <td width="33%" align="center" style="font-family:${FONT_STACK};">
            <div style="font-size:12px;color:${palette.sub};text-transform:uppercase;letter-spacing:.5px;">${t("guests", lang)}</div>
            <div style="font-size:19px;font-weight:800;color:${palette.text};">${people}</div>
          </td>
        </tr>
      </table>
      ${
        shortId
          ? `<div style="margin-top:10px;text-align:center;font-size:12px;color:${palette.sub};">
               ID: <strong style="letter-spacing:.4px;color:${palette.text};">${shortId}</strong>
             </div>`
          : ""
      }
    </div>`;
}

/* =================== Verify Email =================== */
export async function sendVerifyEmail(to: string, token: string, lang?: string | null) {
  const L = normLang(lang);
  const link = buildUrl(`/auth/verify?token=${encodeURIComponent(token)}`, L);
  const html = renderEmailShell({
    lang: L,
    title: t("verifyTitle", L),
    subtitle: t("verifyLead", L),
    bodyHtml: "",
    cta: { label: t("verifyCta", L), url: link },
    preheader: t("verifyLead", L),
  });

  return await sendMail(to, t("verifySubject", L), html);
}

/* =================== Reset Email =================== */
export async function sendResetEmail(to: string, token: string, lang?: string | null) {
  const L = normLang(lang);
  const link = buildUrl(`/auth/reset?token=${encodeURIComponent(token)}`, L);
  const html = renderEmailShell({
    lang: L,
    title: t("resetTitle", L),
    subtitle: t("resetLead", L),
    bodyHtml: "",
    cta: { label: t("resetCta", L), url: link },
    preheader: t("resetLead", L),
  });

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
  occasion?: string | null;   // birthday | anniversary | date | business | celebration | other
  dietary?: string[] | null;  // vegetarian | vegan | gluten_free | kosher | halal | allergies
  lang?: string | null;    // שפת המייל
}) {
  const L = normLang(opts.lang);
  const {
    to, restaurantName, date, time, people,
    customerName, reservationId, note, occasion, dietary,
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

  const lines = I18N.reservationBodyLines[L] ?? I18N.reservationBodyLines.he;

  const bodyHtml = `
    ${reservationDetailsCard({ lang: L, dayShort, dm, time, people, shortId })}
    ${extrasAsHtml(occasion, dietary, L)}
    ${noteAsHtml(note, L)}
    <div style="padding:4px 2px 0;">
      ${customerName ? `<p style="margin:10px 0 0;">${t("hello", L)} ${customerName},</p>` : ""}
      ${lines.map((x) => `<p style="margin:6px 0 0;">${x}</p>`).join("")}
    </div>
  `;

  const html = renderEmailShell({
    lang: L,
    title: restaurantName,
    subtitle: t("reservationLead", L),
    bodyHtml,
    cta: manageUrl ? { label: t("manageCta", L), url: manageUrl } : undefined,
    preheader: `${t("reservationSubject", L)(restaurantName)}${shortId ? ` · ID ${shortId}` : ""}`,
  });

  const text = [
    t("reservationSubject", L)(restaurantName),
    customerName ? `${t("hello", L)} ${customerName},` : "",
    `${t("date", L)}: ${date} | ${t("time", L)}: ${time} | ${t("guests", L)}: ${people}`,
    shortId ? `ID: ${shortId}` : "",
    extrasAsText(occasion, dietary, L),
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
  occasion?: string | null;   // birthday | anniversary | date | business | celebration | other
  dietary?: string[] | null;  // vegetarian | vegan | gluten_free | kosher | halal | allergies
  lang?: string | null; // אם יש לכם העדפת שפה לבעלים
}) {
  const L = normLang(opts.lang);
  const {
    to, restaurantName, customerName, customerPhone, customerEmail,
    date, time, people, note, occasion, dietary,
  } = opts;

  const bodyHtml = `
    <div style="border:1px solid ${palette.border};border-radius:12px;background:${palette.accentSoft};padding:12px 16px;">
      <p style="margin:0;font-size:15px;color:${palette.text};">
        <strong>${t("date", L)}:</strong> ${date} · <strong>${t("time", L)}:</strong> ${time} · <strong>${t("guests", L)}:</strong> ${people}
      </p>
    </div>
    <div style="margin-top:12px;border:1px solid ${palette.border};border-radius:12px;background:${palette.soft};padding:12px 16px;">
      <p style="margin:0;"><strong>${t("customerLabel", L)}:</strong> ${customerName}</p>
      <p style="margin:0;"><strong>${t("phoneLabel", L)}:</strong> ${customerPhone || "-"}</p>
      <p style="margin:0;"><strong>${t("emailLabel", L)}:</strong> ${customerEmail || "-"}</p>
    </div>
    ${extrasAsHtml(occasion, dietary, L)}
    ${noteAsHtml(note, L)}
  `;

  const html = renderEmailShell({
    lang: L,
    title: t("ownerNewTitle", L),
    subtitle: restaurantName,
    bodyHtml,
    preheader: `${(I18N.ownerSubject[L] ?? I18N.ownerSubject.he)(restaurantName)} · ${date} ${time}`,
  });

  const extrasTxt = extrasAsText(occasion, dietary, L);
  const text =
    `${t("ownerNewTitle", L)} — ${restaurantName}\n` +
    `${t("date", L)}: ${date} | ${t("time", L)}: ${time} | ${t("guests", L)}: ${people}\n` +
    `${t("customerLabel", L)}: ${customerName} | ${t("phoneLabel", L)}: ${customerPhone || "-"} | ${t("emailLabel", L)}: ${customerEmail || "-"}\n` +
    (extrasTxt ? `${extrasTxt}\n` : "") +
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

  const bodyHtml = `
    <div style="border:1px solid ${palette.border};border-radius:12px;background:${palette.accentSoft};padding:12px 16px;">
      <p style="margin:0;font-size:15px;color:${palette.text};">
        <strong>${t("date", L)}:</strong> ${opts.date} · <strong>${t("time", L)}:</strong> ${opts.time} · <strong>${t("guests", L)}:</strong> ${opts.people}
      </p>
    </div>
    <div style="margin-top:12px;">
      ${opts.customerName ? `<p style="margin:0;">${t("hello", L)} ${opts.customerName},</p>` : ""}
      <p style="margin:6px 0 0;">${t("reminderLead", L)}</p>
    </div>
  `;

  const html = renderEmailShell({
    lang: L,
    title: t("reminderTitle", L),
    subtitle: opts.restaurantName,
    bodyHtml,
    cta: { label: t("reminderCta", L), url: link },
    preheader: `${t("reminderSubject", L)} · ${opts.restaurantName}`,
  });

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

/* =================== Find My Reservations (magic links) =================== */
export async function sendFindReservationsEmail(opts: {
  to: string;
  items: Array<{
    restaurantName: string;
    date: string;       // YYYY-MM-DD
    time: string;       // HH:mm
    people: number;
    manageUrl: string;  // absolute /r/:token link
  }>;
  lang?: string | null;
}) {
  const L = normLang(opts.lang);
  const { to, items } = opts;
  if (!items.length) return { ok: false, reason: "no_items" };

  const esc = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const cards = items.map((it) => {
    const d = new Date(`${it.date}T12:00:00`);
    const dayShort = isNaN(d.getTime()) ? "" : weekdayShortByLang(L, d);
    const dm = formatDM(it.date);
    const withLang = ((): string => {
      try {
        const u = new URL(it.manageUrl, "http://local");
        u.searchParams.set("lang", L);
        return it.manageUrl.startsWith("http") ? u.toString() : `${u.pathname}${u.search}`;
      } catch { return it.manageUrl; }
    })();
    return `
      <div style="border:1px solid ${palette.border};border-radius:12px;background:${palette.soft};padding:14px 16px;margin:0 0 12px;">
        <div style="font-size:16px;font-weight:800;color:${palette.text};margin-bottom:6px;">${esc(it.restaurantName)}</div>
        <p style="margin:0 0 10px;font-size:14px;color:${palette.text};">
          <strong>${t("date", L)}:</strong> ${dayShort} ${dm} (${esc(it.date)}) ·
          <strong>${t("time", L)}:</strong> ${esc(it.time)} ·
          <strong>${t("guests", L)}:</strong> ${it.people}
        </p>
        <a href="${withLang}" style="display:inline-block;padding:9px 18px;background:${palette.accent};border-radius:10px;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${palette.btnText};text-decoration:none;">${t("findResvManageCta", L)}</a>
      </div>`;
  }).join("");

  const bodyHtml = `
    ${cards}
    <p style="margin:8px 0 0;color:${palette.sub};font-size:13px;">${t("findResvIgnore", L)}</p>
  `;

  const html = renderEmailShell({
    lang: L,
    title: t("findResvTitle", L),
    subtitle: t("findResvLead", L),
    bodyHtml,
    preheader: t("findResvSubject", L),
  });

  const text = [
    t("findResvTitle", L),
    t("findResvLead", L),
    "",
    ...items.map((it) =>
      `${it.restaurantName} | ${t("date", L)}: ${it.date} | ${t("time", L)}: ${it.time} | ${t("guests", L)}: ${it.people}\n${t("findResvManageCta", L)}: ${it.manageUrl}`
    ),
    "",
    t("findResvIgnore", L),
  ].join("\n");

  return await sendMailAny({
    to,
    subject: t("findResvSubject", L),
    html,
    text,
    headers: {
      "Reply-To": "no-reply",
      "List-Unsubscribe": "<mailto:no-reply>",
    },
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

  const bodyHtml = `
    ${customerName ? `<p style="margin:0 0 8px;">${t("hello", L)} ${customerName},</p>` : ""}
    <p style="margin:0;color:${palette.sub};">${lead}</p>
  `;

  const html = renderEmailShell({
    lang: L,
    title: t("reviewTitle", L),
    subtitle: `${restaurantName} · ${date}`,
    bodyHtml,
    cta: { label: `⭐ ${t("reviewCta", L)}`, url: link },
    preheader: (t("reviewSubject", L) as (r: string) => string)(restaurantName),
  });

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
