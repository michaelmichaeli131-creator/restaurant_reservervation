(function(){
  // עזר לעיגול דקות ל־15
  function pad2(n){ return String(n).padStart(2, "0"); }
  function roundTo15(value) {
    if (typeof value !== "string") return value;
    const t = /^\d{2}\.\d{2}$/.test(value) ? value.replace(".", ":") : value;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return value;
    let h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    let mi = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    mi = Math.round(mi / 15) * 15;
    if (mi === 60) {
      mi = 0;
      h = (h + 1) % 24;
    }
    return `${pad2(h)}:${pad2(mi)}`;
  }

  function applyToInput(inputEl) {
    if (!inputEl) return;
    if (inputEl._timeFixed) return;
    inputEl._timeFixed = true;

    if (inputEl.value) {
      inputEl.value = roundTo15(inputEl.value);
    }

    // אם כבר הוגדר Flatpickr
    if (inputEl._flatpickr) {
      inputEl._flatpickr.set({
        time_24hr: true,
        minuteIncrement: 15,
        dateFormat: "H:i"
      });
      inputEl.addEventListener("blur", () => {
        if (inputEl.value) inputEl.value = roundTo15(inputEl.value);
      });
      return;
    }

    // אם קיימת ספריית Flatpickr
    if (typeof flatpickr === "function") {
      inputEl._flatpickr = flatpickr(inputEl, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        time_24hr: true,
        minuteIncrement: 15,
        allowInput: true,
        parseDate: ds => {
          const [h, m] = String(ds).split(":").map(x => parseInt(x,10));
          if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
            const d = new Date();
            d.setHours(h, m, 0, 0);
            return d;
          }
          return flatpickr.parseDate(ds, "H:i");
        },
        onChange: (_, ds) => {
          inputEl.value = ds;
        }
      });
      inputEl.addEventListener("blur", () => {
        if (inputEl.value) inputEl.value = roundTo15(inputEl.value);
      });
      return;
    }

    // fallback — native <input type="time">
    try {
      inputEl.type = "time";
      inputEl.step = 900; // 15 דקות
      inputEl.addEventListener("blur", () => {
        if (inputEl.value) inputEl.value = roundTo15(inputEl.value);
      });
    } catch(e) {
      console.warn("Time fix fallback failed:", e);
    }
  }

  function fixAllTimeInputs(root = document) {
    const els = root.querySelectorAll('input[name="time"]');
    els.forEach(applyToInput);
  }

  // הרצה ראשונית כש-DOM מוכן
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      fixAllTimeInputs();
    });
  } else {
    fixAllTimeInputs();
  }

  // ניטור שינויים בדף — אם שדות זמן מתווספים מאוחר
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches && node.matches('input[name="time"]')) {
            applyToInput(node);
          }
          const inner = node.querySelectorAll ? node.querySelectorAll('input[name="time"]') : [];
          inner.forEach(applyToInput);
        }
      }
      if (m.type === "attributes" && m.target && m.target.matches && m.target.matches('input[name="time"]')) {
        applyToInput(m.target);
      }
    }
  });
  try {
    mo.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["class","data-"]
    });
  } catch(e) {
    // ניטור נכשל — לא קריטי
  }

  // גם להפעיל ל־check-btn ול־renderAround אם תרצה
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("check-btn");
    btn?.addEventListener("click", async () => {
      const date = document.querySelector('input[name="date"]').value;
      const time = document.querySelector('input[name="time"]').value;
      if (!date || !time) {
        alert("נא לבחור תאריך ושעה");
        return;
      }
      const rid = btn.dataset.rid;
      const resp = await fetch(`/api/restaurants/${encodeURIComponent(rid)}/check`, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ date, time })
      });
      const js = await resp.json().catch(() => ({}));
      if (resp.ok && js.ok) {
        // אם זמין — מחביאים הצעות
        const aroundCard = document.getElementById("around-card");
        if (aroundCard) aroundCard.hidden = true;
      } else {
        renderAround(js.suggestions || []);
      }
    });
  });

  function renderAround(slots) {
    const card = document.getElementById("around-card");
    const box = document.getElementById("around-slots");
    if (!box || !card) return;
    box.innerHTML = "";
    if (Array.isArray(slots) && slots.length) {
      card.hidden = false;
      slots.slice(0,4).forEach(t => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        b.textContent = t;
        b.onclick = () => {
          const timeIn = document.querySelector('input[name="time"]');
          if (timeIn) timeIn.value = t;
          renderAround([]);
        };
        box.appendChild(b);
      });
    } else {
      card.hidden = true;
    }
  }

})();
