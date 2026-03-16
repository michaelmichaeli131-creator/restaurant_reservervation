(() => {
  const raf = (fn) => window.requestAnimationFrame(fn);

  function initFeaturedCarousel(root) {
    const viewport = root.querySelector('[data-featured-viewport]');
    const track = root.querySelector('[data-featured-track]');
    const slides = Array.from(root.querySelectorAll('[data-featured-slide]'));
    const prevBtn = root.querySelector('[data-featured-prev]');
    const nextBtn = root.querySelector('[data-featured-next]');
    const dotsWrap = root.querySelector('[data-featured-dots]');
    if (!viewport || !track || !slides.length || !dotsWrap) return;

    let dots = [];
    let autoplayTimer = null;
    const AUTOPLAY_MS = 3600;

    function gapSize() {
      return parseFloat(getComputedStyle(track).gap || '0') || 0;
    }

    function slideSpan() {
      const first = slides[0];
      if (!first) return 320;
      return first.getBoundingClientRect().width + gapSize();
    }

    function maxIndex() {
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const span = slideSpan();
      if (!span) return 0;
      return Math.max(0, Math.round(maxScroll / span));
    }

    function currentIndex() {
      const span = slideSpan();
      if (!span) return 0;
      return Math.max(0, Math.min(maxIndex(), Math.round(viewport.scrollLeft / span)));
    }

    function renderDots() {
      const total = maxIndex() + 1;
      dotsWrap.innerHTML = '';
      dots = [];
      for (let i = 0; i < total; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'featured-dot';
        btn.setAttribute('aria-label', `Go to restaurant ${i + 1}`);
        btn.addEventListener('click', () => {
          goToIndex(i);
          restartAutoplay();
        });
        dotsWrap.appendChild(btn);
        dots.push(btn);
      }
      syncDots();
    }

    function syncDots() {
      const index = currentIndex();
      dots.forEach((dot, idx) => dot.classList.toggle('is-active', idx === index));
    }

    function goToIndex(index) {
      const span = slideSpan();
      const target = Math.max(0, Math.min(maxIndex(), index));
      viewport.scrollTo({ left: target * span, behavior: 'smooth' });
      raf(syncDots);
    }

    function step(dir) {
      goToIndex(currentIndex() + dir);
    }

    function nextAuto() {
      const max = maxIndex();
      if (max <= 0) return;
      const next = currentIndex() >= max ? 0 : currentIndex() + 1;
      goToIndex(next);
    }

    function stopAutoplay() {
      if (autoplayTimer) {
        clearInterval(autoplayTimer);
        autoplayTimer = null;
      }
    }

    function startAutoplay() {
      stopAutoplay();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (maxIndex() <= 0) return;
      autoplayTimer = setInterval(nextAuto, AUTOPLAY_MS);
    }

    function restartAutoplay() {
      startAutoplay();
    }

    prevBtn?.addEventListener('click', () => {
      step(-1);
      restartAutoplay();
    });

    nextBtn?.addEventListener('click', () => {
      step(1);
      restartAutoplay();
    });

    viewport.addEventListener('scroll', () => raf(syncDots), { passive: true });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const oldIndex = currentIndex();
        renderDots();
        goToIndex(oldIndex);
        restartAutoplay();
      }, 120);
    });

    let startX = 0;
    viewport.addEventListener('touchstart', (e) => {
      if (!e.touches?.[0]) return;
      startX = e.touches[0].clientX;
      stopAutoplay();
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
      const endX = e.changedTouches?.[0]?.clientX;
      if (typeof endX !== 'number') {
        restartAutoplay();
        return;
      }
      const dx = endX - startX;
      if (Math.abs(dx) >= 45) {
        step(dx > 0 ? -1 : 1);
      }
      restartAutoplay();
    }, { passive: true });

    root.addEventListener('mouseenter', stopAutoplay);
    root.addEventListener('mouseleave', startAutoplay);
    root.addEventListener('focusin', stopAutoplay);
    root.addEventListener('focusout', startAutoplay);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAutoplay();
      else startAutoplay();
    });

    renderDots();
    startAutoplay();
  }

  function initHomepageAutocomplete() {
    const form = document.getElementById('search-form');
    const input = document.getElementById('q');
    const list = document.getElementById('ac-list');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement) || !list) return;

    const endpoint = form.dataset.autocompleteUrl || '/api/restaurants';
    const placeholder = '/static/placeholder.png';
    let activeIndex = -1;
    let items = [];
    let abortController = null;
    let debounceTimer = null;

    const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch] || ch));

    function pickPhoto(item) {
      if (typeof item.cover === 'string' && item.cover.trim()) return item.cover.trim();
      if (typeof item.photoUrl === 'string' && item.photoUrl.trim()) return item.photoUrl.trim();
      if (Array.isArray(item.photos) && item.photos.length) {
        const first = item.photos.find((p) => typeof p === 'string' && p.trim());
        if (first) return first.trim();
      }
      return placeholder;
    }

    function normalize(itemsRaw) {
      return (Array.isArray(itemsRaw) ? itemsRaw : []).slice(0, 6).map((item) => ({
        id: String(item?.id ?? ''),
        name: String(item?.name ?? '').trim(),
        city: String(item?.city ?? '').trim(),
        address: String(item?.address ?? '').trim(),
        kitchens: Array.isArray(item?.kitchenCategories) ? item.kitchenCategories.filter(Boolean).slice(0, 2).join(' · ') : '',
        photo: pickPhoto(item),
      })).filter((item) => item.id && item.name);
    }

    function hideList() {
      list.hidden = true;
      list.innerHTML = '';
      list.removeAttribute('data-open');
      activeIndex = -1;
      items = [];
    }

    function renderList() {
      if (!items.length) {
        hideList();
        return;
      }
      list.innerHTML = items.map((item, idx) => {
        const sub = [item.city, item.kitchens || item.address].filter(Boolean).join(' · ');
        return `
          <a class="ac-item${idx === activeIndex ? ' is-active' : ''}" data-index="${idx}" href="/restaurants/${encodeURIComponent(item.id)}" role="option" aria-selected="${idx === activeIndex ? 'true' : 'false'}">
            <img class="ac-thumb" src="${esc(item.photo)}" alt="${esc(item.name)}" loading="lazy">
            <span class="ac-meta">
              <span class="ac-title">${esc(item.name)}</span>
              <span class="ac-sub">${esc(sub)}</span>
            </span>
          </a>`;
      }).join('');
      list.hidden = false;
      list.setAttribute('data-open', '1');
    }

    function setActive(index) {
      if (!items.length) {
        activeIndex = -1;
        return;
      }
      activeIndex = Math.max(0, Math.min(items.length - 1, index));
      renderList();
    }

    async function fetchSuggestions(query) {
      if (abortController) abortController.abort();
      abortController = new AbortController();
      try {
        const url = `${endpoint}?approved=1&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: abortController.signal, headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`autocomplete_${res.status}`);
        const data = await res.json();
        items = normalize(data);
        activeIndex = items.length ? 0 : -1;
        renderList();
      } catch (err) {
        if (err?.name === 'AbortError') return;
        hideList();
      }
    }

    function queueFetch() {
      const query = input.value.trim();
      clearTimeout(debounceTimer);
      if (query.length < 2) {
        hideList();
        return;
      }
      debounceTimer = window.setTimeout(() => fetchSuggestions(query), 180);
    }

    input.addEventListener('input', queueFetch);
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && !list.hidden) renderList();
      else queueFetch();
    });

    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(activeIndex < 0 ? 0 : activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(activeIndex <= 0 ? items.length - 1 : activeIndex - 1);
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        const item = items[activeIndex];
        if (!item) return;
        e.preventDefault();
        window.location.href = `/restaurants/${encodeURIComponent(item.id)}`;
      } else if (e.key === 'Escape') {
        hideList();
      }
    });

    list.addEventListener('mousemove', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.ac-item') : null;
      if (!row) return;
      const idx = Number(row.getAttribute('data-index'));
      if (Number.isFinite(idx) && idx !== activeIndex) setActive(idx);
    });

    document.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Node && (form.contains(target) || list.contains(target))) return;
      hideList();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-featured-carousel]').forEach(initFeaturedCarousel);
    initHomepageAutocomplete();
  });
})();
