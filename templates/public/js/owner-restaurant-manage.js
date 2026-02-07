/* SpotBook – Owner Restaurant Manage page
 * Task 4: search/filter + density toggle (desktop-friendly) + small UX polish.
 * No external deps, CSP-friendly (self).
 */

function normalize(str) {
  return (str || '')
    .toString()
    .trim()
    .toLowerCase();
}

function termsOf(q) {
  return normalize(q)
    .split(/\s+/)
    .filter(Boolean);
}

function matchesAll(haystack, terms) {
  if (!terms.length) return true;
  const h = normalize(haystack);
  return terms.every((t) => h.includes(t));
}

function setEmptyState(container, isEmpty) {
  const el = container?.querySelector('[data-sb-empty]');
  if (!el) return;
  el.style.display = isEmpty ? '' : 'none';
}

function applyFilter(q) {
  const terms = termsOf(q);
  const items = Array.from(document.querySelectorAll('[data-sb-search]'));
  let visibleCount = 0;

  for (const it of items) {
    const text = it.getAttribute('data-sb-search') || it.textContent || '';
    const ok = matchesAll(text, terms);
    it.style.display = ok ? '' : 'none';
    if (ok) visibleCount++;
  }

  const root = document.querySelector('[data-sb-filter-root]');
  setEmptyState(root, terms.length > 0 && visibleCount === 0);
}

function setDensity(mode) {
  const body = document.body;
  const isCompact = mode === 'compact';
  body.classList.toggle('sb-compact', isCompact);
  try {
    localStorage.setItem('sbDensity', isCompact ? 'compact' : 'comfortable');
  } catch (_) {}

  const btn = document.getElementById('sbDensityToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', isCompact ? 'true' : 'false');
    btn.textContent = isCompact ? 'תצוגה רגילה' : 'תצוגה קומפקטית';
  }
}

function initDensity() {
  let mode = 'comfortable';
  try {
    mode = localStorage.getItem('sbDensity') || 'comfortable';
  } catch (_) {}
  setDensity(mode);

  const btn = document.getElementById('sbDensityToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.body.classList.contains('sb-compact') ? 'comfortable' : 'compact';
      setDensity(next);
    });
  }
}

function initSearch() {
  const input = document.getElementById('sbFeatureSearch');
  if (!input) return;

  const onInput = () => applyFilter(input.value);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      applyFilter('');
      input.blur();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initDensity();
  initSearch();
});
