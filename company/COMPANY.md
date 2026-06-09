# SpotBook Inc. — Virtual Company

> חברה וירטואלית המנוהלת על־ידי צוות AI agents, בפיקוח המייסד (מיכאל).
> A virtual company run by AI agents, supervised by the founder (Michael).

## 🧑‍💼 Org Chart / מבנה ארגוני

| Role | Agent | Responsibility |
|---|---|---|
| **Founder / Final approver** | Michael (human) | החלטות אסטרטגיות, עבודה שדורשת בן־אדם (דומיינים, חשבונות, מכירות בשטח) |
| **CEO / Coordinator** | Claude (main session) | תיאום, תעדוף, דיווח יומי |
| **Head of Design & UX** | UX audit agent | עיצוב, נגישות, חוויית הזמנה |
| **Head of Localization** | i18n agent | עברית / אנגלית / גאורגית, RTL |
| **Head of Product** | Product agent | פערי פיצ'רים מול השוק, roadmap |
| **CMO (Marketing)** | Marketing hat | מיתוג, SEO, משפך רכישה, תוכן |
| **CFO (Finance)** | Finance hat | מודל הכנסות, תמחור, unit economics |

## 🎯 Mission

**"השולחן הנכון, בלחיצה אחת"** — פלטפורמת הזמנות + תפעול מסעדה מלאה
(הזמנות, POS, מלאי, משמרות, מפת רצפה) במחיר שמסעדה קטנה יכולה להרשות לעצמה.

Target markets: **Israel 🇮🇱, Georgia 🇬🇪** (underserved!), expanding to EN-speaking markets.

## 🏆 Competitive position (vs Ontopo, Tabit, OpenTable, TheFork)

**Our moats:**
1. POS + מלאי + משמרות + הזמנות בחבילה אחת (המתחרים גובים בנפרד)
2. תמיכה מלאה בגאורגית — שוק כמעט ללא תחרות מקומית
3. עברית RTL מלאה
4. מפת רצפה בזמן אמת (live floor view) — יתרון מול OpenTable

**Our gaps (roadmap):** mobile app, SMS/WhatsApp, Google Reserve, loyalty.

---

## 📅 Daily Standup Log

### Day 1 — 2026-06-09 (Sprint 1: "Market-Ready Foundations")

**הושלם היום:**
- ✅ אאודיט מלא: עיצוב/UX, לוקליזציה (he/en/ka), פערי מוצר מול השוק
- ✅ SEO: meta description, Open Graph, Twitter cards, robots.txt, sitemap.xml דינמי, schema.org Restaurant (כולל דירוגים) — מנועי חיפוש יציגו אותנו עשירים יותר
- ✅ נגישות: skip-link, focus-visible גלובלי, ניגודיות AA, מטרות מגע 44px+ במובייל
- ✅ UX הזמנה: החלפת alert() ב‑toast, מצבי טעינה בכפתורים, מניעת הגשה כפולה
- ✅ פיצ'ר חדש: **מועדפים (❤️)** — DB + API + דף /favorites + כפתור לב בדף מסעדה
- ✅ תיקוני i18n: באג RTL קריטי במסך מלצרים, השלמת ~100 מפתחות חסרים ב‑en/he, פוליש גאורגית

**Blockers:** אין גישת רשת בסביבה (אין type-check של Deno) — נבדק ב‑CI/deploy.

**מחר (Sprint 2 candidates):**
- Widget הטמעה למסעדות (lever המרה מס' 1 מדוח המוצר)
- SMS/WhatsApp תזכורות (Twilio) — דורש חשבון (משימת אדם)
- Guest CRM tags למסעדנים

---

## 💰 CFO Corner — Revenue Model (v1)

| Tier | מחיר | כולל |
|---|---|---|
| **Free** | ₪0 | עד 100 הזמנות/חודש, מייל בלבד, עובד 1 |
| **Pro** | ₪179/חודש (~$49) | ללא הגבלה, SMS/WhatsApp, 10 עובדים, אנליטיקס |
| **Enterprise** | מותאם | White-label, API, תמיכה ייעודית |

Unit economics יעד: CAC ‹ ₪600/מסעדה, LTV (Pro, 24 חודשים) ≈ ₪4,300 → LTV/CAC ≈ 7.

## 🧑 Human Task Queue (משימות שרק מיכאל יכול לעשות)

| # | משימה | למה | סטטוס |
|---|---|---|---|
| 1 | רכישת דומיין (spotbook.ge / spotbook.co.il) | אמינות + SEO | ⬜ |
| 2 | חשבון Resend מאומת דומיין + RESEND_DRY_RUN=false | מיילים אמיתיים ללקוחות | ⬜ |
| 3 | חשבון Twilio (או provider מקומי) ל‑SMS | תזכורות = פחות no-shows | ⬜ |
| 4 | 10 שיחות עם מסעדנים בטביליסי/ת"א (discovery) | ולידציה לתמחור | ⬜ |
| 5 | צילומי מסך/וידאו דמו לדף הנחיתה | שיווק | ⬜ |
| 6 | רישום Google Business Profile + Search Console | הופעה בחיפוש | ⬜ |
