(() => {
  const form=document.querySelector('.sb-hours form');
  if(!form)return;
  const lang=(document.documentElement.lang||'en').split('-')[0];
  const words={he:{invalid:'יש לתקן את השדות המסומנים לפני השמירה.',times:'בחרו שעת פתיחה ושעת סגירה מאוחרת ממנה.',dirty:'יש שינויים שלא נשמרו',saving:'שומר…',closed:'כל ימות השבוע סגורים. לקוחות לא יוכלו להזמין מקום. לשמור כך?'},ka:{invalid:'შენახვამდე შეასწორეთ მონიშნული ველები.',times:'აირჩიეთ გახსნის დრო და მასზე გვიანი დახურვის დრო.',dirty:'შეუნახავი ცვლილებები',saving:'ინახება…',closed:'კვირის ყველა დღე დახურულია. სტუმრები მაგიდას ვერ დაჯავშნიან. შევინახოთ?'},en:{invalid:'Correct the highlighted fields before saving.',times:'Choose an opening time and a later closing time.',dirty:'Unsaved changes',saving:'Saving…',closed:'Every day is closed. Guests will not be able to book. Save anyway?'}}[lang] || {invalid:'Check the highlighted fields.',times:'Closing time must be later than opening time.',dirty:'Unsaved changes',saving:'Saving…',closed:'Every day is closed. Save anyway?'};
  const status=document.createElement('p');status.className='hours-save-feedback';status.setAttribute('role','status');form.querySelector('.form-actions')?.before(status);
  if(!form.elements.lang){const input=document.createElement('input');input.type='hidden';input.name='lang';input.value=lang;form.append(input);}
  const rows=[...form.querySelectorAll('tr[data-day]')];
  for(const name of ['capacity','slotIntervalMinutes','serviceDurationMinutes'])if(form.elements[name])form.elements[name].required=true;
  const snapshot=()=>JSON.stringify([...new FormData(form).entries()]);
  let initial=snapshot(),submitting=false;
  const validate=()=>{
    for(const row of rows){
      const open=row.querySelector('.open'),close=row.querySelector('.close'),enabled=row.querySelector('.open-toggle').checked;
      open.required=close.required=enabled;
      const invalid=enabled&&(!open.value||!close.value||close.value<=open.value);
      close.setCustomValidity(invalid?words.times:'');
      open.setAttribute('aria-invalid',String(invalid));close.setAttribute('aria-invalid',String(invalid));
    }
  };
  const changed=()=>{validate();status.textContent=snapshot()!==initial?words.dirty:'';};
  form.addEventListener('input',changed);form.addEventListener('change',changed);
  form.querySelector('#copyAllBtn')?.addEventListener('click',()=>queueMicrotask(changed));
  form.addEventListener('submit',event=>{
    validate();
    if(submitting){event.preventDefault();return;}
    if(!form.checkValidity()){
      event.preventDefault();status.textContent=words.invalid;
      const invalid=form.querySelector(':invalid');
      // The quarter-hour picker may visually replace the underlying time input.
      const target=invalid?.hidden || invalid?.style.display==='none' ? invalid.closest('td')?.querySelector('select,button') : invalid;
      target?.scrollIntoView({block:'center',behavior:'smooth'});target?.focus();return;
    }
    if(rows.every(row=>!row.querySelector('.open-toggle').checked)&&!confirm(words.closed)){event.preventDefault();return;}
    submitting=true;status.textContent=words.saving;
    form.querySelectorAll('[type=submit]').forEach(button=>button.disabled=true);
  },true);
  window.addEventListener('beforeunload',event=>{if(!submitting&&snapshot()!==initial){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pageshow',()=>{submitting=false;form.querySelectorAll('[type=submit]').forEach(button=>button.disabled=false);changed();});
  validate();
})();
