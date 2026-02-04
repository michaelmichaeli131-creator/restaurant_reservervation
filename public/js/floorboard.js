(function(){
  function el(tag, attrs, children){
    const n = document.createElement(tag);
    if (attrs){
      for (const [k,v] of Object.entries(attrs)){
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v != null) n.setAttribute(k, String(v));
      }
    }
    if (children){
      for (const c of children){
        if (c == null) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function statusLabel(s){
    switch(s){
      case 'occupied': return 'תפוס';
      case 'reserved': return 'שמור';
      case 'dirty': return 'מלוכלך';
      default: return 'פנוי';
    }
  }

  function buildChip(kind, label, active, onClick){
    const dot = el('span', { class: `sb-dot-status sb-dot-${kind}` });
    return el('button', {
      type: 'button',
      class: 'sb-chip',
      'aria-pressed': active ? 'true' : 'false',
      onclick: onClick,
    }, [dot, el('span', { text: label })]);
  }

  async function fetchPlan(url){
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  }

  function renderBoard(holder, state){
    holder.innerHTML = '';

    const toolbar = el('div', { class: 'sb-floorboard-toolbar' });
    const filters = el('div', { class: 'sb-floorboard-filters' });

    const filterDefs = [
      { key: 'all', label: 'הכל', dot: 'occupied' },
      { key: 'occupied', label: 'תפוסים', dot: 'occupied' },
      { key: 'reserved', label: 'שמורים', dot: 'reserved' },
      { key: 'dirty', label: 'מלוכלכים', dot: 'dirty' },
      { key: 'empty', label: 'פנויים', dot: 'empty' },
    ];

    filterDefs.forEach(d => {
      filters.appendChild(buildChip(d.dot, d.label, state.filter === d.key, () => {
        state.filter = d.key;
        renderBoard(holder, state);
      }));
    });

    toolbar.appendChild(filters);
    toolbar.appendChild(el('div', { class: 'sb-floorboard-note' }, [
      'לחיצה על שולחן תפוס פותחת הזמנה. שולחן פנוי מציג מידע בלבד.'
    ]));

    holder.appendChild(toolbar);

    const items = state.tables
      .slice()
      .sort((a,b)=>a.tableNumber-b.tableNumber)
      .filter(t => {
        if (state.filter === 'all') return true;
        const st = t.status || 'empty';
        return st === state.filter;
      });

    if (!items.length){
      holder.appendChild(el('div', { class: 'sb-floorboard-empty' }, ['אין שולחנות להצגה.']));
      return;
    }

    const grid = el('div', { class: 'sb-floorboard-grid' });
    items.forEach(t => {
      const st = t.status || 'empty';
      const card = el('div', { class: `sb-tablecard ${st}`, role: 'button', tabindex: '0' });
      const statusDot = el('div', { class: 'sb-tablecard-status' });

      const top = el('div', { class: 'sb-tablecard-top' }, [
        el('div', {}, [
          el('div', { class: 'sb-table-num', text: String(t.tableNumber) }),
          el('div', { class: 'sb-table-meta', text: `סטטוס: ${statusLabel(st)}` }),
        ]),
        el('span', { class: 'sb-badge', text: statusLabel(st) })
      ]);

      const actions = el('div', { class: 'sb-table-actions' });
      if (st === 'occupied'){
        actions.appendChild(el('a', { class: 'btn sm primary', href: `/waiter/${encodeURIComponent(state.rid)}/${encodeURIComponent(t.tableNumber)}` }, ['למסך הזמנה']));
      } else {
        actions.appendChild(el('button', { class: 'btn sm ghost', type: 'button', onclick: (e)=>{ e.stopPropagation(); alert('שולחן לא הושב עדיין. רק המארחת יכולה להושיב דרך מסך המארחת.'); } }, ['פרטים']));
      }

      card.appendChild(statusDot);
      card.appendChild(top);
      card.appendChild(actions);

      card.addEventListener('click', () => {
        if (st === 'occupied'){
          window.location.href = `/waiter/${encodeURIComponent(state.rid)}/${encodeURIComponent(t.tableNumber)}`;
        }
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          card.click();
        }
      });

      grid.appendChild(card);
    });

    holder.appendChild(grid);
  }

  async function mountFloorBoard(opts){
    const holder = opts && opts.holder;
    const rid = opts && opts.rid;
    if (!holder || !rid) return;

    const state = { rid, filter: 'all', tables: [] };
    holder.classList.add('sb-floorboard');

    const floorUrl = `/api/floor-plans/${encodeURIComponent(rid)}`;

    async function load(){
      const plan = await fetchPlan(floorUrl);
      if (!plan){
        holder.innerHTML = `<div class="sb-floorboard-empty">לא הוגדרה מפת שולחנות למסעדה זו.</div>`;
        return;
      }
      const tables = Array.isArray(plan.tables) ? plan.tables : [];
      const tableStatuses = Array.isArray(plan.tableStatuses) ? plan.tableStatuses : [];
      const statusMap = new Map();
      tableStatuses.forEach(s => statusMap.set(Number(s.tableNumber), s.status || 'empty'));

      state.tables = tables.map(t => ({
        tableNumber: Number(t.tableNumber),
        status: statusMap.get(Number(t.tableNumber)) || 'empty',
      }));

      if (!state.tables.length){
        holder.innerHTML = `<div class="sb-floorboard-empty">אין שולחנות מוגדרים במפת המסעדה.</div>`;
        return;
      }

      renderBoard(holder, state);
    }

    await load();
    setInterval(load, 5000);
  }

  window.SB = window.SB || {};
  window.SB.mountFloorBoard = mountFloorBoard;
})();
