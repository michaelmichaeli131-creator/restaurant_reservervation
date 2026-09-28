const root = document.getElementById('restaurant-gallery-root');
const lightbox = document.getElementById('restaurant-lightbox');
const lightboxImg = document.getElementById('restaurant-lightbox-image');
const counterEl = document.getElementById('restaurant-lightbox-counter');

if (root && lightbox && lightboxImg && counterEl) {
  let photos = [];
  try {
    photos = JSON.parse(root.dataset.photos || '[]');
  } catch {
    photos = [];
  }

  let currentIndex = 0;
  let lastActive = null;
  let previousOverflow = '';
  const rtl = document.documentElement.dir === 'rtl';
  counterEl.setAttribute('aria-live', 'polite');

  const update = () => {
    if (!photos.length) return;
    const safeIndex = ((currentIndex % photos.length) + photos.length) % photos.length;
    currentIndex = safeIndex;
    lightboxImg.src = photos[safeIndex] || '';
    lightboxImg.alt = `${root.querySelector('img')?.alt || 'Photo'} (${safeIndex + 1} / ${photos.length})`;
    counterEl.textContent = `${safeIndex + 1} / ${photos.length}`;
  };

  const openAt = (index) => {
    if (!photos.length) return;
    lastActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    currentIndex = Number.isFinite(index) ? Number(index) : 0;
    update();
    lightbox.hidden = false;
    lightbox.setAttribute('aria-hidden', 'false');
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    lightbox.querySelector('.rsv-lightbox__btn--close')?.focus();
  };

  const close = () => {
    lightbox.hidden = true;
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = previousOverflow;
    if (lastActive && typeof lastActive.focus === 'function') {
      lastActive.focus();
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const opener = target.closest('[data-gallery-open]');
    if (opener) {
      event.preventDefault();
      openAt(parseInt(opener.getAttribute('data-gallery-open') || '0', 10) || 0);
      return;
    }
    if (target.closest('[data-gallery-close]')) {
      event.preventDefault();
      close();
      return;
    }
    if (target.closest('[data-gallery-prev]')) {
      event.preventDefault();
      currentIndex -= 1;
      update();
      return;
    }
    if (target.closest('[data-gallery-next]')) {
      event.preventDefault();
      currentIndex += 1;
      update();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      currentIndex += rtl ? 1 : -1;
      update();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      currentIndex += rtl ? -1 : 1;
      update();
    } else if (event.key === 'Tab') {
      const buttons = [...lightbox.querySelectorAll('.rsv-lightbox__dialog button')].filter(b => !b.hidden && !b.disabled);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  let touch = null;
  lightboxImg.addEventListener('touchstart', event => {
    touch = event.touches.length === 1 ? {x:event.touches[0].clientX, y:event.touches[0].clientY} : null;
  }, {passive:true});
  lightboxImg.addEventListener('touchcancel', () => { touch = null; });
  lightboxImg.addEventListener('touchend', event => {
    if (!touch || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    currentIndex += (dx < 0 ? 1 : -1) * (rtl ? -1 : 1);
    update();
  }, {passive:true});
  for (const button of lightbox.querySelectorAll('[data-gallery-prev], [data-gallery-next]')) button.hidden = photos.length < 2;
}
