(function(){
  function init(root){
    if(!root) return;
    const rid = root.getAttribute('data-rid') || '';
    if(!rid) return;
    const preview = root.querySelector('.js-system-time-preview');
    const dateInput = root.querySelector('.js-system-time-date');
    const timeInput = root.querySelector('.js-system-time-time');
    const applyBtn = root.querySelector('.js-system-time-apply');
    const nowBtn = root.querySelector('.js-system-time-now');
    const status = root.querySelector('.js-system-time-status');
    const msgPick = root.getAttribute('data-msg-pick') || 'Please choose both date and time.';
    const msgError = root.getAttribute('data-msg-error') || 'Unable to update restaurant time.';
    const msgSaved = root.getAttribute('data-msg-saved') || 'Restaurant time saved. Refreshing…';
    const msgReset = root.getAttribute('data-msg-reset') || 'Returned to real time. Refreshing…';
    const msgHint = root.getAttribute('data-msg-hint') || '';
    const reloadMode = (root.getAttribute('data-reload') || 'true') !== 'false';

    async function apply(mode){
      try {
        const body = mode === 'reset'
          ? { mode: 'reset' }
          : { date: dateInput && dateInput.value, time: timeInput && timeInput.value };
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

    if (applyBtn) applyBtn.addEventListener('click', function(){ apply('set'); });
    if (nowBtn) nowBtn.addEventListener('click', function(){ apply('reset'); });
    if (status && !status.textContent.trim() && msgHint) status.textContent = msgHint;
  }

  function boot(){
    document.querySelectorAll('.js-restaurant-time').forEach(init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
