/* static/app.js
 * אוטוקומפליט + בדיקת זמינות (כפי שהיה),
 * תוספת: timepicker ב-24h עם קפיצות של 15 דק, כולל ניטור דינמי אם תוסף נטען מאוחר.
 */

(function () {
  // --- helpers for defaults ---
  function pad2(n){return String(n).padStart(2,"0")}
  function todayISO(){
    const d=new Date(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function nextQuarter(){
    const d=new Date(); const m=d.getMinutes(); const add=15-(m%15||15); d.setMinutes(m+add,0,0);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // --- helper: עיגול ל-15 דקות (24h) ---
  function roundTo15(value) {
    if (typeof value !== "string" || !value) return value;
    const t = /^\d{2}\.\d{2}$/.test(value) ? value.replace(".", ":") : value;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return value;
    let h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
    let mi = Math.max(0, Math.min(59, parseInt(m[2], 10)));
    mi = Math.round(mi / 15) * 15;
    if (mi === 60) { mi = 0; h = (h + 1) % 24; }
    return `${pad2(h)}:${pad2(mi)}`;
  }

  // ------------------------
  // Time pickers (24h, 15min)
  // ------------------------
  function applyAttrs(el){
    // עוזר לרמוז לספריות/לדפדפן
    el.setAttribute("inputmode","numeric");
    el.setAttribute("placeholder","HH:MM");
    el.setAttribute("pattern","^\\d{2}:\\d{2}$");
    el.setAttribute("autocomplete","off");
    el.setAttribute("dir","ltr");
    // data-* למימושים שונים של TW Elements / Flowbite
    el.setAttribute("data-te-format24","true");
    el.setAttribute("data-te-increment","15");
    el.setAttribute("data-format","HH:mm");
    el.setAttribute("data-minute-increment","15");
  }

  function initFlatpickr(el) {
    try {
      if (!window.flatpickr) return false;
      const inst = el._flatpickr;
      const opts = {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",
        time_24hr: true,
        minuteIncrement: 15,
        allowInput: true,
      };
      if (inst && typeof inst.set === "function") inst.set(opts);
      else window.flatpickr(el, opts);
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      return true;
    } catch { return false; }
  }

  function initTWElements(el) {
    try {
      const te = window.te || window.TWElements || window.mdb;
      const Cls = te && (te.Timepicker || te.TimePicker);
      if (!Cls) return false;

      // נסה להשיג אינסטנס קיים ולעדכן; אם לא — צור חדש
      let inst = (te.getInstance && te.getInstance(el, te.Timepicker || te.TimePicker)) || el._teTimepickerInstance || null;

      const opts = {
        // כיסינו כמה שמות אפשריים של אפשרויות בין גרסאות:
        format24: true, format: "24", twelveHour: false,
        increment: 15, step: 15, minutesStep: 15
      };

      if (inst && typeof inst.setOptions === "function") {
        inst.setOptions(opts);
      } else {
        inst = new Cls(el, opts);
        el._teTimepickerInstance = inst;
      }
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      return true;
    } catch { return false; }
  }

  function initFlowbite(el) {
    try {
      const FB = window.Flowbite || window.flowbite;
      const Cls = (FB && (FB.Timepicker || FB.TimePicker)) || window.Timepicker || window.TimePicker;
      if (!Cls) return false;

      let inst = el._flowbiteInstance || null;
      const opts = { format: "HH:mm", stepping: 15, minuteIncrement: 15 };
      if (!inst) {
        inst = new Cls(el, opts);
        el._flowbiteInstance = inst;
      } else if (typeof inst.setOptions === "function") {
        inst.setOptions(opts);
      }
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      return true;
    } catch { return false; }
  }

  function initNative(el) {
    try {
      el.type = "time";
      el.step = 900; // 15 דקות
      if (el.value) el.value = roundTo15(el.value);
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      return true;
    } catch { return false; }
  }

  function initOneTimeInput(el){
    if (el._timePickerInited) return;
    el._timePickerInited = true;
    applyAttrs(el);

    // סדר עדיפויות: Flatpickr → TW Elements → Flowbite → native
    const ok =
      initFlatpickr(el) ||
      initTWElements(el) ||
      initFlowbite(el) ||
      initNative(el);

    // נרמול מיידי + שמירת 24h בתיבה
    if (el.value) el.value = roundTo15(el.value);
    if (!ok) {
      // נוודא שלפחות ה-step הנייטיבי נמצא
      try { el.step = 900; } catch {}
    }
  }

  function ensureTimePicker(root=document) {
    const inputs = root.querySelectorAll('input[name="time"]');
    inputs.forEach(initOneTimeInput);
  }

  // ניטור DOM — אם תוסף מאתחל מאוחר/מחליף את ה-input, ניישם שוב
  const mo = new MutationObserver((mutations)=>{
    for(const m of mutations){
      for(const node of (m.addedNodes || [])){
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches && node.matches('input[name="time"]')) initOneTimeInput(node);
        // אם נוספו צאצאים, נבדוק שם:
        const found = node.querySelectorAll ? node.querySelectorAll('input[name="time"]') : [];
        found && found.forEach(initOneTimeInput);
      }
      if (m.type === "attributes" && m.target && m.target.matches && m.target.matches('input[name="time"]')) {
        initOneTimeInput(m.target);
      }
    }
  });
  try { mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class","data-te-format24","data-te-increment"] }); } catch {}

  // --- Autocomplete ---
  const q = document.getElementById("q");
  const ac = document.getElementById("ac-list");
  function clearAC(){ if(ac) ac.innerHTML=""; }
  function renderAC(items){
    if(!ac) return;
    if(!items||items.length===0){ clearAC(); return; }
    const panel=document.createElement("div"); panel.className="panel";
    items.slice(0,8).forEach(r=>{
      const div=document.createElement("div"); div.className="ac-item";
      div.innerHTML=`<strong>${escapeHtml(r.name)}</strong><br><small class="muted">${escapeHtml(r.city)} · ${escapeHtml(r.address)}</small>`;
      div.addEventListener("click",()=>{ window.location.href=`/restaurants/${r.id}`; });
      panel.appendChild(div);
    });
    ac.innerHTML=""; ac.appendChild(panel);
  }
  function escapeHtml(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}
  let timer=null;
  if(q){
    q.addEventListener("input",()=>{
      const val=q.value.trim(); if(!val){ clearAC(); return; }
      clearTimeout(timer);
      timer=setTimeout(async()=>{
        try{
          const res=await fetch(`/api/restaurants?q=${encodeURIComponent(val)}`);
          if(!res.ok) throw new Error("bad status");
          const items=await res.json(); renderAC(items);
        }catch{ clearAC(); }
      },180);
    });
    document.addEventListener("click",(e)=>{ if(ac && !ac.contains(e.target) && e.target!==q) clearAC(); });
  }

  // --- Reservation check button (AJAX) ---
  const checkBtn=document.getElementById("check-btn");
  const form=document.getElementById("reserve-form");
  const result=document.getElementById("reserve-result");
  async function post(url,data){
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(data)});
    const json=await res.json().catch(()=>({})); return {ok:res.ok,json};
  }
  if(checkBtn && form && result){
    ensureTimePicker(form);

    checkBtn.addEventListener("click", async ()=>{
      const rid=checkBtn.dataset.rid;
      let date=form.querySelector('input[name="date"]').value.trim();
      let time=form.querySelector('input[name="time"]').value.trim();
      const people=form.querySelector('input[name="people"]').value;

      if(!date) date=todayISO();
      if(!time) time=nextQuarter();
      time = roundTo15(time) || nextQuarter();

      if(!rid || !people){ result.textContent="נא למלא את כל השדות"; return; }
      const {ok,json}=await post(`/api/restaurants/${encodeURIComponent(rid)}/check`,{date,time,people:Number(people)});
      if(ok && json.ok){
        result.textContent="זמין! ניתן להגיש את הטופס להזמנה."; result.classList.remove("warn");
      }else{
        result.classList.add("warn");
        result.innerHTML=`לא זמין. ${json.reason==="full"?"מלא בתאריך/שעה זו.":"שגיאה."} `+(json.suggestions?.length?`הצעות: ${json.suggestions.join(", ")}`:"");
      }
    });
  }

  // אתחול כללי לאחר טעינה
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureTimePicker(document));
  } else {
    ensureTimePicker(document);
  }

  // חשיפה אם צריך לאתחל אחרי ניווט דינמי
  window.GeoTable = window.GeoTable || {};
  window.GeoTable.ensureTimePicker = ensureTimePicker;
})();
