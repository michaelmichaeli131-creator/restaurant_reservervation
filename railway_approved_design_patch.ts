// Apply approved September 2026 designs AFTER the verified backend and prior UI layers.
// Deliberately preserve forms, field names, script hooks, permissions and restaurant data.
const root = Deno.env.get('SPOTBOOK_ROOT') || '/app';
const pages = JSON.parse(await Deno.readTextFile(`${root}/design-system/pages.json`));
const link = '\n<link rel="stylesheet" href="/public/css/spotbook-approved.css?v=20260917-1">\n';
for (const name of ['_layout','auth/_layout','_layout_ops','layout']) {
  const path = `${root}/templates/${name}.eta`;
  let text = await Deno.readTextFile(path);
  if (!text.includes('/public/css/spotbook-approved.css')) {
    if (!text.includes('</head>')) {
      if (text.includes('layout(')) continue;
      throw new Error(`Missing head in ${name}`);
    }
    text = text.replace('</head>',link+'</head>');
    await Deno.writeTextFile(path,text);
  }
}
await Deno.writeTextFile(`${root}/public/css/spotbook-approved.css`,await Deno.readTextFile(`${root}/design-system/approved.css`));
await Deno.writeTextFile(`${root}/templates/components/_approved_nav.eta`,await Deno.readTextFile(`${root}/design-system/nav.eta`));
for (const [name, config] of Object.entries(pages) as [string, {kind:string;image:string;icon?:string}][]) {
  const path = `${root}/templates/${name}.eta`;
  let text = await Deno.readTextFile(path);
  if (text.includes('data-approved-page=')) continue;
  if (name === 'owner/owner_bills') text = text.replace('include("components/_owner_tabs"', 'include("../components/_owner_tabs"');
  const image = `/public/img/spotbook/${config.image}.webp`;
  const navPath = name.includes('/') ? '../components/_approved_nav' : 'components/_approved_nav';
  const nav = config.kind === 'owner' ? `<%~ include('${navPath}', {...it, approvedPage: '${name}'}) %>` : '';
  const icon = config.icon ? `<img class="sb-design-icon" src="/public/img/spotbook/${config.icon}.webp" alt="" width="72" height="72">` : '';
  // Atmospheric artwork remains decorative, never substituted for an actual restaurant's gallery.
  const hero = `<div class="sb-design-photo" aria-hidden="true"><img src="${image}" alt="" width="1536" height="1024" decoding="async" fetchpriority="${config.kind.startsWith('customer')?'high':'auto'}"></div>`;
  const open = `<div class="sb-approved sb-approved--${config.kind} sb-page-${name.replaceAll('/','-')}" data-approved-page="${name}">${nav}<div class="sb-design-workspace">${hero}${icon}<div class="sb-design-content">`;
  const close = '</div></div></div>';
  if (text.includes('<html')) {
    text = text.replace('</head>',link+'</head>');
    // Standalone reservation management has its own document shell.
    text = text.replace(/(<body\b[^>]*>)/, '$1'+open).replace('</body>',close+'</body>');
  } else {
    text = open + text + close;
  }
  await Deno.writeTextFile(path,text);
}
console.log(`[approved-design] Integrated ${Object.keys(pages).length} pages with approved imagery`);
