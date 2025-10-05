<% layout("_layout", it) %>

<section class="card" style="max-width:920px;margin:24px auto">
  <header class="page-header">
    <h1 style="margin:0 0 8px">שעות פתיחה — <%= it.restaurant.name %></h1>
    <p class="muted" style="margin:0"><%= it.restaurant.city %> · <%= it.restaurant.address %></p>
    <% if (it.saved) { %>
      <div class="alert success" role="alert" style="margin-top:12px">
        השעות נשמרו בהצלחה.
      </div>
    <% } %>
  </header>

  <form id="hours-form" class="form-grid" method="post" action="/owner/restaurants/<%= it.restaurant.id %>/hours" novalidate>
    <input type="hidden" name="__owner_hours_form" value="1"/>

    <table class="hours-table">
      <thead>
        <tr>
          <th style="width:120px">יום</th>
          <th style="width:110px">פתיחה</th>
          <th style="width:110px">סגירה</th>
          <th style="width:90px">פעיל</th>
          <th>דוגמה</th>
        </tr>
      </thead>
      <tbody>
        <% for (let d=0; d<=6; d++) { 
             const cur = (it.weekly?.[d] || null);
             const open = cur?.open || "";
             const close = cur?.close || "";
             const enabled = !!cur;
        %>
          <tr>
            <td><strong><%= it.labels[d] %></strong></td>
            <td>
              <input type="time" lang="he-IL" class="open" id="d<%= d %>_open" name="d<%= d %>_open"
                     placeholder="HH:mm" value="<%= open %>" inputmode="numeric" />
            </td>
            <td>
              <input type="time" lang="he-IL" class="close" id="d<%= d %>_close" name="d<%= d %>_close"
                     placeholder="HH:mm" value="<%= close %>" inputmode="numeric" />
            </td>
            <td style="text-align:center">
              <input type="checkbox" class="enabled" id="d<%= d %>_enabled" name="d<%= d %>_enabled" <%= enabled ? "checked" : "" %> />
            </td>
            <td class="muted example">הזינו פורמט 24-שעות — לדוגמה: 08:00 · 19:30</td>
          </tr>
        <% } %>
      </tbody>
    </table>

    <div class="form-actions" style="margin-top:16px;display:flex;gap:10px">
      <button type="submit" class="btn">שמירת שעות</button>
      <a class="btn secondary" href="/owner/restaurants/<%= it.restaurant.id %>">חזרה לניהול מסעדה</a>
    </div>
  </form>
</section>

<style>
  .form-grid{display:block}
  .hours-table{width:100%;border-collapse:collapse;margin-top:12px}
  .hours-table th,.hours-table td{border:1px solid #eee;padding:8px;vertical-align:middle}
  .hours-table thead th{background:#fafafa}
  .btn{background:#111;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
  .btn.secondary{background:#666}
  .alert.success{border:1px solid #b7f0c0;background:#e9fff0;border-radius:8px;padding:10px}
  .muted{color:#777}
  /* הסתרת AM/PM בפיקרים מבוססי WebKit (כפיית תצוגת 24h ברמת UI היכן שניתן) */
  input[type="time"]::-webkit-datetime-edit-ampm-field { display: none; }
  input[type="time"] { width:7.5em; }
</style>

<script>
  (function(){
    const DAYS = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];

    // פורמט 24h + תמיכה ב-AM/PM אם הוזן ידנית (למשל בספארי/פיירפוקס כש-type=time לא נתמך)
    const isHHMM = (s)=>/^\d{1,2}:\d{2}$/.test(String(s||"").trim());
    const normHHMM = (s) => {
      s = String(s||"").trim();
      if (!s) return "";
      // 08.30 -> 08:30 (וגם אם יש AM/PM בסוף)
      if (/^\d{1,2}\.\d{2}(\s*[ap]m)?$/i.test(s)) s = s.replace(".", ":");

      // AM/PM -> 24h
      const ampm = s.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
      if (ampm) {
        let h = parseInt(ampm[1], 10);
        const mi = Math.max(0, Math.min(59, parseInt(ampm[2], 10)));
        const pm = /pm/i.test(ampm[3]);
        if (pm && h < 12) h += 12;
        if (!pm && h === 12) h = 0; // 12:xx AM -> 00:xx
        return String(h).padStart(2,"0") + ":" + String(mi).padStart(2,"0");
      }

      // כבר בפורמט H:MM / HH:MM
      const m = s.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return s;
      let h = Math.max(0, Math.min(23, parseInt(m[1],10)));
      let mi = Math.max(0, Math.min(59, parseInt(m[2],10)));
      return String(h).padStart(2,"0") + ":" + String(mi).padStart(2,"0");
    };

    function readForm() {
      const rows = [];
      for (let d=0; d<=6; d++){
        const en = document.getElementById(`d${d}_enabled`);
        const o  = document.getElementById(`d${d}_open`);
        const c  = document.getElementById(`d${d}_close`);

        let open = normHHMM(o?.value || "");
        let close = normHHMM(c?.value || "");
        const enabled = !!en?.checked || (!!open && !!close);

        rows.push({ d, open, close, enabled });
      }
      return rows;
    }

    function validateRows(rows){
      const errs = [];
      for (const r of rows){
        if (!r.enabled) continue;
        if (!isHHMM(r.open) || !isHHMM(r.close)) {
          errs.push(`יום ${DAYS[r.d]}: יש להזין שעות בפורמט 24-שעות (HH:mm)`);
          continue;
        }
        // אין כאן אימות לוגי (פתיחה < סגירה) כי בצד השרת זה כבר מטופל כ"חותך עד סוף היום" אם צריך.
      }
      return errs;
    }

    function rowsToFormBody(rows){
      const sp = new URLSearchParams();
      for (const r of rows){
        if (r.open) sp.set(`d${r.d}_open`, r.open);
        if (r.close) sp.set(`d${r.d}_close`, r.close);
        if (r.enabled) sp.set(`d${r.d}_enabled`, "on");
      }
      return sp;
    }

    const form = document.getElementById("hours-form");
    form?.addEventListener("submit", async (ev)=>{
      try{
        ev.preventDefault();
        const rows = readForm();
        const errs = validateRows(rows);
        if (errs.length){
          alert(errs.join("\n"));
          return;
        }
        const body = rowsToFormBody(rows);
        // שליחה לשרת — application/x-www-form-urlencoded
        const res = await fetch(form.action, {
          method: "POST",
          headers: {"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
          body
        });
        if (res.redirected) {
          window.location.href = res.url;
          return;
        }
        if (!res.ok){
          const txt = await res.text();
          alert("שגיאה בשמירה:\n" + txt);
          return;
        }
        // fallback: רענון ידני עם saved=1
        const u = new URL(window.location.href);
        u.searchParams.set("saved","1");
        window.location.replace(u.toString());
      }catch(e){
        alert("שגיאה בלתי צפויה: " + e);
      }
    });

    // בעת עזיבת השדה — נרמל ל-HH:mm כדי שגם אם הוזן 7:00 PM יראה כ-19:00
    document.querySelectorAll('input[type="time"]').forEach((el)=>{
      el.addEventListener("blur", ()=>{
        const v = normHHMM(el.value);
        if (isHHMM(v)) el.value = v;
      });
    });
  })();
</script>
