import { preferredLanguage } from '../lib/accept_language.ts';
import { readOnce } from '../lib/request_reads.ts';
function assert(ok: unknown, message: string) { if (!ok) throw new Error(message); }
function equal(a: unknown, b: unknown) { assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
Deno.test('browser language honors weights, regional tags, ties and exclusions', () => {
  for (const [header, expected] of [
    ['ka-GE, en-US;q=0.8, he;q=0.5', 'ka'], ['en-US,en;q=0.9,he;q=0.8', 'en'],
    ['he;q=0,en;q=0.5,ka;q=0.9', 'ka'], ['ka;q=0.3,he;q=0.8', 'he'],
    ['ka;q=0.8,en;q=0.8', 'ka'], ['xx-he,xx-en,ka;q=0.4', 'ka'],
    ['en;q=invalid,he;q=0.4', 'he'], ['en;q=2,ka;q=0', undefined], [null, undefined],
  ] as const) equal(preferredLanguage(header), expected);
});
Deno.test('request reads share in-flight work but never persist between requests', async () => {
  let reads = 0;
  const load = async () => ++reads;
  const cache = new Map();
  equal(await Promise.all(Array.from({length: 32}, () => readOnce(cache, ['a'], load))), Array(32).fill(1));
  equal(await readOnce(new Map(), ['a'], load), 2);
  equal(await readOnce(undefined, ['a'], load), 3);
  let failures = 0;
  const failing = () => readOnce(cache, ['fail'], async () => { failures++; throw Error('offline'); });
  const results = await Promise.allSettled([failing(), failing()]);
  assert(results.every(r => r.status === 'rejected'), 'failures must propagate'); equal(failures, 1);
});
// Exercise the actual generated production validators with deterministic storage dependencies.
Deno.test('all slots retain identical results while repeated database work is shared', async () => {
  const db = await Deno.readTextFile(new URL('../database.ts', import.meta.url));
  let validators = db.slice(db.indexOf('export async function checkAvailability('), db.indexOf('/** סלוטים זמינים סביב'));
  validators = validators.replace(/  const \{ (listFloorLayouts|getFloorLayout) \} = await import\("\.\/services\/floor_service.ts"\);\n/g, '');
  const preamble = `import { readOnce, type RequestReads } from ${JSON.stringify(new URL('../lib/request_reads.ts', import.meta.url).href)};
    export const state = {calls: {} as Record<string,number>, used: 2, fail:false};
    const tick=(k:string)=>{state.calls[k]=(state.calls[k]||0)+1;};
    const validDate=(s:string)=>/^\\d{4}-\\d{2}-\\d{2}$/.test(s);
    const validTime=(s:string)=>/^([01]\\d|2[0-3]):[0-5]\\d$/.test(s);
    const validPeople=(n:number)=>Number.isInteger(n)&&n>0&&n<=100;
    const getRestaurant=async(id:string)=>{tick('restaurant');return {id,capacity:10,slotIntervalMinutes:15,serviceDurationMinutes:30};};
    const coerceRestaurantDefaults=(r:any)=>r;
    const listFloorLayouts=async(_id:string)=>{tick('layouts');if(state.fail)throw Error('offline');return [{capacity:10}];};
    const getFloorLayout=async(_id:string,l:string)=>{tick('layout');return l==='room'?{capacity:4,name:'Main'}:null;};
    const deriveLayoutCapacity=(l:any)=>l.capacity;
    const toMinutes=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3));
    const fromMinutes=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
    const snapToGrid=(n:number,s:number)=>Math.floor(n/s)*s;
    const isWithinOpening=(_r:any,_d:string,s:number,span:number)=>s>=1080&&s+span<=1200;
    const computeOccupancy=async()=>{tick('occupancy');return new Map([['18:15',state.used],['18:30',10]]);};
    const getRoomOccupancySnapshot=async()=>{tick('roomOccupancy');return {map:new Map([['18:00',state.used],['18:15',state.used]])};};
  `;
  const m = await import('data:application/typescript;base64,' + btoa(preamble + validators.replace(/[^\x00-\x7F]/g, ' ')));
  const times = ['17:45','18:00','18:15','18:30','19:00','19:45','23:45'];
  const run=async(cache?:Map<string,Promise<unknown>>)=>await Promise.all(times.map(async t=>[
    await m.checkAvailability('r','2030-01-07',t,2,cache),
    await m.checkRoomCapacity('r','room','2030-01-07',t,2,cache),
  ]));
  const old = await run(); const oldReads={...m.state.calls}; m.state.calls={};
  equal(await run(new Map()), old);
  for (const key of ['restaurant','layouts','layout','occupancy','roomOccupancy']) equal(m.state.calls[key], 1);
  console.log('Repeated slot reads:', oldReads, '->', m.state.calls);
  m.state.used=4;
  assert(!(await m.checkRoomCapacity('r','room','2030-01-07','18:00',2,new Map())).ok,'next request must see new occupancy');
  assert(!(await m.checkRoomCapacity('r','missing','2030-01-07','18:00',2,new Map())).ok,'invalid room must fail');
  m.state.fail=true;
  let failed=false;try{await m.checkAvailability('r','2030-01-07','18:00',2,new Map());}catch{failed=true;}
  assert(failed,'storage error must not fall back to potentially incorrect capacity');
});
Deno.test('opening API always validates default party capacity and rejects malformed input', async () => {
  let source = await Deno.readTextFile(new URL('../routes/opening.ts', import.meta.url));
  source=source.replace(/^import .*;\n/gm,'');
  const preamble=`export const state={handler:null as any,approved:true};
    const Router=class{get(_p:string,f:any){state.handler=f;}};
    const Status={NotFound:404,BadRequest:400,OK:200};
    const getRestaurant=async()=>({approved:state.approved,slotIntervalMinutes:15,serviceDurationMinutes:30});
    const openingWindowsForDate=()=>[{open:'18:00',close:'19:00'}];
    const getRestaurantSystemNow=async()=>new Date('2030-01-07T17:00:00');
    const validDate=(s:string)=>/^\\d{4}-\\d{2}-\\d{2}$/.test(s);
    const debugLog=()=>{};
    const checkAvailability=async(_r:string,_d:string,t:string)=>({ok:t!=='18:15'});
    const checkRoomCapacity=async(_r:string,l:string)=>({ok:l==='main'});
  `;
  const m=await import('data:application/typescript;base64,'+btoa((preamble+source).replace(/[^\x00-\x7F]/g,' ')));
  const get=async(q:string)=>{const c:any={params:{id:'r'},request:{url:new URL('http://fixture/?date=2030-01-07'+q)},response:{headers:new Headers()}};await m.state.handler(c);return c.response;};
  equal((await get('')).body.bookableTimes,['18:00','18:30']);
  equal((await get('&preferredLayoutId=missing')).body.bookableTimes,[]);
  for(const p of ['','0','101','2.5','no'])equal((await get('&people='+p)).status,400);
  m.state.approved=false;equal((await get('')).status,404);
});
