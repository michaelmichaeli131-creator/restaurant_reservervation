// public/js/pos_waiter_menu.js
// Handles waiter menu search, filters, add-item, and notes modal.
(function () {
  const root = document.getElementById('menu-root');
  if (!root) return;

  const readJsonScript = (id, fallback) => {
    try {
      const el = document.getElementById(id);
      if (!el) return fallback;
      const parsed = JSON.parse(el.textContent || 'null');
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  };

  const rid = String(root.dataset.rid || '').trim();
  const table = Number(root.dataset.table || 0);
  const accountId = String(root.dataset.accountId || 'main').trim() || 'main';
  const reservationId = String(root.dataset.reservationId || '').trim();
  const locationId = String(root.dataset.locationId || '').trim();
  const loadMenuErrorText = String(root.dataset.loadErrorText || 'Error loading the menu.');
  const emptyMenuText = String(root.dataset.emptyText || 'No dishes in menu currently.');
  const addItemErrorText = String(root.dataset.addItemErrorText || 'Could not add item');
  const allText = String(root.dataset.allText || 'All');
  const noCategoryText = String(root.dataset.noCategoryText || 'Uncategorized');
  const categoryText = String(root.dataset.categoryText || 'Category');
  const dishText = String(root.dataset.dishText || 'Dish');
  const destBarText = String(root.dataset.destBarText || 'Bar');
  const destKitchenText = String(root.dataset.destKitchenText || 'Kitchen');
  const createdText = String(root.dataset.createdText || 'Created');
  const receivedText = String(root.dataset.receivedText || 'Received');
  const cancelText = String(root.dataset.cancelText || 'Cancel');
  const markServedText = String(root.dataset.markServedText || 'Mark as Served');
  const addedText = String(root.dataset.addedText || 'Added to order');
  const tapToAddText = String(root.dataset.tapToAddText || 'Tap to add');
  const addNoteText = String(root.dataset.addNoteText || 'Add to current check');
  const sectionHelpText = String(root.dataset.sectionHelpText || 'Choose a dish and add it straight to the live check.');
  const dishesText = String(root.dataset.dishesText || 'dishes');
  const locale = String(root.dataset.locale || 'en-US');
  const currency = document.getElementById('bill-summary')?.dataset.currency || '₪';
  let currentSeatIds = [];
  try {
    currentSeatIds = JSON.parse(decodeURIComponent(root.dataset.seatIds || '%5B%5D'));
    if (!Array.isArray(currentSeatIds)) currentSeatIds = [];
  } catch {
    currentSeatIds = [];
  }

  const toastEl = document.getElementById('sb-toast');
  let toastTimer = 0;
  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = String(text || '');
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let allItems = [];
  let selectedCat = '__all__';
  let selectedDest = '__all__';
  let query = '';

  const searchEl = document.getElementById('menu-search');
  const catsEl = document.getElementById('menu-cats');
  const segEl = document.querySelector('.sb-seg');
  const notesOverlay = document.getElementById('notes-overlay');
  const notesInput = document.getElementById('notes-input');
  const notesDishName = document.getElementById('notes-dish-name');
  const notesSkipBtn = document.getElementById('notes-skip');
  const notesSendBtn = document.getElementById('notes-send');
  let pendingCard = null;

  function renderCategories(items) {
    if (!catsEl || catsEl.dataset.built === '1') return;
    catsEl.dataset.built = '1';
    const byCat = new Map();
    items.forEach((item) => {
      const cid = item.categoryId || '__no_cat__';
      if (!byCat.has(cid)) byCat.set(cid, item);
    });
    const makeChip = (id, label, active) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sb-chip' + (active ? ' is-active' : '');
      b.dataset.cat = id;
      b.textContent = label;
      return b;
    };
    catsEl.innerHTML = '';
    catsEl.appendChild(makeChip('__all__', allText, true));
    byCat.forEach((item, cid) => {
      const label = cid === '__no_cat__'
        ? noCategoryText
        : (item.categoryName || item.categoryName_en || item.categoryName_he || item.categoryName_ka || categoryText);
      catsEl.appendChild(makeChip(cid, label, false));
    });
  }

  function filteredItems() {
    return allItems.filter((m) => {
      if (!m || m.outOfStock || m.isActive === false) return false;
      if (selectedDest !== '__all__' && String(m.destination || '') !== selectedDest) return false;
      const cid = m.categoryId || '__no_cat__';
      if (selectedCat !== '__all__' && cid !== selectedCat) return false;
      if (query) {
        const hay = [m.name_en, m.name_he, m.name_ka, m.desc_en, m.desc_he, m.desc_ka]
          .map((v) => String(v || '').toLowerCase())
          .join(' ');
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  function renderMenu(items) {
    if (!Array.isArray(items) || !items.length) {
      root.innerHTML = `<p class="muted">${escapeHtml(emptyMenuText)}</p>`;
      return;
    }
    allItems = items.slice();
    renderCategories(items);

    const grouped = new Map();
    filteredItems().forEach((item) => {
      const cid = item.categoryId || '__no_cat__';
      if (!grouped.has(cid)) grouped.set(cid, []);
      grouped.get(cid).push(item);
    });

    if (!grouped.size) {
      root.innerHTML = `<p class="muted">${escapeHtml(emptyMenuText)}</p>`;
      return;
    }

    const frag = document.createDocumentFragment();
    grouped.forEach((list, cid) => {
      const section = document.createElement('section');
      section.className = 'menu-section';

      const first = list[0] || {};
      const sectionTitle = cid === '__no_cat__'
        ? noCategoryText
        : (first.categoryName || first.categoryName_en || first.categoryName_he || first.categoryName_ka || categoryText);

      const head = document.createElement('div');
      head.className = 'menu-section-head';
      head.innerHTML = `
        <div>
          <h3 class="menu-section-title">${escapeHtml(sectionTitle)}</h3>
          <div class="menu-section-subtitle">${escapeHtml(sectionHelpText)}</div>
        </div>
        <span class="menu-section-count">${list.length} ${escapeHtml(dishesText)}</span>
      `;
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'menu-grid';
      list.forEach((m) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'menu-item-card';
        card.dataset.menuItemId = String(m.id || '');
        card.dataset.price = String(m.price || 0);
        card.dataset.dest = String(m.destination || 'kitchen');
        const dishName = m.name_en || m.name_he || m.name_ka || dishText;
        const dishDesc = m.desc_en || m.desc_he || m.desc_ka || '';
        const destText = String(m.destination || '') === 'bar' ? destBarText : destKitchenText;
        card.innerHTML = `
          <div class="menu-item-topline">
            <span class="menu-item-dest-badge">${escapeHtml(destText)}</span>
            <span class="menu-item-cta">${escapeHtml(tapToAddText)}</span>
          </div>
          <div class="menu-item-head">
            <div class="menu-item-copy">
              <div class="menu-item-name">${escapeHtml(dishName)}</div>
              <div class="menu-item-desc muted">${escapeHtml(dishDesc)}</div>
            </div>
            <span class="menu-item-price">${Number(m.price || 0).toFixed(2)} ${escapeHtml(currency)}</span>
          </div>
          <div class="menu-item-footer">
            <span class="menu-item-note">${escapeHtml(addNoteText)}</span>
            <span class="menu-item-add" aria-hidden="true">＋</span>
          </div>
        `;
        grid.appendChild(card);
      });
      section.appendChild(grid);
      frag.appendChild(section);
    });

    root.innerHTML = '';
    root.appendChild(frag);
  }

  function readPreloadedMenu() {
    const parsed = readJsonScript('menu-data', []);
    return Array.isArray(parsed) ? parsed : [];
  }

  async function loadMenu() {
    const preloaded = readPreloadedMenu();
    if (preloaded.length) {
      renderMenu(preloaded);
      return;
    }
    if (!rid) {
      root.innerHTML = `<p class="muted">${escapeHtml(loadMenuErrorText)}</p>`;
      return;
    }
    try {
      const res = await fetch(`/api/pos/menu/${encodeURIComponent(rid)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = await res.json();
      renderMenu(Array.isArray(items) ? items : []);
    } catch (err) {
      console.error('waiter menu load failed', err);
      root.innerHTML = `<p class="muted">${escapeHtml(loadMenuErrorText)}</p>`;
    }
  }

  function openNotesModal(card) {
    pendingCard = card;
    if (notesDishName) {
      notesDishName.textContent = card.querySelector('.menu-item-name')?.textContent || '';
    }
    if (notesInput) notesInput.value = '';
    if (notesOverlay) notesOverlay.hidden = false;
    setTimeout(() => notesInput?.focus(), 50);
  }

  function closeNotesModal() {
    if (notesOverlay) notesOverlay.hidden = true;
    pendingCard = null;
  }

  async function addItem(card, notes) {
    const menuItemId = String(card?.dataset?.menuItemId || '').trim();
    if (!menuItemId || !rid || !table || !Number.isFinite(Number(table))) return;
    if (card.classList.contains('is-loading')) return;
    card.classList.add('is-loading');

    try {
      const payload = {
        restaurantId: rid,
        table,
        accountId,
        reservationId: reservationId || undefined,
        locationId: locationId || undefined,
        tableId: locationId || undefined,
        locationType: (reservationId || currentSeatIds.length) ? 'bar' : 'table',
        seatIds: Array.isArray(currentSeatIds) ? currentSeatIds : [],
        seatId: Array.isArray(currentSeatIds) && currentSeatIds.length ? currentSeatIds[0] : undefined,
        menuItemId,
        quantity: 1,
        ...(String(notes || '').trim() ? { notes: String(notes || '').trim() } : {}),
      };

      const res = await fetch('/api/pos/order-item/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || !data?.ok) {
        const msg = data?.error || data?.message || `HTTP ${res.status}`;
        showToast(`${addItemErrorText}: ${msg}`);
        return;
      }

      const item = data.item;
      const listEl = document.getElementById('order-items');
      if (listEl && item) {
        const emptyRow = listEl.querySelector('.no-items-row');
        if (emptyRow) emptyRow.remove();

        const rowEl = document.createElement('div');
        rowEl.className = `order-row sb-wt-item status-${item.status}`;
        rowEl.dataset.orderId = String(item.orderId || '');
        rowEl.dataset.itemId = String(item.id || '');
        rowEl.dataset.qty = String(item.quantity || 0);
        rowEl.dataset.price = String(item.unitPrice || 0);
        rowEl.dataset.accountId = String(item.accountId || accountId);

        const createdAt = new Date(item.createdAt || Date.now());
        const timeStr = createdAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
        const destText = item.destination === 'bar' ? destBarText : destKitchenText;
        const notesHtml = item.notes ? `<div class="sb-wt-item-notes">${escapeHtml(item.notes)}</div>` : '';
        const showServe = item.status === 'ready' || item.status === 'in_progress';
        const statusLabel = item.status === 'ready' ? statusTextReady
          : item.status === 'in_progress' ? statusTextInProgress
          : item.status === 'served' ? statusTextServed
          : statusTextReceived;
        const statusHint = item.status === 'ready'
          ? 'Ready to run to the guest'
          : item.status === 'in_progress'
            ? 'Being prepared now'
            : item.status === 'served'
              ? 'Delivered to the table'
              : 'Queued for the line';
        const nextActionText = item.status === 'ready'
          ? 'Serve to guest'
          : item.status === 'in_progress'
            ? 'Track kitchen progress'
            : item.status === 'served'
              ? 'Completed'
              : 'Waiting for prep';
        rowEl.innerHTML = `
          <div class="sb-wt-item-shell">
            <div class="sb-wt-item-rail">
              <span class="sb-wt-item-state"><span class="sb-wt-item-state__dot" aria-hidden="true">•</span><span class="js-status-label">${escapeHtml(statusLabel)}</span></span>
              <span class="sb-wt-item-rail-chip">${escapeHtml(destText)}</span>
              <span class="sb-wt-item-rail-chip">x${escapeHtml(String(item.quantity || 1))}</span>
              <span class="sb-wt-item-rail-chip">${escapeHtml(createdText)} ${escapeHtml(timeStr)}</span>
            </div>
            <div class="sb-wt-item-content">
              <div class="sb-wt-item-main">
                <div class="sb-wt-item-heading">
                  <div>
                    <div class="sb-wt-item-title">${escapeHtml(item.name || '')}</div>
                    <div class="sb-wt-item-subtitle">${escapeHtml(statusHint)}</div>
                  </div>
                  <div class="sb-wt-item-total-wrap">
                    <div class="sb-wt-item-total-label">Line total</div>
                    <div class="sb-wt-item-total">${(Number(item.unitPrice || 0) * Number(item.quantity || 0)).toFixed(2)} ${escapeHtml(currency)}</div>
                  </div>
                </div>
                ${notesHtml ? `<div class="sb-wt-item-notes"><strong>Note</strong><span class="sb-wt-item-notes__text">${escapeHtml(item.notes)}</span></div>` : ''}
                <div class="sb-wt-item-info-grid">
                  <div class="sb-wt-item-info-card">
                    <span class="sb-wt-item-info-card__label">Destination</span>
                    <strong class="sb-wt-item-info-card__value">${escapeHtml(destText)}</strong>
                  </div>
                  <div class="sb-wt-item-info-card">
                    <span class="sb-wt-item-info-card__label">Quantity</span>
                    <strong class="sb-wt-item-info-card__value">x${escapeHtml(String(item.quantity || 1))}</strong>
                  </div>
                  <div class="sb-wt-item-info-card">
                    <span class="sb-wt-item-info-card__label">Status</span>
                    <strong class="sb-wt-item-info-card__value">${escapeHtml(statusLabel)}</strong>
                  </div>
                  <div class="sb-wt-item-info-card">
                    <span class="sb-wt-item-info-card__label">Created</span>
                    <strong class="sb-wt-item-info-card__value">${escapeHtml(timeStr)}</strong>
                  </div>
                </div>
              </div>
              <div class="sb-wt-item-side">
                <div class="sb-wt-item-side-card">
                  <div class="sb-wt-item-side-card__label">Next action</div>
                  <div class="sb-wt-item-side-card__value">${escapeHtml(nextActionText)}</div>
                </div>
                <div class="sb-wt-item-actions">
                  <button type="button" class="btn ghost md btn-cancel-item" title="${escapeHtml(cancelText)}">
                    <span class="icon">🗑</span> ${escapeHtml(cancelText)}
                  </button>
                  ${showServe ? `<button type="button" class="btn ghost md btn-mark-served" title="${escapeHtml(markServedText)}"><span class="icon">✅</span> ${escapeHtml(markServedText)}</button>` : ''}
                </div>
              </div>
            </div>
          </div>
        `;
        listEl.appendChild(rowEl);
      }

      window.sbRecalcBill?.();
      card.classList.add('is-added');
      setTimeout(() => card.classList.remove('is-added'), 450);
      if (navigator.vibrate) {
        try { navigator.vibrate(8); } catch {}
      }
      showToast(`${addedText}: ${item?.name || ''}`);
    } catch (err) {
      console.error('addItem failed', err);
      showToast(addItemErrorText);
    } finally {
      card.classList.remove('is-loading');
    }
  }

  if (searchEl) {
    searchEl.addEventListener('input', () => {
      query = String(searchEl.value || '').trim().toLowerCase();
      renderMenu(allItems);
    });
  }

  if (catsEl) {
    catsEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.sb-chip');
      if (!btn) return;
      selectedCat = btn.dataset.cat || '__all__';
      catsEl.querySelectorAll('.sb-chip').forEach((el) => el.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderMenu(allItems);
    });
  }

  if (segEl) {
    segEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.sb-seg-btn');
      if (!btn) return;
      selectedDest = btn.dataset.dest || '__all__';
      segEl.querySelectorAll('.sb-seg-btn').forEach((el) => el.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderMenu(allItems);
    });
  }

  root.addEventListener('click', (ev) => {
    const card = ev.target.closest('.menu-item-card');
    if (!card) return;
    ev.preventDefault();
    addItem(card, '');
  });

  notesSkipBtn?.addEventListener('click', () => {
    if (pendingCard) addItem(pendingCard, '');
    closeNotesModal();
  });
  notesSendBtn?.addEventListener('click', () => {
    if (pendingCard) addItem(pendingCard, notesInput?.value || '');
    closeNotesModal();
  });
  notesInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (pendingCard) addItem(pendingCard, notesInput.value || '');
      closeNotesModal();
    }
  });
  notesOverlay?.addEventListener('click', (ev) => {
    if (ev.target === notesOverlay) closeNotesModal();
  });

  // Optional long-press / secondary action can open notes modal in the future.
  // For now keep direct add on tap.

  loadMenu();
})();
