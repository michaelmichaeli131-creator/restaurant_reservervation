(() => {
  if(!document.querySelector('.rsv-page'))return;
  const editable=el=>el instanceof HTMLElement&&el.matches('input:not([type=hidden]),textarea,select,[contenteditable=true]');
  const sync=()=>document.documentElement.classList.toggle('customer-editing',editable(document.activeElement));
  document.addEventListener('focusin',sync);
  document.addEventListener('focusout',()=>setTimeout(sync,0));
  window.visualViewport?.addEventListener('resize',sync);
  for(const [name,value] of [['phone','tel'],['email','email']]){
    const input=document.querySelector('.rsv-page input[name="'+name+'"]');
    if(input){input.autocomplete=value;input.setAttribute('inputmode',value);input.dir='ltr';}
  }
})();
