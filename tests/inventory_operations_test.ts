Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts');
const inv=await import('../inventory/inventory_db.ts');
const failures:string[]=[];
const check=(v:unknown,m:string)=>{if(!v)failures.push(m);};
async function ingredient(id:string){return await inv.upsertIngredient({id,restaurantId:'test',name:id,unit:'kg',currentQty:0,minQty:0});}
async function order(id:string,lines:any[]){const po=await inv.createPurchaseOrder({restaurantId:'test',supplier:{id,name:id,leadTimeDays:1} as any});await inv.savePurchaseOrder({restaurantId:'test',poId:po.id,lines});return po;}
try{
 await ingredient('a');
 await Promise.all([3,7].map(deltaQty=>inv.applyInventoryTx({restaurantId:'test',ingredientId:'a',type:'delivery',deltaQty})));
 check((await inv.getIngredient('test','a'))?.currentQty===10,'concurrent stock movements lost quantity');
 await ingredient('b');
 const po=await order('supplier',[{ingredientId:'b',qty:4},{ingredientId:'b',qty:2}]);
 await Promise.all([inv.markPurchaseOrderDelivered({restaurantId:'test',poId:po.id}),inv.markPurchaseOrderDelivered({restaurantId:'test',poId:po.id})]);
 const txs=await inv.listInventoryTx('test',100);
 check((await inv.getIngredient('test','b'))?.currentQty===6,'duplicate delivery changed stock twice');
 check(txs.filter(t=>t.ingredientId==='b').reduce((s,t)=>s+t.deltaQty,0)===6,'duplicate delivery created duplicate ledger movements');
 await ingredient('c'); await ingredient('d');
 const failing=await order('failure',[{ingredientId:'c',qty:3},{ingredientId:'d',qty:5}]);
 const original=db.kv.atomic.bind(db.kv);let commits=0;
 (db.kv as any).atomic=()=>{const tx=original();const commit=tx.commit.bind(tx);(tx as any).commit=async()=>{if(++commits===2)throw Error('simulated storage failure');return await commit();};return tx;};
 try{await inv.markPurchaseOrderDelivered({restaurantId:'test',poId:failing.id});}catch{}
 finally{(db.kv as any).atomic=original;}
 const saved=await inv.getPurchaseOrder('test',failing.id);
 const c=(await inv.getIngredient('test','c'))!.currentQty,d=(await inv.getIngredient('test','d'))!.currentQty;
 check(saved?.status==='delivered'?c===3&&d===5:c===0&&d===0,'delivery left partially updated stock');
 await ingredient('e');
 const missing=await order('missing',[{ingredientId:'e',qty:2},{ingredientId:'deleted-ingredient',qty:1}]);
 let missingRejected=false;
 try{await inv.markPurchaseOrderDelivered({restaurantId:'test',poId:missing.id});}catch{missingRejected=true;}
 check(missingRejected && (await inv.getIngredient('test','e'))?.currentQty===0,'missing ingredient partially changed stock');
 const cancelled=await order('cancelled',[{ingredientId:'e',qty:2}]);
 await inv.setPurchaseOrderStatus({restaurantId:'test',poId:cancelled.id,status:'cancelled'});
 await inv.markPurchaseOrderDelivered({restaurantId:'test',poId:cancelled.id});
 check((await inv.getIngredient('test','e'))?.currentQty===0,'cancelled order changed stock');
 const rollback=await order('rollback',[{ingredientId:'e',qty:2}]);
 (db.kv as any).atomic=()=>{const tx=original();(tx as any).commit=async()=>{throw Error('forced commit failure');};return tx;};
 let rejected=false;
 try{await inv.markPurchaseOrderDelivered({restaurantId:'test',poId:rollback.id});}catch{rejected=true;}
 finally{(db.kv as any).atomic=original;}
 check(rejected && (await inv.getIngredient('test','e'))?.currentQty===0 && (await inv.getPurchaseOrder('test',rollback.id))?.status==='draft','failed receipt must preserve stock and status');
 let invalidRejected=false;try{await inv.applyInventoryTx({restaurantId:'test',ingredientId:'a',type:'delivery',deltaQty:Infinity});}catch{invalidRejected=true;}
 check(invalidRejected,'nonfinite stock quantity accepted');
 if(failures.length)throw Error(failures.join('\n'));
 console.log('PASS: stock concurrency, duplicate delivery, repeated ingredient lines, all-or-nothing receipt, input validation');
}finally{db.kv.close();}
