import { Application } from 'jsr:@oak/oak';
function assert(ok:unknown,message:string): asserts ok {if(!ok) throw new Error(message);}
Deno.test({name:'Calendar HTTP permissions, guest consent, filters and reservation operations',sanitizeResources:false,sanitizeOps:false,fn:async()=>{
 const dir=await Deno.makeTempDir(); Deno.env.set('DENO_KV_PATH',dir+'/http.db');
 const db=await import('../database.ts');
 const {ownerCalendarRouter}=await import('../routes/owner_calendar.ts');
 const app=new Application(); const session=new Map();
 app.use(async(ctx,next)=>{try{await next();}catch(e){ctx.response.status=(e as any).status||500;ctx.response.body={error:(e as Error).message};}});
 app.use(async(ctx,next)=>{
  const user=ctx.request.headers.get('x-test-user');
  ctx.state.user=user?{id:user,role:'owner'}:null;
  ctx.state.session={get:(k:string)=>session.get(k),set:(k:string,v:unknown)=>session.set(k,v)};
  ctx.state.lang='en'; ctx.state.t=(_k:string)=>_k;
  await next();
 });
 app.use(ownerCalendarRouter.routes());app.use(ownerCalendarRouter.allowedMethods());
 const request=(path:string,method='GET',data?:unknown,user='owner')=>app.handle(new Request('http://localhost'+path,{method,headers:{'x-test-user':user,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})}));
 const path='/owner/restaurants/test/calendar';
 try{
  await db.kv.set(['restaurant','test'],{id:'test',ownerId:'owner',name:'Test',approved:true,capacity:20,slotIntervalMinutes:10,serviceDurationMinutes:60});
  await db.kv.set(['staff','test','viewer'],{userId:'viewer',restaurantId:'test',status:'active',approvalStatus:'approved',permissions:['reservations.view']});
  await db.kv.set(['staff','test','host'],{userId:'host',restaurantId:'test',status:'active',approvalStatus:'approved',permissions:['reservations.view','reservations.manage']});
  assert((await request(path+'/agenda?date=2099-01-01','GET',undefined,''))?.status===401,'Anonymous read allowed');
  assert((await request(path+'/agenda?date=2099-01-01','GET',undefined,'other-owner'))?.status===403,'Unrelated owner read allowed');
  assert((await request(path+'/agenda?date=2099-01-01','GET',undefined,'viewer'))?.status===200,'Authorized viewer denied');
  const payload={date:'2099-01-01',time:'18:10',people:2,firstName:'Ada'};
  assert((await request(path+'/save','POST',payload,'viewer'))?.status===403,'Read-only staff could write');
  const saved=await request(path+'/save','POST',payload,'host');assert(saved?.status===200,'Host could not save');
  const event=await request(path+'/save','POST',{...payload,time:'20:10',calendarKind:'event',eventTitle:'Birthday'});assert(event?.status===200,'Event creation failed');
  const filtered=await (await request(path+'/agenda?date=2099-01-01&kind=event&q=Birthday'))?.json();assert(filtered.items.length===1&&filtered.items[0].eventTitle==='Birthday','Shared filters failed');
  const month=await (await request(path+'/month?month=2099-01&kind=event'))?.json();assert(month.days[0].events===1&&month.days[0].reservations===0,'Event month counts failed');
  const form=await request('/restaurants/test/waitlist','GET',undefined,'');assert(form?.status===200,'Guest form failed to render');
  const body=await form.text();assert(body.includes('name="nonce"'),'Guest nonce missing');
  const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const guest={date,time:'19:00',name:'Guest',phone:'+972501234567',people:2,nonce:session.get('calendarWaitlistNonce')};
  assert((await request('/restaurants/test/waitlist','POST',guest,''))?.status===400,'Missing consent accepted');
  const success=await request('/restaurants/test/waitlist','POST',{...guest,nonce:session.get('calendarWaitlistNonce'),consent:'yes'},'');assert(success?.status===200,'Guest request failed');
  const rows=await (await request(path+'/waitlist?date='+date))?.json();assert(rows.items.length===1&&rows.items[0].source==='guest','Guest request not stored');
  assert((await db.listReservationsByRestaurantAndDate('test',date)).length===0,'Waitlist consumed reservation capacity');
 }finally{db.kv.close();await Deno.remove(dir,{recursive:true});}
}});
