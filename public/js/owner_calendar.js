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
    agenda: null,
    summary: null,
    drawer: { open: false, time: null, items: [] },
    sse: { es: null, retryMs: 1500, pollTimer: null },
    cal: { year: 0, month: 0 },
    systemTime: { date: init.systemNowDate || init.date || todayISO(), time: init.systemNowTime || "12:00" },
    ui: { occupancyFilter: "all", searchMatchTimes: null, view: "day", statusFilter: "all" },
  };

  const viewButtons = Array.from(document.querySelectorAll("[data-calendar-view]"));
  const agendaPanel = $("#oc-agenda");
  const agendaRows = $("#oc-agenda-rows");
  const agendaStatus = $("#oc-agenda-status");
  const waitlistPanel = $("#oc-waitlist");
  const waitlistForm = $("#oc-waitlist-form");
  const waitlistRows = $("#oc-waitlist-rows");
  const waitlistCount = $("#oc-waitlist-count");
  const waitlistDate = $("#oc-waitlist-date");
  const waitlistFeedback = $("#oc-waitlist-feedback");
  let waitlistRequest = 0;
  const weekPanel = $("#oc-week");
  const weekGrid = $("#oc-week-grid");
  const monthPanel = $("#oc-month");
  const monthGrid = $("#oc-month-grid");
  const monthTitle = $("#oc-month-title");
  const monthPrev = $("#oc-month-prev");
  const monthNext = $("#oc-month-next");
  let monthRequest = 0;
  let weekRequest = 0;
  let weekCache = null;
  let agendaRequest = 0;
  const weekModeButtons = Array.from(document.querySelectorAll("[data-week-mode]"));
  const weekIntervalSelect = $("#oc-week-interval");
  function restoreWeekOptions() {
    try {
      const saved = JSON.parse(localStorage.getItem(viewStoreKey) || "null");
      return {
        mode: ["columns", "timeline"].includes(saved?.weekMode) ? saved.weekMode : "columns",
        minutes: saved?.displayMinutes === 15 ? 15 : 30,
      };
    } catch { return { mode: "columns", minutes: 30 }; }
  }
  function persistCalendarOptions() {
    try {
      localStorage.setItem(viewStoreKey, JSON.stringify({
        view: state.ui.view, weekMode: state.ui.weekMode,
        displayMinutes: state.ui.displayMinutes,
      }));
    } catch { /* storage may be unavailable */ }
  }
  const deviceClass = window.matchMedia && window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";
  const viewStoreKey = ["spotbook", "calendar-v2", init.userId || "owner", state.rid, deviceClass].join(":");

  function restoreView() {
    try {
      const saved = JSON.parse(localStorage.getItem(viewStoreKey) || "null");
      return saved && ["day", "list", "week", "month"].includes(saved.view) ? saved.view : (deviceClass === "mobile" ? "list" : "day");
    } catch { return deviceClass === "mobile" ? "list" : "day"; }
  }

  const weekOptions = restoreWeekOptions();
  state.ui.weekMode = weekOptions.mode;
  state.ui.displayMinutes = weekOptions.minutes;
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

  function waitlistMessage(message) {
    if (waitlistFeedback) waitlistFeedback.textContent = message;
  }

  function renderWaitlist(data) {
    if (!waitlistRows) return;
    waitlistRows.textContent = "";
    const items = data.items || [];
    if (waitlistCount) waitlistCount.textContent = String((data.waiting || 0) + (data.offered || 0));
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "oc-waitlist__empty";
      empty.textContent = lang === "he" ? "אין בקשות המתנה ביום הזה" : "No waitlist requests for this day";
      waitlistRows.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("article");
      row.className = "oc-waitlist__item";
      if (["cancelled", "converted"].includes(item.status)) row.classList.add("is-closed");
      const description = document.createElement("div");
      description.className = "oc-waitlist__person";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const details = document.createElement("small");
      details.textContent = [item.time, item.people + (lang === "he" ? " סועדים" : " guests"),
        item.area, item.status].filter(Boolean).join(" · ");
      description.append(name, details);
      if (item.note) {
        const note = document.createElement("small");
        note.textContent = item.note;
        description.appendChild(note);
      }
      const actions = document.createElement("div");
      actions.className = "oc-waitlist__actions";
      if (item.phone) {
        const call = document.createElement("a");
        call.href = "tel:" + item.phone.replace(/[^\d+]/g, "");
        call.textContent = lang === "he" ? "התקשר" : "Call";
        actions.appendChild(call);
      }
      if (["waiting", "offered"].includes(item.status)) {
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = item.status === "waiting"
          ? (lang === "he" ? "סמן כטופל" : "Mark contacted")
          : (lang === "he" ? "החזר להמתנה" : "Back to waiting");
        action.addEventListener("click", () => {
          void changeWaitlistStatus(item, item.status === "waiting" ? "offered" : "waiting");
        });
        actions.appendChild(action);
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "oc-waitlist__cancel";
        cancel.textContent = lang === "he" ? "בטל בקשה" : "Cancel request";
        cancel.addEventListener("click", () => {
          if (window.confirm(lang === "he" ? "לבטל את בקשת ההמתנה?" : "Cancel this waitlist request?")) {
            void changeWaitlistStatus(item, "cancelled");
          }
        });
        actions.appendChild(cancel);
      }
      row.append(description, actions);
      waitlistRows.appendChild(row);
    }
  }

  async function loadWaitlist() {
    if (!waitlistRows) return;
    const request = ++waitlistRequest;
    const date = state.date;
    if (waitlistDate) waitlistDate.textContent = date;
    if (waitlistCount) waitlistCount.textContent = "…";
    waitlistRows.textContent = lang === "he" ? "טוען רשימת המתנה…" : "Loading waitlist…";
    try {
      const data = await fetchJSON("/owner/restaurants/" + encodeURIComponent(state.rid) +
        "/calendar/waitlist?date=" + encodeURIComponent(date));
      if (request !== waitlistRequest || state.date !== date) return;
      renderWaitlist(data);
    } catch {
      if (request === waitlistRequest && state.date === date) {
        if (waitlistCount) waitlistCount.textContent = "!";
        waitlistRows.textContent = lang === "he"
          ? "לא ניתן לטעון את רשימת ההמתנה כרגע"
          : "Could not load the waitlist";
      }
    }
  }

  async function changeWaitlistStatus(item, status) {
    waitlistMessage("");
    try {
      await fetchJSON("/owner/restaurants/" + encodeURIComponent(state.rid) +
        "/calendar/waitlist/" + encodeURIComponent(item.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ date: item.date, status }),
      });
      if (state.date === item.date) await loadWaitlist();
    } catch {
      waitlistMessage(lang === "he" ? "לא ניתן לעדכן. רענן את הרשימה ונסה שוב." :
        "Could not update this entry. Refresh the list and retry.");
    }
  }

  function renderAgenda() {
    if (!agendaRows) return;
    if (!state.agenda || state.agenda.date !== state.date) {
      agendaRows.textContent = lang === "he" ? "טוען הזמנות…" : "Loading reservations…";
      return;
    }
    const query = String(daySearch?.value || "").trim().toLowerCase();
    const statusFilter = state.ui.statusFilter;
    const normalized = (s) => {
      const value = String(s || "").toLowerCase();
      if (["canceled", "rejected", "declined"].includes(value)) return "cancelled";
      if (["approved", "booked", "hold", "on-hold", "invited"].includes(value)) return "confirmed";
      if (["request", "requested", "tentative"].includes(value)) return "pending";
      if (value === "noshow" || value === "no-show") return "no_show";
      return value;
    };
    const items = (state.agenda.items || []).filter((item) => {
      if (statusFilter !== "all" && normalized(item.status) !== statusFilter) return false;
      return !query || [item.firstName, item.lastName, item.phone, item.roomLabel, item.occasion]
        .some((part) => String(part || "").toLowerCase().includes(query));
    });
    agendaRows.textContent = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "oc-agenda__empty";
      empty.textContent = lang === "he" ? "אין הזמנות התואמות לבחירה" : "No reservations match this selection";
      agendaRows.appendChild(empty);
      return;
    }
    for (const item of items) {
      const status = normalized(item.status);
      const isBlocked = status === "blocked";
      const statusTone = ["cancelled", "no_show"].includes(status) ? "danger"
        : status === "arrived" ? "arrived" : status === "confirmed" ? "confirmed"
        : isBlocked ? "blocked" : "new";
      const label = [item.firstName, item.lastName].filter(Boolean).join(" ") ||
        (isBlocked ? (lang === "he" ? "שעה חסומה" : "Blocked time") : (lang === "he" ? "אורח" : "Guest"));
      const meta = [
        item.people > 0 ? `${Number(item.people)} ${lang === "he" ? "סועדים" : "guests"}` : "",
        item.roomLabel || "",
        item.occasion || "",
      ].filter(Boolean).join(" · ");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "oc-agenda__item";
      row.innerHTML = `<time class="oc-agenda__time">${escapeHTML(item.time || "—")}</time>
        <span class="oc-agenda__person"><strong>${escapeHTML(label)}</strong>
        <small>${escapeHTML(meta)}</small></span>
        <span class="oc-agenda__status oc-agenda__status--${statusTone}">${escapeHTML(item.status || "new")}</span>
        <span class="oc-agenda__arrow" aria-hidden="true">↗</span>`;
      row.addEventListener("click", () => { if (/^\d{2}:\d{2}$/.test(item.time || "")) openDrawer(item.time); });
      agendaRows.appendChild(row);
    }
  }

  async function loadAgenda() {
    if (state.ui.view !== "list") return;
    const selected = state.date;
    const request = ++agendaRequest;
    state.agenda = null;
    renderAgenda();
    try {
      const data = await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/agenda?date=${encodeURIComponent(selected)}`);
      if (request !== agendaRequest || state.date !== selected || state.ui.view !== "list") return;
      state.agenda = data;
      renderAgenda();
    } catch {
      if (request === agendaRequest && state.date === selected && state.ui.view === "list" && agendaRows) {
        agendaRows.textContent = lang === "he" ? "טעינת ההזמנות נכשלה. נסה לרענן את העמוד." : "Could not load reservations. Try refreshing.";
      }
    }
  }

  async function openWeekDay(date, time = "") {
    state.date = date;
    if (datePicker) datePicker.value = date;
    setCalendarView("day");
    await Promise.all([loadDay(), loadSummary()]);
    connectSSE();
    if (/^\d{2}:\d{2}$/.test(time)) openDrawer(time);
  }

  function createWeekHeading(date) {
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "oc-week__heading";
    heading.textContent = fmtDate(isoToDate(date), { weekday: "short", month: "short", day: "numeric" });
    heading.addEventListener("click", () => { void openWeekDay(date); });
    return heading;
  }

  function weekItemButton(date, item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oc-week__booking";
    const name = [item.firstName, item.lastName].filter(Boolean).join(" ") ||
      (String(item.status || "").toLowerCase() === "blocked"
        ? (lang === "he" ? "שעה חסומה" : "Blocked time")
        : (lang === "he" ? "הזמנה" : "Reservation"));
    const time = String(item.time || "");
    const guests = Number(item.people || 0);
    button.setAttribute("aria-label", [time, name, guests > 0 ? guests + " guests" : "", item.status].filter(Boolean).join(", "));
    const timeNode = document.createElement("time");
    timeNode.textContent = time || "—";
    const nameNode = document.createElement("strong");
    nameNode.textContent = name;
    const metaNode = document.createElement("small");
    metaNode.textContent = [guests > 0 ? String(guests) : "", item.status || ""].filter(Boolean).join(" · ");
    button.append(timeNode, nameNode, metaNode);
    const status = String(item.status || "").toLowerCase();
    if (["cancelled", "canceled", "no-show", "noshow", "no_show"].includes(status)) {
      button.classList.add("is-inactive");
    } else if (status === "blocked") button.classList.add("is-blocked");
    else if (["arrived", "confirmed", "approved"].includes(status)) button.classList.add("is-confirmed");
    button.addEventListener("click", () => { void openWeekDay(date, time); });
    return button;
  }

  function renderWeekTimeline(dates, results) {
    if (!weekGrid) return;
    const dayItems = results.map((result) =>
      result.status === "fulfilled" ? (result.value.items || []).filter((item) =>
        /^\d{2}:\d{2}$/.test(String(item.time || ""))) : []);
    const allItems = dayItems.flat();
    const firstBooking = allItems.length ? Math.min(...allItems.map((item) => timeToMinutes(item.time))) : 11 * 60;
    const lastBooking = allItems.length ? Math.max(...allItems.map((item) =>
      timeToMinutes(item.time) + Math.max(15, Number(item.durationMinutes) || 60))) : 22 * 60;
    const firstMinute = Math.max(0, Math.min(11 * 60, Math.floor(firstBooking / 60) * 60));
    const lastMinute = Math.min(24 * 60, Math.max(22 * 60, Math.ceil(lastBooking / 60) * 60));
    const step = state.ui.displayMinutes;
    const heightPerStep = step === 15 ? 32 : 46;
    const ppm = heightPerStep / step;
    const fullHeight = (lastMinute - firstMinute) * ppm;
    const tick = (minute) => String(Math.floor(minute / 60)).padStart(2, "0") +
      ":" + String(minute % 60).padStart(2, "0");

    weekGrid.className = "oc-week__grid oc-week__grid--timeline";
    const axis = document.createElement("div");
    axis.className = "oc-week__axis";
    const axisHeader = document.createElement("div");
    axisHeader.className = "oc-week__axis-header";
    axisHeader.textContent = lang === "he" ? "שעה" : "Time";
    axis.appendChild(axisHeader);
    const axisBody = document.createElement("div");
    axisBody.className = "oc-week__axis-body";
    axisBody.style.height = fullHeight + "px";
    for (let minute = firstMinute; minute < lastMinute; minute += step) {
      const label = document.createElement("span");
      label.className = "oc-week__tick";
      label.textContent = tick(minute);
      label.style.top = (minute - firstMinute) * ppm + "px";
      axisBody.appendChild(label);
    }
    axis.appendChild(axisBody);
    weekGrid.appendChild(axis);

    dates.forEach((date, index) => {
      const column = document.createElement("section");
      column.className = "oc-week__track";
      column.appendChild(createWeekHeading(date));
      const canvas = document.createElement("div");
      canvas.className = "oc-week__canvas";
      canvas.style.height = fullHeight + "px";
      canvas.style.setProperty("--week-step-height", heightPerStep + "px");
      if (results[index].status !== "fulfilled") {
        const error = document.createElement("p");
        error.className = "oc-week__empty";
        error.textContent = lang === "he" ? "לא ניתן לטעון" : "Could not load";
        canvas.appendChild(error);
      } else {
        // Overlap lanes keep simultaneous reservations visible. The interval
        // choice changes only pixel spacing, never restaurant booking rules.
        const bookings = dayItems[index].map((item) => ({
          item,
          start: timeToMinutes(item.time),
          end: timeToMinutes(item.time) + Math.max(15, Number(item.durationMinutes) || 60),
        })).sort((a, b) => a.start - b.start || a.end - b.end);
        const clusters = [];
        let cluster = [], clusterEnd = -1;
        for (const item of bookings) {
          if (cluster.length && item.start >= clusterEnd) {
            clusters.push(cluster);
            cluster = [];
          }
          cluster.push(item);
          clusterEnd = Math.max(clusterEnd, item.end);
        }
        if (cluster.length) clusters.push(cluster);
        for (const group of clusters) {
          const lanes = [];
          for (const booking of group) {
            let lane = lanes.findIndex((until) => until <= booking.start);
            if (lane === -1) lane = lanes.length;
            lanes[lane] = booking.end;
            booking.lane = lane;
          }
          for (const booking of group) {
            const button = weekItemButton(date, booking.item);
            const top = (booking.start - firstMinute) * ppm;
            const visible = Math.max(15, Math.min(booking.end, lastMinute) - booking.start);
            button.style.top = Math.max(0, top) + "px";
            button.style.height = Math.max(26, visible * ppm - 3) + "px";
            button.style.left = booking.lane * 100 / lanes.length + "%";
            button.style.width = 100 / lanes.length + "%";
            canvas.appendChild(button);
          }
        }
      }
      column.appendChild(canvas);
      weekGrid.appendChild(column);
    });
  }

  function renderWeekResults(dates, results, selected) {
    if (!weekGrid || state.date !== selected || state.ui.view !== "week") return;
    weekGrid.textContent = "";
    if (state.ui.weekMode === "timeline") {
      renderWeekTimeline(dates, results);
      return;
    }
    weekGrid.className = "oc-week__grid";
    dates.forEach((date, i) => {
      const result = results[i];
      const card = document.createElement("section");
      card.className = "oc-week__day";
      card.appendChild(createWeekHeading(date));
      if (result.status !== "fulfilled") {
        const error = document.createElement("p");
        error.className = "oc-week__empty";
        error.textContent = lang === "he" ? "לא ניתן לטעון" : "Could not load";
        card.appendChild(error);
      } else {
        const items = result.value.items || [];
        const count = document.createElement("small");
        count.className = "oc-week__count";
        count.textContent = items.length + " " + (lang === "he" ? "הזמנות" : "reservations");
        card.appendChild(count);
        for (const item of items) card.appendChild(weekItemButton(date, item));
      }
      weekGrid.appendChild(card);
    });
  }

  async function loadWeek() {
    if (!weekGrid || state.ui.view !== "week") return;
    const request = ++weekRequest;
    const selected = state.date;
    const anchor = isoToDate(selected);
    const weekday = (anchor.getDay() + 6) % 7;
    const start = addDays(selected, -weekday);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    if (weekCache?.start === start && weekCache.selected === selected) {
      renderWeekResults(weekCache.dates, weekCache.results, selected);
      return;
    }
    weekGrid.textContent = lang === "he" ? "טוען שבוע…" : "Loading week…";
    const results = await Promise.allSettled(dates.map((date) =>
      fetchJSON("/owner/restaurants/" + encodeURIComponent(state.rid) +
        "/calendar/agenda?date=" + encodeURIComponent(date))
    ));
    if (request !== weekRequest || state.date !== selected || state.ui.view !== "week") return;
    // A partial failure should be retried on next visit instead of cached.
    weekCache = results.every((result) => result.status === "fulfilled")
      ? { start, selected, dates, results } : null;
    renderWeekResults(dates, results, selected);
  }

  async function loadMonth() {
    if (!monthGrid || state.ui.view !== "month") return;
    const request = ++monthRequest;
    const selected = state.date;
    const month = selected.slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number);
    const first = new Date(year, monthNumber - 1, 1);
    const count = new Date(year, monthNumber, 0).getDate();
    if (monthTitle) monthTitle.textContent = fmtDate(first, { month: "long", year: "numeric" });
    monthGrid.textContent = lang === "he" ? "טוען חודש…" : "Loading month…";
    try {
      const data = await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/month?month=${encodeURIComponent(month)}`);
      if (request !== monthRequest || state.date !== selected || state.ui.view !== "month") return;
      monthGrid.textContent = "";
      const weekdays = lang === "he" ? ["ב", "ג", "ד", "ה", "ו", "ש", "א"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      weekdays.forEach((name) => {
        const cell = document.createElement("span");
        cell.className = "oc-month__weekday";
        cell.textContent = name;
        monthGrid.appendChild(cell);
      });
      const offset = (first.getDay() + 6) % 7;
      for (let i = 0; i < offset; i++) {
        const spacer = document.createElement("span");
        spacer.className = "oc-month__spacer";
        spacer.setAttribute("aria-hidden", "true");
        monthGrid.appendChild(spacer);
      }
      const byDate = new Map((data.days || []).map((day) => [day.date, day]));
      for (let day = 1; day <= count; day++) {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const item = byDate.get(date) || { reservations: 0, guests: 0 };
        const button = document.createElement("button");
        button.type = "button";
        button.className = "oc-month__day" + (date === selected ? " is-selected" : "");
        button.innerHTML = `<strong>${day}</strong><span>${Number(item.reservations || 0)} ${lang === "he" ? "הזמנות" : "bookings"}</span><small>${Number(item.guests || 0)} ${lang === "he" ? "סועדים" : "guests"}</small>`;
        button.setAttribute("aria-label", `${date}: ${Number(item.reservations || 0)} ${lang === "he" ? "הזמנות" : "bookings"}`);
        button.addEventListener("click", async () => {
          state.date = date;
          if (datePicker) datePicker.value = date;
          setCalendarView(deviceClass === "mobile" ? "list" : "day");
          await Promise.all([loadDay(), loadSummary()]);
          connectSSE();
        });
        monthGrid.appendChild(button);
      }
    } catch {
      if (request === monthRequest && state.ui.view === "month" && state.date === selected) {
        monthGrid.textContent = lang === "he" ? "טעינת החודש נכשלה. נסה שוב." : "Could not load the month. Please try again.";
      }
    }
  }

  async function moveCalendarMonth(delta) {
    if (state.ui.view !== "month") return;
    const [year, month] = state.date.slice(0, 7).split("-").map(Number);
    const target = new Date(year, month - 1 + delta, 1);
    const targetYear = target.getFullYear();
    const targetMonth = String(target.getMonth() + 1).padStart(2, "0");
    const targetDay = Math.min(Number(state.date.slice(8)), new Date(targetYear, target.getMonth() + 1, 0).getDate());
    state.date = `${targetYear}-${targetMonth}-${String(targetDay).padStart(2, "0")}`;
    if (datePicker) datePicker.value = state.date;
    await Promise.all([loadDay(), loadSummary()]);
    connectSSE();
  }

  function setCalendarView(next) {
    if (!["day", "list", "week", "month"].includes(next)) return;
    state.ui.view = next;
    document.body.classList.toggle("oc-calendar-list-mode", next === "list");
    if (next !== "list") ++agendaRequest;
    if (agendaPanel) agendaPanel.hidden = next !== "list";
    if (weekPanel) weekPanel.hidden = next !== "week";
    if (monthPanel) monthPanel.hidden = next !== "month";
    document.body.classList.toggle("oc-calendar-week-mode", next === "week");
    if (next !== "week") ++weekRequest;
    if (next !== "month") ++monthRequest;
    document.body.classList.toggle("oc-calendar-month-mode", next === "month");
    viewButtons.forEach((button) => {
      const selected = button.dataset.calendarView === next;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    persistCalendarOptions();
    if (next === "list") {
      if (state.agenda?.date === state.date) renderAgenda();
      else void loadAgenda();
    }
    if (next === "week") {
      weekModeButtons.forEach((button) => {
        const active = button.dataset.weekMode === state.ui.weekMode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      if (weekIntervalSelect) weekIntervalSelect.value = String(state.ui.displayMinutes);
      void loadWeek();
    }
    if (next === "month") void loadMonth();
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
      const guestChips = occasionDietaryChips(item);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="${escapeHTML(init?.txt?.firstName || "First name")}">${escapeHTML(item.firstName || "")}${guestChips}</td>
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

  function occasionDietaryChips(item) {
    const occasionMeta = {
      birthday:    { emoji: "🎂", label: init?.txt?.occasionBirthday || "Birthday" },
      anniversary: { emoji: "💍", label: init?.txt?.occasionAnniversary || "Anniversary" },
      date:        { emoji: "❤️", label: init?.txt?.occasionDate || "Date night" },
      business:    { emoji: "💼", label: init?.txt?.occasionBusiness || "Business meal" },
      celebration: { emoji: "🎉", label: init?.txt?.occasionCelebration || "Celebration" },
      other:       { emoji: "✨", label: init?.txt?.occasionOther || "Other" },
    };
    const dietaryMeta = {
      vegetarian:  init?.txt?.dietaryVegetarian || "Vegetarian",
      vegan:       init?.txt?.dietaryVegan || "Vegan",
      gluten_free: init?.txt?.dietaryGlutenFree || "Gluten-free",
      kosher:      init?.txt?.dietaryKosher || "Kosher",
      halal:       init?.txt?.dietaryHalal || "Halal",
      allergies:   init?.txt?.dietaryAllergies || "Allergies",
    };
    const chips = [];
    const visits = Number(item.visitCount || 0);
    if (visits >= 2) {
      const tpl = init?.txt?.returningGuest || "Returning guest · visit {n}";
      const label = tpl.replace("{n}", String(visits));
      chips.push(`<span title="${escapeHTML(label)}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(198,162,48,.18);color:#C6A230;border:1px solid rgba(198,162,48,.35)">⭐ ${escapeHTML(label)}</span>`);
    }
    const occ = occasionMeta[String(item.occasion || "")];
    if (occ) {
      chips.push(`<span title="${escapeHTML(occ.label)}" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.14);color:#fcd34d;border:1px solid rgba(245,158,11,.3)">${occ.emoji} ${escapeHTML(occ.label)}</span>`);
    }
    for (const d of Array.isArray(item.dietary) ? item.dietary : []) {
      const label = dietaryMeta[String(d)];
      if (!label) continue;
      chips.push(`<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.14);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)">${escapeHTML(label)}</span>`);
    }
    if (!chips.length) return "";
    return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;justify-content:center">${chips.join("")}</div>`;
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
    const selectedDate = state.date;
    const result = await fetchJSON(url);
    if (selectedDate !== state.date) return;
    state.day = result;
    if (state.day?.currentTime) {
      state.systemTime.date = state.day.currentTime.sourceDate || state.day.currentTime.date || state.systemTime.date;
      state.systemTime.time = state.day.currentTime.time || state.systemTime.time;
      if (systemDateInput) systemDateInput.value = state.systemTime.date;
      if (systemTimeInput) systemTimeInput.value = state.systemTime.time;
      if (systemPreview) systemPreview.textContent = `${state.systemTime.time}`;
    }
    renderHeaderLine();
    renderSlots();
    void loadWaitlist();
    if (state.ui.view === "list" && state.agenda?.date !== state.date) await loadAgenda();
    renderRoomOccupancy();
    renderKPIs();
    if (datePicker) datePicker.value = state.date;
    if (state.ui.view === "week") void loadWeek();
    if (state.ui.view === "month") void loadMonth();
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
    const selectedDate = state.date;
    const result = await fetchJSON(url);
    if (selectedDate !== state.date) return;
    state.summary = result;
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
    state.agenda = null;
    weekCache = null;
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
      weekCache = null;
      state.agenda = null;
      ++agendaRequest;
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
      weekCache = null;
      state.agenda = null;
      ++agendaRequest;
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
    if (waitlistForm) waitlistForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = waitlistForm.querySelector('[type="submit"]');
      if (button?.disabled) return;
      const date = state.date;
      const fields = new FormData(waitlistForm);
      const payload = {
        date,
        name: String(fields.get("name") || ""),
        phone: String(fields.get("phone") || ""),
        people: Number(fields.get("people")),
        time: String(fields.get("time") || ""),
        area: String(fields.get("area") || ""),
        note: String(fields.get("note") || ""),
      };
      if (button) button.disabled = true;
      waitlistMessage("");
      try {
        await fetchJSON("/owner/restaurants/" + encodeURIComponent(state.rid) +
          "/calendar/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        waitlistForm.reset();
        waitlistMessage(lang === "he" ? "הבקשה נוספה לרשימת ההמתנה (לא נוצרה הזמנה)." :
          "Added to waitlist. No reservation has been created.");
        if (state.date === date) await loadWaitlist();
      } catch {
        waitlistMessage(lang === "he" ? "לא ניתן להוסיף בקשה. בדוק פרטים ונסה שוב." :
          "Could not add request. Check the details and retry.");
      } finally {
        if (button) button.disabled = false;
      }
    });
    weekModeButtons.forEach((button) => button.addEventListener("click", () => {
      const mode = button.dataset.weekMode;
      if (!["columns", "timeline"].includes(mode)) return;
      state.ui.weekMode = mode;
      weekModeButtons.forEach((item) => {
        const active = item.dataset.weekMode === mode;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      persistCalendarOptions();
      void loadWeek();
    }));
    if (weekIntervalSelect) weekIntervalSelect.addEventListener("change", () => {
      state.ui.displayMinutes = Number(weekIntervalSelect.value) === 15 ? 15 : 30;
      persistCalendarOptions();
      if (state.ui.view === "week" && state.ui.weekMode === "timeline") void loadWeek();
    });
    if (monthPrev) monthPrev.addEventListener("click", () => { void moveCalendarMonth(-1); });
    if (monthNext) monthNext.addEventListener("click", () => { void moveCalendarMonth(1); });
    viewButtons.forEach((button) => button.addEventListener("click", () => setCalendarView(button.dataset.calendarView)));
    if (agendaStatus) agendaStatus.addEventListener("change", () => {
      state.ui.statusFilter = agendaStatus.value || "all";
      renderAgenda();
    });
    if (btnPrev) btnPrev.addEventListener("click", async () => {
      if (state.ui.view === "month") { await moveCalendarMonth(-1); return; }
      state.date = addDays(state.date, state.ui.view === "week" ? -7 : -1);
      if (datePicker) datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (btnNext) btnNext.addEventListener("click", async () => {
      if (state.ui.view === "month") { await moveCalendarMonth(1); return; }
      state.date = addDays(state.date, state.ui.view === "week" ? 7 : 1);
      if (datePicker) datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (datePicker) datePicker.addEventListener("change", async () => {
      state.date = datePicker.value;
      await Promise.all([loadDay(), loadSummary()]);
      connectSSE();
    });

    if (daySearch) daySearch.addEventListener("input", debounce(() => {
      if (state.ui.view === "list") renderAgenda();
      else searchInDay(daySearch.value.trim());
    }, 250));
    if (sideSearch) sideSearch.addEventListener("input", debounce(() => {
      const v = sideSearch.value || "";
      if (daySearch) daySearch.value = v;
      if (state.ui.view === "list") renderAgenda();
      else searchInDay(v.trim());
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
    setCalendarView(restoreView());
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
