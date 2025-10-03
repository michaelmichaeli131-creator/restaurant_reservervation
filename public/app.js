/* public/app.js
 * אוטוקומפליט + בדיקות זמינות קיימות (ללא שינוי התנהגות),
 * בתוספת שדרוג בחירת שעה: 24h וצעדים של 15 דקות, כולל נרמול ערך.
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
    // תמיכה גם ב-"08.30" → "08:30"
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
  // Time picker (24h, 15min)
  // ------------------------
  function initNativeTimeInput(el) {
    try {
      // <input type="time"> כבר עובד ב-24h מבחינת value; step=900 (15 דק)
      el.type = "time";
      el.step = 900; // 15 * 60
      // שמירה על ערך עגול לרבע שעה
      if (el.value) el.value = roundTo15(el.value);
      el.addEventListener("blur", () => {
        if (el.value) el.value = roundTo15(el.value);
      });
    } catch (e) {
      console.warn("[time-input] native init failed:", e);
    }
  }

  function initFlatpickr(el) {
    try {
      if (!window.flatpickr) return false;
      window.flatpickr(el, {
        enableTime: true,
        noCalendar: true,
        dateFormat: "H:i",   // 24h
        time_24hr: true,
        minuteIncrement: 15, // מרווח 15 דק
        allowInput: true,
        onClose: function() {
          if (el.value) el.value = roundTo15(el.value);
        }
      });
      return true;
    } catch (e) {
      console.warn("[time-input] flatpickr init failed:", e);
      return false;
    }
  }

  function ensureTimePicker(root=document) {
    // נאתחל כל שדה time שנמצא (גם בשלב 1 וגם בטפסים אחרים אם קיימים)
    const inputs = root.querySelectorAll('input[name="time"]');
    inputs.forEach((input) => {
      if (input._timePickerInited) return;
      input._timePickerInited = true;
      const usedFlatpickr = initFlatpickr(input);
      if (!usedFlatpickr) initNativeTimeInput(input);
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
    // הבטחת time picker (24h/15min) עבור הטופס הזה
    ensureTimePicker(form);

    checkBtn.addEventListener("click", async ()=>{
      const rid=checkBtn.dataset.rid;
      let date=form.querySelector('input[name="date"]').value.trim();
      let time=form.querySelector('input[name="time"]').value.trim();
      const people=form.querySelector('input[name="people"]').value;

      if(!date) date=todayISO();
      if(!time) time=nextQuarter();
      // נרמול זמן לרבע שעה (אם המשתמש הקליד ידנית)
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

  // אתחול גלובלי לאחר טעינת הדף (למקרה שיש עוד טפסים עם name="time")
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureTimePicker(document));
  } else {
    ensureTimePicker(document);
  }

  // חשיפה עדינה אם צריך לאתחל שוב אחרי ניווט דינמי
  window.GeoTable = window.GeoTable || {};
  window.GeoTable.ensureTimePicker = ensureTimePicker;
})();
