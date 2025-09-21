(() => {
  // --------- Hard navigation for internal links ---------
  // כל לינק שיש עליו data-hard-nav יגרום לטעינה מלאה של הדף ב-window.location.assign
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[data-hard-nav="true"]');
    if (!a) return;

    // רק קליק שמאלי בלי מקשים מיוחדים
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    try {
      // אל תבטל את ברירת המחדל — פשוט תכריח ניווט לפני שכל קוד אחר יתערב
      // (זה מנצח כמעט כל preventDefault צד שלישי)
      window.location.assign(a.href);
    } catch (_) {
      // fallback
      window.location.href = a.getAttribute("href");
    }
  }, { capture: true });

  // --------- Autocomplete (כמו שהיה) ---------
  const input = document.getElementById("searchInput");
  const box = document.getElementById("suggestions");
  if (!input || !box) return;

  let timer = null;
  const fetchSuggest = async (q) => {
    if (!q || q.trim().length < 1) { box.hidden = true; box.innerHTML = ""; return; }
    try {
      const res = await fetch(`/api/restaurants/search?query=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const { items } = await res.json();
      if (!Array.isArray(items) || items.length === 0) { box.hidden = true; box.innerHTML = ""; return; }
      box.innerHTML = items.map(it =>
        `<div class="suggestion" data-id="${it.id}">
          <strong>${escapeHtml(it.name)}</strong>
          <span class="muted">${escapeHtml(it.city)} · ${escapeHtml(it.address || "")}</span>
        </div>`
      ).join("");
      box.hidden = false;
    } catch {
      box.hidden = true; box.innerHTML = "";
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => fetchSuggest(input.value), 150);
  });

  document.addEventListener("click", (e) => {
    if (!box.contains(e.target) && e.target !== input) {
      box.hidden = true;
    }
  });

  box.addEventListener("click", (e) => {
    const el = e.target.closest(".suggestion");
    if (!el) return;
    const id = el.getAttribute("data-id");
    if (id) window.location.assign(`/restaurants/${id}`);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
})();
