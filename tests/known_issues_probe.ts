// Diagnostic reproductions of findings outside the current security/POS patch.
Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts'),clock=await import('../services/timeclock_db.ts'),inv=await import('../inventory/inventory_db.ts');
const oldLog=console.log;console.log=()=>{};
try{
 const at=(h:number)=>new Date(2030,0,7,h,0,0).getTime();
 for(const [start,end] of [[9,12],[15,18]]){
 await clock.checkInNow({restaurantId:'r',staffId:'s',userId:'u',source:'staff',at:at(start)});
 await clock.checkOutNow({staffId:'s',userId:'u',roleForAudit:'staff',at:at(end)});
 }
 const row=await clock.getRow('r','s',clock.ymdKeyLocal(at(9)));
 oldLog(JSON.stringify({finding:'second shift replaces first shift',expectedMinutes:360,actualMinutes:clock.minutesWorked(row!)}));
 const ing=await inv.upsertIngredient({id:'a',restaurantId:'r',name:'A',unit:'kg',currentQty:10,minQty:0});
 const count=await inv.createInventoryCountSession({restaurantId:'r'});
 await inv.ensureInventoryCountSnapshot({restaurantId:'r',countId:count.id,ingredients:[ing]});
 await inv.upsertInventoryCountLine({restaurantId:'r',countId:count.id,ingredientId:'a',actualQty:8,adjustKind:'adjustment',note:null});
 await Promise.allSettled([inv.finalizeInventoryCount({restaurantId:'r',countId:count.id}),inv.finalizeInventoryCount({restaurantId:'r',countId:count.id})]);
 oldLog(JSON.stringify({finding:'concurrent count finalization applies correction twice',expectedQty:8,actualQty:(await inv.getIngredient('r','a'))?.currentQty}));
}finally{console.log=oldLog;db.kv.close();}
