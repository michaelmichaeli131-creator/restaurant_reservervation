// Apply after archived assets, design layers and localized templates are restored.
const root = Deno.env.get('SPOTBOOK_ROOT') || '/app';
const href = '/public/css/spotbook-mobile.css?v=20260926-2';
async function enhance(directory: string) {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) { await enhance(path); continue; }
    if (!entry.name.endsWith('.eta')) continue;
    let source = await Deno.readTextFile(path);
    if (!source.includes('</head>')) continue;
    source = source.replace(/<link rel="stylesheet" href="\/public\/css\/spotbook-mobile.css\?v=[^"]+">\s*/g, '');
    source = source.replace('</head>', `<link rel="stylesheet" href="${href}">\n</head>`);
    if (entry.name === 'owner_calendar.eta' && !source.includes('/public/js/spotbook-mobile.js')) {
      source = source.replace('</head>', '<script src="/public/js/spotbook-mobile.js?v=20260926-2" defer></script>\n</head>');
    }
    source = source.replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"');
    // Touch generates a click too: use the existing click handler for both.
    source = source.replace("      btn.addEventListener('touchstart', toggleMenu, { passive: true });", '');
    await Deno.writeTextFile(path, source);
  }
}
await enhance(`${root}/templates`);
console.log('[mobile] Applied responsive styles after localized templates');
