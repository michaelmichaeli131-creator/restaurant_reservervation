// /static/js/owner_calendar.js
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const init = window.__OC__ || {};
  const lang = String(init.lang || document.documentElement.lang || document.documentElement.getAttribute("lang") || "en").toLowerCase();
  const locale = String(init.locale || (lang === "ka" ? "ka-GE" : (lang === "he" ? "he-IL" : "en-US")));

  const state = {
    rid: init.rid || getRidFromPath(),
    date: init.date || todayISO(),
    day: null,
    summary: null,
    drawer: { open: false, time: null, items: [] },
    sse: { es: null, retryMs: 1500, pollTimer: null },
    cal: { year: 0, month: 0 },
    systemTime: { date: init.systemNowDate || init.date || todayISO(), time: init.systemNowTime || "12:00" },
    ui: { occupancyFilter: "all", searchMatchTimes: null },
  };

  const datePicker = $("#datePicker");
  const dateLabel = $("#date-label");
  const btnPrev = $("#btn-prev");
  const btnNext = $("#btn-next");
  const daySearch = $("#daySearch");
  const capLine = $("#cap-line");
  const slotsRoot = $("#slots");
  const summaryRoot = $("#summary");
  const hintRoot = $("#oc-hint");
  const emptyState = $("#oc-empty-state");
  const emptyCopy = $("#oc-empty-copy");
  const currentTimeChip = $("#oc-current-time-chip");
  const kpisRoot = $("#oc-kpis");
  const filtersRoot = $("#oc-filters");
  const btnJumpNow = $("#btn-jump-now");
  const densityRail = $("#oc-density-rail");
  const densityMeta = $("#oc-density-meta");
  const bandGrid = $("#oc-band-grid");
  const serviceScore = $("#oc-service-score");
  const serviceScoreBar = $("#oc-service-score-bar");
  const serviceMood = $("#oc-service-mood");
  const serviceMoodSub = $("#oc-service-mood-sub");
  const nextPeakEl = $("#oc-next-peak");
  const serviceWindowEl = $("#oc-service-window");
  const peakRoomEl = $("#oc-peak-room");
  const visibleFocusEl = $("#oc-visible-focus");
  const spotlightTitle = $("#oc-spotlight-title");
  const spotlightSub = $("#oc-spotlight-sub");
  const spotlightMetrics = $("#oc-spotlight-metrics");
  const currentLoadEl = $("#oc-current-load");
  const currentRoomEl = $("#oc-current-room");
  const expectedGuestsEl = $("#oc-expected-guests");
  const recoveryWatchEl = $("#oc-recovery-watch");
  const btnOpenNextPeak = $("#oc-open-next-peak");
  const btnOpenCurrentSlot = $("#oc-open-current-slot");

  const drawer = $("#drawer");
  const drawerTitle = $("#drawer-title");
  const drawerClose = $("#drawer-close");
  const drawerSearch = $("#drawer-search");
  const drawerTableBody = $("#drawer-table tbody");
  const btnAdd = $("#btn-add");

  const calTitle = $("#cal-title");
  const calBody = $("#cal-body");
  const calWk = $("#cal-weekdays");
  const calPrev = $("#cal-prev");
  const calNext = $("#cal-next");
  const sideSearch = $("#sideSearch");
  const sideSumBox = $("#day-summary-box");
  const sideSumText = $("#day-summary-text");
  const sideSumBar = $("#day-summary-bar");
  const systemDateInput = $("#oc-system-date");
  const systemTimeInput = $("#oc-system-time");
  const systemApplyBtn = $("#oc-system-apply-btn");
  const systemNowBtn = $("#oc-system-now-btn");
  const systemPreview = $("#oc-system-time-preview");
  const systemStatus = $("#oc-system-time-status");
  const roomGraphTime = $("#oc-room-graph-time");
  const roomGraphBody = $("#oc-room-graph-body");

  function getRidFromPath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("restaurants");
    if (i >= 0 && parts[i + 1]) return decodeURIComponent(parts[i + 1]);
    const rid = new URL(location.href).searchParams.get("rid");
    if (rid) return rid;
    throw new Error("RID not found");
  }

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fmt(n) { return new Intl.NumberFormat(locale).format(Number(n || 0)); }
  function fmtDate(d, opts) { return d.toLocaleDateString(locale, opts); }
  function getCSS(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function setOpen(el, on) { if (el) el.classList.toggle("open", !!on); }
  function ymd(d) { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function timeToMinutes(hhmm) {
    const [h, m] = String(hhmm || "00:00").split(":").map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  }

  function addDays(iso, days) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return ymd(dt);
  }

  function isoToDate(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date();
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function color(p) {
    if (p >= 80) return getCSS("--danger");
    if (p >= 50) return getCSS("--warn");
    return getCSS("--ok");
  }

  function bandForPercent(pct) {
    if (pct >= 80) return { key: "full", label: init?.txt?.bandFull || "Critical", className: "oc-tag--full" };
    if (pct >= 40) return { key: "busy", label: init?.txt?.bandBusy || "Busy", className: "oc-tag--busy" };
    return { key: "quiet", label: init?.txt?.bandQuiet || "Comfortable", className: "oc-tag--quiet" };
  }

  function toAMPM(hhmm) {
    const [H, M] = String(hhmm || "00:00").split(":").map(Number);
    const ampm = H >= 12 ? "PM" : "AM";
    const h = ((H + 11) % 12) + 1;
    return `${h}:${String(M).padStart(2, "0")} ${ampm}`;
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...opts,
    });
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await res.json().catch(() => ({}));
    } else {
      const txt = await res.text().catch(() => "");
      try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    }
    if (!res.ok || data?.ok === false) {
      const msg = data?.error || data?.message || `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data;
  }

  function renderHeaderLine() {
    if (!state.day) {
      if (dateLabel) dateLabel.textContent = "—";
      if (capLine) capLine.textContent = "";
      return;
    }
    const d = new Date(state.date + "T00:00:00");
    const weekday = fmtDate(d, { weekday: "short" });
    const long = fmtDate(d, { year: "numeric", month: "short", day: "numeric" });
    if (dateLabel) dateLabel.textContent = `${weekday}, ${long}`;
    if (capLine) {
      capLine.textContent = `${init?.txt?.capacityPeople || "People"} ${state.day.capacityPeople} • ${init?.txt?.capacityTables || "Tables"} ${state.day.capacityTables} • ${init?.txt?.capacityStep || "Step"}: ${state.day.slotMinutes}${init?.txt?.minutesShort || "m"}`;
    }
    if (currentTimeChip) currentTimeChip.textContent = state.day?.currentTime?.time || state.systemTime.time || "—";
  }

  function filteredSlots() {
    const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
    return slots.filter((slot) => {
      const pct = Number(slot.percent || 0);
      if (state.ui.occupancyFilter === "quiet") return pct < 40;
      if (state.ui.occupancyFilter === "busy") return pct >= 40 && pct < 80;
      if (state.ui.occupancyFilter === "full") return pct >= 80;
      return true;
    });
  }

  function rowHeader() {
    if (!slotsRoot) return;
    let th = $(".oc-th", slotsRoot);
    if (!th) {
      th = document.createElement("div");
      th.className = "oc-row oc-th";
      slotsRoot.prepend(th);
    }
    th.innerHTML = `
      <div>${escapeHTML(init?.txt?.time || "Time")}</div>
      <div>${escapeHTML(init?.txt?.occupancy || "Occupancy")}</div>
      <div class="oc-info">${escapeHTML(init?.txt?.availability || "Availability")}</div>
      <div class="oc-info">${escapeHTML(init?.txt?.openAction || "Open")}</div>
    `;
  }

  function updateEmptyState(visibleCount, totalCount) {
    if (!emptyState || !emptyCopy) return;
    const hasSearch = state.ui.searchMatchTimes instanceof Set;
    const show = totalCount === 0 || visibleCount === 0;
    emptyState.hidden = !show;
    if (!show) return;
    if (totalCount === 0) {
      emptyCopy.textContent = init?.txt?.emptyDay || "No slots are available for this day yet.";
      return;
    }
    if (hasSearch) {
      emptyCopy.textContent = init?.txt?.emptySearch || "No matching guests were found in the visible slots.";
      return;
    }
    emptyCopy.textContent = init?.txt?.emptyFilter || "Try a different occupancy filter to reveal more time slots.";
  }

  function updateHint(visibleCount, totalCount) {
    if (!hintRoot) return;
    if (!totalCount) {
      hintRoot.textContent = init?.txt?.hintEmpty || "This day has no active slots yet.";
      return;
    }
    const hasSearch = state.ui.searchMatchTimes instanceof Set;
    if (hasSearch) {
      const matches = Array.from(state.ui.searchMatchTimes || []).length;
      hintRoot.textContent = `${init?.txt?.hintMatches || "Matches highlighted"}: ${fmt(matches)} • ${init?.txt?.hintVisible || "Visible slots"}: ${fmt(visibleCount)}/${fmt(totalCount)}`;
      return;
    }
    hintRoot.textContent = `${init?.txt?.hintVisible || "Visible slots"}: ${fmt(visibleCount)}/${fmt(totalCount)} • ${init?.txt?.hintTap || "Tap any slot to manage guests."}`;
  }

  function renderKPIs() {
    if (!kpisRoot) return;
    if (!state.day || !state.summary) {
      kpisRoot.innerHTML = Array.from({ length: 4 }).map(() => `
        <article class="oc-kpi">
          <div class="oc-kpi__label">${escapeHTML(init?.txt?.loadingLabel || "Loading")}</div>
          <div class="oc-kpi__value">—</div>
          <div class="oc-kpi__sub">${escapeHTML(init?.txt?.dailySummaryLoading || "Daily summary — loading…")}</div>
        </article>
      `).join("");
      return;
    }

    const s = state.summary;
    const peakSlot = s.peakSlot || "—";
    const peakSub = peakSlot === "—" ? (init?.txt?.peakSubNone || "No peak slot yet") : `${fmt(s.peakOccupancy || 0)}% ${escapeHTML(init?.txt?.peakSub || "load")}`;
    const avgOcc = Number(s.avgOccupancyPeople || s.occupancyPct || 0);
    const currentTime = state.day?.currentTime?.time || state.systemTime.time || "—";

    kpisRoot.innerHTML = `
      <article class="oc-kpi">
        <div class="oc-kpi__label">${escapeHTML(init?.txt?.totalReservations || "Total Reservations")}</div>
        <div class="oc-kpi__value">${fmt(s.totalReservations || 0)}</div>
        <div class="oc-kpi__sub">${escapeHTML(init?.txt?.kpiReservationsSub || "Booked for the selected day")}</div>
      </article>
      <article class="oc-kpi">
        <div class="oc-kpi__label">${escapeHTML(init?.txt?.totalGuests || "Total Guests")}</div>
        <div class="oc-kpi__value">${fmt(s.totalGuests || 0)}</div>
        <div class="oc-kpi__sub">${escapeHTML(init?.txt?.kpiGuestsSub || "Expected covers across all slots")}</div>
      </article>
      <article class="oc-kpi">
        <div class="oc-kpi__label">${escapeHTML(init?.txt?.peak || "Peak")}</div>
        <div class="oc-kpi__value">${escapeHTML(peakSlot)}</div>
        <div class="oc-kpi__sub">${escapeHTML(peakSub)}</div>
      </article>
      <article class="oc-kpi">
        <div class="oc-kpi__label">${escapeHTML(init?.txt?.avgOccupancy || "Avg Occupancy")}</div>
        <div class="oc-kpi__value">${fmt(avgOcc)}%</div>
        <div class="oc-kpi__sub">${escapeHTML(init?.txt?.kpiOccupancySub || "Current focus")} · ${escapeHTML(currentTime)}</div>
      </article>
    `;
  }

  function findCurrentSlot() {
    const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
    const target = state.day?.currentTime?.time || state.systemTime.time || "";
    return slots.find((slot) => slot.time === target) || slots[0] || null;
  }

  function getMoodDescriptor(pct) {
    if (pct >= 80) {
      return {
        label: init?.txt?.serviceFlowCritical || "Critical pressure",
        sub: `${fmt(pct)}% ${init?.txt?.occupancy || "Occupancy"}`,
      };
    }
    if (pct >= 55) {
      return {
        label: init?.txt?.serviceFlowBusy || "Rush building up",
        sub: `${fmt(pct)}% ${init?.txt?.occupancy || "Occupancy"}`,
      };
    }
    if (pct >= 30) {
      return {
        label: init?.txt?.serviceFlowBalanced || "Balanced flow",
        sub: `${fmt(pct)}% ${init?.txt?.occupancy || "Occupancy"}`,
      };
    }
    return {
      label: init?.txt?.serviceFlowCalm || "Calm service",
      sub: `${fmt(pct)}% ${init?.txt?.occupancy || "Occupancy"}`,
    };
  }

  function focusSlot(time, { open = false } = {}) {
    if (!time) return;
    const row = Array.from($$(".oc-row[data-time]", slotsRoot || document)).find((el) => el.dataset.time === time);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("is-match");
      setTimeout(() => row.classList.remove("is-match"), 1200);
    }
    if (open) openDrawer(time);
  }

  function renderBandGrid() {
    if (!bandGrid) return;
    const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
    const stats = [
      { key: "all", label: init?.txt?.allSlotsLabel || "All slots", count: slots.length, sub: init?.txt?.visibleSlotsMeta || "Visible slots" },
      { key: "quiet", label: init?.txt?.quietLabel || "Quiet", count: slots.filter((slot) => Number(slot.percent || 0) < 40).length, sub: "< 40%" },
      { key: "busy", label: init?.txt?.busyLabel || "Busy", count: slots.filter((slot) => Number(slot.percent || 0) >= 40 && Number(slot.percent || 0) < 80).length, sub: "40–79%" },
      { key: "full", label: init?.txt?.fullLabel || "Critical", count: slots.filter((slot) => Number(slot.percent || 0) >= 80).length, sub: "80%+" },
    ];
    bandGrid.innerHTML = stats.map((item) => `
      <button class="oc-band-card ${state.ui.occupancyFilter === item.key ? "is-active" : ""}" type="button" data-filter="${item.key}">
        <span class="oc-band-card__label">${escapeHTML(item.label)}</span>
        <span class="oc-band-card__value">${fmt(item.count)}</span>
        <span class="oc-band-card__sub">${escapeHTML(item.sub)}${item.key === "all" ? ` • ${fmt(filteredSlots().length)} ${escapeHTML(init?.txt?.slotsLabel || "slots")}` : ""}</span>
      </button>
    `).join("");
    $$(".oc-band-card", bandGrid).forEach((btn) => {
      btn.addEventListener("click", () => setOccupancyFilter(btn.dataset.filter || "all"));
    });
  }

  function renderDensityRail() {
    if (!densityRail) return;
    const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
    const visibleSet = new Set(filteredSlots().map((slot) => slot.time));
    const matchSet = state.ui.searchMatchTimes;
    const currentTime = state.day?.currentTime?.time || state.systemTime.time || "";
    const visibleCount = slots.filter((slot) => {
      const filterVisible = visibleSet.has(slot.time);
      const searchVisible = !(matchSet instanceof Set) || matchSet.has(slot.time);
      return filterVisible && searchVisible;
    }).length;
    if (densityMeta) densityMeta.textContent = `${fmt(visibleCount)} / ${fmt(slots.length)} ${init?.txt?.visibleSlotsMeta || "Visible slots"}`;
    if (!slots.length) {
      densityRail.innerHTML = `<div class="muted">${escapeHTML(init?.txt?.dailySummaryLoading || "Daily summary — loading…")}</div>`;
      return;
    }
    densityRail.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const slot of slots) {
      const pct = clamp(Number(slot.percent || 0), 0, 100);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oc-density__slot";
      const filterVisible = visibleSet.has(slot.time);
      const searchVisible = !(matchSet instanceof Set) || matchSet.has(slot.time);
      if (slot.time === currentTime) btn.classList.add("is-current");
      if (matchSet instanceof Set && matchSet.has(slot.time)) btn.classList.add("is-match");
      if (!filterVisible || !searchVisible) btn.classList.add("is-dim");
      btn.title = `${slot.time} • ${fmt(pct)}%`;
      btn.innerHTML = `
        <div class="oc-density__time">${escapeHTML(slot.time)}</div>
        <div class="oc-density__pct">${fmt(pct)}%</div>
        <div class="oc-density__bar"><span class="oc-density__fill" style="width:${pct}%;background:${color(pct)}"></span></div>
      `;
      btn.addEventListener("click", () => focusSlot(slot.time, { open: false }));
      frag.appendChild(btn);
    }
    densityRail.appendChild(frag);
  }

  function renderPremiumPanels() {
    const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
    const summary = state.summary || {};
    const currentSlot = findCurrentSlot();
    const currentPct = clamp(Number(currentSlot?.percent || 0), 0, 100);
    const mood = getMoodDescriptor(currentPct);
    const currentTime = currentSlot?.time || state.day?.currentTime?.time || state.systemTime.time || "—";
    const futureSlots = slots.filter((slot) => timeToMinutes(slot.time) >= timeToMinutes(currentTime));
    const peakSlot = slots.reduce((best, slot) => Number(slot.percent || 0) > Number(best?.percent || -1) ? slot : best, null);
    const nextPeak = (futureSlots.length ? futureSlots : slots).reduce((best, slot) => Number(slot.percent || 0) > Number(best?.percent || -1) ? slot : best, null);
    const rooms = Array.isArray(state.day?.roomOccupancy) ? state.day.roomOccupancy : [];
    const topRoom = rooms.reduce((best, room) => Number(room.percent || 0) > Number(best?.percent || -1) ? room : best, null);
    const firstSlot = slots[0]?.time || "—";
    const lastSlot = slots[slots.length - 1]?.time || "—";
    const visibleCount = slots.filter((slot) => {
      const filterVisible = filteredSlots().some((x) => x.time === slot.time);
      const searchVisible = !(state.ui.searchMatchTimes instanceof Set) || state.ui.searchMatchTimes.has(slot.time);
      return filterVisible && searchVisible;
    }).length;
    const avg = Number(summary.avgOccupancyPeople || summary.occupancyPct || currentPct || 0);
    const cancellations = Number(summary.cancelled || 0);
    const noShow = Number(summary.noShow || 0);
    const pressurePenalty = Math.max(0, currentPct - 72) * 0.9;
    const score = clamp(Math.round(100 - Math.abs(avg - 68) * 0.9 - pressurePenalty - cancellations * 2 - noShow * 3), 18, 98);

    if (serviceScore) serviceScore.textContent = `${score}`;
    if (serviceScoreBar) serviceScoreBar.style.width = `${score}%`;
    if (serviceMood) serviceMood.textContent = mood.label;
    if (serviceMoodSub) serviceMoodSub.textContent = `${currentTime} • ${mood.sub}`;
    if (nextPeakEl) nextPeakEl.textContent = nextPeak ? `${nextPeak.time} • ${fmt(nextPeak.percent || 0)}%` : "—";
    if (serviceWindowEl) serviceWindowEl.textContent = `${firstSlot} → ${lastSlot}`;
    if (peakRoomEl) peakRoomEl.textContent = topRoom ? `${topRoom.label || "—"} • ${fmt(topRoom.percent || 0)}%` : "—";
    if (visibleFocusEl) visibleFocusEl.textContent = `${fmt(visibleCount)} / ${fmt(slots.length)} ${init?.txt?.slotsLabel || "slots"}`;

    if (spotlightTitle) spotlightTitle.textContent = mood.label;
    if (spotlightSub) {
      const nextCopy = nextPeak ? `${init?.txt?.nextPeakLabel || "Next peak"} ${nextPeak.time} • ${fmt(nextPeak.percent || 0)}%.` : "";
      spotlightSub.textContent = `${currentTime} is tracking at ${fmt(currentPct)}% occupancy. ${nextCopy} ${slots.length ? `${init?.txt?.serviceWindowLabel || "Service window"} ${firstSlot}–${lastSlot}.` : ""}`.trim();
    }
    if (spotlightMetrics) {
      spotlightMetrics.innerHTML = `
        <span class="oc-spotlight-pill"><span>${escapeHTML(init?.txt?.occupancyScoreLabel || "Service score")}</span>${fmt(score)}</span>
        <span class="oc-spotlight-pill"><span>${escapeHTML(init?.txt?.avgOccupancy || "Avg Occupancy")}</span>${fmt(avg)}%</span>
        <span class="oc-spotlight-pill"><span>${escapeHTML(init?.txt?.totalReservations || "Total Reservations")}</span>${fmt(summary.totalReservations || 0)}</span>
        <span class="oc-spotlight-pill"><span>${escapeHTML(init?.txt?.visibleSlotsMeta || "Visible slots")}</span>${fmt(visibleCount)}/${fmt(slots.length)}</span>
      `;
    }
    if (currentLoadEl) currentLoadEl.textContent = `${currentTime} • ${fmt(currentPct)}%`;
    if (currentRoomEl) currentRoomEl.textContent = topRoom ? `${topRoom.label || "—"} • ${fmt(topRoom.remainingPeople || 0)} ${init?.txt?.guestsLeftLabel || "Guests left"}` : "—";
    if (expectedGuestsEl) expectedGuestsEl.textContent = fmt(summary.totalGuests || 0);
    if (recoveryWatchEl) recoveryWatchEl.textContent = `${fmt(cancellations)} ${init?.txt?.cancelled || "Cancelled"} • ${fmt(noShow)} ${init?.txt?.noShow || "No-Show"}`;
  }

  function renderSlots() {
    if (!slotsRoot) return;
    rowHeader();
    $$(".oc-row", slotsRoot).forEach((el, i) => { if (i > 0) el.remove(); });
    if (!state.day) return;

    const allSlots = filteredSlots();
    const currentSlotTime = state.day?.currentTime?.time || state.systemTime.time;
    const matchSet = state.ui.searchMatchTimes;
    const frag = document.createDocumentFragment();

    for (const slot of allSlots) {
      const pct = Math.max(0, Math.min(100, Number(slot.percent || 0)));
      const fillColor = color(pct);
      const band = bandForPercent(pct);
      const remainingPeople = Math.max(0, Number(state.day.capacityPeople || 0) - Number(slot.people || 0));
      const remainingTables = Math.max(0, Number(state.day.capacityTables || 0) - Number(slot.tables || 0));
      const isCurrent = currentSlotTime && slot.time === currentSlotTime;
      const isMatch = matchSet instanceof Set ? matchSet.has(slot.time) : false;
      const isDim = matchSet instanceof Set && !isMatch;

      const row = document.createElement("div");
      row.className = "oc-row";
      row.dataset.time = slot.time;
      row.dataset.pct = String(pct);
      row.dataset.band = band.key;
      row.dataset.current = isCurrent ? "true" : "false";
      if (isCurrent) row.style.outline = `2px solid ${getCSS("--brand")}`;
      if (isMatch) row.classList.add("is-match");
      if (isDim) row.classList.add("is-dim");

      row.innerHTML = `
        <div class="oc-time">
          <span class="oc-time__main">${escapeHTML(slot.time)}</span>
          <span class="oc-time__sub">${escapeHTML(toAMPM(slot.time))}</span>
        </div>
        <div class="oc-load">
          <div class="oc-load__top">
            <div class="oc-load__title">${escapeHTML(init?.txt?.people || "People")} ${fmt(slot.people || 0)} · ${escapeHTML(init?.txt?.tables || "Tables")} ${fmt(slot.tables || 0)}</div>
            <span class="oc-tag ${band.className}">${escapeHTML(band.label)}</span>
          </div>
          <div class="oc-bar"><div class="fill" style="width:${pct}%;background:${fillColor}"></div></div>
          <div class="oc-load__meta">${fmt(pct)}% ${escapeHTML(init?.txt?.occupancy || "Occupancy")} ${isCurrent ? `• ${escapeHTML(init?.txt?.currentSlot || "Current slot")}` : ""}</div>
        </div>
        <div class="oc-availability">
          <div class="oc-stat">
            <span class="oc-stat__label">${escapeHTML(init?.txt?.leftGuests || "Guests left")}</span>
            <span class="oc-stat__value">${fmt(remainingPeople)}</span>
          </div>
          <div class="oc-stat">
            <span class="oc-stat__label">${escapeHTML(init?.txt?.leftTables || "Tables left")}</span>
            <span class="oc-stat__value">${fmt(remainingTables)}</span>
          </div>
        </div>
        <div class="oc-open" aria-hidden="true">
          <span>${escapeHTML(init?.txt?.openAction || "Open")}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg>
        </div>
      `;

      row.title = `${init?.txt?.people || "People"}: ${slot.people}/${state.day.capacityPeople} • ${init?.txt?.tables || "Tables"}: ${slot.tables}/${state.day.capacityTables} • ${pct}%`;
      row.addEventListener("click", () => openDrawer(slot.time));
      frag.appendChild(row);
    }

    slotsRoot.appendChild(frag);
    updateEmptyState(allSlots.length, Array.isArray(state.day.slots) ? state.day.slots.length : 0);
    updateHint(allSlots.length, Array.isArray(state.day.slots) ? state.day.slots.length : 0);
    renderDensityRail();
    renderBandGrid();
    renderPremiumPanels();
  }

  function renderSummary() {
    if (!summaryRoot) return;
    const s = state.summary;
    if (!s) {
      summaryRoot.textContent = init?.txt?.dailySummaryLoading || "Daily summary — loading…";
      return;
    }

    const avgPeople = Number(s.avgOccupancyPeople || s.occupancyPct || 0);
    const avgTables = Number(s.avgOccupancyTables || 0);
    summaryRoot.innerHTML = `
      <div class="oc-summary-grid">
        <article class="oc-summary-card">
          <div class="oc-summary-card__label">${escapeHTML(init?.txt?.totalReservations || "Total Reservations")}</div>
          <div class="oc-summary-card__value">${fmt(s.totalReservations || 0)}</div>
          <div class="oc-summary-card__sub">${escapeHTML(init?.txt?.summaryReservationsSub || "Reservations in this service window")}</div>
        </article>
        <article class="oc-summary-card">
          <div class="oc-summary-card__label">${escapeHTML(init?.txt?.totalGuests || "Total Guests")}</div>
          <div class="oc-summary-card__value">${fmt(s.totalGuests || 0)}</div>
          <div class="oc-summary-card__sub">${escapeHTML(init?.txt?.summaryGuestsSub || "Total expected guest count")}</div>
        </article>
        <article class="oc-summary-card">
          <div class="oc-summary-card__label">${escapeHTML(init?.txt?.avgOccupancy || "Avg Occupancy")}</div>
          <div class="oc-summary-card__value">${fmt(avgPeople)}%</div>
          <div class="oc-summary-card__sub">${escapeHTML(init?.txt?.people || "People")} ${fmt(avgPeople)}% · ${escapeHTML(init?.txt?.tables || "Tables")} ${fmt(avgTables)}%</div>
        </article>
        <article class="oc-summary-card">
          <div class="oc-summary-card__label">${escapeHTML(init?.txt?.peak || "Peak")}</div>
          <div class="oc-summary-card__value">${escapeHTML(s.peakSlot || "—")}</div>
          <div class="oc-summary-card__sub">${fmt(s.peakOccupancy || 0)}% ${escapeHTML(init?.txt?.summaryPeakSub || "peak utilization")}</div>
        </article>
        <article class="oc-summary-card">
          <div class="oc-summary-card__label">${escapeHTML(init?.txt?.cancelled || "Cancelled")} / ${escapeHTML(init?.txt?.noShow || "No-Show")}</div>
          <div class="oc-summary-card__value">${fmt(s.cancelled || 0)} / ${fmt(s.noShow || 0)}</div>
          <div class="oc-summary-card__sub">${escapeHTML(init?.txt?.summaryRecoverySub || "Watch these numbers before peak hours")}</div>
        </article>
      </div>
    `;

    updateSidebarSummary(s);
    renderKPIs();
    renderPremiumPanels();
  }

  function renderRoomOccupancy() {
    const rooms = state.day?.roomOccupancy || [];
    if (roomGraphTime) roomGraphTime.textContent = state.day?.currentTime?.time || state.systemTime.time || "—";
    if (!roomGraphBody) return;
    if (!rooms.length) {
      roomGraphBody.innerHTML = `<div class="muted">${escapeHTML(init?.txt?.noRoomData || "No room data")}</div>`;
      return;
    }
    roomGraphBody.innerHTML = rooms.map((room) => {
      const pct = Number(room.percent || 0);
      const col = pct >= 80 ? getCSS("--danger") : pct >= 50 ? getCSS("--warn") : getCSS("--ok");
      const remaining = Number(room.remainingPeople || 0);
      return `
        <div class="oc-room-row">
          <div class="oc-room-row__name">${escapeHTML(room.label || "—")}</div>
          <div class="oc-room-row__bar"><div class="oc-room-row__fill" style="width:${pct}%;background:${col}"></div></div>
          <div class="oc-room-row__meta">${fmt(remaining)} ${escapeHTML(init?.txt?.leftSuffix || "left")}</div>
        </div>
      `;
    }).join("");
    renderPremiumPanels();
  }

  function updateSidebarSummary(s) {
    if (!sideSumBox || !sideSumText || !sideSumBar || !s) return;
    const pct = Math.max(0, Math.min(100, Math.round(s.occupancyPct || s.avgOccupancyPeople || 0)));
    const ppl = s.people ?? s.totalGuests ?? 0;
    const tbl = s.tables ?? 0;
    sideSumText.textContent = `${init?.txt?.people || "People"} ${fmt(ppl)} · ${init?.txt?.tables || "Tables"} ${fmt(tbl)} · ${pct}%`;
    sideSumBar.style.width = `${pct}%`;
  }

  function renderDrawer(items) {
    if (!drawerTableBody) return;
    drawerTableBody.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const roomCell = item.roomLabel
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.25)">${escapeHTML(item.roomLabel)}</span>`
        : `<span style="color:var(--ink-muted,#9aa3b2)">—</span>`;
      const depositButtons = renderDepositButtons(item);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="${escapeHTML(init?.txt?.firstName || "First name")}">${escapeHTML(item.firstName || "")}</td>
        <td data-label="${escapeHTML(init?.txt?.lastName || "Last name")}">${escapeHTML(item.lastName || "")}</td>
        <td data-label="${escapeHTML(init?.txt?.partySize || "Party size")}">${Number(item.people || 0)}</td>
        <td data-label="${escapeHTML(init?.txt?.room || "Room")}">${roomCell}</td>
        <td data-label="${escapeHTML(init?.txt?.status || "Status")}">${badge(item.status || "")}${depositBadge(item.depositStatus, item.depositAmount, item.depositCurrency)}</td>
        <td data-label="${escapeHTML(init?.txt?.phone || "Phone")}"><a href="tel:${(item.phone || "").replace(/\s+/g, "")}">${escapeHTML(item.phone || "")}</a></td>
        <td data-label="${escapeHTML(init?.txt?.actions || "Actions")}">
          <button class="btn" data-act="arrived" data-id="${item.id}">${escapeHTML(init?.txt?.btnArrived || "Arrived")}</button>
          <button class="btn warn" data-act="cancel" data-id="${item.id}">${escapeHTML(init?.txt?.btnCancel || "Cancel")}</button>
          ${depositButtons}
        </td>
      `;
      frag.appendChild(tr);
    }
    drawerTableBody.appendChild(frag);

    $$('button[data-act="arrived"]', drawerTableBody).forEach((b) => b.addEventListener("click", () => slotAction("arrived", { id: b.dataset.id })));
    $$('button[data-act="cancel"]', drawerTableBody).forEach((b) => b.addEventListener("click", () => slotAction("cancel", { id: b.dataset.id })));
    $$('button[data-act="confirm_deposit"]', drawerTableBody).forEach((b) => b.addEventListener("click", () => slotAction("confirm_deposit", { id: b.dataset.id })));
    $$('button[data-act="refund_deposit"]', drawerTableBody).forEach((b) => b.addEventListener("click", () => slotAction("refund_deposit", { id: b.dataset.id })));
  }

  function depositBadge(depositStatus, depositAmount, depositCurrency) {
    if (!depositStatus || depositStatus === "not_required") return "";
    const symbols = { EUR: "€", GBP: "£", USD: "$" };
    const sym = symbols[depositCurrency] || "€";
    const amt = depositAmount ? (depositAmount / 100).toFixed(2) : "0.00";
    const labels = {
      pending: init?.txt?.depositPending || "Deposit Pending",
      received: init?.txt?.depositReceived || "Deposit Paid",
      refunded: init?.txt?.depositRefunded || "Refunded",
    };
    const classes = {
      pending: "deposit-pending",
      received: "deposit-paid",
      refunded: "deposit-refunded",
    };
    return ` <span class="badge ${classes[depositStatus] || ""}">${sym}${amt} ${labels[depositStatus] || depositStatus}</span>`;
  }

  function renderDepositButtons(item) {
    if (!item.depositStatus || item.depositStatus === "not_required") return "";
    if (item.depositStatus === "pending") return `<button class="btn ok" data-act="confirm_deposit" data-id="${item.id}">${escapeHTML(init?.txt?.btnConfirmDeposit || "Confirm deposit")}</button>`;
    if (item.depositStatus === "received") return `<button class="btn muted" data-act="refund_deposit" data-id="${item.id}">${escapeHTML(init?.txt?.btnRefundDeposit || "Refund")}</button>`;
    return "";
  }

  function badge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "new") return `<span class="badge booked">${escapeHTML(init?.txt?.statusNew || "New")}</span>`;
    if (["pending", "request", "requested", "tentative"].includes(s)) return `<span class="badge booked">${escapeHTML(init?.txt?.statusPending || "Pending")}</span>`;
    if (["booked", "hold", "on-hold", "invited"].includes(s)) return `<span class="badge booked">${escapeHTML(init?.txt?.statusBooked || "Booked")}</span>`;
    if (s === "approved") return `<span class="badge approved">${escapeHTML(init?.txt?.statusApproved || "Approved")}</span>`;
    if (s === "confirmed") return `<span class="badge approved">${escapeHTML(init?.txt?.statusConfirmed || "Confirmed")}</span>`;
    if (s === "arrived") return `<span class="badge arrived">${escapeHTML(init?.txt?.statusArrived || "Arrived")}</span>`;
    if (["cancelled", "canceled", "rejected", "declined"].includes(s)) return `<span class="badge cancelled">${escapeHTML(init?.txt?.statusCancelled || "Cancelled")}</span>`;
    return `<span class="badge booked">${escapeHTML(status || "Booked")}</span>`;
  }

  function openDrawer(hhmm) {
    state.drawer.time = hhmm;
    if (drawerTitle) drawerTitle.textContent = `${init?.txt?.customersAt || "Customers"} ${toAMPM(hhmm)}`;
    setOpen(drawer, true);
    state.drawer.open = true;
    loadSlot();
  }

  function closeDrawer() {
    setOpen(drawer, false);
    state.drawer.open = false;
    state.drawer.time = null;
  }

  async function loadDay() {
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day?date=${encodeURIComponent(state.date)}`;
    state.day = await fetchJSON(url);
    if (state.day?.currentTime) {
      state.systemTime.date = state.day.currentTime.sourceDate || state.day.currentTime.date || state.systemTime.date;
      state.systemTime.time = state.day.currentTime.time || state.systemTime.time;
      if (systemDateInput) systemDateInput.value = state.systemTime.date;
      if (systemTimeInput) systemTimeInput.value = state.systemTime.time;
      if (systemPreview) systemPreview.textContent = `${state.systemTime.time}`;
    }
    renderHeaderLine();
    renderSlots();
    renderRoomOccupancy();
    renderKPIs();
    if (datePicker) datePicker.value = state.date;
    const d = isoToDate(state.date);
    if (dateLabel) dateLabel.textContent = fmtDate(d, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    if (state.cal.year !== d.getFullYear() || state.cal.month !== d.getMonth()) {
      state.cal.year = d.getFullYear();
      state.cal.month = d.getMonth();
    }
    buildCalendar(state.cal.year, state.cal.month);
  }

  async function loadSummary() {
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/summary?date=${encodeURIComponent(state.date)}`;
    state.summary = await fetchJSON(url);
    renderSummary();
  }

  async function loadSlot() {
    if (!state.drawer.time) return;
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot?date=${encodeURIComponent(state.date)}&time=${encodeURIComponent(state.drawer.time)}`;
    const data = await fetchJSON(url);
    state.drawer.items = data.items || [];
    renderDrawer(state.drawer.items);
  }

  async function slotAction(action, reservation = {}) {
    if (!state.drawer.time) return;
    const qs = new URLSearchParams({
      action,
      date: state.date,
      time: state.drawer.time,
      reservation: JSON.stringify(reservation),
    });
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot?${qs.toString()}`;
    const body = JSON.stringify({ action, date: state.date, time: state.drawer.time, reservation });
    try {
      await fetchJSON(url, { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body });
    } catch {
      await fetchJSON(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body });
    }
    await Promise.all([loadSlot(), loadDay(), loadSummary()]);
  }

  async function createManual() {
    if (!state.drawer.time) return;
    const firstName = prompt(init?.txt?.promptFirstName || "First name:") || "";
    const lastName = prompt(init?.txt?.promptLastName || "Last name:") || "";
    if (!firstName && !lastName) return;
    const phone = prompt(init?.txt?.promptPhone || "Phone (optional):") || "";
    const people = Math.max(1, parseInt(prompt(init?.txt?.promptPartySize || "Party size:", "2") || "2", 10));
    const notes = prompt(init?.txt?.promptNotes || "Notes (optional):") || "";
    await slotAction("create", { firstName, lastName, phone, people, notes, status: "booked" });
  }

  async function searchInDay(q) {
    if (!q) {
      state.ui.searchMatchTimes = null;
      renderSlots();
      return;
    }
    const data = await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/search?date=${encodeURIComponent(state.date)}&q=${encodeURIComponent(q)}`);
    const times = new Set((data.items || []).map((x) => x.time).filter(Boolean));
    state.ui.searchMatchTimes = times;
    renderSlots();
    const first = (data.items || [])[0];
    if (first && first.time) openDrawer(first.time);
  }

  function connectSSE() {
    cleanupSSE();
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/events?date=${encodeURIComponent(state.date)}`;
    let es;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      schedulePolling();
      return;
    }
    state.sse.es = es;

    const onRefresh = (e) => {
      try {
        const data = JSON.parse(e.data || "{}");
        Promise.all([loadDay(), loadSummary()]).then(() => {
          const t = data.time;
          if (state.drawer.open && t && state.drawer.time === t) loadSlot();
        });
      } catch {
        // ignore malformed events
      }
    };

    es.addEventListener("hello", () => {});
    es.addEventListener("ping", () => {});
    es.addEventListener("reservation_create", onRefresh);
    es.addEventListener("reservation_update", onRefresh);
    es.addEventListener("reservation_cancel", onRefresh);
    es.addEventListener("reservation_arrived", onRefresh);
    es.onerror = () => {
      cleanupSSE();
      scheduleReconnect();
    };
  }

  function cleanupSSE() {
    if (state.sse.es) { try { state.sse.es.close(); } catch {} state.sse.es = null; }
    if (state.sse.pollTimer) { clearInterval(state.sse.pollTimer); state.sse.pollTimer = null; }
  }

  function scheduleReconnect() {
    setTimeout(() => { try { connectSSE(); } catch { schedulePolling(); } }, state.sse.retryMs);
  }

  function schedulePolling() {
    cleanupSSE();
    state.sse.pollTimer = setInterval(() => {
      Promise.all([loadDay(), loadSummary()]).catch(() => {});
    }, 15000);
  }

  if (calWk) {
    const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const weekdayStart = new Date(2024, 0, 7);
    calWk.innerHTML = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekdayStart);
      d.setDate(weekdayStart.getDate() + i);
      return `<th>${escapeHTML(weekdayFmt.format(d))}</th>`;
    }).join("");
  }

  function buildCalendar(year, month) {
    if (!calBody || !calTitle) return;
    const ref = new Date(year, month, 1);
    calTitle.textContent = fmtDate(ref, { year: "numeric", month: "long" });
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const selected = isoToDate(state.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rows = [];
    let cur = new Date(start);
    for (let r = 0; r < 6; r++) {
      const tds = [];
      for (let c = 0; c < 7; c++) {
        const inMonth = cur.getMonth() === month;
        const isSel = cur.getFullYear() === selected.getFullYear() && cur.getMonth() === selected.getMonth() && cur.getDate() === selected.getDate();
        const isToday = cur.getFullYear() === today.getFullYear() && cur.getMonth() === today.getMonth() && cur.getDate() === today.getDate();
        const classes = [inMonth ? "" : "out", isToday ? "today" : "", isSel ? "sel" : ""].filter(Boolean).join(" ");
        const iso = ymd(cur);
        tds.push(`<td><button class="${classes}" data-iso="${iso}" title="${iso}">${cur.getDate()}</button></td>`);
        cur.setDate(cur.getDate() + 1);
      }
      rows.push(`<tr>${tds.join("")}</tr>`);
    }
    calBody.innerHTML = rows.join("");

    $$("button", calBody).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const iso = btn.getAttribute("data-iso");
        if (!iso) return;
        state.date = iso;
        await Promise.all([loadDay(), loadSummary()]);
        connectSSE();
      });
    });
  }

  if (calPrev) calPrev.addEventListener("click", () => {
    let { year, month } = state.cal;
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    state.cal = { year, month };
    buildCalendar(year, month);
  });

  if (calNext) calNext.addEventListener("click", () => {
    let { year, month } = state.cal;
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    state.cal = { year, month };
    buildCalendar(year, month);
  });

  async function applySystemTime(mode) {
    const body = mode === "reset" ? { mode: "reset" } : { date: systemDateInput?.value, time: systemTimeInput?.value };
    const data = await fetchJSON(`/api/restaurants/${encodeURIComponent(state.rid)}/system-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    state.systemTime.date = data.date || state.systemTime.date;
    state.systemTime.time = data.time || state.systemTime.time;
    if (systemPreview) systemPreview.textContent = `${state.systemTime.time}`;
    if (systemStatus) systemStatus.textContent = mode === "reset" ? (init?.txt?.usingRealTime || "Using real time now.") : (init?.txt?.syncedAll || "Restaurant time updated for all connected systems.");
    if (!datePicker || !datePicker.value || state.date === (init.date || todayISO())) {
      state.date = state.systemTime.date;
      if (datePicker) datePicker.value = state.date;
    }
    await Promise.all([loadDay(), loadSummary()]);
    connectSSE();
  }

  function setOccupancyFilter(filter) {
    state.ui.occupancyFilter = filter;
    $$(".oc-filter", filtersRoot || document).forEach((btn) => btn.classList.toggle("is-active", btn.dataset.filter === filter));
    renderSlots();
    renderBandGrid();
  }

  function jumpToCurrentSlot() {
    const row = $(`.oc-row[data-current="true"]`, slotsRoot || document);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function wire() {
    if (btnPrev) btnPrev.addEventListener("click", async () => {
      state.date = addDays(state.date, -1);
      if (datePicker) datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (btnNext) btnNext.addEventListener("click", async () => {
      state.date = addDays(state.date, +1);
      if (datePicker) datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (datePicker) datePicker.addEventListener("change", async () => {
      state.date = datePicker.value;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (daySearch) daySearch.addEventListener("input", debounce(() => searchInDay(daySearch.value.trim()), 250));
    if (sideSearch) sideSearch.addEventListener("input", debounce(() => {
      const v = sideSearch.value || "";
      if (daySearch) daySearch.value = v;
      searchInDay(v.trim());
    }, 250));

    if (filtersRoot) {
      $$(".oc-filter", filtersRoot).forEach((btn) => {
        btn.addEventListener("click", () => setOccupancyFilter(btn.dataset.filter || "all"));
      });
    }

    if (btnJumpNow) btnJumpNow.addEventListener("click", jumpToCurrentSlot);
    if (btnOpenCurrentSlot) btnOpenCurrentSlot.addEventListener("click", () => {
      const current = findCurrentSlot();
      if (current?.time) focusSlot(current.time, { open: true });
    });
    if (btnOpenNextPeak) btnOpenNextPeak.addEventListener("click", () => {
      const slots = Array.isArray(state.day?.slots) ? state.day.slots : [];
      const current = findCurrentSlot();
      const future = slots.filter((slot) => timeToMinutes(slot.time) >= timeToMinutes(current?.time || state.systemTime.time || "00:00"));
      const peak = (future.length ? future : slots).reduce((best, slot) => Number(slot.percent || 0) > Number(best?.percent || -1) ? slot : best, null);
      if (peak?.time) focusSlot(peak.time, { open: true });
    });

    if (systemApplyBtn) systemApplyBtn.addEventListener("click", async () => {
      if (!systemDateInput?.value || !systemTimeInput?.value) {
        alert(init?.txt?.pickBoth || "Please choose both date and time.");
        return;
      }
      await applySystemTime("set");
    });

    if (systemNowBtn) systemNowBtn.addEventListener("click", async () => {
      await applySystemTime("reset");
    });

    if (drawerClose) drawerClose.addEventListener("click", closeDrawer);
    if (btnAdd) btnAdd.addEventListener("click", createManual);
    if (drawerSearch) drawerSearch.addEventListener("input", () => {
      const q = drawerSearch.value.trim().toLowerCase();
      $$("#drawer-table tbody tr").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.drawer.open) closeDrawer();
    });
  }

  function initMonthFromSelected() {
    const d = isoToDate(state.date);
    state.cal.year = d.getFullYear();
    state.cal.month = d.getMonth();
  }

  async function initApp() {
    if (datePicker) datePicker.value = state.date;
    initMonthFromSelected();
    wire();
    buildCalendar(state.cal.year, state.cal.month);
    renderKPIs();
    renderBandGrid();
    renderDensityRail();
    renderPremiumPanels();
    await Promise.all([loadDay(), loadSummary()]);
    connectSSE();
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
