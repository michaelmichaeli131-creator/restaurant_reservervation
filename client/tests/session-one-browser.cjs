const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const deps = process.env.SPOTBOOK_BROWSER_DEPS;
const { chromium } = require(path.join(deps, 'playwright-core'));
const serverChromium = require(path.join(deps, '@sparticuz/chromium/build/index.js')).default;
const fixture = { id:'room', restaurantId:'demo', name:'Main room', gridRows:10, gridCols:12, isActive:true,
  tables:[{id:'one',name:'Table 1',tableNumber:1,gridX:1,gridY:1,spanX:2,spanY:2,seats:4,shape:'square'},
    {id:'two',name:'Table 2',tableNumber:2,gridX:4,gridY:1,spanX:2,spanY:2,seats:4,shape:'square'}],objects:[] };
(async () => {
  const { createServer } = await import('../node_modules/vite/dist/node/index.js');
  const server = await createServer({root:path.resolve(__dirname,'..'),server:{host:'127.0.0.1',port:5173}});
  await server.listen();
  const browser = await chromium.launch({executablePath:process.env.SPOTBOOK_CHROMIUM || await serverChromium.executablePath(),args:serverChromium.args,headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1050}});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  let saved=null;
  await page.route('**/api/**', async route => {
    const req=route.request(); let body=[];
    if(req.url().includes('/i18n/')) body={};
    else if(req.method()==='PUT'){saved=req.postDataJSON();body=saved;}
    else if(req.url().includes('/activate')) body={ok:true};
    else if(req.url().includes('/floor-layouts/')) body=[fixture];
    await route.fulfill({json:body});
  });
  await page.route('**/floor_assets/**', async route=>{
    try { await route.fulfill({body:await fs.readFile(path.join(__dirname,'../../public/floor_assets',path.basename(new URL(route.request().url()).pathname))),contentType:'image/svg+xml'}); }
    catch { await route.fulfill({status:404,body:''}); }
  });
  await page.goto('http://127.0.0.1:5173/?restaurantId=demo');
  await page.locator('.fe-grid .table').first().click();
  const width=page.locator('.properties-panel').getByLabel('Width:',{exact:true});
  const height=page.locator('.properties-panel').getByLabel('Height:',{exact:true});
  await width.fill('3');
  assert.equal(await width.inputValue(),'3');
  await page.getByRole('button',{name:'↶ Undo',exact:true}).click();
  assert.equal(await width.inputValue(),'2');
  await page.getByRole('button',{name:'↷ Redo',exact:true}).click();
  assert.equal(await width.inputValue(),'3');
  await page.getByRole('button',{name:'↶ Undo',exact:true}).click();
  await page.getByLabel('Lock proportions').check();
  await width.fill('4');
  assert.equal(await height.inputValue(),'4');
  assert.ok(await page.locator('.fe-conflict').count() >= 2);
  await page.getByRole('button',{name:'↶ Undo',exact:true}).click();
  await page.getByRole('button',{name:'Duplicate item',exact:true}).click();
  assert.equal(await page.locator('.fe-grid .table').count(),3);
  await page.getByRole('button',{name:'↶ Undo',exact:true}).click();
  assert.equal(await page.locator('.fe-grid .table').count(),2);
  await page.getByRole('button',{name:'↷ Redo',exact:true}).click();
  page.once('dialog', d=>d.dismiss());
  await page.getByRole('button',{name:'Switch to live view mode'}).click();
  assert.equal(await page.locator('.floor-editor').count(),1);
  page.once('dialog', d=>d.accept());
  await page.getByRole('button',{name:'Save layout',exact:true}).click();
  await page.getByText('All changes saved',{exact:true}).waitFor();
  assert.equal(saved.tables.length,3);
  await page.screenshot({path:'/tmp/spotbook-session1-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/spotbook-session1-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'Mobile must not overflow');
  assert.deepEqual(errors,[]);
  console.log('PASS: browser undo/redo, ratio lock, overlap warning, duplicate, leave guard, save payload, desktop/mobile layout.');
  await browser.close();
  await server.close();
})().catch(e=>{console.error(e);process.exit(1)});
