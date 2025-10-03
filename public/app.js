/* public/app.js
 * קיים: אוטוקומפליט + בדיקת זמינות (ללא שינוי).
 * חדש: כיוונון timepicker ל-24h ו-step 15 דק בכל ספרייה נפוצה (flatpickr / tw-elements / flowbite),
 * וגם fallback ל-native <input type="time"> עם step=900.
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
  function initFlatpickr(el) {
    try {
      if (!window.flatpickr) return false;
      // אם כבר מאותחל, נעדכן אפשרויות דרך instance.config (ככל הניתן)
      const inst = el._flatpickr;
      if (inst) {
        inst.set({ dateFormat: "H:i", time_24hr: true, minuteIncrement: 15, allowInput: true });
      } else {
        window.flatpickr(el, {
          enableTime: true,
          noCalendar: true,
          dateFormat: "H:i",
          time_24hr: true,
          minuteIncrement: 15,
          allowInput: true,
        });
      }
      // נרמול ערך על blur
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      console.debug("[time-input] flatpickr: 24h/15m applied");
      return true;
    } catch (e) {
      console.warn("[time-input] flatpickr init failed:", e);
      return false;
    }
  }

  // TW Elements (MDB/Tailwind) timepicker
  function initTWElements(el) {
    try {
      const te = window.te || window.TWElements || window.mdb; // כינויים אפשריים
      if (!te || !te.Timepicker) return false;

      // אם קיים אינסטנס — נעדכן קונפיג (חלק מהגרסאות תומכות setOptions)
      const inst = te.getInstance ? te.getInstance(el, te.Timepicker) : null;
      const opts = { format24: true, increment: 15 }; // בחלק מהגרסאות: { format: '24', increment: 15 }
      if (inst && typeof inst.setOptions === "function") {
        inst.setOptions(opts);
      } else {
        // ייתכן שהאתחול נעשה עם data-*; נכריח אתחול מחדש לא הרסני
        // נסמן שנאתחל פעם אחת
        if (!el._teTimepickerApplied) {
          el.setAttribute("data-te-format24", "true");
          el.setAttribute("data-te-increment", "15");
          // חלק מהגרסאות דורשות init מפורש:
          try { new te.Timepicker(el, opts); } catch(_) {}
          el._teTimepickerApplied = true;
        }
      }
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      console.debug("[time-input] TW Elements: 24h/15m applied");
      return true;
    } catch (e) {
      console.warn("[time-input] TW Elements init failed:", e);
      return false;
    }
  }

  // Flowbite timepicker (flowbite-datepicker/timepicker)
  function initFlowbite(el) {
    try {
      const FB = window.Flowbite || window.flowbite;
      // יש כמה חבילות; ננסה API נפוצים:
      const Cls = (FB && (FB.Timepicker || FB.TimePicker)) || window.Timepicker || window.TimePicker;
      if (!Cls) return false;

      if (!el._flowbiteApplied) {
        // חלק מהגרסאות: { format: 'HH:mm', minuteIncrement/stepping: 15 }
        const opts = { format: 'HH:mm', stepping: 15, minuteIncrement: 15 };
        try { new Cls(el, opts); } catch (_) {}
        el._flowbiteApplied = true;
      }
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      console.debug("[time-input] Flowbite: 24h/15m applied");
      return true;
    } catch (e) {
      console.warn("[time-input] Flowbite init failed:", e);
      return false;
    }
  }

  // Native <input type="time">
  function initNative(el) {
    try {
      el.type = "time";
      el.step = 900; // 15 דקות
      if (el.value) el.value = roundTo15(el.value);
      el.addEventListener("blur", () => { if (el.value) el.value = roundTo15(el.value); });
      console.debug("[time-input] native time input: step=900");
      return true;
    } catch (e) {
      console.warn("[time-input] native init failed:", e);
      return false;
    }
  }

  function ensureTimePicker(root=document) {
    const inputs = root.querySelectorAll('input[name="time"]');
    inputs.forEach((input) => {
      if (input._timePickerInited) return;
      input._timePickerInited = true;

      // נסה ספריות לפי סדר: flatpickr → tw-elements → flowbite → native
      const ok =
        initFlatpickr(input) ||
        initTWElements(input) ||
        initFlowbite(input) ||
        initNative(input);

      // נרמול מיידי לערך קיים
      if (ok && input.value) input.value = roundTo15(input.value);
    });
  }

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
    document.addEventListener("click",(e)=>{ if(!ac.contains(e.target)&&e.target!==q) clearAC(); });
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

  // אתחול כללי
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureTimePicker(document));
  } else {
    ensureTimePicker(document);
  }

  // חשיפה עדינה אם צריך לאתחל שוב אחרי ניווט דינמי
  window.GeoTable = window.GeoTable || {};
  window.GeoTable.ensureTimePicker = ensureTimePicker;
})();
