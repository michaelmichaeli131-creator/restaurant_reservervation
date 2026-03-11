(function(){
  function detectBrowserTimeZone(){
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
  }
  function partsInTimeZone(timeZone){
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      });
      const parts = fmt.formatToParts(new Date());
      const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
      return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
    } catch {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return { date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
    }
  }

  function init(root){
    if(!root) return;
    const rid = root.getAttribute('data-rid') || '';
    if(!rid) return;
    const preview = root.querySelector('.js-system-time-preview');
    const dateInput = root.querySelector('.js-system-time-date');
    const timeInput = root.querySelector('.js-system-time-time');
    const tzInput = root.querySelector('.js-system-time-zone');
    const applyBtn = root.querySelector('.js-system-time-apply');
    const nowBtn = root.querySelector('.js-system-time-now');
    const status = root.querySelector('.js-system-time-status');
    const msgPick = root.getAttribute('data-msg-pick') || 'Please choose both date and time.';
    const msgError = root.getAttribute('data-msg-error') || 'Unable to update restaurant time.';
    const msgSaved = root.getAttribute('data-msg-saved') || 'Restaurant time saved.';
    const msgReset = root.getAttribute('data-msg-reset') || 'Returned to real time.';
    const msgHint = root.getAttribute('data-msg-hint') || '';
    const reloadMode = (root.getAttribute('data-reload') || 'true') !== 'false';
    const shouldDetectTimeZone = (root.getAttribute('data-detect-timezone') || 'false') === 'true';

    function updatePreview(){
      if (!preview) return;
      const date = dateInput && dateInput.value ? dateInput.value : '';
      const time = timeInput && timeInput.value ? timeInput.value : '';
      preview.textContent = date && time ? `${date} • ${time}` : `${date || ''}${date && time ? ' • ' : ''}${time || ''}`;
    }

    const hadInitialTimeZone = !!(tzInput && tzInput.value);

    function ensureDefaults(forceDateTime){
      const browserTz = detectBrowserTimeZone();
      if (tzInput && shouldDetectTimeZone && !tzInput.value && browserTz) tzInput.value = browserTz;
      if (forceDateTime || !dateInput?.value || !timeInput?.value) {
        const parts = partsInTimeZone((tzInput && tzInput.value) || browserTz || undefined);
        if (dateInput && !dateInput.value) dateInput.value = parts.date;
        if (timeInput && !timeInput.value) timeInput.value = parts.time;
      }
      updatePreview();
    }

    
    async function persistTimezoneSilently(){
      try {
        const timezone = (tzInput && tzInput.value) || detectBrowserTimeZone() || '';
        if (!timezone) return;
        await fetch(`/api/restaurants/${encodeURIComponent(rid)}/system-time`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ mode: 'timezone', timezone }),
        });
      } catch (err) {
        console.warn('[restaurant-system-time] timezone persist skipped', err);
      }
    }

    async function apply(mode){
      try {
        ensureDefaults(mode === 'reset');
        const timezone = (tzInput && tzInput.value) || detectBrowserTimeZone() || '';
        const body = mode === 'reset'
          ? { mode: 'reset', timezone }
          : { mode: 'set', date: dateInput && dateInput.value, time: timeInput && timeInput.value, timezone };
        if (mode !== 'reset' && (!body.date || !body.time)) {
          window.alert(msgPick);
          return;
        }
        const res = await fetch(`/api/restaurants/${encodeURIComponent(rid)}/system-time`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (preview) preview.textContent = `${data.date || ''} • ${data.time || ''}`;
        if (dateInput && data.date) dateInput.value = data.date;
        if (timeInput && data.time) timeInput.value = data.time;
        if (tzInput && data.timezone) tzInput.value = data.timezone;
        if (status) status.textContent = mode === 'reset' ? msgReset : msgSaved;
        if (reloadMode) {
          window.setTimeout(function(){ window.location.reload(); }, 160);
        }
      } catch (err) {
        console.error('[restaurant-system-time]', err);
        if (status) status.textContent = msgError;
        else window.alert(msgError);
      }
    }

    ensureDefaults(false);
    if (!hadInitialTimeZone && tzInput && tzInput.value) persistTimezoneSilently();
    if (applyBtn) applyBtn.addEventListener('click', function(){ apply('set'); });
    if (nowBtn) nowBtn.addEventListener('click', function(){ apply('reset'); });
    if (status && !status.textContent.trim() && msgHint) status.textContent = msgHint;
    if (dateInput) dateInput.addEventListener('change', updatePreview);
    if (timeInput) timeInput.addEventListener('change', updatePreview);
    if (tzInput) tzInput.addEventListener('change', function(){ ensureDefaults(false); });
  }

  function boot(){
    document.querySelectorAll('.js-restaurant-time').forEach(init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
