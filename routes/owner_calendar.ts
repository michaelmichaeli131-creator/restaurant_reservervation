// /public/js/owner_calendar.js
// Owner Day Calendar — keep the exact layout; fill data & include phone & names.

(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const boot = (window.__OC__ && typeof window.__OC__ === "object") ? window.__OC__ : {};
  const state = {
    rid: boot.rid || "",
    date: boot.date || "",
    slots: [],
    caps: { people: 0, tables: 0, step: 15 },
    drawer: { time: null, items: [], filter: "" },
  };

  // Elements (guard against null)
  const dateLabel = $("#date-label");
  const datePicker = $("#datePicker");
  const btnPrev = $("#btn-prev");
  const btnNext = $("#btn-next");
  const daySearch = $("#daySearch");
  const capLine = $("#cap-line");
  const slotsWrap = $("#slots");
  const summaryBox = $("#summary");

  const drawer = $("#drawer");
  const drawerTitle = $("#drawer-title");
  const drawerClose = $("#drawer-close");
  const drawerSearch = $("#drawer-search");
  const btnAdd = $("#btn-add");
  const drawerTableBody = $("#drawer-table tbody");

  // Utils
  const pad2 = (n) => String(n).padStart(2, "0");
  const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseISO = (s) => {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  };
  const addDays = (dateISO, delta) => {
    const d = parseISO(dateISO);
    if (!d) return dateISO;
    d.setDate(d.getDate() + delta);
    return toISO(d);
  };
  const telLink = (p) => {
    const phone = String(p || "").trim();
    return phone ? `<a href="tel:${phone.replace(/\s+/g,'')}">${phone}</a>` : "";
  };

  const colorClass = (pctRaw) => {
    const pct = Number.isFinite(+pctRaw) ? +pctRaw : 0;
    return pct >= 80 ? "barr" : pct >= 50 ? "bary" : "barg";
  };

  async function getJSON(url) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  async function loadDay(dateISO) {
    if (!slotsWrap) return;
    // Day payload
    const day = await getJSON(
      `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day?date=${encodeURIComponent(
        dateISO
      )}`
    );
    state.date = day.date || dateISO;
    if (datePicker) datePicker.value = state.date;
    if (dateLabel) dateLabel.textContent = state.date;

    // Caps line
    state.caps.people = Number(day.capacityPeople || 0);
    state.caps.tables = Number(day.capacityTables || 0);
    state.caps.step = Number(day.slotMinutes || 15);
    if (capLine) {
      capLine.textContent = `Capacity: People ${state.caps.people} • Tables ${state.caps.tables} • Step: ${state.caps.step}`;
    }

    // Slots
    state.slots = Array.isArray(day.slots) ? day.slots : [];
    renderSlots();

    // Summary
    if (summaryBox) {
      try {
        const sum = await getJSON(
          `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/summary?date=${encodeURIComponent(
            state.date
          )}`
        );
        summaryBox.textContent = `Daily Summary — reservations ${sum.totalReservations || 0} • guests ${sum.totalGuests || 0} • peak ${sum.peakOccupancy || 0}%`;
      } catch {
        summaryBox.textContent = "";
      }
    }
  }

  function renderSlots() {
    if (!slotsWrap) return;

    // clear existing rows except header
    $$(".oc-row", slotsWrap)
      .filter((el) => !el.classList.contains("oc-th"))
      .forEach((el) => el.remove());

    const q = (daySearch && daySearch.value || "").trim().toLowerCase();
    const byName = q.length > 0;

    state.slots.forEach((s) => {
      const row = document.createElement("div");
      row.className = "oc-row";
      row.dataset.time = s.time;

      const colTime = document.createElement("div");
      colTime.textContent = s.time;

      const colOcc = document.createElement("div");
      const bar = document.createElement("div");
      bar.className = colorClass(s.percent);
      bar.style.width = Math.max(0, Math.min(100, Number(s.percent || 0))) + "%";
      colOcc.appendChild(bar);

      const colInfo = document.createElement("div");
      colInfo.className = "oc-info";
      colInfo.textContent = `${s.people} • ${s.tables} • ${s.percent}%`;

      row.appendChild(colTime);
      row.appendChild(colOcc);
      row.appendChild(colInfo);

      row.addEventListener("click", () => openSlot(state.date, s.time));

      // Simple highlight if name search is active → visual hint (actual filtering inside drawer)
      if (byName) row.style.outline = "1px dashed #c7d2fe";

      slotsWrap.appendChild(row);
    });
  }

  async function openSlot(date, time) {
    if (drawer) drawer.classList.add("open");
    if (drawerTitle) drawerTitle.textContent = `Customers — ${time}`;
    state.drawer.time = time;
    state.drawer.items = [];
    state.drawer.filter = "";

    const payload = await getJSON(
      `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot?date=${encodeURIComponent(
        date
      )}&time=${encodeURIComponent(time)}`
    );
    state.drawer.items = Array.isArray(payload.items) ? payload.items : [];

    renderDrawerTable();
  }

  function renderDrawerTable() {
    if (!drawerTableBody) return;

    const q = (drawerSearch && drawerSearch.value || "").trim().toLowerCase();
    const items = state.drawer.items.filter((it) => {
      if (!q) return true;
      const f = String(it.firstName || "").toLowerCase();
      const l = String(it.lastName || "").toLowerCase();
      const p = String(it.phone || "").toLowerCase();
      return f.includes(q) || l.includes(q) || p.includes(q); // ← גם לפי טלפון
    });

    // empty
    drawerTableBody.innerHTML = "";
    if (!items.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "muted";
      td.textContent = "No customers in this slot.";
      tr.appendChild(td);
      drawerTableBody.appendChild(tr);
      return;
    }

    for (const it of items) {
      const tr = document.createElement("tr");

      const tdFirst = document.createElement("td");
      tdFirst.textContent = it.firstName || "";

      const tdLast = document.createElement("td");
      tdLast.textContent = it.lastName || "";

      const tdParty = document.createElement("td");
      tdParty.textContent = String(it.people ?? 0);

      const tdStatus = document.createElement("td");
      tdStatus.textContent = String(it.status || "");

      const tdPhone = document.createElement("td");
      tdPhone.innerHTML = telLink(it.phone);

      const tdActions = document.createElement("td");
      tdActions.className = "tbl-actions";
      tdActions.innerHTML = `
        <button class="btn sm" data-act="arrived">Arrived</button>
        <button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm warn" data-act="cancel">Cancel</button>
      `;

      tdActions.addEventListener("click", async (ev) => {
        const b = ev.target.closest && ev.target.closest("button[data-act]");
        if (!b) return;
        const act = b.getAttribute("data-act");
        if (act === "arrived") {
          await patchSlot("arrived", { id: it.id });
          await Promise.all([reopenSlot(), loadDay(state.date)]); // ← רענון גם לגריד
        } else if (act === "cancel") {
          if (!confirm("Cancel this reservation?")) return;
          await patchSlot("cancel", { id: it.id, reason: "" });
          await Promise.all([reopenSlot(), loadDay(state.date)]);
        } else if (act === "edit") {
          const firstName = prompt("First name", it.firstName || "") || "";
          const lastName = prompt("Last name", it.lastName || "") || "";
          const phone = prompt("Phone", it.phone || "") || "";
          const people = Number(prompt("Party size", String(it.people || 0)) || 0);
          const notes = prompt("Notes", it.notes || "") || "";
          const status = prompt("Status (invited/approved/arrived/cancelled)", it.status || "approved") || "approved";
          await patchSlot("update", { id: it.id, firstName, lastName, phone, people, notes, status });
          await Promise.all([reopenSlot(), loadDay(state.date)]);
        }
      });

      tr.appendChild(tdFirst);
      tr.appendChild(tdLast);
      tr.appendChild(tdParty);
      tr.appendChild(tdStatus);
      tr.appendChild(tdPhone);
      tr.appendChild(tdActions);
      drawerTableBody.appendChild(tr);
    }
  }

  async function patchSlot(action, reservation) {
    const body = {
      action,
      date: state.date,
      time: state.drawer.time,
      reservation,
    };
    const res = await fetch(
      `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  async function reopenSlot() {
    await openSlot(state.date, state.drawer.time);
  }

  // Add customer
  if (btnAdd) {
    btnAdd.addEventListener("click", async () => {
      if (!state.drawer.time) return;
      const firstName = prompt("First name") || "";
      const lastName = prompt("Last name") || "";
      const phone = prompt("Phone") || "";
      const people = Number(prompt("Party size", "2") || 2);
      const notes = prompt("Notes") || "";
      const status = "approved";

      if (!firstName || !lastName || !people) return;

      await patchSlot("create", { firstName, lastName, phone, people, notes, status });
      await Promise.all([reopenSlot(), loadDay(state.date)]);
    });
  }

  // Drawer events
  if (drawerClose) {
    drawerClose.addEventListener("click", () => drawer && drawer.classList.remove("open"));
  }
  if (drawer) {
    drawer.addEventListener("click", (ev) => {
      if (ev.target === drawer) drawer.classList.remove("open");
    });
  }
  if (drawerSearch) {
    drawerSearch.addEventListener("input", renderDrawerTable);
  }

  // Day search — highlight is simple; true filtering happens inside the drawer per slot
  if (daySearch) {
    daySearch.addEventListener("input", renderSlots);
  }

  // Date controls
  if (btnPrev) btnPrev.addEventListener("click", () => loadDay(addDays(state.date, -1)));
  if (btnNext) btnNext.addEventListener("click", () => loadDay(addDays(state.date, +1)));
  if (dateLabel) {
    dateLabel.addEventListener("click", () => {
      if (datePicker && typeof datePicker.showPicker === "function") {
        datePicker.showPicker();
      } else if (datePicker) {
        datePicker.focus();
        datePicker.click();
      }
    });
  }
  if (datePicker) {
    datePicker.addEventListener("change", () => loadDay(datePicker.value));
  }

  // init
  if (state.rid && state.date) {
    loadDay(state.date).catch(console.error);
  }
})();
