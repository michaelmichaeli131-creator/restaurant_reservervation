// Exercise real KV and the same day lock used by public bookings.
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(fn: () => Promise<unknown>, message: string) { let failed=false; try { await fn(); } catch {failed=true;} assert(failed,message); }
Deno.test({name:'Calendar: capacity, event duration, table conflicts, tenant isolation and atomic waitlist conversion',sanitizeResources:false,sanitizeOps:false,fn:async()=>{
 const dir=await Deno.makeTempDir(); Deno.env.set('DENO_KV_PATH',dir+'/calendar.db');
 const db=await import('../database.ts');
 const {saveCalendarReservation:save, updateCalendarStatus:updateStatus, calendarAlternatives:alternatives}=await import('../services/calendar_operations.ts');
 const {createCalendarWaitlist,listCalendarWaitlist}=await import('../services/calendar_waitlist.ts');
 try {
  const rid='calendar-test', date='2099-01-01';
  await db.kv.set(['restaurant',rid],{id:rid,ownerId:'owner',name:'Calendar Test',approved:true,capacity:4,slotIntervalMinutes:10,serviceDurationMinutes:60});
  const base={date,time:'18:10',people:3,firstName:'Guest',durationMinutes:60};
  const concurrent=await Promise.allSettled([save(rid,base,'owner'),save(rid,base,'owner')]);
  assert(concurrent.filter(r=>r.status==='fulfilled').length===1,'Concurrent calendar writes overbooked');
  const first=(concurrent.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  assert(first.time==='18:10','Display ruler changed booking time');
  await rejects(()=>save('another-restaurant',{...base,id:first.id},'other'),'Cross restaurant mutation allowed');
  await rejects(()=>save(rid,{...base,time:'25:00'},'owner'),'Invalid time accepted');
  await rejects(()=>save(rid,{...base,date:'2026-02-30'},'owner'),'Impossible date accepted');
  await save(rid,{id:first.id,date:'2099-01-02',time:'18:10'},'owner');
  assert((await db.listReservationsByRestaurantAndDate(rid,date)).length===0,'Old date index retained after reschedule');
  assert((await db.listReservationsByRestaurantAndDate(rid,'2099-01-02')).length===1,'New date index missing');
  const event=await save(rid,{...base,time:'19:00',people:4,durationMinutes:180,calendarKind:'event',eventTitle:'Private dinner'},'owner');
  assert(!(await db.checkAvailability(rid,date,'21:00',2)).ok,'Event capacity not visible to public booking');
  await rejects(()=>save(rid,{...base,time:'21:30',people:1},'owner'),'Long event overlap not detected');
  await save(rid,{id:event.id,status:'canceled'},'owner');
  assert((await db.checkAvailability(rid,date,'21:00',2)).ok,'Cancelled event still occupies seats');
  await db.kv.set(['floor_plan',rid,'room'],{id:'room',restaurantId:rid,name:'Terrace',capacity:4,tables:[{id:'table',seats:2}],createdAt:Date.now()});
  await db.kv.set(['floor_plan_by_restaurant',rid,'room'],{id:'room'});
  const seated=await save(rid,{...base,people:2,preferredLayoutId:'room',tableId:'table'},'owner');
  await rejects(()=>save(rid,{...base,people:2,preferredLayoutId:'room',tableId:'table'},'owner'),'Double table assignment accepted');
  const before=JSON.stringify((await db.kv.get(['reservation',seated.id])).value);
  const choices=await alternatives(rid,{...base,people:2,preferredLayoutId:'room',tableId:'table'});
  assert(choices.length>0 && choices.every(c=>c.time<='17:10'||c.time>='19:10'),'Suggestions overlap reserved table');
  assert(choices.every(c=>c.time.endsWith('0')),'Suggestions ignored booking interval');
  assert(before===JSON.stringify((await db.kv.get(['reservation',seated.id])).value),'Availability check mutated reservation');
  await rejects(()=>updateStatus('other',{id:seated.id,updatedAt:seated.updatedAt,status:'arrived'},'owner'),'Status endpoint crossed tenant');
  await rejects(()=>updateStatus(rid,{id:seated.id,updatedAt:seated.updatedAt-1,status:'arrived'},'owner'),'Stale status accepted');
  const arrived=await updateStatus(rid,{id:seated.id,updatedAt:seated.updatedAt,status:'arrived'},'host');
  assert(arrived.phone===seated.phone&&arrived.time===seated.time&&arrived.tableId===seated.tableId,'Status changed booking details');
  const atTable=await updateStatus(rid,{id:arrived.id,updatedAt:arrived.updatedAt,status:'seated'},'host');
  await rejects(()=>save(rid,{...base,people:2,preferredLayoutId:'room',tableId:'table'},'owner'),'Seated reservation stopped occupying table');
  const done=await updateStatus(rid,{id:atTable.id,updatedAt:atTable.updatedAt,status:'completed'},'host');
  await rejects(()=>updateStatus(rid,{id:done.id,updatedAt:done.updatedAt,status:'arrived'},'host'),'Quick action reopened completed booking');
  const free=await save(rid,{...base,people:2,preferredLayoutId:'room',tableId:'table'},'owner');
  await save(rid,{id:free.id,status:'canceled'},'owner');
  await save(rid,{id:seated.id,status:'canceled'},'owner');
  const waiting=await createCalendarWaitlist(rid,{date,time:'18:10',name:'Wait Guest',phone:'+972501234567',people:2},'guest');
  const convert={date,time:'18:10',people:2,firstName:waiting.name,phone:waiting.phone};
  const replay=await Promise.all([save(rid,convert,'owner',waiting.id),save(rid,convert,'owner',waiting.id)]);
  assert(replay[0].id===replay[1].id,'Waitlist replay produced two reservations');
  assert((await listCalendarWaitlist(rid,date))[0].status==='converted','Conversion status not stored atomically');
  const impossible=await createCalendarWaitlist(rid,{date,time:'18:10',name:'Too many',phone:'+972501111111',people:4});
  await rejects(()=>save(rid,{...convert,people:4},'owner',impossible.id),'Waitlist conversion overbooked');
  assert((await listCalendarWaitlist(rid,date)).find(r=>r.id===impossible.id)?.status==='waiting','Failed conversion changed waitlist state');
 } finally { db.kv.close(); await Deno.remove(dir,{recursive:true}); }
}});
