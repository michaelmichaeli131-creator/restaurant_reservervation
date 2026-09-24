(() => {
  const match = location.pathname.match(/^\/restaurants\/([^/]+)\/?$/);
  if (!match || document.getElementById('calendar-waitlist-link')) return;
  const he = document.documentElement.lang === 'he', ka = document.documentElement.lang === 'ka';
  const link = document.createElement('a');
  link.id = 'calendar-waitlist-link';
  link.href = `/restaurants/${match[1]}/waitlist`;
  link.textContent = he ? 'לא מצאתם מקום? הצטרפו לרשימת המתנה' : ka ? 'ადგილი ვერ იპოვეთ? ჩაეწერეთ მოლოდინის სიაში' : 'No suitable table? Join the waitlist';
  link.style.cssText = 'display:block;margin:18px 0;padding:16px 20px;border:1px solid #4173b8;border-radius:12px;background:#112948;color:#c5dfff;text-align:center;font-weight:600;text-decoration:none';
  const form = document.querySelector('form[action*="reserve"]') || document.querySelector('main form') || document.querySelector('main');
  if (form) form.after(link);
})();
