// public/js/pos_waiter_note.js
// Shared note for the active waiter check.

(function(){
  const bill = document.getElementById('bill-summary');
  const input = document.getElementById('order-service-note');
  const btn = document.getElementById('btn-save-order-note');
  const status = document.getElementById('order-service-note-status');
  if (!bill || !input || !btn || !status) return;

  const rid = String(bill.dataset.rid || '').trim();
  const table = Number(bill.dataset.table || '0');
  const accountId = String(bill.dataset.accountId || 'main').trim() || 'main';
  input.dataset.initial = String(input.value || '').trim();

  function setStatus(text, tone){
    status.textContent = text;
    status.classList.remove('is-dirty','is-saving','is-saved','is-error');
    if (tone) status.classList.add(tone);
  }

  function currentValue(){
    return String(input.value || '').trim();
  }

  function updateDirtyState(){
    const dirty = currentValue() !== String(input.dataset.initial || '').trim();
    btn.disabled = !dirty;
    if (dirty) setStatus('Unsaved changes', 'is-dirty');
    else setStatus(currentValue() ? 'Saved to this check' : 'No shared note yet', currentValue() ? 'is-saved' : '');
  }

  async function save(){
    if (!rid || !table) return;
    const serviceNote = currentValue();
    btn.disabled = true;
    setStatus('Saving…', 'is-saving');
    try{
      const res = await fetch('/api/pos/table-account/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: rid, table, accountId, serviceNote }),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.message || ('HTTP ' + res.status));
      input.dataset.initial = String(data.serviceNote || '').trim();
      input.value = String(data.serviceNote || '');
      setStatus(input.dataset.initial ? 'Saved to this check' : 'No shared note yet', input.dataset.initial ? 'is-saved' : '');
    }catch(err){
      console.error('waiter note save failed', err);
      setStatus('Could not save note', 'is-error');
      btn.disabled = false;
      return;
    }
    updateDirtyState();
  }

  input.addEventListener('input', updateDirtyState);
  input.addEventListener('blur', () => {
    if (currentValue() !== String(input.dataset.initial || '').trim()) save();
  });
  input.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      save();
    }
  });
  btn.addEventListener('click', save);

  updateDirtyState();
})();
