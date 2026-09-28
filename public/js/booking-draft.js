/* A short-lived draft in this tab only. Never persist payment or anti-replay tokens. */
(()=>{
 const form=document.getElementById('details-form');
 const match=location.pathname.match(/^\/restaurants\/([^/]+)/);if(!match)return;
 const key='spotbook-booking-draft:'+match[1];
 const get=()=>{try{const d=JSON.parse(sessionStorage.getItem(key)||'null');return d&&Date.now()-d.at<2*60*60*1000?d:null;}catch{return null;}};
 if(form){
   const names=['name','phone','email','note','occasion'];const draft=get();
   if(draft){for(const name of names){const el=form.elements.namedItem(name);if(el&&!el.value&&typeof draft[name]==='string')el.value=draft[name];}for(const el of form.querySelectorAll('[name="dietary"]'))el.checked=Array.isArray(draft.dietary)&&draft.dietary.includes(el.value);}
   const save=()=>{const d={at:Date.now()};for(const name of names)d[name]=String(form.elements.namedItem(name)?.value||'');d.dietary=Array.from(form.querySelectorAll('[name="dietary"]:checked'),e=>e.value);try{sessionStorage.setItem(key,JSON.stringify(d));}catch{}};
   form.addEventListener('input',save);form.addEventListener('change',save);form.addEventListener('submit',save,true);
   const back=document.querySelector('.rsv-back-link');if(back){const u=new URL(back.href);const room=form.elements.namedItem('preferredLayoutId')?.value;if(room)u.searchParams.set('preferredLayoutId',room);back.href=u.pathname+u.search;}
   const summary=document.querySelector('.rsv-summary-bar');const actions=form.querySelector('.rsv-actions');
   if(summary&&actions){const review=document.createElement('section');review.className='booking-final-summary';const title=document.createElement('strong');title.textContent=document.documentElement.lang==='he'?'סיכום לפני אישור':document.documentElement.lang==='ka'?'შეჯამება დადასტურებამდე':'Review before confirming';review.appendChild(title);const name=document.querySelector('.rsv-details-header__sub')?.cloneNode(true);if(name)review.appendChild(name);const copy=summary.cloneNode(true);copy.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));review.appendChild(copy);const deposit=document.querySelector('.rsv-deposit-notice')?.cloneNode(true);if(deposit)review.appendChild(deposit);actions.before(review);}
 }
 if(document.body.dataset.bookingComplete==='1'){try{sessionStorage.removeItem(key);}catch{}}
 if(location.pathname.endsWith('/waitlist')){const params=new URLSearchParams(location.search);for(const name of ['date','time','people','area']){const el=document.querySelector(`[name="${name}"]`);const v=params.get(name);if(el&&v)el.value=v;}const d=get();if(d)for(const name of ['name','phone','note']){const el=document.querySelector(`[name="${name}"]`);if(el&&!el.value)el.value=d[name]||'';}}
})();
