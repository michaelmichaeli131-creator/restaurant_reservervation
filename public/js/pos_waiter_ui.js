// public/js/pos_waiter_ui.js
// UI helpers for the waiter table screen: mobile tabs + bottom bar.

(function () {
  const page = document.querySelector('.sb-wt-page');
  if (!page) return;

  const tabs = Array.from(page.querySelectorAll('.sb-wt-tabs .sb-tab'));
  const bottomBtns = Array.from(page.querySelectorAll('.sb-wt-bottom [data-view]'));

  const KEY = 'sb_waiter_table_view';

  function setView(view) {
    if (view !== 'menu' && view !== 'order') view = 'order';
    page.dataset.view = view;

    tabs.forEach((b) => b.classList.toggle('is-active', (b.dataset.view === view)));
    bottomBtns.forEach((b) => b.classList.toggle('is-active', (b.dataset.view === view)));

    try {
      sessionStorage.setItem(KEY, view);
    } catch (_) {
      // ignore
    }
  }

  function getInitialView() {
    try {
      const v = sessionStorage.getItem(KEY);
      if (v === 'menu' || v === 'order') return v;
    } catch (_) {}
    return 'order';
  }

  // Click handlers
  page.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-view]');
    if (!btn) return;

    // Only handle our UI controls (avoid accidental dataset.view on other elements)
    if (!btn.classList.contains('sb-tab') && !btn.classList.contains('sb-wt-bottom-btn')) return;

    ev.preventDefault();
    setView(btn.dataset.view);

    // On mobile, move focus to top for a smoother experience.
    if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Init
  setView(getInitialView());
})();
