// /public/js/owner_calendar.js
// גרסה מעודכנת: Layout כפול, כפתורי Prev/Next, שורת קיבולת, טבלת סלוטים, Drawer עם טבלת לקוחות ובאדג'ים

(function(){
  "use strict";

  /* ---------- Shortcuts ---------- */
  const $ = (sel, root=document)=>root.querySelector(sel);
  const $$ = (sel, root=document)=>Array.from(root.querySelectorAll(sel));

  /* ---------- State ---------- */
  const init = window.__OC__ || {};
  const state = {
    rid: init.rid || getRidFromPath(),
    date: init.date || todayISO(),
    day: null,
    summary: null,
    drawer: { open:false, time:null, items:[] }
  };

  /* ---------- DOM ---------- */
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

  /* ---------- Utils ---------- */
  function getRidFromPath(){
    const parts = location.pathname.split("/").filter(Boolean);
    const i = parts.indexOf("restaurants");
    if (i>=0 && parts[i+1]) return decodeURIComponent(parts[i+1]);
    const rid = new URL(location.href).searchParams.get("rid");
    if (rid) return rid;
    throw new Error("RID not found");
  }
  function todayISO(){
    const d = new Date();
    const p = n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }
  function fmt(n){ return new Intl.NumberFormat("en-US").format(n); }
  function color(p){
    if (p>=80) return getCSS("--danger");
    if (p>=50) return getCSS("--warn");
    return getCSS("--ok");
  }
  function getCSS(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function setOpen(el,on){ el.classList.toggle("open", !!on); }

  function addDays(iso, days){
    const d = new Date(iso); d.setDate(d.getDate()+days);
    const p=n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  async function fetchJSON(url, opts={}){
    const res = await fetch(url, { credentials:"same-origin", headers:{Accept:"application/json"}, ...opts });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /* ---------- Rendering ---------- */

  function renderHeaderLine(){
    if (!state.day){ dateLabel.textContent = "—"; capLine.textContent=""; return; }
    // תווית תאריך נחמדה
    const d = new Date(state.date+"T00:00:00");
    const weekday = d.toLocaleDateString("en-US", { weekday:"short" });
    const long = d.toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" });
    dateLabel.textContent = `${weekday}, ${long}`;
    capLine.textContent = `Capacity: People ${state.day.capacityPeople} • Tables ${state.day.capacityTables} • Step: ${state.day.slotMinutes}m`;
  }

  function rowHeader(){
    // כבר קיים ב-ETA, אך אם נרצה רינדור מחדש מלא:
    if (!$(".oc-th", slotsRoot)){
      const th = document.createElement("div");
      th.className = "oc-row oc-th";
      th.innerHTML = `<div>Time</div><div>Occupancy</div><div class="oc-info">People • Tables • %</div>`;
      slotsRoot.appendChild(th);
    }
  }

  function renderSlots(){
    // מחיקה של כל שורות ה-Data (לא של ה-Header)
    $$(".oc-row", slotsRoot).slice(1).forEach(el=>el.remove());
    if (!state.day){ return; }
    const frag = document.createDocumentFragment();
    for (const s of state.day.slots){
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

      row.addEventListener("click", ()=>openDrawer(s.time));
      frag.appendChild(row);
    }
    slotsRoot.appendChild(frag);
  }

  function renderSummary(){
    const s = state.summary;
    if (!s){ summaryRoot.textContent = "Daily Summary — loading…"; return; }
    summaryRoot.innerHTML = `
      <div><b>Total Reservations:</b> ${fmt(s.totalReservations)} · <b>Total Guests:</b> ${fmt(s.totalGuests)}</div>
      <div><b>Avg Occupancy:</b> People ${fmt(s.avgOccupancyPeople)}% · Tables ${fmt(s.avgOccupancyTables)}%</div>
      <div><b>Peak:</b> ${s.peakSlot || "-"} (${fmt(s.peakOccupancy)}%) · <b>Cancelled:</b> ${fmt(s.cancelled)} · <b>No-Show:</b> ${fmt(s.noShow)}</div>
    `;
  }

  function renderDrawer(items){
    drawerTableBody.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const it of items){
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHTML(it.firstName||"")}</td>
        <td>${escapeHTML(it.lastName||"")}</td>
        <td>${Number(it.people||0)}</td>
        <td>${badge(it.status||"")}</td>
        <td><a href="tel:${(it.phone||"").replace(/\s+/g,"")}">${escapeHTML(it.phone||"")}</a></td>
        <td>
          <button class="btn" data-act="arrived" data-id="${it.id}">Arrived</button>
          <button class="btn warn" data-act="cancel" data-id="${it.id}">Cancel</button>
        </td>
      `;
      frag.appendChild(tr);
    }
    drawerTableBody.appendChild(frag);

    // wire actions
    $$('button[data-act="arrived"]', drawerTableBody).forEach(b=>{
      b.addEventListener("click", ()=>markArrived(b.dataset.id));
    });
    $$('button[data-act="cancel"]', drawerTableBody).forEach(b=>{
      b.addEventListener("click", ()=>cancelRes(b.dataset.id));
    });
  }

  function badge(status){
    const s = String(status).toLowerCase();
    let cls="approved", txt="Approved";
    if (s==="booked" || s==="invited"){ cls="booked"; txt=s==="booked"?"Booked":"Invited"; }
    if (s==="arrived"){ cls="arrived"; txt="Arrived"; }
    if (s==="cancelled"){ cls="cancelled"; txt="Cancelled"; }
    return `<span class="badge ${cls}">${txt}</span>`;
  }

  function escapeHTML(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

  /* ---------- Drawer ---------- */
  function openDrawer(hhmm){
    state.drawer.time = hhmm;
    drawerTitle.textContent = `Customers ${toAMPM(hhmm)}`;
    setOpen(drawer,true); state.drawer.open=true;
    loadSlot();
  }
  function closeDrawer(){ setOpen(drawer,false); state.drawer.open=false; state.drawer.time=null; }

  function toAMPM(hhmm){
    const [H,M] = hhmm.split(":").map(Number);
    const ampm = H>=12 ? "PM" : "AM";
    const h = ((H+11)%12)+1;
    return `${h}:${String(M).padStart(2,"0")} ${ampm}`;
  }

  /* ---------- Data ---------- */
  async function loadDay(){
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day?date=${encodeURIComponent(state.date)}`;
    const data = await fetchJSON(url);
    if (!data.ok) throw new Error("day failed");
    state.day = data;
    renderHeaderLine();
    rowHeader();
    renderSlots();
  }

  async function loadSummary(){
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/summary?date=${encodeURIComponent(state.date)}`;
    const data = await fetchJSON(url);
    state.summary = data;
    renderSummary();
  }

  async function loadSlot(){
    if (!state.drawer.time) return;
    const url = `/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot?date=${encodeURIComponent(state.date)}&time=${encodeURIComponent(state.drawer.time)}`;
    const data = await fetchJSON(url);
    if (!data.ok) throw new Error("slot failed");
    state.drawer.items = data.items||[];
    renderDrawer(state.drawer.items);
  }

  /* ---------- Actions ---------- */
  async function createManual(){
    if (!state.drawer.time) return;
    const firstName = prompt("First name:"); if(!firstName) return;
    const lastName = prompt("Last name:"); if(!lastName) return;
    const phone = prompt("Phone:")||"";
    const people = Math.max(1, parseInt(prompt("Party size:","2")||"2",10));
    const notes = prompt("Notes (optional):")||"";
    await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot`,{
      method:"PATCH",headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ action:"create", date:state.date, time:state.drawer.time, reservation:{ firstName,lastName,phone,people,notes,status:"approved" } })
    });
    await Promise.all([loadSlot(), loadDay(), loadSummary()]);
  }

  async function cancelRes(id){
    if(!confirm("Cancel this reservation?")) return;
    await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot`,{
      method:"PATCH",headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ action:"cancel", date:state.date, time:state.drawer.time, reservation:{ id } })
    });
    await Promise.all([loadSlot(), loadDay(), loadSummary()]);
  }

  async function markArrived(id){
    await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/slot`,{
      method:"PATCH",headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ action:"arrived", date:state.date, time:state.drawer.time, reservation:{ id } })
    });
    await Promise.all([loadSlot(), loadDay(), loadSummary()]);
  }

  /* ---------- Search ---------- */
  async function searchInDay(q){
    if(!q){ // clear highlights
      $$('.oc-row', slotsRoot).forEach((r,i)=>{ if(i>0) r.style.outline="none"; });
      return;
    }
    const data = await fetchJSON(`/owner/restaurants/${encodeURIComponent(state.rid)}/calendar/day/search?date=${encodeURIComponent(state.date)}&q=${encodeURIComponent(q)}`);
    if (!data.ok) return;
    const times = new Set((data.items||[]).map(x=>x.time).filter(Boolean));
    $$('.oc-row', slotsRoot).forEach((r,i)=>{
      if(i===0) return;
      const t = r.dataset.time;
      r.style.outline = times.has(t) ? `2px solid ${getCSS("--brand")}` : "none";
    });
    const first = (data.items||[])[0];
    if (first && first.time){
      const el = $(`.oc-row[data-time="${CSS.escape(first.time)}"]`, slotsRoot);
      if (el) el.scrollIntoView({ behavior:"smooth", block:"center" });
      openDrawer(first.time);
    }
  }

  /* ---------- Wiring ---------- */
  function wire(){
    btnPrev.addEventListener("click", async ()=>{
      state.date = addDays(state.date, -1);
      datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
    });
    btnNext.addEventListener("click", async ()=>{
      state.date = addDays(state.date, +1);
      datePicker.value = state.date;
      await Promise.all([loadDay(), loadSummary()]);
    });
    datePicker.addEventListener("change", async ()=>{
      state.date = datePicker.value;
      await Promise.all([loadDay(), loadSummary()]);
    });
    daySearch.addEventListener("input", debounce(()=>searchInDay(daySearch.value), 250));
    drawerClose.addEventListener("click", closeDrawer);
    btnAdd.addEventListener("click", createManual);
    drawerSearch.addEventListener("input", ()=>{
      // סנן מקומית בתוך הטבלה
      const q = drawerSearch.value.trim().toLowerCase();
      $$("tbody tr", $("#drawer-table")).forEach(tr=>{
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
  }

  function debounce(fn, ms){
    let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
  }

  /* ---------- Init ---------- */
  async function initApp(){
    datePicker.value = state.date;
    wire();
    await Promise.all([loadDay(), loadSummary()]);
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
