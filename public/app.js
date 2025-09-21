(() => {
  const input = document.getElementById("searchInput");
  const box = document.getElementById("suggestions");
  if (!input || !box) return;

  let timer = null;
  const fetchSuggest = async (q) => {
    if (!q || q.trim().length < 1) { box.hidden = true; box.innerHTML = ""; return; }
    try {
      const res = await fetch(`/api/restaurants/search?query=${encodeURIComponent(q)}`);
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
    if (id) window.location.href = `/restaurants/${id}`;
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
})();
