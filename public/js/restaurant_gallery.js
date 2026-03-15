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

  const update = () => {
    if (!photos.length) return;
    const safeIndex = ((currentIndex % photos.length) + photos.length) % photos.length;
    currentIndex = safeIndex;
    lightboxImg.src = photos[safeIndex] || '';
    counterEl.textContent = `${safeIndex + 1} / ${photos.length}`;
  };

  const openAt = (index) => {
    if (!photos.length) return;
    lastActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    currentIndex = Number.isFinite(index) ? Number(index) : 0;
    update();
    lightbox.hidden = false;
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    lightbox.querySelector('.rsv-lightbox__btn--close')?.focus();
  };

  const close = () => {
    lightbox.hidden = true;
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
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
      close();
    } else if (event.key === 'ArrowLeft') {
      currentIndex -= 1;
      update();
    } else if (event.key === 'ArrowRight') {
      currentIndex += 1;
      update();
    }
  });
}
