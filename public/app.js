// public/app.js
// SpotBook – client helpers for reservation UI
// -------------------------------------------------------------
// שיפורים חשובים:
// 1) לא נוגעים יותר בשדות time חבויים (hidden)
// 2) חיווט dropdown של שעות לעדכון השדה החבוי בשם "time"
// 3) נרמול ל-15 דקות והשלמה בעת שליחה אם צריך
// -------------------------------------------------------------

(function () {
  const Q = (sel, root = document) => root.querySelector(sel);
  const QA = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- Utils ----------
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function normalizeToQuarter(hhmm) {
    // קולט "HH:MM" ומחזיר מנורמל לרבע שעה
    if (!/^\d{1,2}:\d{2}$/.test(hhmm || "")) return hhmm || "";
    const [hStr, mStr] = hhmm.split(":");
    let h = parseInt(hStr, 10);
    let m = parseInt(mStr, 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;

    const rem = m % 15;
    if (rem !== 0) {
      m = m + (15 - rem);
      if (m === 60) {
        m = 0;
        h = (h + 1) % 24;
      }
    }
    return `${pad2(h)}:${pad2(m)}`;
  }

  function parseHHMMFromText(t) {
    const match = (t || "").trim().match(/\b(\d{1,2}):(\d{2})\b/);
    return match ? `${pad2(match[1])}:${pad2(match[2])}` : "";
  }

  // ---------- Inputs enhancement ----------
  function enhanceInputs() {
    // אם יש לוגיקה שהופכת inputs ל-type="time", נוודא שלא נוגעים ב-hidden:
    // שימו לב: אנחנו בכוונה *לא* משנים type לשדה time חבוי.
    const timeInputs = QA('input[name="time"]:not([type="hidden"])');
    timeInputs.forEach((inp) => {
      try {
        // אם כבר type="time" — אל תיגע; אחרת, אל תשנה.
        // אם בכל זאת תרצה להפוך ל-time, בטל את ההערה בשורה הבאה:
        // if (inp.type !== "time") inp.type = "time";

        // Validate to HH:MM on blur (אם המשתמש הקליד חופשי)
        inp.addEventListener("blur", () => {
          if (!inp.value) return;
          const v = parseHHMMFromText(inp.value) || inp.value;
          const norm = normalizeToQuarter(v);
          if (norm) inp.value = norm;
        });
      } catch {
        /* no-op */
      }
    });

    // תאריך – הוספת אימות בסיסי
    const dateInputs = QA('input[type="date"][name="date"]');
    dateInputs.forEach((inp) => {
      inp.addEventListener("blur", () => {
        // לוודא תבנית YYYY-MM-DD
        if (inp.value && !/^\d{4}-\d{2}-\d{2}$/.test(inp.value)) {
          // נסה לתקן dd/mm/yyyy -> yyyy-mm-dd
          const m = inp.value.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
          if (m) {
            const d = pad2(m[1]);
            const mo = pad2(m[2]);
            const y = m[3].length === 2 ? `20${m[3]}` : m[3];
            inp.value = `${y}-${mo}-${d}`;
          }
        }
      });
    });
  }

  // ---------- Time dropdown wiring ----------
  function wireTimeDropdown() {
    // הנחות מבניות (קשיח למינימום כדי לעבוד גם אם המבנה קצת שונה):
    // - יש כפתור שמציג את השעה הנבחרת (id או data-role)
    // - יש רשימת אפשרויות שעה עם class .time-option (הטקסט או data-time="HH:MM")
    // - יש input hidden בשם time (input[name="time"][type="hidden"])
    const timeHidden =
      Q('input[name="time"][type="hidden"]') || Q('#time[type="hidden"]');
    if (!timeHidden) return; // אין שדה חבוי – אין לנו מה לעשות כאן

    const timeButton =
      Q('#time-button') || Q('[data-role="time-button"]') || Q('[data-time-button]');
    const dropdown =
      Q('#time-dropdown') ||
      Q('.time-dropdown') ||
      Q('[data-role="time-dropdown"]');

    // עוזר להחיל שעה שנבחרה
    function applyPickedTime(hhmm, opts = { updateButton: true }) {
      if (!hhmm) return;
      const norm = normalizeToQuarter(hhmm);
      timeHidden.value = norm;
      if (opts.updateButton && timeButton) {
        // אם הכפתור מציג טקסט בשפה אחרת, נשמור את הפורמט HH:MM החלק
        const original = timeButton.getAttribute('data-label') || '';
        timeButton.textContent = original ? `${original} ${norm}` : norm;
        timeButton.setAttribute('data-picked', norm);
      }
    }

    // קליק על אפשרות בתפריט
    if (dropdown) {
      dropdown.addEventListener("click", (ev) => {
        const target = ev.target;
        const option = target && (target.closest?.(".time-option") || null);
        if (!option) return;

        const attr = option.getAttribute("data-time");
        const picked =
          attr && /^\d{1,2}:\d{2}$/.test(attr)
            ? attr
            : parseHHMMFromText(option.textContent);

        if (picked) {
          applyPickedTime(picked, { updateButton: true });
          // סגירה לאחר בחירה
          dropdown.classList.remove("open");
          dropdown.setAttribute("aria-expanded", "false");
        }
      });
    }

    // פתיחה/סגירה של dropdown
    if (timeButton && dropdown) {
      // שמור label בסיסי אם יש
      if (!timeButton.getAttribute('data-label')) {
        timeButton.setAttribute('data-label', timeButton.textContent.trim());
      }

      timeButton.addEventListener("click", (e) => {
        e.preventDefault();
        dropdown.classList.toggle("open");
        dropdown.setAttribute(
          "aria-expanded",
          dropdown.classList.contains("open") ? "true" : "false",
        );
      });

      // סגירה בלחיצה מחוץ
      document.addEventListener("click", (e) => {
        if (
          dropdown.classList.contains("open") &&
          !dropdown.contains(e.target) &&
          !timeButton.contains(e.target)
        ) {
          dropdown.classList.remove("open");
          dropdown.setAttribute("aria-expanded", "false");
        }
      });
    }

    // אם יש input time גלוי (לא hidden) – סנכרון דו כיווני
    const visibleTimeInput = Q('input[name="time"]:not([type="hidden"])');
    if (visibleTimeInput) {
      visibleTimeInput.addEventListener("input", () => {
        if (!visibleTimeInput.value) return;
        applyPickedTime(visibleTimeInput.value, { updateButton: true });
      });
      visibleTimeInput.addEventListener("blur", () => {
        if (!visibleTimeInput.value) return;
        applyPickedTime(visibleTimeInput.value, { updateButton: true });
      });
    }

    // אם כבר הוזן ערך (נניח שחזרנו מטעות) – הצג בכפתור
    if (timeHidden.value && timeButton) {
      applyPickedTime(timeHidden.value, { updateButton: true });
    }
  }

  // ---------- Form submit guard ----------
  function wireSubmitGuard() {
    const form = Q("#reserve-form") || Q('form[action*="/reserve"]');
    if (!form) return;

    form.addEventListener("submit", (e) => {
      // ודא שתאריך ושעה נשלחים
      const dateInput = Q('input[name="date"]', form);
      const hiddenTime =
        Q('input[name="time"][type="hidden"]', form) ||
        Q('#time[type="hidden"]', form);
      const visibleTime = Q('input[name="time"]:not([type="hidden"])', form);

      // אם השעה החבויה ריקה אבל הכפתור מציג שעה — קח משם
      const timeButton =
        Q('#time-button') ||
        Q('[data-role="time-button"]') ||
        Q('[data-time-button]');
      if (hiddenTime && !hiddenTime.value && timeButton) {
        const btnPicked = timeButton.getAttribute("data-picked");
        if (btnPicked && /^\d{1,2}:\d{2}$/.test(btnPicked)) {
          hiddenTime.value = normalizeToQuarter(btnPicked);
        } else {
          // ננסה לפענח מהטקסט של הכפתור
          const parsed = parseHHMMFromText(timeButton.textContent);
          if (parsed) hiddenTime.value = normalizeToQuarter(parsed);
        }
      }

      // אם נקלטה שעה בשדה הגלוי – נעדיף אותה (מנורמלת)
      if (visibleTime && visibleTime.value) {
        const norm = normalizeToQuarter(visibleTime.value);
        if (hiddenTime) hiddenTime.value = norm;
      }

      // ולידציה בסיסית בצד לקוח
      const errors = [];
      if (!dateInput || !dateInput.value) {
        errors.push("אנא בחר/י תאריך.");
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) {
        errors.push("תאריך לא תקין. פורמט נדרש: YYYY-MM-DD.");
      }

      if (!hiddenTime || !hiddenTime.value) {
        errors.push("אנא בחר/י שעה.");
      } else if (!/^\d{2}:\d{2}$/.test(hiddenTime.value)) {
        errors.push("שעה לא תקינה. פורמט נדרש: HH:MM.");
      }

      if (errors.length) {
        e.preventDefault();
        // הצגת הודעה למשתמש (אפשר לשפר לטוסט/אלרט מעוצב)
        alert(errors.join("\n"));
        // נסה לפקסס לשדות שגויים
        if (dateInput && !dateInput.value) dateInput.focus();
        else {
          const timeBtn =
            Q('#time-button') ||
            Q('[data-role="time-button"]') ||
            Q('[data-time-button]');
          (timeBtn || visibleTime || hiddenTime)?.focus?.();
        }
      }
    });
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", () => {
    try {
      enhanceInputs();
      wireTimeDropdown();
      wireSubmitGuard();
    } catch (err) {
      // בלוג דיבאג לקונסול בלבד
      console.debug("[app.js] init error", err);
    }
  });

// ===== Restaurant Carousel (Cyclic 3-of-5) =====
(function() {
  const wrap = document.querySelector('.hs-wrap');
  const scroller = wrap?.querySelector('.hs');
  const items = Array.from(scroller?.children || []);
  const prev = wrap?.querySelector('.prev');
  const next = wrap?.querySelector('.next');
  if (!wrap || !scroller || items.length === 0) return;

  let startIndex = 0;
  const visible = 3;
  const total = items.length;

  function render() {
    scroller.innerHTML = '';
    for (let i = 0; i < visible; i++) {
      const idx = (startIndex + i) % total;
      scroller.appendChild(items[idx].cloneNode(true));
    }
  }
  render();

  prev.addEventListener('click', () => {
    startIndex = (startIndex - 1 + total) % total;
    render();
  });
  next.addEventListener('click', () => {
    startIndex = (startIndex + 1) % total;
    render();
  });

  // Swipe for mobile
  let touchStartX = 0;
  scroller.addEventListener('touchstart', e => touchStartX = e.touches[0].clientX);
  scroller.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx > 50) prev.click();
    else if (dx < -50) next.click();
  });
})();

})();



