(function(){
  function qs(el, sel){ return el ? el.querySelector(sel) : null; }

  function uniq(arr){
    const s = new Set();
    arr.forEach(v => { if(v != null && v !== '') s.add(String(v)); });
    return Array.from(s);
  }

  function buildLegend(){
    const wrap = document.createElement('div');
    wrap.className = 'sb-floor-legend';
    const items = [
      ['empty','פנוי'],
      ['occupied','תפוס'],
      ['reserved','שמור'],
      ['dirty','מלוכלך'],
    ];
    items.forEach(([k,label]) => {
      const it = document.createElement('span');
      it.className = 'sb-leg-item';
      const dot = document.createElement('span');
      dot.className = 'sb-dot ' + k;
      const txt = document.createElement('span');
      txt.textContent = label;
      it.appendChild(dot);
      it.appendChild(txt);
      wrap.appendChild(it);
    });
    return wrap;
  }

  function humanizeSection(id, idx){
    if(!id) return idx === 0 ? 'קומה ראשית' : `קומה ${idx+1}`;
    // common patterns
    const t = String(id);
    if (/floor/i.test(t)) return t.replace(/_/g,' ');
    return idx === 0 ? 'קומה 1' : `קומה ${idx+1}`;
  }

  function createShell(root){
    root.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'sb-floor-shell';
    const topbar = document.createElement('div');
    topbar.className = 'sb-floor-topbar';
    const tabs = document.createElement('div');
    tabs.className = 'sb-floor-tabs';
    tabs.id = 'sb-floor-tabs';
    topbar.appendChild(tabs);
    topbar.appendChild(buildLegend());

    const viewport = document.createElement('div');
    viewport.className = 'sb-floor-viewport';
    const stage = document.createElement('div');
    stage.className = 'sb-floor-stage';
    stage.id = 'sb-floor-stage';
    viewport.appendChild(stage);

    shell.appendChild(topbar);
    shell.appendChild(viewport);
    root.appendChild(shell);

    return { shell, topbar, tabs, viewport, stage };
  }

  function computeLayout(plan, tables){
    // Base unit sizes (scaled to fit viewport)
    const cell = Number(getComputedStyle(document.documentElement).getPropertyValue('--sb-map-cell').trim().replace('px','')) || 104;
    const gap  = Number(getComputedStyle(document.documentElement).getPropertyValue('--sb-map-gap').trim().replace('px','')) || 14;
    const pad  = Number(getComputedStyle(document.documentElement).getPropertyValue('--sb-map-pad').trim().replace('px','')) || 14;

    const cols = Number(plan.gridCols || 10);
    const rows = Number(plan.gridRows || 8);

    const boardW = pad*2 + cols*cell + Math.max(0, cols-1)*gap;
    const boardH = pad*2 + rows*cell + Math.max(0, rows-1)*gap;

    return { cell, gap, pad, cols, rows, boardW, boardH };
  }

  function fitToViewport(viewport, boardW, boardH){
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const s = Math.min(vw/boardW, vh/boardH);
    // allow a bit of upscale on large displays, but keep it stable
    const scale = Math.min(Math.max(s, 0.35), 1.15);
    const x = Math.max(0, (vw - boardW*scale)/2);
    const y = Math.max(0, (vh - boardH*scale)/2);
    return { scale, x, y };
  }

  function makeTableEl(t, status, onClick){
    const btn = document.createElement('div');
    btn.className = 'sb-floor-table ' + (status || 'empty');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.dataset.tableNumber = String(t.tableNumber);

    const badge = document.createElement('span');
    badge.className = 'sb-floor-badge';

    const inner = document.createElement('div');
    inner.style.display = 'flex';
    inner.style.flexDirection = 'column';
    inner.style.alignItems = 'center';
    inner.style.justifyContent = 'center';
    inner.style.width = '100%';
    inner.style.height = '100%';

    const tn = document.createElement('div');
    tn.className = 'sb-tn';
    tn.textContent = String(t.tableNumber);

    const sub = document.createElement('div');
    sub.className = 'sb-sub';
    sub.textContent = status === 'occupied' ? (t.guestName || 'בהושבה') : (status === 'reserved' ? 'בהמתנה' : '');

    inner.appendChild(tn);
    if (sub.textContent) inner.appendChild(sub);
    btn.appendChild(badge);
    btn.appendChild(inner);

    const trigger = () => onClick(t, status);
    btn.addEventListener('click', trigger);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        trigger();
      }
    });
    return btn;
  }

  async function loadPlan(rid){
    const res = await fetch(`/api/floor-plans/${encodeURIComponent(rid)}`);
    if (!res.ok) throw new Error('failed');
    return await res.json();
  }

  function mapStatuses(plan){
    const m = new Map();
    (Array.isArray(plan.tableStatuses) ? plan.tableStatuses : []).forEach(s => {
      m.set(Number(s.tableNumber), {
        status: s.status || 'empty',
        guestName: s.guestName || null,
        guestCount: s.guestCount || null,
        orderId: s.orderId || null,
      });
    });
    return m;
  }

  function applyStatusClass(el, status){
    el.classList.remove('empty','occupied','reserved','dirty');
    el.classList.add(status || 'empty');
  }

  function initFloorMap(root){
    const rid = root.dataset.rid;
    if (!rid) return;

    const ui = createShell(root);
    const state = {
      sectionId: null,
      tablesByNumber: new Map(),
      plan: null,
      layout: null,
      fit: null,
    };

    const onTableClick = (t, status) => {
      if (status === 'occupied') {
        window.location.href = `/waiter/${encodeURIComponent(rid)}/${encodeURIComponent(t.tableNumber)}`;
      } else {
        // keep behavior safe for staff
        alert('שולחן לא תפוס כרגע. הושבה נעשית דרך מסך המארחת.');
      }
    };

    function renderSection(sectionId){
      const plan = state.plan;
      if (!plan) return;
      const statusMap = mapStatuses(plan);

      const allTables = Array.isArray(plan.tables) ? plan.tables : [];
      const tables = sectionId ? allTables.filter(t => String(t.sectionId||'') === String(sectionId)) : allTables;

      ui.stage.innerHTML = '';
      state.tablesByNumber.clear();

      const layout = computeLayout(plan, tables);
      state.layout = layout;

      // compute fit
      const fit = fitToViewport(ui.viewport, layout.boardW, layout.boardH);
      state.fit = fit;
      ui.stage.style.transform = `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`;

      // place tables
      tables.forEach((t) => {
        const tn = Number(t.tableNumber);
        const st = statusMap.get(tn)?.status || 'empty';
        const guestName = statusMap.get(tn)?.guestName || null;
        const tableData = Object.assign({}, t, { guestName });

        const el = makeTableEl(tableData, st, onTableClick);

        const x = layout.pad + (t.gridX * (layout.cell + layout.gap));
        const y = layout.pad + (t.gridY * (layout.cell + layout.gap));
        const w = (t.spanX || 1) * layout.cell + Math.max(0, (t.spanX||1)-1)*layout.gap;
        const h = (t.spanY || 1) * layout.cell + Math.max(0, (t.spanY||1)-1)*layout.gap;

        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.width = w + 'px';
        el.style.height = h + 'px';

        ui.stage.appendChild(el);
        state.tablesByNumber.set(tn, el);
      });
    }

    function buildTabs(){
      const plan = state.plan;
      const tables = Array.isArray(plan.tables) ? plan.tables : [];
      const sections = uniq(tables.map(t => t.sectionId || ''))
        .filter(v => v !== '');

      ui.tabs.innerHTML = '';

      // If no sections - hide tabs
      if (!sections.length) {
        ui.tabs.style.display = 'none';
        state.sectionId = null;
        renderSection(null);
        return;
      }

      ui.tabs.style.display = '';

      // Default: first section
      if (!state.sectionId) state.sectionId = sections[0];

      sections.forEach((sid, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sb-floor-tab';
        b.textContent = humanizeSection(sid, idx);
        b.setAttribute('aria-selected', String(sid === state.sectionId));
        b.addEventListener('click', () => {
          state.sectionId = sid;
          // update aria-selected
          Array.from(ui.tabs.querySelectorAll('.sb-floor-tab')).forEach(btn => btn.setAttribute('aria-selected','false'));
          b.setAttribute('aria-selected','true');
          renderSection(state.sectionId);
        });
        ui.tabs.appendChild(b);
      });

      renderSection(state.sectionId);
    }

    async function init(){
      try{
        const plan = await loadPlan(rid);
        state.plan = plan;
        buildTabs();
      }catch(e){
        root.innerHTML = "<p class='muted'>לא הוגדרה מפת שולחנות למסעדה זו.</p>";
      }
    }

    async function refreshStatuses(){
      if (!state.plan) return;
      try{
        const plan = await loadPlan(rid);
        state.plan.tableStatuses = plan.tableStatuses;
        const statusMap = mapStatuses(state.plan);
        state.tablesByNumber.forEach((el, tn) => {
          const st = statusMap.get(Number(tn))?.status || 'empty';
          applyStatusClass(el, st);
          const sub = el.querySelector('.sb-sub');
          if (sub) {
            const gn = statusMap.get(Number(tn))?.guestName;
            sub.textContent = st === 'occupied' ? (gn || 'בהושבה') : (st === 'reserved' ? 'בהמתנה' : '');
            sub.style.display = sub.textContent ? '' : 'none';
          }
        });
      }catch(e){
        // silent
      }
    }

    // Refit on resize, without changing concept
    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (!state.plan) return;
        renderSection(state.sectionId);
      }, 120);
    });

    init();
    setInterval(refreshStatuses, 5000);
  }

  window.SBFloorMap = { init: initFloorMap };
})();