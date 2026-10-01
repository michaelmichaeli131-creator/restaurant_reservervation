// Execute the real route registrations with mocked external I/O and real KV authorization.
Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts');
const {requireRestaurantOwner}=await import('../lib/owner_access.ts');
let registrations:any[]=[];
class Router {get(p:any,...h:any[]){registrations.push({p,h});return this;}post(p:any,...h:any[]){registrations.push({p,h});return this;}put(p:any,...h:any[]){registrations.push({p,h});return this;}delete(p:any,...h:any[]){registrations.push({p,h});return this;}}
try {
 await db.createRestaurant({id:'a',ownerId:'alice',name:'A',city:'A',address:'A'} as any);
 await db.createRestaurant({id:'b',ownerId:'bob',name:'B',city:'B',address:'B'} as any);
 let checked=0;
 for(const path of ['routes/inventory.ts','routes/owner_bills.ts','routes/pos.ts']) {
   registrations=[];
   let source=await Deno.readTextFile(new URL('../'+path,import.meta.url));
   const names=new Set<string>();
   source=source.replace(/import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g,(_,raw)=>{for(const entry of raw.replace(/\/\/[^\n]*/g,'').split(',')){const name=entry.trim().split(/\s+as\s+/).pop();if(name)names.add(name);}return '';});
   const stubs:any={Router,Status:{Forbidden:403},requireRestaurantOwner,requireOwner:()=>true};
   for(const name of names)if(!(name in stubs))stubs[name]=()=>{throw Error('unauthorized handler reached I/O: '+name);};
   (globalThis as any).__routeAudit=stubs;
   const preamble='const {'+[...names].join(',')+'} = (globalThis as any).__routeAudit;\n';
   const temp=await Deno.makeTempFile({suffix:'.ts'});
   try{await Deno.writeTextFile(temp,preamble+source);await import('file://'+temp);}finally{await Deno.remove(temp);}
   for(const {p,h} of registrations.filter(r=>r.p.startsWith('/owner/'))) {
     if(!p.includes(':rid'))throw Error('unexpected owner route '+p);
     const ctx={params:{rid:'b'},state:{user:{id:'alice',role:'owner'}},response:{status:200,body:''}};
     for(const handler of h) await handler(ctx);
     if(ctx.response.status!==403)throw Error('tenant isolation failed: '+p);
     checked++;
   }
 }
 const allowed={state:{user:{id:'alice',role:'owner'}},response:{}};
 if(!(await requireRestaurantOwner(allowed,'a')))throw Error('own restaurant access denied');
 console.log(`PASS: ${checked} actual owner route handlers reject another restaurant before I/O`);
}finally{db.kv.close();delete (globalThis as any).__routeAudit;}
