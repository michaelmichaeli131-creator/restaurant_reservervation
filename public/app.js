// /public/app.js
(function () {
  // --- Autocomplete for #q ---
  const q = document.getElementById("q");
  const ac = document.getElementById("ac-list");

  function clearAC() { if (ac) ac.innerHTML = ""; }
  function renderAC(items) {
    if (!ac) return;
    if (!items || items.length === 0) { clearAC(); return; }
    const panel = document.createElement("div");
    panel.className = "panel";
    items.slice(0, 8).forEach(r => {
      const div = document.createElement("div");
      div.className = "ac-item";
      div.innerHTML = `<strong>${escapeHtml(r.name)}</strong><br><small class="muted">${escapeHtml(r.city)} · ${escapeHtml(r.address)}</small>`;
      div.addEventListener("click", () => { window.location.href = `/restaurants/${r.id}`; });
      panel.appendChild(div);
    });
    ac.innerHTML = "";
    ac.appendChild(panel);
  }
  function escapeHtml(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}
  let timer = null;
  if (q) {
    q.addEventListener("input", () => {
      const val = q.value.trim();
      if (!val) { clearAC(); return; }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/restaurants?q=${encodeURIComponent(val)}`);
          if (!res.ok) throw new Error("bad status");
          const items = await res.json();
          renderAC(items);
        } catch {
          clearAC();
        }
      }, 180);
    });
    document.addEventListener("click", (e) => {
      if (!ac.contains(e.target) && e.target !== q) clearAC();
    });
  }

  // --- Reservation check button (AJAX) ---
  const checkBtn = document.getElementById("check-btn");
  const form = document.getElementById("reserve-form");
  const result = document.getElementById("reserve-result");
  async function post(url, data) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json };
  }
  if (checkBtn && form && result) {
    checkBtn.addEventListener("click", async () => {
      const rid = checkBtn.dataset.rid;
      const date = form.querySelector('input[name="date"]').value;
      const time = form.querySelector('input[name="time"]').value;
      const people = form.querySelector('input[name="people"]').value;
      if (!rid || !date || !time || !people) { result.textContent = "נא למלא את כל השדות"; return; }
      const { ok, json } = await post(`/api/restaurants/${encodeURIComponent(rid)}/check`, { date, time, people: Number(people) });
      if (ok && json.ok) {
        result.textContent = "זמין! ניתן להגיש את הטופס להזמנה.";
        result.classList.remove("warn");
      } else {
        result.classList.add("warn");
        result.innerHTML = `לא זמין. ${json.reason === "full" ? "מלא בתאריך/שעה זו." : "שגיאה."} ` +
          (json.suggestions?.length ? `הצעות: ${json.suggestions.join(", ")}` : "");
      }
    });
  }
})();
