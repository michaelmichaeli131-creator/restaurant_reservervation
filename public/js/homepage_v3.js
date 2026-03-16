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

    const isRTL = getComputedStyle(root).direction === 'rtl' || root.getAttribute('dir') === 'rtl';
    let dots = [];
    let autoplayTimer = null;
    const AUTOPLAY_MS = 3600;

    function slideSpan() {
      if (!slides[0]) return 320;
      const gap = parseFloat(getComputedStyle(track).gap || '0') || 0;
      return slides[0].getBoundingClientRect().width + gap;
    }

    function slidesPerView() {
      const span = slideSpan();
      if (!span) return 1;
      return Math.max(1, Math.round(viewport.clientWidth / span));
    }

    function pageCount() {
      return Math.max(1, Math.ceil(slides.length / slidesPerView()));
    }

    function currentPage() {
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const left = Math.max(0, Math.min(maxScroll, viewport.scrollLeft));
      const ratio = maxScroll > 0 ? left / maxScroll : 0;
      return Math.round(ratio * (pageCount() - 1));
    }

    function renderDots() {
      const total = pageCount();
      dotsWrap.innerHTML = '';
      dots = [];
      for (let i = 0; i < total; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'featured-dot';
        btn.setAttribute('aria-label', `Go to slide ${i + 1}`);
        btn.addEventListener('click', () => {
          goToPage(i);
          restartAutoplay();
        });
        dotsWrap.appendChild(btn);
        dots.push(btn);
      }
      syncDots();
    }

    function syncDots() {
      const page = currentPage();
      dots.forEach((dot, idx) => dot.classList.toggle('is-active', idx === page));
    }

    function goToPage(page) {
      const total = pageCount();
      const targetPage = Math.max(0, Math.min(total - 1, page));
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const left = total > 1 ? (maxScroll / (total - 1)) * targetPage : 0;
      viewport.scrollTo({ left, behavior: 'smooth' });
      raf(syncDots);
    }

    function step(dir) {
      const delta = slideSpan() * Math.max(1, slidesPerView() - 0.15) * dir;
      viewport.scrollBy({ left: delta, behavior: 'smooth' });
      setTimeout(syncDots, 220);
    }

    function nextAuto() {
      const total = pageCount();
      if (total <= 1) return;
      const page = currentPage();
      const nextPage = page >= total - 1 ? 0 : page + 1;
      goToPage(nextPage);
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
      if (pageCount() <= 1) return;
      autoplayTimer = setInterval(nextAuto, AUTOPLAY_MS);
    }

    function restartAutoplay() {
      startAutoplay();
    }

    prevBtn?.addEventListener('click', () => {
      step(isRTL ? 1 : -1);
      restartAutoplay();
    });
    nextBtn?.addEventListener('click', () => {
      step(isRTL ? -1 : 1);
      restartAutoplay();
    });
    viewport.addEventListener('scroll', () => raf(syncDots), { passive: true });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const oldPage = currentPage();
        renderDots();
        goToPage(oldPage);
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
        step(dx > 0 ? (isRTL ? -1 : 1) : (isRTL ? 1 : -1));
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

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-featured-carousel]').forEach(initFeaturedCarousel);
  });
})();
