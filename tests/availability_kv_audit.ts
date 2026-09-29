// Isolated in-memory KV integration test; no external service, reservation or email.
Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts');
function assert(v:unknown,message:string){if(!v)throw Error(message);}
try {
 await db.createRestaurant({id:'test',ownerId:'test',name:'Test',city:'Test',address:'Test',approved:true,capacity:8,slotIntervalMinutes:15,serviceDurationMinutes:30});
 for(const id of ['a','b']){
  await db.kv.set(['floor_plan','test',id],{id,restaurantId:'test',name:id,capacity:4,tables:[],updatedAt:1});
  await db.kv.set(['floor_plan_by_restaurant','test',id],1);
 }
 for(const [id,status,time,durationMinutes,people,room] of [
  ['one','confirmed','18:00',45,4,'a'],['two','cancelled','18:00',30,4,'b'],['three','confirmed','19:00',30,3,'b'],
 ] as const){await db.createReservation({id,restaurantId:'test',date:'2030-01-07',time,people,status,durationMinutes,preferredLayoutId:room,name:'Fixture',phone:'',createdAt:1} as any);}
 const reads=new Map();
 for(const t of ['17:45','18:00','18:15','18:30','18:45','19:00']){
  const plain=await db.checkAvailability('test','2030-01-07',t,2);
  const shared=await db.checkAvailability('test','2030-01-07',t,2,reads);
  assert(JSON.stringify(plain)===JSON.stringify(shared),'total mismatch '+t);
  for(const room of ['a','b'])assert(JSON.stringify(await db.checkRoomCapacity('test',room,'2030-01-07',t,2))===JSON.stringify(await db.checkRoomCapacity('test',room,'2030-01-07',t,2,reads)),'room mismatch '+t);
 }
 assert(!(await db.checkRoomCapacity('test','a','2030-01-07','18:30',2)).ok,'duration overlap must block');
 assert((await db.checkRoomCapacity('test','a','2030-01-07','18:45',2)).ok,'released room must open');
 assert((await db.checkRoomCapacity('test','b','2030-01-07','18:00',4)).ok,'cancelled reservations must not occupy seats');
 console.log('PASS: real in-memory KV, multi-room occupancy, duration overlap, cancellations, snapshot equivalence');
} finally { db.kv.close(); }
