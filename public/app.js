(function(){
  // עזר לעיגול דקות ל-15
  function pad2(n){ return String(n).padStart(2, "0") }
  function roundTo15(value) {
    if (typeof value !== "string") return value;
    const t = /^\d{2}\.\d{2}$/.test(value) ? value.replace(".", ":") : value;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return value;
    let h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    let mi = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    mi = Math.round(mi / 15) * 15;
    if (mi === 60) { mi = 0; h = (h + 1) % 24; }
    return `${pad2(h)}:${pad2(mi)}`;
  }

  function applyToInput(inputEl) {
    if (!inputEl) return;
    if (inputEl._timeFixed) return;
    inputEl._timeFixed = true;

    if (inputEl.value) {
      inputEl.value = roundTo15(inputEl.value);
    }

    // 1. Flatpickr
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

    // 2. TW Elements
    if (window.te || window.TWElements) {
      try {
        const inst = inputEl._teTimepickerInstance;
        if (inst && typeof inst.setOptions === "function") {
          inst.setOptions({ format24: true, increment: 15, step: 15 });
        }
        inputEl.addEventListener("blur", () => {
          if (inputEl.value) inputEl.value = roundTo15(inputEl.value);
        });
        return;
      } catch(e) {}
    }

    // 3. Flowbite
    if (inputEl._flowbiteInstance || window.Flowbite || window.flowbite) {
      try {
        const inst = inputEl._flowbiteInstance;
        if (inst && typeof inst.setOptions === "function") {
          inst.setOptions({ format: "HH:mm", stepping: 15 });
        }
        inputEl.addEventListener("blur", () => {
          if (inputEl.value) inputEl.value = roundTo15(inputEl.value);
        });
        return;
      } catch(e) {}
    }

    // 4. fallback native
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      fixAllTimeInputs();
    });
  } else {
    fixAllTimeInputs();
  }

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
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class","data-"] });
  } catch(e) {}
})();
