// public/app.js
// SpotBook – client helpers for reservation UI
// -------------------------------------------------------------
// - ללא אינליין JS (עומד ב-CSP 'self')
// - לא נוגעים בשדות time חבויים (hidden)
// - חיווט dropdown לשדה החבוי name="time"
// - בדיקת זמינות + הצגת הצעות חלופיות
// -------------------------------------------------------------

(function () {
  const Q = (sel, root = document) => root.querySelector(sel);
  const QA = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- Utils ----------
  function pad2(n) { return String(n).padStart(2, "0"); }

  function normalizeToQuarter(hhmm) {
    if (!/^\d{1,2}:\d{2}$/.test(hhmm || "")) return hhmm || "";
    const [hStr, mStr] = hhmm.split(":");
    let h = parseInt(hStr, 10);
    let m = parseInt(mStr, 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;

    const rem = m % 15;
    if (rem !== 0) {
      m = m + (15 - rem);
      if (m === 60) { m = 0; h = (h + 1) % 24; }
    }
    return `${pad2(h)}:${pad2(m)}`;
  }

  function parseHHMMFromText(t) {
    const match = (t || "").trim().match(/\b(\d{1,2}):(\d{2})\b/);
    return match ? `${pad2(match[1])}:${pad2(match[2])}` : "";
  }

  // ---------- Inputs enhancement ----------
  function enhanceInputs() {
    // אל תיגע ב-hidden:
    const visibleTimes = QA('input[name="time"]:not([type="hidden"])');
    visibleTimes.forEach((inp) => {
      inp.addEventListener("blur", () => {
        if (!inp.value) return;
        const v = parseHHMMFromText(inp.value) || inp.value;
        const norm = normalizeToQuarter(v);
        if (norm) inp.value = norm;
      });
    });

    const dateInputs = QA('input[type="date"][name="date"]');
    dateInputs.forEach((inp) => {
      inp.addEventListener("blur", () => {
        if (inp.value && !/^\d{4}-\d{2}-\d{2}$/.test(inp.value)) {
          const m = inp.value.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
          if (m) {
            const d = pad2(m[1]), mo = pad2(m[2]);
            const y = m[3].length === 2 ? `20${m[3]}` : m[3];
            inp.value = `${y}-${mo}-${d}`;
          }
        }
      });
    });
  }

  // ---------- Time dropdown wiring ----------
  function wireTimeDropdown() {
    const hiddenTime =
      Q('input[name="time"][type="hidden"]') || Q('#time[type="hidden"]');
    if (!hiddenTime) return;

    // תמיכה בשתי סכימות מזהים:
    const timeButton =
      Q('#time-button') || Q('#time-display') ||
      Q('[data-role="time-button"]') || Q('[data-time-button]');
    const dropdown =
      Q('#time-dropdown') || Q('#time-options') ||
      Q('.time-dropdown') || Q('.time-options') ||
      Q('[data-role="time-dropdown"]');

    function setButtonText(btn, hhmm) {
      if (!btn) return;
      btn.textContent = hhmm + " ";
      const arr = document.createElement("span");
      arr.className = "arrow";
      arr.textContent = "▾";
      btn.appendChild(arr);
      btn.setAttribute("data-picked", hhmm);
      btn.setAttribute("aria-expanded", "false");
    }

    function applyPickedTime(hhmm, opts = { updateButton: true }) {
      if (!hhmm) return;
      const norm = normalizeToQuarter(hhmm);
      hiddenTime.value = norm;
      if (opts.updateButton && timeButton) setButtonText(timeButton, norm);
    }

    // קליק על אפשרות
    if (dropdown) {
      dropdown.addEventListener("click", (ev) => {
        const el = ev.target?.closest?.(".time-option");
        if (!el) return;
        const t = el.getAttribute("data-time") || parseHHMMFromText(el.textContent);
        if (t) {
          applyPickedTime(t, { updateButton: true });
          hideDropdown();
        }
      });
    }

    function showDropdown() {
      if (!dropdown) return;
      dropdown.hidden = false;
      dropdown.classList.add("open");
      timeButton?.setAttribute?.("aria-expanded", "true");
    }

    function hideDropdown() {
      if (!dropdown) return;
      dropdown.hidden = true;
      dropdown.classList.remove("open");
      timeButton?.setAttribute?.("aria-expanded", "false");
    }

    if (timeButton && dropdown) {
      timeButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.hidden ? showDropdown() : hideDropdown();
      });

      document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && !timeButton.contains(e.target)) hideDropdown();
      });
    }

    // אם כבר היה ערך (חזרה משגיאה) – הצג בכפתור
    if (hiddenTime.value && timeButton) setButtonText(timeButton, hiddenTime.value);
  }

  // ---------- Availability check & suggestions ----------
  function wireAvailabilityCheck() {
    const btn = Q("#check-btn");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      const date = Q("#date")?.value || "";
      const time = Q('#time[type="hidden"]')?.value || "";
      if (!date || !time) {
        alert("נא לבחור תאריך ושעה");
        return;
      }
      const rid = btn.getAttribute("data-rid") || "";

      const resp = await fetch(`/api/restaurants/${encodeURIComponent(rid)}/check`, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ date, time }),
      });

      let data = null;
      try { data = await resp.json(); } catch { /* ignore */ }

      if (resp.ok && data && data.ok) {
        renderAround([]); // אין קונפליקט
      } else {
        renderAround(data?.suggestions || []);
      }
    });
  }

  function renderAround(slots) {
    const card = Q("#around-card");
    const box = Q("#around-slots");
    const hiddenTime = Q('#time[type="hidden"]');
    const timeButton =
      Q('#time-button') || Q('#time-display') ||
      Q('[data-role="time-button"]') || Q('[data-time-button]');

    if (!card || !box) return;

    box.innerHTML = "";
    if (Array.isArray(slots) && slots.length) {
      card.hidden = false;
      slots.slice(0, 8).forEach((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        b.textContent = t;
        b.addEventListener("click", () => {
          if (hiddenTime) hiddenTime.value = normalizeToQuarter(t);
          if (timeButton) {
            timeButton.textContent = t + " ";
            const arr = document.createElement("span");
            arr.className = "arrow";
            arr.textContent = "▾";
            timeButton.appendChild(arr);
            timeButton.setAttribute("data-picked", t);
          }
          card.hidden = true;
        });
        box.appendChild(b);
      });
    } else {
      card.hidden = true;
    }
  }

  // ---------- Submit guard ----------
  function wireSubmitGuard() {
    const form = Q("#reserve-form") || Q('form[action*="/reserve"]');
    if (!form) return;

    form.addEventListener("submit", (e) => {
      const dateInput = Q('input[name="date"]', form);
      const hiddenTime =
        Q('input[name="time"][type="hidden"]', form) ||
        Q('#time[type="hidden"]', form);

      const errors = [];
      if (!dateInput || !dateInput.value) errors.push("אנא בחר/י תאריך.");
      if (!hiddenTime || !hiddenTime.value) errors.push("אנא בחר/י שעה.");

      if (errors.length) {
        e.preventDefault();
        alert(errors.join("\n"));
        (dateInput?.value ? form.querySelector("#time-button") : dateInput)?.focus?.();
      }
    });
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", () => {
    try {
      enhanceInputs();
      wireTimeDropdown();
      wireAvailabilityCheck();
      wireSubmitGuard();
    } catch (err) {
      console.debug("[app.js] init error", err);
    }
  });
})();
