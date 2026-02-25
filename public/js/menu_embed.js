
// Inject POS menu into restaurant page (if container exists and POS rid available)
(function(){
  const el = document.getElementById("pos-menu");
  if (!el) return;
  const rid = el.dataset.rid;
  if (!rid) return;
  const currency = el.dataset.currency || "₪";
  const emptyMsg = el.dataset.emptyMsg || "אין מנות להצגה כרגע.";
  const errorMsg = el.dataset.errorMsg || "שגיאה בטעינת התפריט";
  const defaultCategory = el.dataset.defaultCategory || "קטגוריה";
  fetch(`/api/pos/menu/${encodeURIComponent(rid)}`).then(r=>r.json()).then(items => {
    if (!Array.isArray(items) || items.length===0) {
      el.innerHTML = '<p class="muted">' + emptyMsg + '</p>';
      return;
    }
    const groups = {};
    for (const m of items) {
      const k = m.categoryId || "_";
      (groups[k] ||= []).push(m);
    }
    const frag = document.createDocumentFragment();
    for (const [k, arr] of Object.entries(groups)) {
      if (k !== "_") {
        const h = document.createElement("h4");
        h.textContent = (arr[0]?.categoryName_he || arr[0]?.categoryName_en || defaultCategory);
        frag.appendChild(h);
      }
      const ul = document.createElement("ul");
      ul.className = "list";
      for (const m of arr) {
        const li = document.createElement("li");
        li.className = "item";
        const name = document.createElement("span");
        name.textContent = `${m.name_he || m.name_en} — ${(m.price||0).toFixed(2)} ${currency}`;
        li.appendChild(name);
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    }
    el.innerHTML = "";
    el.appendChild(frag);
  }).catch(()=>{
    el.innerHTML = '<p class="muted">' + errorMsg + '</p>';
  });
})();
