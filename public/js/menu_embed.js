
// Inject POS menu into restaurant page (if container exists and POS rid available)
(function(){
  const el = document.getElementById("pos-menu");
  if (!el) return;
  const rid = el.dataset.rid;
  if (!rid) return;
  const currency = el.dataset.currency || "₪";
  const lang = String(document.documentElement.lang || 'en').toLowerCase();
  const nameKey = lang.startsWith('ka') ? 'name_ka' : (lang.startsWith('he') ? 'name_he' : 'name_en');
  const categoryKey = lang.startsWith('ka') ? 'categoryName_ka' : (lang.startsWith('he') ? 'categoryName_he' : 'categoryName_en');
  const emptyMsg = el.dataset.emptyMsg || (lang.startsWith('ka') ? 'ამჟამად საჩვენებელი კერძები არ არის.' : (lang.startsWith('he') ? 'אין מנות להצגה כרגע.' : 'No dishes to display right now.'));
  const errorMsg = el.dataset.errorMsg || (lang.startsWith('ka') ? 'მენიუს ჩატვირთვა ვერ მოხერხდა' : (lang.startsWith('he') ? 'שגיאה בטעינת התפריט' : 'Error loading the menu'));
  const defaultCategory = el.dataset.defaultCategory || (lang.startsWith('ka') ? 'კატეგორია' : (lang.startsWith('he') ? 'קטגוריה' : 'Category'));
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
        h.textContent = (arr[0]?.[categoryKey] || arr[0]?.categoryName_en || arr[0]?.categoryName_he || arr[0]?.categoryName_ka || defaultCategory);
        frag.appendChild(h);
      }
      const ul = document.createElement("ul");
      ul.className = "list";
      for (const m of arr) {
        const li = document.createElement("li");
        li.className = "item";
        const name = document.createElement("span");
        name.textContent = `${m[nameKey] || m.name_en || m.name_he || m.name_ka || ''} — ${(m.price||0).toFixed(2)} ${currency}`;
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
