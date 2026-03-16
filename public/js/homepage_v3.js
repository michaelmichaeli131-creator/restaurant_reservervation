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

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-featured-carousel]').forEach(initFeaturedCarousel);
  });
})();
