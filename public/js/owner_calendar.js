// /static/js/owner_calendar.js
(function () {
  "use strict";

  /* ========== DOM helpers ========== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ========== Boot / State ========== */
  const init = window.__OC__ || {};
  const state = {
    rid: init.rid || getRidFromPath(),
    date: init.date || todayISO(),                  // YYYY-MM-DD selected day
    day: null,
    summary: null,
    drawer: { open: false, time: null, items: [] },
    sse: { es: null, retryMs: 1500, pollTimer: null },
    cal: { year: 0, month: 0 },                     // sidebar month view (0-11)
  };

  /* ========== Elements ========== */
  const datePicker = $("#datePicker");
  const dateLabel = $("#date-label");
  const btnPrev = $("#btn-prev");
  const btnNext = $("#btn-next");
  const daySearch = $("#daySearch");
  const capLine = $("#cap-line");
  const slotsRoot = $("#slots");
  const summaryRoot = $("#summary");

  const drawer = $("#drawer");
  const drawerTitle = $("#drawer-title");
  const drawerClose = $("#drawer-close");
  const drawerSearch = $("#drawer-search");
  const drawerTableBody = $("#drawer-table tbody");
  const btnAdd = $("#btn-add");

  // Sidebar calendar/search/summary
  const calTitle = $("#cal-title");
  const calBody  = $("#cal-body");
  const calWk    = $("#cal-weekdays");
  const calPrev  = $("#cal-prev");
  const calNext  = $("#cal-next");
  const sideSearch = $("#sideSearch");
  const sideSumBox = $("#day-summary-box");
  const sideSumText = $("#day-summary-text");
  const sideSumBar  = $("#day-summary-bar");

  /* ========== Utils ========== */
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
  function fmt(n) { return new Intl.NumberFormat("en-US").format(n); }
  function color(p) {
    if (p >= 80) return getCSS("--danger");
    if (p >= 50) return getCSS("--warn");
    return getCSS("--ok");
  }
  function getCSS(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function setOpen(el, on) { el.classList.toggle("open", !!on); }
  function addDays(iso, days) {
    const [y,m,d] = iso.split("-").map(Number);
    const dt = new Date(y, m-1, d);
    dt.setDate(dt.getDate() + days);
    const p = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  function isoToDate(iso){
    const m = String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return new Date();
    return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
  function ymd(d){ const p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

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

  /* ========== Header / lines ========== */
  function renderHeaderLine() {
    if (!state.day) {
      if (dateLabel) dateLabel.textContent = "—";
      if (capLine) capLine.textContent = "";
      return;
    }
    const d = new Date(state.date + "T00:00:00");
    const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
    const long = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    if (dateLabel) dateLabel.textContent = `${weekday}, ${long}`;
    if (capLine) capLine.textContent = `Capacity: People ${state.day.capacityPeople} • Tables ${state.day.capacityTables} • Step: ${state.day.slotMinutes}m`;
  }

  function rowHeader() {
    if (!slotsRoot || $(".oc-th", slotsRoot)) return;
    const th = document.createElement("div");
    th.className = "oc-row oc-th";
    th.innerHTML = `<div>Time</div><div>Occupancy</div><div class="oc-info">People • Tables • %</div>`;
    slotsRoot.appendChild(th);
  }

  function renderSlots() {
    if (!slotsRoot) return;
    $$(".oc-row", slotsRoot).slice(1).forEach((el) => el.remove());
    if (!state.day) return;
    const frag = document.createDocumentFragment();
    for (const s of state.day.slots) {
      const row = document.createElement("div");
      row.className = "oc-row";
      row.dataset.time = s.time;

      const c1 = document.createElement("div");
      c1.className = "oc-time";
      c1.textContent = s.time;

      const c2 = document.createElement("div");
      const bar = document.createElement("div");
      bar.className = "oc-bar";
      const fill = document.createElement("div");
      fill.className = "fill";
      fill.style.width = Math.max(0, Math.min(100, s.percent)) + "%";
      fill.style.background = color(s.percent);
      bar.appendChild(fill);
      c2.appendChild(bar);

      const c3 = document.createElement("div");
      c3.className = "oc-info";
      c3.textContent = `People ${fmt(s.people)} · Tables ${fmt(s.tables)} · ${s.percent}%`;

      row.title = `People: ${s.people}/${state.day.capacityPeople} • Tables: ${s.tables}/${state.day.capacityTables} • ${s.percent}%`;
      row.appendChild(c1); row.appendChild(c2); row.appendChild(c3);

      row.addEventListener("click", () => openDrawer(s.time));
      frag.appendChild(row);
    }
    slotsRoot.appendChild(frag);
  }

  function renderSummary() {
    if (!summaryRoot) return;
    const s = state.summary;
    if (!s) { summaryRoot.textContent = "Daily Summary — loading…"; return; }
    summaryRoot.innerHTML = `
      <div><b>Total Reservations:</b> ${fmt(s.totalReservations)} · <b>Total Guests:</b> ${fmt(s.totalGuests)}</div>
      <div><b>Avg Occupancy:</b> People ${fmt(s.avgOccupancyPeople)}% · Tables ${fmt(s.avgOccupancyTables)}%</div>
      <div><b>Peak:</b> ${s.peakSlot || "-"} (${fmt(s.peakOccupancy)}%) · <b>Cancelled:</b> ${fmt(s.cancelled)} · <b>No-Show:</b> ${fmt(s.noShow)}</div>
    `;
    // עדכון הסיכום הקומפקטי בסיידבר
    updateSidebarSummary(s);
  }

  /* ========== Drawer ========== */
  function renderDrawer(items) {
    if (!drawerTableBody) return;
    drawerTableBody.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHTML(it.firstName || "")}</td>
        <td>${escapeHTML(it.lastName || "")}</td>
        <td>${Number(it.people || 0)}</td>
        <td>${badge(it.status || "")}</td>
        <td><a href="tel:${(it.phone || "").replace(/\s+/g, "")}">${escapeHTML(it.phone || "")}</a></td>
        <td>
          <button class="btn" data-act="arrived" data-id="${it.id}">Arrived</button>
          <button class="btn warn" data-act="cancel" data-id="${it.id}">Cancel</button>
        </td>
      `;
      frag.appendChild(tr);
    }
    drawerTableBody.appendChild(frag);

    $$('button[data-act="arrived"]', drawerTableBody).forEach((b) => {
      b.addEventListener("click", () => slotAction("arrived", { id: b.dataset.id }));
    });
    $$('button[data-act="cancel"]', drawerTableBody).forEach((b) => {
      b.addEventListener("click", () => slotAction("cancel", { id: b.dataset.id }));
    });
  }

  function badge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "new")        return `<span class="badge booked">New</span>`;
    if (s === "pending" || s === "request" || s === "requested" || s === "tentative")
      return `<span class="badge booked">Pending</span>`;
    if (s === "booked" || s === "hold" || s === "on-hold" || s === "invited")
      return `<span class="badge booked">Booked</span>`;
    if (s === "approved")   return `<span class="badge approved">Approved</span>`;
    if (s === "confirmed")  return `<span class="badge approved">Confirmed</span>`;
    if (s === "arrived")    return `<span class="badge arrived">Arrived</span>`;
    if (s === "cancelled" || s === "canceled" || s === "rejected" || s === "declined")
      return `<span class="badge cancelled">Cancelled</span>`;
    return `<span class="badge booked">${escapeHTML(status || "Booked")}</span>`;
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  function openDrawer(hhmm) {
    state.drawer.time = hhmm;
    if (drawerTitle) drawerTitle.textContent = `Customers ${toAMPM(hhmm)}`;
    if (drawer) setOpen(drawer, true);
    state.drawer.open = true;
    loadSlot();
  }
  function closeDrawer() {
    if (drawer) setOpen(drawer, false);
    state.drawer.open = false;
    state.drawer.time = null;
  }
  function toAMPM(hhmm) {
    const [H, M] = hhmm.split(":").map(Number);
    const ampm = H >= 12 ? "PM" : "AM";
    const h = ((H + 11) % 12) + 1;
    return `${h}:${String(M).padStart(2, "0")} ${ampm}`;
  }

  /* ========== Data loading ========== */
  async function loadDay() {
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day?date=${encodeURIComponent(state.date)}`;
    state.day = await fetchJSON(url);
    renderHeaderLine();
    rowHeader();
    renderSlots();
    // רענון תאריך בתווית/פיקר
    if (datePicker) datePicker.value = state.date;
    if (dateLabel) {
      const d = isoToDate(state.date);
      dateLabel.textContent = d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    }
    // רענון היומן החודשי אם חודש התצוגה לא תואם את התאריך הנבחר
    const d = isoToDate(state.date);
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

    const baseQs = {
      action,
      date: state.date,
      time: state.drawer.time,
      reservation: JSON.stringify(reservation),
    };
    const qs = new URLSearchParams(baseQs);
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot?${qs.toString()}`;
    const body = JSON.stringify({ action, date: state.date, time: state.drawer.time, reservation });

    try {
      await fetchJSON(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
    } catch (e) {
      await fetchJSON(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
    }
    await Promise.all([loadSlot(), loadDay(), loadSummary()]);
  }

  async function createManual() {
    if (!state.drawer.time) return;
    const firstName = prompt("First name:") || "";
    const lastName  = prompt("Last name:") || "";
    if (!firstName && !lastName) return;
    const phone  = prompt("Phone (optional):") || "";
    const people = Math.max(1, parseInt(prompt("Party size:", "2") || "2", 10));
    const notes  = prompt("Notes (optional):") || "";
    await slotAction("create", { firstName, lastName, phone, people, notes, status: "booked" });
  }

  async function searchInDay(q) {
    if (!q) {
      if (slotsRoot) $$(".oc-row", slotsRoot).forEach((r, i) => { if (i > 0) r.style.outline = "none"; });
      return;
    }
    const data = await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/search?date=${encodeURIComponent(state.date)}&q=${encodeURIComponent(q)}`);
    const times = new Set((data.items || []).map((x) => x.time).filter(Boolean));
    if (slotsRoot) {
      $$(".oc-row", slotsRoot).forEach((r, i) => {
        if (i === 0) return;
        const t = r.dataset.time;
        r.style.outline = times.has(t) ? `2px solid ${getCSS("--brand")}` : "none";
      });
    }
    const first = (data.items || [])[0];
    if (first && first.time) openDrawer(first.time);
  }

  /* ========== SSE ========== */
  function connectSSE() {
    cleanupSSE();

    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/events?date=${encodeURIComponent(state.date)}`;
    let es;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch (e) {
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
      } catch { /* ignore */ }
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

  /* ========== Sidebar: Monthly Calendar ========== */
  // week days header (Sun..Sat)
  if (calWk) calWk.innerHTML = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => `<th>${d}</th>`).join("");

  function buildCalendar(year, month) {
    if (!calBody || !calTitle) return;

    // Title
    const ref = new Date(year, month, 1);
    calTitle.textContent = ref.toLocaleDateString(undefined, { year:"numeric", month:"long" });

    // First visible cell starts at prev Sunday
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());

    // marks
    const selected = isoToDate(state.date);
    const today = new Date(); today.setHours(0,0,0,0);

    // 6 rows * 7 columns
    const rows = [];
    let cur = new Date(start);
    for (let r=0; r<6; r++){
      const tds = [];
      for (let c=0; c<7; c++){
        const inMonth = (cur.getMonth() === month);
        const isSel = (cur.getFullYear()===selected.getFullYear() &&
                       cur.getMonth()===selected.getMonth() &&
                       cur.getDate()===selected.getDate());
        const isToday = (cur.getFullYear()===today.getFullYear() &&
                         cur.getMonth()===today.getMonth() &&
                         cur.getDate()===today.getDate());

        const classes = [
          inMonth ? "" : "out",
          isToday ? "today" : "",
          isSel ? "sel" : ""
        ].filter(Boolean).join(" ");

        const label = cur.getDate();
        const iso = ymd(cur);
        tds.push(`<td><button class="${classes}" data-iso="${iso}" title="${iso}">${label}</button></td>`);
        cur.setDate(cur.getDate()+1);
      }
      rows.push(`<tr>${tds.join("")}</tr>`);
    }
    calBody.innerHTML = rows.join("");

    // Bind clicks
    $$("button", calBody).forEach(btn => {
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
    let {year, month} = state.cal;
    month--; if (month<0){ month=11; year--; }
    state.cal = {year, month};
    buildCalendar(year, month);
  });
  if (calNext) calNext.addEventListener("click", () => {
    let {year, month} = state.cal;
    month++; if (month>11){ month=0; year++; }
    state.cal = {year, month};
    buildCalendar(year, month);
  });

  /* ========== Sidebar: Daily Summary compact ========== */
  function updateSidebarSummary(s) {
    if (!sideSumBox || !sideSumText || !sideSumBar || !s) return;
    const pct = Math.max(0, Math.min(100, Math.round(s.occupancyPct || 0)));
    const ppl = s.people ?? s.totalGuests ?? 0;
    const tbl = s.tables ?? 0;
    sideSumText.textContent = `People ${fmt(ppl)} · Tables ${fmt(tbl)} · ${pct}%`;
    sideSumBar.style.width = `${pct}%`;
  }

  /* ========== Wire controls ========== */
  function wire() {
    // Top bar: prev/next/datePicker
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

    // Search (header legacy + sidebar unified)
    if (daySearch) daySearch.addEventListener("input", debounce(() => searchInDay(daySearch.value), 250));
    if (sideSearch) sideSearch.addEventListener("input", debounce(() => {
      const v = sideSearch.value || "";
      if (daySearch) daySearch.value = v; // להזרים לוגיקה קיימת אם נשענת על קלט זה
      searchInDay(v);
    }, 250));

    // Drawer
    if (drawerClose) drawerClose.addEventListener("click", () => { closeDrawer(); });
    if (btnAdd) btnAdd.addEventListener("click", createManual);
    if (drawerSearch) drawerSearch.addEventListener("input", () => {
      const q = drawerSearch.value.trim().toLowerCase();
      $$("#drawer-table tbody tr").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }

  /* ========== Init ========== */
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
    await Promise.all([loadDay(), loadSummary()]);
    connectSSE();
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
