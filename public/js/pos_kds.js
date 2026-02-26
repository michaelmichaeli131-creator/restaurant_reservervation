/* SpotBook KDS (Kitchen/Bar)
   - Realtime WebSocket board
   - Optional compact + grouped view
   - Mobile tabs
*/

(function(){
  const shell = document.querySelector('[data-kds-shell]');
  const root  = document.querySelector('[data-kds-root]');
  if (!shell || !root) return;

  const rid = String(root.getAttribute('data-rid') || '');
  const destination = String(root.getAttribute('data-destination') || 'kitchen');
  const locale = String(root.getAttribute('data-locale') || 'he-IL');

  // i18n strings provided by template (fallbacks are okay)
  const STR = {
    live: root.getAttribute('data-str-live') || 'Live',
    offline: root.getAttribute('data-str-offline') || 'Offline',
    search_ph: root.getAttribute('data-str-search') || 'Search table / item',
    received: root.getAttribute('data-str-received') || 'Received',
    in_progress: root.getAttribute('data-str-in-progress') || 'In Progress',
    ready: root.getAttribute('data-str-ready') || 'Ready',
    table: root.getAttribute('data-str-table') || 'Table',
    qty: root.getAttribute('data-str-qty') || 'Qty',
    created: root.getAttribute('data-str-created') || 'Created',
    none: root.getAttribute('data-str-none') || 'No items.',
    btn_back: root.getAttribute('data-str-back') || 'Back',
    btn_compact: root.getAttribute('data-str-compact') || 'Compact',
    btn_comfy: root.getAttribute('data-str-comfy') || 'Comfort',
    btn_group: root.getAttribute('data-str-group') || 'Group',
    btn_ungroup: root.getAttribute('data-str-ungroup') || 'Ungroup',
    act_prev: root.getAttribute('data-str-act-prev') || 'Back',
    act_next: root.getAttribute('data-str-act-next') || 'Next',
    act_start: root.getAttribute('data-str-act-start') || 'Start',
    act_ready: root.getAttribute('data-str-act-ready') || 'Ready',
  };

  // elements
  const el = {
    live: document.getElementById('kds-live'),
    compactBtn: document.getElementById('kds-compact'),
    groupBtn: document.getElementById('kds-group'),
    bottomCompactBtn: document.getElementById('kds-bottom-compact'),
    bottomGroupBtn: document.getElementById('kds-bottom-group'),
    search: document.getElementById('kds-search'),
    tabReceived: document.getElementById('kds-tab-received'),
    tabProgress: document.getElementById('kds-tab-in-progress'),
    tabReady: document.getElementById('kds-tab-ready'),
    countReceived: document.getElementById('kds-count-received'),
    countProgress: document.getElementById('kds-count-in-progress'),
    countReady: document.getElementById('kds-count-ready'),
    colReceived: document.getElementById('kds-col-received'),
    colProgress: document.getElementById('kds-col-in-progress'),
    colReady: document.getElementById('kds-col-ready'),
  };

  if (el.search) el.search.setAttribute('placeholder', STR.search_ph);

  const LS_PREFIX = `sb_kds_${destination}_`;
  const state = new Map(); // orderItemId -> item
  let ws;

  // UI state
  let compact = localStorage.getItem(LS_PREFIX + 'compact') === '1';
  let grouped = localStorage.getItem(LS_PREFIX + 'grouped') !== '0'; // default ON
  let activeStatus = localStorage.getItem(LS_PREFIX + 'tab') || 'received';
  let q = '';

  function setCompact(on){
    compact = !!on;
    shell.classList.toggle('kds-compact', compact);

    const applyBtn = (btn) => {
      if (!btn) return;
      btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
      btn.textContent = compact ? STR.btn_comfy : STR.btn_compact;
    };
    applyBtn(el.compactBtn);
    applyBtn(el.bottomCompactBtn);

    localStorage.setItem(LS_PREFIX + 'compact', compact ? '1' : '0');
  }

  function setGrouped(on){
    grouped = !!on;

    const applyBtn = (btn) => {
      if (!btn) return;
      btn.setAttribute('aria-pressed', grouped ? 'true' : 'false');
      btn.textContent = grouped ? STR.btn_ungroup : STR.btn_group;
    };
    applyBtn(el.groupBtn);
    applyBtn(el.bottomGroupBtn);

    localStorage.setItem(LS_PREFIX + 'grouped', grouped ? '1' : '0');
    render();
  }

  function setLive(isLive){
    if (!el.live) return;
    el.live.dataset.live = isLive ? '1' : '0';
    const label = isLive ? STR.live : STR.offline;
    const dot = '<span class="dot" aria-hidden="true"></span>';
    el.live.innerHTML = dot + label;
  }

  function setActiveStatus(status){
    activeStatus = status;
    localStorage.setItem(LS_PREFIX + 'tab', status);
    // tabs
    const map = {
      received: el.tabReceived,
      in_progress: el.tabProgress,
      ready: el.tabReady,
    };
    Object.entries(map).forEach(([k, btn]) => {
      if (!btn) return;
      btn.setAttribute('aria-selected', k === activeStatus ? 'true' : 'false');
    });
    // columns (ONLY on small screens)
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
    const showAll = !isMobile;
    const setHidden = (node, hidden) => {
      if (!node) return;
      if (hidden) node.setAttribute('hidden', '');
      else node.removeAttribute('hidden');
    };
    if (showAll){
      setHidden(el.colReceived, false);
      setHidden(el.colProgress, false);
      setHidden(el.colReady, false);
    } else {
      setHidden(el.colReceived, activeStatus !== 'received');
      setHidden(el.colProgress, activeStatus !== 'in_progress');
      setHidden(el.colReady, activeStatus !== 'ready');
    }
  }

  function normalize(s){
    return String(s || '').toLowerCase().trim();
  }

  function labelNext(status){
    if (status === 'received') return STR.act_start;
    if (status === 'in_progress') return STR.act_ready;
    return STR.act_next;
  }

  function nextStatus(current){
    if (current === 'received') return 'in_progress';
    if (current === 'in_progress') return 'ready';
    if (current === 'ready') return 'ready'; // waiter updates served
    if (current === 'served') return 'served';
    if (current === 'cancelled') return 'cancelled';
    return current;
  }

  function prevStatus(current){
    if (current === 'ready') return 'in_progress';
    if (current === 'in_progress') return 'received';
    if (current === 'received') return 'received';
    if (current === 'served') return 'ready';
    return current;
  }

  function sendStatusChange(itemId, orderId, status){
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'set_status',
      restaurantId: rid,
      orderItemId: itemId,
      orderId,
      status,
    }));
  }

  function ageMinutes(ts){
    const d = Date.now() - Number(ts || 0);
    return Math.max(0, Math.floor(d / 60000));
  }

  function ageClass(mins, status){
    // Tuned defaults: received gets attention sooner
    const warn = (status === 'received') ? 8 : 12;
    const crit = (status === 'received') ? 16 : 22;
    if (mins >= crit) return 'crit';
    if (mins >= warn) return 'warn';
    return '';
  }

  function ticketOuterClass(mins, status){
    const a = ageClass(mins, status);
    if (a === 'crit') return 'kds-ticket age-crit';
    if (a === 'warn') return 'kds-ticket age-warn';
    return 'kds-ticket';
  }

  function renderEmpty(container){
    const div = document.createElement('div');
    div.className = 'kds-empty';
    div.textContent = STR.none;
    container.appendChild(div);
  }

  function renderUngrouped(container, items){
    if (!items.length) return renderEmpty(container);

    for (const it of items){
      const mins = ageMinutes(it.createdAt);
      const ac = ageClass(mins, it.status);
      const timeStr = new Date(it.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

      const card = document.createElement('div');
      card.className = ticketOuterClass(mins, it.status);
      card.dataset.itemId = it.id;
      card.dataset.orderId = it.orderId;
      card.dataset.status = it.status;

      card.innerHTML = `
        <div class="kds-ticket-top">
          <div class="kds-badges">
            <span class="kds-badge table">${STR.table} ${it.table}</span>
            <span class="kds-badge qty">${STR.qty}: ${it.quantity}</span>
            <span class="kds-badge age ${ac}">${mins}m</span>
          </div>
        </div>
        <div class="kds-item-name">${escapeHtml(it.name)}</div>
        <div class="kds-item-meta">
          <span>${STR.created}: ${timeStr}</span>
          <span>#${escapeHtml(it.orderId).slice(0,6)}</span>
        </div>
        <div class="kds-actions">
          <button type="button" class="kds-act muted kds-prev" ${it.status === 'received' ? 'disabled' : ''}>${STR.act_prev}</button>
          <button type="button" class="kds-act primary kds-next" ${it.status === 'ready' ? 'disabled' : ''}>${labelNext(it.status)}</button>
        </div>
      `;

      container.appendChild(card);
    }
  }

  function renderGrouped(container, items){
    if (!items.length) return renderEmpty(container);

    const byTable = new Map();
    for (const it of items){
      const key = String(it.table);
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push(it);
    }

    const tables = Array.from(byTable.entries())
      .sort((a,b) => {
        // oldest first
        const amin = Math.min(...a[1].map(x => Number(x.createdAt || 0)));
        const bmin = Math.min(...b[1].map(x => Number(x.createdAt || 0)));
        return amin - bmin;
      });

    for (const [table, list] of tables){
      list.sort((a,b) => a.createdAt - b.createdAt);
      const oldest = list[0];
      const mins = ageMinutes(oldest.createdAt);
      const ac = ageClass(mins, oldest.status);

      const group = document.createElement('div');
      group.className = 'kds-group';
      group.innerHTML = `
        <div class="kds-group-header">
          <div class="kds-group-title">
            <span class="kds-badge table">${STR.table} ${escapeHtml(table)}</span>
            <span class="kds-badge age ${ac}">${mins}m</span>
            <span class="kds-badge">${list.length}</span>
          </div>
          <div class="kds-sub">${destination === 'bar' ? '🍸' : '🍳'}</div>
        </div>
        <div class="kds-group-body"></div>
      `;

      const body = group.querySelector('.kds-group-body');
      for (const it of list){
        const line = document.createElement('div');
        line.className = 'kds-line';
        line.dataset.itemId = it.id;
        line.dataset.orderId = it.orderId;
        line.dataset.status = it.status;
        line.innerHTML = `
          <div class="kds-line-left">
            <span class="kds-badge qty">x${it.quantity}</span>
            <span class="kds-line-name" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</span>
          </div>
          <div class="kds-line-actions">
            <button type="button" class="kds-mini secondary kds-prev" ${it.status === 'received' ? 'disabled' : ''}>${STR.act_prev}</button>
            <button type="button" class="kds-mini primary kds-next" ${it.status === 'ready' ? 'disabled' : ''}>${labelNext(it.status)}</button>
          </div>
        `;
        body.appendChild(line);
      }

      container.appendChild(group);
    }
  }

  function render(){
    const cols = {
      received: document.getElementById('kds-items-received'),
      in_progress: document.getElementById('kds-items-in-progress'),
      ready: document.getElementById('kds-items-ready'),
    };

    Object.values(cols).forEach(c => { if (c) c.innerHTML = ''; });

    // build list
    let items = Array.from(state.values()).filter(it => it.destination === destination);
    items.sort((a,b) => a.createdAt - b.createdAt);

    if (q){
      items = items.filter(it => {
        const name = normalize(it.name);
        const table = normalize(it.table);
        return name.includes(q) || table.includes(q);
      });
    }

    const byStatus = {
      received: items.filter(i => i.status === 'received'),
      in_progress: items.filter(i => i.status === 'in_progress'),
      ready: items.filter(i => i.status === 'ready'),
    };

    // counts
    if (el.countReceived) el.countReceived.textContent = String(byStatus.received.length);
    if (el.countProgress) el.countProgress.textContent = String(byStatus.in_progress.length);
    if (el.countReady) el.countReady.textContent = String(byStatus.ready.length);

    // tabs counts
    if (el.tabReceived) el.tabReceived.textContent = `${STR.received} (${byStatus.received.length})`;
    if (el.tabProgress) el.tabProgress.textContent = `${STR.in_progress} (${byStatus.in_progress.length})`;
    if (el.tabReady) el.tabReady.textContent = `${STR.ready} (${byStatus.ready.length})`;

    // render columns
    for (const [status, list] of Object.entries(byStatus)){
      const c = cols[status];
      if (!c) continue;
      if (grouped) renderGrouped(c, list);
      else renderUngrouped(c, list);
    }
  }

  function applySnapshot(list){
    state.clear();
    if (Array.isArray(list)){
      for (const it of list) state.set(it.id, it);
    }
    render();
  }

  function upsertItem(it){
    if (!it || !it.id) return;
    state.set(it.id, it);
    render();
  }

  // click handling (delegated)
  root.addEventListener('click', (ev) => {
    const nextBtn = ev.target.closest('.kds-next');
    const prevBtn = ev.target.closest('.kds-prev');
    if (!nextBtn && !prevBtn) return;
    const node = ev.target.closest('[data-item-id]');
    if (!node) return;

    const itemId = node.dataset.itemId;
    const orderId = node.dataset.orderId;
    const current = node.dataset.status;
    if (!itemId || !orderId || !current) return;

    let target = current;
    if (nextBtn) target = nextStatus(current);
    if (prevBtn) target = prevStatus(current);
    if (target === current) return;

    const local = state.get(itemId);
    if (local){
      local.status = target;
      local.updatedAt = Date.now();
      state.set(itemId, local);
      render();
    }
    sendStatusChange(itemId, orderId, target);
  });

  // controls
  if (el.compactBtn) el.compactBtn.addEventListener('click', () => setCompact(!compact));
  if (el.groupBtn) el.groupBtn.addEventListener('click', () => setGrouped(!grouped));
  if (el.bottomCompactBtn) el.bottomCompactBtn.addEventListener('click', () => setCompact(!compact));
  if (el.bottomGroupBtn) el.bottomGroupBtn.addEventListener('click', () => setGrouped(!grouped));
  if (el.search) el.search.addEventListener('input', () => { q = normalize(el.search.value); render(); });

  const bindTab = (btn, status) => {
    if (!btn) return;
    btn.addEventListener('click', () => setActiveStatus(status));
  };
  bindTab(el.tabReceived, 'received');
  bindTab(el.tabProgress, 'in_progress');
  bindTab(el.tabReady, 'ready');

  // initial UI state
  setCompact(compact);
  setGrouped(grouped);
  setActiveStatus(activeStatus);
  setLive(false);

  window.addEventListener('resize', () => {
    // re-apply column visibility when crossing breakpoints
    setActiveStatus(activeStatus);
  });

  // keep ages fresh (every 30s)
  setInterval(() => {
    // only re-render if there are items
    if (state.size) render();
  }, 30000);

  // Wake lock (optional; safe fallback)
  (async function(){
    try{
      if (!('wakeLock' in navigator)) return;
      // @ts-ignore
      const lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        try{
          if (document.visibilityState === 'visible') {
            // @ts-ignore
            await navigator.wakeLock.request('screen');
          }
        }catch(_e){}
      });
      // avoid unused var lint
      if (!lock) return;
    }catch(_e){}
  })();

  // WebSocket
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/ws/pos';

  try{
    ws = new WebSocket(wsUrl);
  }catch(e){
    console.error('WS connect failed', e);
    return;
  }

  ws.addEventListener('open', () => {
    setLive(true);
    ws.send(JSON.stringify({ type: 'join', role: destination, restaurantId: rid }));
  });
  ws.addEventListener('close', () => setLive(false));
  ws.addEventListener('error', () => setLive(false));

  ws.addEventListener('message', (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if (!msg || msg.restaurantId !== rid) return;

      if (msg.type === 'snapshot') applySnapshot(msg.items || []);
      if (msg.type === 'order_item') upsertItem(msg.item);
      if (msg.type === 'order_item_updated') upsertItem(msg.item);

      if (msg.type === 'order_closed'){
        const table = msg.table;
        if (table != null){
          for (const it of Array.from(state.values())){
            if (it.table === table) state.delete(it.id);
          }
          render();
        }
      }
    }catch(e){
      console.warn('bad WS message', e);
    }
  });

  // helpers
  function escapeHtml(s){
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  function escapeAttr(s){
    // attribute-safe
    return escapeHtml(s).replaceAll('`', '&#96;');
  }
})();
