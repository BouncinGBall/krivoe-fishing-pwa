// Read-only OSM import. Prints geometry; commit generated data with apply_patch.
const id = process.argv[2];
if (!/^\d+$/.test(id || '')) throw new Error('Provide an OSM relation id');
const response = await fetch(`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`, {signal: AbortSignal.timeout(25000)});
if (!response.ok) throw new Error(`OSM HTTP ${response.status}`);
const {elements} = await response.json();
const nodes = new Map(elements.filter(e => e.type === 'node').map(e => [e.id, [e.lat, e.lon]]));
const ways = new Map(elements.filter(e => e.type === 'way').map(e => [e.id, e.nodes]));
const relation = elements.find(e => e.type === 'relation' && e.id === Number(id));
function rings(role) {
  const pending = relation.members.filter(m => m.type === 'way' && m.role === role).map(m => [...ways.get(m.ref)]);
  const result = [];
  while (pending.length) {
    const ring = pending.shift();
    while (ring[0] !== ring.at(-1)) {
      const i = pending.findIndex(p => p[0] === ring.at(-1) || p.at(-1) === ring.at(-1));
      if (i < 0) throw new Error('Unclosed OSM ring');
      const next = pending.splice(i,1)[0];
      if (next[0] !== ring.at(-1)) next.reverse();
      ring.push(...next.slice(1));
    }
    result.push(ring.map(n => nodes.get(n)));
  }
  return result;
}
// Keep original coordinates, simplify by at most ~3 m perpendicular error.
const project = p => [p[1]*55500,p[0]*111200];
function simplify(points, eps=3) {
  if(points.length<=3)return points;
  const a=project(points[0]),b=project(points.at(-1));
  let best=0,index=0;
  for(let i=1;i<points.length-1;i++) {
    const p=project(points[i]),dx=b[0]-a[0],dy=b[1]-a[1];
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
    const d=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
    if(d>best){best=d;index=i;}
  }
  return best>eps ? [...simplify(points.slice(0,index+1),eps).slice(0,-1),...simplify(points.slice(index),eps)] : [points[0],points.at(-1)];
}
const outer=rings('outer');
if(outer.length!==1)throw new Error('App needs one outer polygon');
console.log(JSON.stringify({source:`https://www.openstreetmap.org/relation/${id}`,version:relation.version,checked:'2026-09-14',tags:relation.tags,geometry:simplify(outer[0]),holes:rings('inner').map(r=>simplify(r))}));
