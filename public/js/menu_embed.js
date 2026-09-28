// Public menu: localized category filtering, readable prices, and recoverable loading.
(() => {
  const root = document.getElementById('pos-menu');
  if (!root?.dataset.rid) return;
  const lang = (document.documentElement.lang || 'en').split('-')[0];
  const words = {
    he: {all:'הכול',search:'חיפוש בתפריט',none:'לא נמצאו מנות מתאימות',retry:'נסו שוב',loading:'טוען תפריט…',error:'לא ניתן לטעון את התפריט כרגע',category:'קטגוריה',empty:'אין מנות להצגה כרגע.'},
    en: {all:'All',search:'Search the menu',none:'No matching dishes',retry:'Try again',loading:'Loading menu…',error:'Unable to load the menu right now',category:'Category',empty:'No dishes to display right now.'},
    ka: {all:'ყველა',search:'მენიუში ძებნა',none:'შესაბამისი კერძები ვერ მოიძებნა',retry:'ხელახლა ცდა',loading:'მენიუ იტვირთება…',error:'მენიუს ჩატვირთვა ვერ მოხერხდა',category:'კატეგორია',empty:'ამჟამად საჩვენებელი კერძები არ არის.'}
  }[lang] || {all:'All',search:'Search the menu',none:'No matching dishes',retry:'Try again',loading:'Loading menu…',error:'Unable to load the menu',category:'Category',empty:'No dishes to display right now.'};
  const node = (tag, cls, text) => { const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el; };
  const localized = (item, prefix) => item[prefix+'_'+lang] || item[prefix+'_en'] || item[prefix+'_he'] || item[prefix+'_ka'] || '';
  const money = new Intl.NumberFormat(['he','en','ka'].includes(lang)?lang:'en', {minimumFractionDigits:2, maximumFractionDigits:2});
  async function load() {
    root.setAttribute('aria-busy','true');
    root.replaceChildren(node('p','muted',words.loading));
    const abort=new AbortController(), timeout=setTimeout(()=>abort.abort(),15000);
    try {
      const response=await fetch('/api/pos/menu/'+encodeURIComponent(root.dataset.rid),{signal:abort.signal});
      if(!response.ok)throw Error('Menu unavailable');
      const items=await response.json();
      if(!Array.isArray(items))throw Error('Invalid menu');
      if(!items.length){root.replaceChildren(node('p','muted',root.dataset.emptyMsg||words.empty));return;}
      const groups=new Map();
      for(const item of items){const key=String(item.categoryId||'_');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
      const search=node('input','customer-menu-search');search.type='search';search.placeholder=words.search;search.setAttribute('aria-label',words.search);
      const tabs=node('div','customer-menu-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label',words.category);
      const content=node('div','customer-menu-content'), sections=[], buttons=[];
      let active=null;
      const status=node('p','muted');status.setAttribute('role','status');
      const filter=()=>{
        const query=search.value.trim().toLocaleLowerCase();let count=0;
        for(const {key,section,rows} of sections){let visible=0;for(const {li,name} of rows){li.hidden=(active!==null&&active!==key)||!name.toLocaleLowerCase().includes(query);if(!li.hidden)visible++;}section.hidden=!visible;count+=visible;}
        status.textContent=count?'':words.none;
        for(const {button,key} of buttons)button.setAttribute('aria-pressed',String(active===key));
      };
      const addTab=(key,label)=>{const button=node('button','customer-menu-tab',label);button.type='button';button.onclick=()=>{active=key;filter();};tabs.append(button);buttons.push({button,key});};
      addTab(null,words.all);
      for(const [key,arr] of groups){
        const title=localized(arr[0],'categoryName')||root.dataset.defaultCategory||words.category;
        if(groups.size>1)addTab(key,title);
        const section=node('section','customer-menu-section');section.append(node('h4','',title));
        const list=node('ul','customer-menu-list'),rows=[];
        for(const item of arr){
          const name=localized(item,'name'),li=node('li','customer-menu-item');
          li.append(node('span','customer-menu-name',name));
          const price=Number(item.price);
          if(Number.isFinite(price)&&price>=0){const amount=node('bdi','customer-menu-price',money.format(price)+' '+(root.dataset.currency||'₪'));li.append(amount);}
          list.append(li);rows.push({li,name});
        }
        section.append(list);content.append(section);sections.push({key,section,rows});
      }
      root.replaceChildren(search);
      if(groups.size>1)root.append(tabs);
      root.append(content,status);search.addEventListener('input',filter);filter();
    } catch {
      const message=node('p','muted',root.dataset.errorMsg||words.error),retry=node('button','customer-menu-tab',words.retry);
      message.setAttribute('role','status');retry.type='button';retry.onclick=load;root.replaceChildren(message,retry);
    } finally {clearTimeout(timeout);root.setAttribute('aria-busy','false');}
  }
  load();
})();
