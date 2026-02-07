(() => {
  const f = document.getElementById('search-form');
  if (!f) return;

  // אם אין ערכי תאריך/שעה – נגדיר ברירות מחדל של היום + עכשיו מעוגל לרבע שעה
  const pad2 = n => String(n).padStart(2, '0');
  const roundToQuarter = (d) => {
    const ms = 15 * 60 * 1000;
    return new Date(Math.ceil(d.getTime() / ms) * ms);
  };

  const date = f.querySelector('#date');
  const time = f.querySelector('#time');

  if (date && !date.value) {
    const d = new Date();
    date.value = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  if (time && !time.value) {
    const t = roundToQuarter(new Date());
    time.value = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  }

  f.addEventListener('submit', () => {
    // נותן לשרת את הפרמטרים q/date/time בדיוק כמו היום (לא מחליף שום פיצ'ר קיים)
  });
})();
