// Isolated headless app QA. Never attaches to the user's browser/profile.
// npm install --prefix ../mobile-qa-runtime playwright
// node tests/mobile.cjs [base URL] [artifact directory]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.FISH_QA_PLAYWRIGHT || '../../mobile-qa-runtime/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767/';
const out = path.resolve(process.argv[3] || '../mobile-qa-artifacts');
const evidence = { base, at: new Date().toISOString(), viewport: '390x844', engine: 'headless Edge / Chromium; not physical iPhone Safari', checks: [] };
let browser;
async function main() {
  await fs.mkdir(out, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true, hasTouch:true, locale:'ru-RU', timezoneId:'Europe/Moscow', geolocation:{latitude:60.1931,longitude:30.14328,accuracy:12}, permissions:['geolocation'] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const shots = async name => { await page.screenshot({path:path.join(out, name+'.png')}); };
  const pass = (name, details) => { evidence.checks.push({name,details}); console.log('PASS',name,JSON.stringify(details ?? '')); };
  const dimensions = () => page.evaluate(() => {
    const box = sel => {const r=document.querySelector(sel).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,header:box('.topbar'),brand:box('.brand'),nav:box('.bottom-nav'),map:box('.canvas-wrap'),navPosition:getComputedStyle(document.querySelector('.bottom-nav')).position};
  });
  const nav = async screen => {await page.locator('.bottom-nav [data-screen-target="'+screen+'"]').click(); await page.locator('#screen-'+screen).waitFor({state:'visible'});await page.waitForFunction(()=>scrollY<2);};
  const cdp = await context.newCDPSession(page);
  await page.goto(base+'?lake=mednoe#map', {waitUntil:'networkidle'});
  await page.locator('#leafletMap.leaflet-container').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tile')].some(i=>i.complete&&i.naturalWidth>0));
  let d = await dimensions();
  assert.equal(d.width,390); assert.equal(d.scrollWidth,390); assert(d.map.height>=420); assert.equal(d.navPosition,'fixed'); assert(Math.abs(d.nav.bottom-844)<1);
  pass('mobile layout / map size / fixed navigation',d);
  // This installed Chromium cannot emulate native iOS env() insets. Resolve
  // the SAME production stylesheet's env() values for a bounded layout test.
  // This verifies layout at 47/34px, not Safari's delivery of those env values.
  const productionCss=await page.locator('link[href^="styles.css"]').getAttribute('href');
  const cssResponse=await context.request.get(new URL(productionCss,base).href);
  const css=await cssResponse.text();
  assert(css.includes('env(safe-area-inset-top'));
  const insetStyle=await page.addStyleTag({content:css.replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g,'47px').replace(/env\(safe-area-inset-bottom(?:,\s*0px)?\)/g,'34px')});
  await page.evaluate(()=>scrollTo(0,0));
  d=await dimensions(); assert(d.brand.y>=47); assert(d.nav.height>=90);
  pass('47/34px safe-inset layout simulation (not native Safari env)',d); await shots('01-header-safe-area');
  await insetStyle.evaluate(el=>el.remove());
  await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();
  await shots('02-hybrid');
  assert.equal(await page.locator('#mode3d').isDisabled(),true);
  assert.equal(await page.locator('.depth-label-marker').count(),0);
  for (const [fish,count] of [['perch',3],['bullhead',1]]) {
    await page.locator('#mapFishSelect').selectOption(fish);
    assert.equal(await page.locator('#fishSelect').inputValue(),fish);
    assert.equal(await page.locator('#fishMapPoints .fish-map-point').count(),count);
  }
  await shots('03-bullhead-filter'); pass('Mednoe species selectors and point filtering',{perch:3,bullhead:1});
  await page.locator('#mapFishSelect').selectOption('perch');
  // Persist a test-only record in this disposable profile, via the actual UI.
  await nav('journal'); await page.locator('#journalAddButton').click();
  await page.locator('#pointType').selectOption('catch');
  await page.locator('#pointFish').fill('окунь');
  await page.locator('#pointNote').fill('QA: тестовая запись, не реальный улов');
  await page.locator('#pointForm button[type=submit]').click();
  assert.equal(await page.locator('#journalCount').innerText(),'1');
  await shots('04-journal');
  for(const type of ['Json','Csv']) {
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#export'+type+'Button').click();
    const download=await downloadPromise;
    const file=path.join(out,download.suggestedFilename()); await download.saveAs(file);
    const body=await fs.readFile(file,'utf8'); assert(body.includes('QA: тестовая запись'));
    if(type==='Json')assert.equal(JSON.parse(body).entries.length,1);
  }
  pass('journal save and JSON/CSV export');
  await nav('map'); await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();
  await page.locator('.journal-point-marker').waitFor();
  await page.locator('#locateButton').click(); await page.locator('.user-location-marker').waitFor();
  await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>!document.querySelector('.leaflet-zoom-anim'));
  await shots('05-personal-markers');
  // Marker's LatLng is immutable; pinch changes geographic scale, not page scale.
  const markerBefore=await page.locator('.journal-point-marker').boundingBox();
  const before=await page.locator('.leaflet-control-scale-line').innerText();
  const r=await page.locator('#leafletMap').boundingBox();
  const cy=Math.min(r.y+r.height*.5,650),cx=r.x+r.width*.5;
  const points=spread=>[{x:cx-spread,y:cy,id:1},{x:cx+spread,y:cy,id:2}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(28)});
  for(const spread of [36,48,64,84,110])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(spread)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(old=>document.querySelector('.leaflet-control-scale-line').textContent!==old,before);
  const after=await page.locator('.leaflet-control-scale-line').innerText();
  assert.equal(await page.locator('#pointModal').isVisible(),false);
  const pinch=await page.evaluate(()=>({scale:visualViewport.scale,width:innerWidth,tiles:[...document.querySelectorAll('.leaflet-tile')].filter(x=>x.complete&&x.naturalWidth).length}));
  assert.equal(pinch.scale,1);assert.equal(pinch.width,390);
  pass('two-finger geographic zoom',{before,after,...pinch}); await shots('06-pinch-zoom');
  const panBefore=await page.locator('.user-location-marker').boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx,y:cy,id:1}]});
  for(const offset of [12,24,40,60])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx+offset,y:cy+20,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(old=>Math.abs(document.querySelector('.user-location-marker').getBoundingClientRect().x-old)>20,panBefore.x);
  const panAfter=await page.locator('.user-location-marker').boundingBox();
  assert.equal(await page.locator('#pointModal').isVisible(),false);
  pass('one-finger map pan and anchored personal marker',{before:panBefore,after:panAfter,journalBefore:markerBefore});
  for(const key of ['krivoe','ulovnoe','sukhodol','lembolovo','mednoe']) {
    await page.locator('[data-lake="'+key+'"]').click();
    await page.waitForFunction(k=>new URL(location.href).searchParams.get('lake')===k,key);
    await page.locator('#modeHybrid').click();
    assert.equal(await page.locator('#leafletMap').isVisible(),true);
    const noDepths=['lembolovo','mednoe'].includes(key);
    assert.equal(await page.locator('#mode3d').isDisabled(),noDepths);
    await page.locator('#mode2d').click(); assert.equal(await page.locator('#lakeCanvas').isVisible(),true);
    if(!noDepths) {
      const flat=await page.locator('#lakeCanvas').screenshot();
      await page.locator('#mode3d').click(); assert.equal(await page.locator('#lakeCanvas').getAttribute('data-mode'),'3d');
      const terrain=await page.locator('#lakeCanvas').screenshot();assert(!flat.equals(terrain),'3D rendering must differ from 2D');
      if(key==='krivoe'){await fs.writeFile(path.join(out,'krivoe-2d.png'),flat);await fs.writeFile(path.join(out,'krivoe-3d.png'),terrain);}
    }
    d=await dimensions();assert.equal(d.scrollWidth,390);
    pass('lake modes '+key,{noDepths,title:await page.locator('#lakeTitle').innerText()});
  }
  await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();await shots('07-offline-map-style');
  await page.locator('#tripJump').click();
  await page.waitForFunction(()=>{const y=document.querySelector('#expeditionSection').getBoundingClientRect().top;return y>=0&&y<80;});
  await shots('08-trip-plan');
  assert((await page.locator('#expeditionSection').innerText()).includes('15 сентября'));
  assert((await page.locator('#expeditionSection a').evaluateAll(as=>as.map(a=>a.href))).some(url=>url.includes('yandex')));
  await page.locator('#expeditionSection summary').last().click();
  await page.evaluate(()=>scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
  d=await dimensions();assert.equal(d.navPosition,'fixed');assert(Math.abs(d.nav.bottom-844)<1);assert.equal(d.scrollWidth,390);
  await shots('09-deep-scroll');pass('dated shore plan, routes, sources and deep-scroll navigation',d.nav);
  await nav('forecast');await page.locator('#fishSelect').selectOption('bullhead');
  assert.equal(await page.locator('#mapFishSelect').inputValue(),'bullhead');
  await shots('10-forecast');
  pass('forecast content',{temperature:await page.locator('#forecastTemp').innerText(),conditions:await page.locator('#forecastWeatherMeta').innerText(),updated:await page.locator('#updatedLabel').innerText()});
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await nav('map');await page.locator('#modeHybrid').click();
  await context.setOffline(true);await page.locator('#lakeCanvas').waitFor({state:'visible'});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.querySelector('#lakeCanvas').hidden || [...document.querySelectorAll('.leaflet-tile')].some(i=>i.complete&&i.naturalWidth));
  // Chromium can reuse HTTP-cached tiles while navigator.onLine resets to true
  // on navigation. Either a rendered cached map or the offline scheme is usable.
  const networkBlocked=await page.evaluate(async()=>{try{await fetch('https://api.open-meteo.com/v1/forecast?latitude=60.2&longitude=30.14&current=temperature_2m',{cache:'no-store',signal:AbortSignal.timeout(3000)});return false;}catch{return true;}});
  assert(networkBlocked,'external network must really be unavailable');
  await page.locator('#mode2d').click(); await page.locator('#lakeCanvas').waitFor({state:'visible'});
  assert.equal(await page.locator('#lakeTitle').innerText(),'Медное озеро');
  await nav('journal');assert.equal(await page.locator('#journalCount').innerText(),'1');
  await nav('map');await page.locator('.canvas-wrap').scrollIntoViewIfNeeded();await shots('11-offline-reload');
  pass('offline service-worker reload, scheme and journal persistence',await page.evaluate(async()=>({navigatorOnline:navigator.onLine,cache:await caches.keys(),mode:document.querySelector('#lakeCanvas').dataset.mode})));
  await context.setOffline(false);
  const failureContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await failureContext.route(/arcgisonline\.com/,route=>route.abort());
  const failurePage=await failureContext.newPage();
  await failurePage.goto(base+'?lake=mednoe#map');
  await failurePage.locator('#lakeCanvas[data-mode="2d"]').waitFor({state:'visible'});
  assert((await failurePage.locator('#toast').innerText()).includes('Спутник не загрузился'));
  pass('satellite provider failure falls back to usable 2D while online');
  await failureContext.close();
  assert.deepEqual(errors,[]);pass('no uncaught application errors');
  evidence.result='PASS';
}
main().catch(error=>{evidence.result='FAIL';evidence.error=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(evidence,null,2));if(browser)await browser.close();});
