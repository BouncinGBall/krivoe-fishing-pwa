const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
const elements = new Map();
function el(id) { if (!elements.has(id)) elements.set(id, { id, textContent:'', innerHTML:'', value:'', hidden:false, dataset:{}, style:{setProperty(){}}, classList:{toggle(){},add(){},remove(){}}, setAttribute(){}, removeAttribute(){}, addEventListener(){}, querySelector(){return el(id+'child');}, querySelectorAll(){return [];} }); return elements.get(id); }
const storage = new Map();
const ctx = {window:{},document:{getElementById:el,querySelector:el,querySelectorAll:()=>[],addEventListener(){}},navigator:{onLine:false},location:{search:'?lake=lembolovo'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},URLSearchParams,URL,Date,console,setTimeout,clearTimeout,AbortSignal};
vm.createContext(ctx);
for (const file of ['data.js','trip-data.js','mednoe-geometry.js','mednoe-data.js']) vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
const source = fs.readFileSync('app.js','utf8').replace('  document.addEventListener("DOMContentLoaded", boot);', '  window.test = {scoreAt,conditionsAt,weatherUsable,bestWindows,rankedHotspots,pointInWater,estimateDepth,moscowDay,moscowHour,renderAll,weatherUrl,renderExpedition, inject(data,at){weather=data;weatherCache[selectedLake]={data,at};},select(key){selectedLake=key;}};');
vm.runInContext(source,ctx);
const t=ctx.window.test, lake=ctx.window.LAKE_DATA.lembolovo;
assert.equal(Object.keys(ctx.window.LAKE_DATA).length,5);
assert.equal(t.scoreAt(new Date()),null);
assert.equal(t.bestWindows().length,0);
assert.equal(t.estimateDepth(...lake.center),null);
assert.match(t.weatherUrl(),/latitude=60.391/);
assert.match(t.weatherUrl(),/wind_speed_unit=ms/);
for (const spot of lake.hotspots) assert(t.pointInWater([spot.lat,spot.lon]),spot.id+' must be in water');
assert(!t.pointInWater([lake.expedition.access[0].lat,lake.expedition.access[0].lon]),'access must be on land');
const island=lake.holes[0].slice(0,-1).reduce((a,p)=>[a[0]+p[0]/3,a[1]+p[1]/3],[0,0]);
assert(!t.pointInWater(island),'island is not water');
assert.equal(t.rankedHotspots('pike').length,3);
assert.equal(t.rankedHotspots('roach').length,2);
assert.equal(t.rankedHotspots('bream').length,1);
assert.equal(t.moscowHour(new Date('2026-09-14T23:00:00Z')),2);
assert.equal(t.moscowDay(new Date('2026-09-14T23:00:00Z')),'2026-09-15');
const start=Math.floor(Date.now()/3600000)*3600000-6*3600000;
const times=Array.from({length:54},(_,i)=>new Date(start+i*3600000+10800000).toISOString().slice(0,16));
const arr=v=>times.map(()=>v);
const data={hourly:{time:times,temperature_2m:arr(15),wind_speed_10m:arr(3),wind_gusts_10m:arr(5),wind_direction_10m:arr(90),pressure_msl:arr(1015),cloud_cover:arr(50),precipitation_probability:arr(10),weather_code:arr(2)},hourly_units:{wind_speed_10m:'m/s'},daily:{time:[...new Set(times.map(s=>s.slice(0,10)))]}};
data.daily.sunrise=data.daily.time.map(d=>d+'T06:25');data.daily.sunset=data.daily.time.map(d=>d+'T19:20');
t.inject(data,Date.now());
assert(Number.isFinite(t.scoreAt(new Date())));
assert(t.bestWindows().length>0);
assert.equal(t.scoreAt(new Date(start+80*3600000)),null);
data.hourly.wind_speed_10m.fill(null);assert.equal(t.scoreAt(new Date()),null);
data.hourly.wind_speed_10m.fill(3);data.hourly.wind_gusts_10m.fill(16);assert.equal(t.scoreAt(new Date()),8);
t.inject(data,Date.now()-7*3600000);assert.equal(t.scoreAt(new Date()),null);
assert.equal(t.bestWindows().length,0);
t.renderAll();
assert.equal(el('scoreValue').textContent,'—');
assert(!/null|NaN|undefined/.test(el('expeditionSection').innerHTML));
assert.match(el('expeditionSection').innerHTML,/Лемболовского/);
assert.match(el('fishGuide').innerHTML,/незацепляйка/);
assert(!/null|NaN|undefined/.test(el('compareList').innerHTML));
for (const key of ['krivoe','ulovnoe','sukhodol','lembolovo','mednoe']) {
  t.select(key); t.renderAll();
  assert(!/null|NaN|undefined/.test(el('fishGuide').innerHTML),key+' guide');
  assert.equal(el('fishSelect').innerHTML,el('mapFishSelect').innerHTML,'both fish selectors must match');
}
const mednoe=ctx.window.LAKE_DATA.mednoe;
assert.equal(mednoe.holes.length,10);
assert(mednoe.geometry.length>400,'detailed OSM shoreline');
assert.equal(t.estimateDepth(...mednoe.center),null);
assert.equal(el('mode3d').disabled,true);
assert.equal(el('depthToggle').disabled,true);
assert.equal(el('legendDeep').hidden,true);
assert.equal(el('depthScaleChips').innerHTML,'');
assert.match(el('fishSelect').innerHTML,/bullhead/);
assert.match(el('fishGuide').innerHTML,/Бурый американский сомик/);
assert.match(el('expeditionSection').innerHTML,/НЕ РЕЙТИНГ УЛОВА/);
assert.match(el('expeditionSection').innerHTML,/Сравнение вариантов/);
assert.match(el('expeditionSection').innerHTML,/105482/,'include negative shore evidence');
assert.equal(t.rankedHotspots('pike').length,0,'do not invent pike points');
assert.equal(t.rankedHotspots('perch').length,3);
assert.equal(t.rankedHotspots('bullhead').length,1);
for (const spot of mednoe.hotspots) assert(t.pointInWater([spot.lat,spot.lon]),spot.id+' must be in water');
assert(!t.pointInWater([mednoe.expedition.access[0].lat,mednoe.expedition.access[0].lon]),'Mednoe access is on land');
// Spherical polygon area; displayed approximation excludes the ten islands.
const area=r=>Math.abs(r.reduce((sum,p,i)=>{const q=r[(i+1)%r.length];return sum+(q[1]-p[1])*Math.PI/180*(2+Math.sin(p[0]*Math.PI/180)+Math.sin(q[0]*Math.PI/180));},0)*6371008.8**2/2);
const km2=(area(mednoe.geometry)-mednoe.holes.reduce((s,r)=>s+area(r),0))/1e6;
assert(km2>.94&&km2<.95,'Mednoe area without islands');
for (const ring of mednoe.holes) {
  // Midpoint just inside an island edge; avoid assuming concave centroid is inside.
  let found=false;
  const minLat=Math.min(...ring.map(p=>p[0])), maxLat=Math.max(...ring.map(p=>p[0]));
  const minLon=Math.min(...ring.map(p=>p[1])), maxLon=Math.max(...ring.map(p=>p[1]));
  for(let y=1;y<10&&!found;y++)for(let x=1;x<10&&!found;x++) {
    const p=[minLat+(maxLat-minLat)*y/10,minLon+(maxLon-minLon)*x/10];
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++)if((ring[i][1]>p[1])!==(ring[j][1]>p[1])&&p[0]<(ring[j][0]-ring[i][0])*(p[1]-ring[i][1])/(ring[j][1]-ring[i][1])+ring[i][0])inside=!inside;
    if(inside){assert(!t.pointInWater(p),'island cannot be water');found=true;}
  }
  assert(found,'island test point');
}
const html=fs.readFileSync('index.html','utf8');
assert(html.indexOf('src="data.js')<html.indexOf('src="trip-data.js'));
assert(html.indexOf('src="trip-data.js')<html.indexOf('src="app.js'));
assert(html.indexOf('src="trip-data.js')<html.indexOf('src="mednoe-geometry.js'));
assert(html.indexOf('src="mednoe-geometry.js')<html.indexOf('src="mednoe-data.js'));
assert(html.indexOf('src="mednoe-data.js')<html.indexOf('src="app.js'));
const sw=fs.readFileSync('sw.js','utf8');
for(const file of ['trip-data.js','mednoe-geometry.js','mednoe-data.js'])assert(sw.includes('./'+file));
for(const file of ['index.html','app.js','sw.js'])assert(fs.readFileSync(file,'utf8').includes('20260914-mednoe-1'));
console.log('PASS: five lakes; fish selectors and filters; Mednoe area/shoreline/ten islands/dry access; no invented depths; honest comparison; weather freshness/units/nulls/storm; Moscow time; offline rendering; script order and PWA assets.');
