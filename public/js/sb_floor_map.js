(function(){
  function qs(el, sel){ return el ? el.querySelector(sel) : null; }

  function uniq(arr){
    const s = new Set();
    arr.forEach(v => { if(v != null && v !== '') s.add(String(v)); });
    return Array.from(s);
  }

  function statusLabel(status){
    switch(status){
      case 'occupied': return 'תפוס';
      case 'reserved': return 'שמור';
      case 'dirty': return 'מלוכלך';
      case 'empty':
      default: return 'פנוי';
    }
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

    // Floating HUD controls (Stage 2): zoom + center
    const hud = document.createElement('div');
    hud.className = 'sb-floor-hud';
    hud.innerHTML = `
      <div class="sb-floor-floatbar sb-floor-hudbar" role="toolbar" aria-label="Map controls">
        <button type="button" class="sb-floor-floatbtn" data-action="zoom-out" aria-label="Zoom out">−</button>
        <button type="button" class="sb-floor-floatbtn" data-action="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" class="sb-floor-floatbtn" data-action="center" aria-label="Center">◎</button>
      </div>
    `;
    const stage = document.createElement('div');
    stage.className = 'sb-floor-stage';
    stage.id = 'sb-floor-stage';
    viewport.appendChild(stage);
    viewport.appendChild(hud);

    shell.appendChild(topbar);
    shell.appendChild(viewport);
    root.appendChild(shell);

    return { shell, topbar, tabs, viewport, stage, hud };
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

  function fitToViewport(viewport, boardW, boardH, zoom){
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;

    // Safe padding so the map never touches the container edges (prevents visual clipping)
    const margin = 28;
    const aw = Math.max(1, vw - margin*2);
    const ah = Math.max(1, vh - margin*2);

    const s = Math.min(aw/boardW, ah/boardH);
    // allow a bit of upscale on large displays, but keep it stable
    const base = Math.min(Math.max(s, 0.35), 1.15);
    const z = Number(zoom || 1);
    const scale = Math.min(Math.max(base * z, 0.25), 2.0);

    // Center even when the board is larger than the viewport (x/y may be negative)
    const x = margin + (aw - boardW*scale)/2;
    const y = margin + (ah - boardH*scale)/2;
    return { scale, x, y };
  }

  
  // ================= Logical sizing =================
  // Scale furniture visually based on logical size (seats/type), without changing grid spans.
  function tableScale(tbl){
    const seats = Number(tbl.seats || 0);
    const shape = String(tbl.shape || 'rect').toLowerCase();

    // Booths: slightly larger and stable
    if (shape === 'booth') {
      if (seats <= 4) return 1.15;
      return 1.35;
    }

    // Default tables
    if (seats <= 2) return 0.75;   // smallest
    if (seats <= 4) return 1.00;   // baseline (round/rect equal)
    if (seats <= 6) return 1.50;   // 6 seats = 1.5x of 4
    if (seats <= 8) return 1.75;
    return 2.00;                  // 10+
  }

  function objectScale(obj){
    const t = String(obj.type || 'divider').toLowerCase();
    if (t === 'bar') return 1.80;
    return 1.00;
  }

function makeTableEl(t, status, onClick, extra){
    const btn = document.createElement('div');
    btn.className = 'sb-floor-table ' + (status || 'empty') + ' ' + ('shape-' + String((t.shape||'rect')).toLowerCase());
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.dataset.tableNumber = String(t.tableNumber);

    

    // logical scale for assets
    btn.style.setProperty('--sb-asset-scale', String(tableScale(t)));
const badge = document.createElement('span');
    badge.className = 'sb-floor-badge';

    // Status pill (reference-like). Keep empty clean.
    const pill = document.createElement('div');
    pill.className = 'sb-floor-statuspill';
    if (status && status !== 'empty') {
      const dot = document.createElement('span');
      dot.className = 'sb-dot is-' + status;
      const txt = document.createElement('span');
      const count = (t.guestCount != null && t.guestCount !== '') ? ` · ${t.guestCount}` : '';
      txt.textContent = statusLabel(status) + count;
      pill.appendChild(dot);
      pill.appendChild(txt);
    } else {
      pill.style.display = 'none';
    }

 
function tableAssetUrl(tbl){
  const BASE = '/floor_assets/';
  // Prefer explicit assetFile (critical for new palette items)
  if (tbl && tbl.assetFile) return BASE + String(tbl.assetFile);
  const seats = Number(tbl.seats || 0);
  const shape = String(tbl.shape || 'rect').toLowerCase();

  if (shape === 'round') {
    return seats >= 9 
      ? BASE + 'round_table_10.svg' 
      : BASE + 'round_table4.svg';
  }

  if (shape === 'booth') {
    return seats >= 6 
      ? BASE + 'large_booth.svg' 
      : BASE + 'booth4.svg';
  }

  // rect/square fallback
  const targets = [2,4,6,8,10];
  const nearest = targets.reduce((best, v) => 
    (Math.abs(v-seats) < Math.abs(best-seats) ? v : best), 4);

  return BASE + `square_table${nearest}.svg`;
}

    // No auto-chairs: chairs are explicit objects/assets in the layout.

    // Visual layer (asset + optional chairs)
    const visual = document.createElement('div');
    visual.className = 'sb-floor-visual';
    // Prefer explicit assetFile on the table object.
    if (t && t.assetFile) visual.dataset.asset = String(t.assetFile);

    const img = document.createElement('img');
    img.className = 'sb-floor-asset';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.src = tableAssetUrl(t);
    visual.appendChild(img);

    // No auto-chairs: chairs are explicit assets in the layout.

    const overlay = document.createElement('div');
    overlay.className = 'sb-floor-overlay';

    const tn = document.createElement('div');
    tn.className = 'sb-tn';
    tn.textContent = String(t.tableNumber);

    const sub = document.createElement('div');
    sub.className = 'sb-sub';
    sub.textContent = status === 'occupied' ? (t.guestName || 'בהושבה') : (status === 'reserved' ? 'בהמתנה' : '');

    overlay.appendChild(tn);
    if (sub.textContent) overlay.appendChild(sub);
    // Seats chip (subtle, bottom-left)
    const seats = document.createElement('div');
    seats.className = 'sb-floor-seats';
    if (t.seats != null && t.seats !== '') {
      seats.textContent = String(t.seats);
    } else {
      seats.style.display = 'none';
    }

    btn.appendChild(badge);
    btn.appendChild(pill);
    btn.appendChild(seats);
    btn.appendChild(visual);
    btn.appendChild(overlay);

    const trigger = () => onClick(t, status, extra);
    btn.addEventListener('click', trigger);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        trigger();
      }
    });
    return btn;
  }

  function makeObjectEl(obj){
    const el = document.createElement('div');
    el.className = 'sb-floor-object type-' + String(obj.type||'divider');
    
    el.style.setProperty('--sb-obj-scale', String(objectScale(obj)));
const type = String(obj.type||'divider');

function objectAssetUrl(o){
  const BASE = '/floor_assets/';
  if (o && o.assetFile) return BASE + String(o.assetFile);
  const t = String(o.type||'divider');

  if (t === 'door') return BASE + 'door.svg';
  if (t === 'bar') return BASE + 'bar.svg';
  if (t === 'plant') return BASE + 'plant.svg';
  if (t === 'chair') return BASE + 'chair.svg';
      if (t === 'cyclic_partition' || t === 'cyclic') return BASE + 'cyclic_partition.svg';

  // wall / divider logic
  const sx = Number(o.spanX || 1);
  const sy = Number(o.spanY || 1);

  if (sx === 1 && sy === 1) return BASE + 'corner_partitaion.svg';
  if (sx > sy) return BASE + 'horizintal_partitaion.svg';
  return BASE + 'vertical_partition.svg';
}


    const img = document.createElement('img');
    img.className = 'sb-obj-asset';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.src = objectAssetUrl(obj);
    el.appendChild(img);
    if (obj.label) {
      const lbl = document.createElement('div');
      lbl.className = 'sb-obj-label';
      lbl.textContent = String(obj.label);
      el.appendChild(lbl);
    }
    const rot = Number(obj.rotation || 0);
    if (!Number.isNaN(rot) && rot) {
      el.style.transform = `rotate(${rot}deg)`;
    }
    return el;
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

    // Click behavior can be customized per-page.
    // Default keeps the legacy behavior (navigate on occupied).
    // For waiter lobby (Stage 3.2b) we dispatch an event instead.
    const clickMode = (root.dataset.clickMode || root.dataset.mode || '').toLowerCase();

    const ui = createShell(root);
    const state = {
      sectionId: null,
      tablesByNumber: new Map(),
      plan: null,
      layout: null,
      fit: null,
      zoom: 1,
      selectedTn: null,
    };

    // Expose instance for external syncing (left list <-> map)
    // eslint-disable-next-line no-underscore-dangle
    root.__sbFloor = { ui, state };

    const onTableClick = (t, status, extra) => {
      // Event mode: let the page decide what to do (open drawer, show info, etc.)
      if (clickMode === 'lobby' || clickMode === 'event') {
        const detail = {
          rid,
          tableNumber: Number(t.tableNumber),
          status: status || 'empty',
          guestName: t.guestName || null,
          guestCount: t.guestCount || null,
          orderId: (extra && extra.orderId) ? extra.orderId : null,
        };
        root.dispatchEvent(new CustomEvent('sb:floor-table-click', { detail }));
        return;
      }

      // Default legacy behavior
      if (status === 'occupied') {
        window.location.href = `/waiter/${encodeURIComponent(rid)}/${encodeURIComponent(t.tableNumber)}`;
      } else {
        alert('שולחן לא תפוס כרגע. הושבה נעשית דרך מסך המארחת.');
      }
    };

    function renderSection(sectionId){
      let gridLayer;

      const plan = state.plan;
      if (!plan) return;
      const statusMap = mapStatuses(plan);

      const allTables = Array.isArray(plan.tables) ? plan.tables : [];
      const tables = sectionId ? allTables.filter(t => String(t.sectionId||'') === String(sectionId)) : allTables;

      ui.stage.innerHTML = '';
      state.tablesByNumber.clear();

      const layout = computeLayout(plan, tables);
      state.layout = layout;
      // Floor theme (stored in layout.floorColor). Back-compat: if old hex string, default to parquet_blue.
      try {
        const raw = String(layout.floorColor || 'parquet_blue');
        const theme = raw.startsWith('#') ? 'parquet_blue' : raw;
        if (state.root) state.root.setAttribute('data-floor-theme', theme);
      } catch(e) {}

      // compute fit
      const fit = fitToViewport(ui.viewport, layout.boardW, layout.boardH, state.zoom);
      state.fit = fit;
      ui.stage.style.transform = `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`;

      // Grid mask (restaurant shape): render inactive cells as holes
      if (Array.isArray(plan.gridMask) && plan.gridMask.length) {
        const mask = document.createElement('div');
        mask.className = 'sb-floor-mask';
        mask.style.width = layout.boardW + 'px';
        mask.style.height = layout.boardH + 'px';
        const frag = document.createDocumentFragment();
        const cols = Number(plan.gridCols || layout.cols);
        const rows = Number(plan.gridRows || layout.rows);
        const m = plan.gridMask;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const idx = y * cols + x;
            if (m[idx] === 0) {
              const h = document.createElement('div');
              h.className = 'sb-hole';
              h.style.left = (layout.pad + x * (layout.cell + layout.gap)) + 'px';
              h.style.top = (layout.pad + y * (layout.cell + layout.gap)) + 'px';
              h.style.width = layout.cell + 'px';
              h.style.height = layout.cell + 'px';
              frag.appendChild(h);
            }
          }
        }
        mask.appendChild(frag);
        ui.stage.appendChild(mask);
      }

      // Place objects (walls/doors/bar/plants) behind tables
      const objects = Array.isArray(plan.objects) ? plan.objects : [];
      objects.forEach((o) => {
        const el = makeObjectEl(o);
        const x = layout.pad + (o.gridX * (layout.cell + layout.gap));
        const y = layout.pad + (o.gridY * (layout.cell + layout.gap));
        const w = (o.spanX || 1) * layout.cell + Math.max(0, (o.spanX||1)-1)*layout.gap;
        const h = (o.spanY || 1) * layout.cell + Math.max(0, (o.spanY||1)-1)*layout.gap;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.width = w + 'px';
        el.style.height = h + 'px';
        ui.stage.appendChild(el);
      });

      // place tables
      tables.forEach((t) => {
        const tn = Number(t.tableNumber);
        const st = statusMap.get(tn)?.status || 'empty';
        const stObj = statusMap.get(tn) || {};
        const guestName = stObj.guestName || null;
        const guestCount = stObj.guestCount || null;
        const orderId = stObj.orderId || null;
        const tableData = Object.assign({}, t, { guestName, guestCount });

        const el = makeTableEl(tableData, st, (tbl, status) => onTableClick(tbl, status, { orderId }));

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

      // Notify page that the floor map is ready (useful for syncing selections)
      root.dispatchEvent(new CustomEvent('sb:floor-ready', { detail: { rid } }));
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

          const pill = el.querySelector('.sb-floor-statuspill');
          if (pill) {
            if (st && st !== 'empty') {
              const gn = statusMap.get(Number(tn))?.guestName;
              const gc = statusMap.get(Number(tn))?.guestCount;
              const dot = pill.querySelector('.sb-dot');
              if (dot) dot.className = 'sb-dot is-' + st;
              const txt = pill.querySelector('span:nth-child(2)');
              if (txt) {
                const count = (gc != null && gc !== '') ? ` · ${gc}` : '';
                txt.textContent = statusLabel(st) + count;
              }
              pill.style.display = '';
            } else {
              pill.style.display = 'none';
            }
          }
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

    // HUD controls
    if (ui.hud) {
      ui.hud.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'zoom-in') state.zoom = Math.min(2.0, state.zoom * 1.12);
        if (action === 'zoom-out') state.zoom = Math.max(0.6, state.zoom / 1.12);
        if (action === 'center') state.zoom = 1;
        renderSection(state.sectionId);
      });
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

    // Public-ish helpers for pages (selection highlight)
    root.__sbFloor = {
      selectTable: (tn) => {
        const num = Number(tn);
        if (!Number.isFinite(num)) return;
        const el = state.tablesByNumber.get(num);
        if (!el) return;
        // clear previous
        state.tablesByNumber.forEach((node) => node.classList.remove('selected'));
        el.classList.add('selected');
      },
      clearSelection: () => {
        state.tablesByNumber.forEach((node) => node.classList.remove('selected'));
      }
    };
  }

  window.SBFloorMap = {
    init: initFloorMap,
    select: (root, tableNumber) => {
      if (root && root.__sbFloor && typeof root.__sbFloor.selectTable === 'function') {
        root.__sbFloor.selectTable(tableNumber);
      }
    },
    clearSelection: (root) => {
      if (root && root.__sbFloor && typeof root.__sbFloor.clearSelection === 'function') {
        root.__sbFloor.clearSelection();
      }
    }
  };
})();