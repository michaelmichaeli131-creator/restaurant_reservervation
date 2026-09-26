/* Progressive enhancement: move existing controls so handlers and permissions survive. */
(() => {
  const words = {
    en: {filters:'Filters', insights:'Daily insights', actions:'Calendar actions'},
    he: {filters:'מסננים', insights:'סיכום יומי', actions:'פעולות ביומן'},
    ka: {filters:'ფილტრები', insights:'დღის შეჯამება', actions:'კალენდრის მოქმედებები'},
  };
  function start() {
    const bar = document.querySelector('.oc-global-tools');
    if (!bar || document.querySelector('.oc-mobile-filters')) return;
    const text = words[document.documentElement.lang] || words.en;
    const media = matchMedia('(max-width: 700px)');
    const original = Array.from(bar.children);
    const filterLabels = original.filter(node => node.tagName === 'LABEL' && !node.contains(document.querySelector('#oc-global-search')));
    const filters = document.createElement('details'); filters.className = 'oc-mobile-filters';
    const summary = document.createElement('summary');
    const label = document.createElement('span'); label.textContent = text.filters;
    const count = document.createElement('span'); count.className = 'oc-mobile-filter-count';
    summary.append(label, count); filters.append(summary);
    const fields = document.createElement('div'); fields.className = 'oc-mobile-filter-fields'; filters.append(fields);
    const dock = document.createElement('nav'); dock.className = 'oc-mobile-actions'; dock.setAttribute('aria-label',text.actions);
    const actions = ['oc-add-reservation','oc-add-event','oc-floor-link'].map(id=>document.getElementById(id)).filter(Boolean);
    const clear = document.getElementById('oc-clear-filters');
    const kpis = document.querySelector('.oc-kpis');
    const extraInsights = ['.oc-panel-header','.oc-summary'].map(selector=>document.querySelector(selector)).filter(Boolean).map(node=>{
      const marker=document.createComment('restore insight');node.before(marker);return {node,marker};
    });
    const anchor = document.createComment('daily insights');
    const insights = document.createElement('details'); insights.className = 'oc-mobile-insights';
    const title = document.createElement('summary'); title.textContent = text.insights; insights.append(title);
    if(kpis) kpis.before(anchor);
    function updateCount() {
      const active = ['status','room','kind'].filter(id=>{
        const value = document.getElementById('oc-global-'+id)?.value;
        return value && value !== 'all';
      }).length;
      count.textContent = active ? String(active) : '';
      count.hidden = !active;
    }
    function arrange() {
      if(media.matches) {
        filterLabels.forEach(node=>fields.append(node)); if(clear) fields.append(clear);
        bar.append(filters); actions.forEach(node=>dock.append(node)); document.body.append(dock);
        if(kpis) {anchor.after(insights); insights.append(kpis);extraInsights.forEach(({node})=>insights.append(node));}
        document.body.classList.add('oc-mobile-enhanced');
      } else {
        original.forEach(node=>bar.append(node)); filters.remove();dock.remove();
        if(kpis) anchor.after(kpis);extraInsights.forEach(({node,marker})=>marker.after(node)); insights.remove();
        document.body.classList.remove('oc-mobile-enhanced');
      }
      updateCount();
    }
    bar.addEventListener('change',updateCount);
    clear?.addEventListener('click',updateCount);
    media.addEventListener('change',arrange); arrange();
  }
  // The calendar creates its controls synchronously in DOMContentLoaded.
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded',()=>requestAnimationFrame(start),{once:true});
  else requestAnimationFrame(start);
})();
