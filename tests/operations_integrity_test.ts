Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts');
const auth=await import('../services/authz.ts');
const pos=await import('../pos/pos_db.ts');
const failures:string[]=[];
const check=(v:unknown,m:string)=>{if(!v)failures.push(m);};
const owner={id:'owner-a',role:'owner'} as any;
try {
 await db.createRestaurant({id:'restaurant-a',ownerId:'owner-a',name:'A',city:'A',address:'A'} as any);
 await db.createRestaurant({id:'restaurant-b',ownerId:'owner-b',name:'B',city:'B',address:'B'} as any);
 check(await auth.userHasPermission(owner,'restaurant-a','menu.manage'),'own restaurant access denied');
 check(!(await auth.userHasPermission(owner,'restaurant-b','menu.manage')),'owner gets permissions in another restaurant');
 check(!(await auth.userHasAnyPermission(owner,'restaurant-b',['menu.manage'])),'OR permission check bypasses ownership');
 const ctx={state:{user:owner},response:{}};
 check(!(await auth.requireRestaurantAccess(ctx,'restaurant-b')),'restaurant middleware permits unrelated owner');
 await db.kv.set(['staff','restaurant-a','staff-a'],{userId:'staff-a',restaurantId:'restaurant-a',status:'active',approvalStatus:'approved',permissions:['pos.waiter']});
 const staff={id:'staff-a',role:'staff'} as any;
 check(await auth.userHasPermission(staff,'restaurant-a','pos.waiter'),'approved staff denied');
 check(!(await auth.userHasPermission(staff,'restaurant-a','menu.manage')),'staff permission bypass');
 await db.kv.set(['staff','restaurant-a','staff-a'],{userId:'staff-a',restaurantId:'restaurant-a',status:'inactive',approvalStatus:'approved',permissions:['pos.waiter']});
 const staleCtx={state:{user:staff,staff:{userId:'staff-a',restaurantId:'restaurant-a',status:'active',approvalStatus:'approved'}},response:{}};
 check(!(await auth.requireRestaurantAccess(staleCtx,'restaurant-a')),'revoked staff gets access from stale context');
 const orders=await Promise.all([pos.getOrCreateOpenOrder('restaurant-a',1),pos.getOrCreateOpenOrder('restaurant-a',1)]);
 check(orders[0].id===orders[1].id,'parallel open creates two checks for the same table/account');
 await pos.getOrCreateOpenOrder('restaurant-a',2);
 await Promise.all([pos.closeOrderForTable('restaurant-a',2),pos.closeOrderForTable('restaurant-a',2)]);
 const bills=await pos.listBillsForRestaurant('restaurant-a',100);
 check(bills.filter(b=>b.table===2).length===1,'parallel close produces duplicate bills');
 // Force a new item to arrive after bill totals are read but before closure commits.
 const originalAtomic=db.kv.atomic.bind(db.kv);
 await pos.getOrCreateOpenOrder('restaurant-a',3);
 let injected=false;
 (db.kv as any).atomic=()=>{
   const tx=originalAtomic(),set=tx.set.bind(tx),commit=tx.commit.bind(tx);let closes=false;
   (tx as any).set=(key:any,value:any,...args:any[])=>{if(key[0]==='pos' && key[1]==='bill')closes=true;return set(key,value,...args);};
   (tx as any).commit=async()=>{
     if(closes && !injected){injected=true;await pos.addOrderItem({restaurantId:'restaurant-a',table:3,menuItem:{id:'dish',restaurantId:'restaurant-a',name_en:'Dish',price:25,destination:'kitchen'} as any,quantity:2});}
     return await commit();
   };return tx;
 };
 try{await pos.closeOrderForTable('restaurant-a',3);}finally{(db.kv as any).atomic=originalAtomic;}
 const raceBill=(await pos.listBillsForRestaurant('restaurant-a',100)).find(b=>b.table===3);
 check(injected && raceBill?.totals.total===50 && raceBill?.items.length===1,'item arriving during closure is missing from bill');
 if(raceBill){const item=raceBill.items[0];check(await pos.cancelOrderItem(raceBill.orderId,item.id,'restaurant-a')===null,'closed bill item can still be cancelled');}
 if(failures.length)throw Error(failures.join('\n'));
 console.log('PASS: tenant isolation, staff permissions/revocation, single concurrent account and bill');
} finally {db.kv.close();}
