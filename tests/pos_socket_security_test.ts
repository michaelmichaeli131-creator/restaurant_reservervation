Deno.env.set('DENO_KV_PATH', ':memory:');
const db=await import('../database.ts');
const pos=await import('../pos/pos_db.ts');
const failures:string[]=[];const check=(v:unknown,m:string)=>{if(!v)failures.push(m);};
const sourcePath=Deno.env.get('WS_SOURCE') || new URL('../pos/pos_ws.ts',import.meta.url).pathname;
const source=(await Deno.readTextFile(sourcePath)).replace('import { Status, type Context } from "jsr:@oak/oak";','const Status={BadRequest:400}; type Context=any;');
const fixture=await Deno.makeTempFile({dir:new URL('../pos/',import.meta.url).pathname,suffix:'.ts'});
await Deno.writeTextFile(fixture,source);
const wsModule=await import('file://'+fixture);
function connection(user?:any){let closedResolve:()=>void=()=>{};const closed=new Promise<void>(r=>closedResolve=r);const socket:any={readyState:1,sent:[],send(s:string){this.sent.push(JSON.parse(s));},close(){this.readyState=3;closedResolve();this.onclose?.();}};const ctx:any={state:{user},response:{},isUpgradable:true,upgraded:false,upgrade(){this.upgraded=true;return socket;},throw(){throw Error('unexpected HTTP throw');}};return{ctx,socket,closed};}
async function send(c:any,msg:any){await c.socket.onmessage?.({data:JSON.stringify(msg)});}
try{
 for(const [id,role] of [['alice','owner'],['bob','owner'],['staff','staff']])await db.kv.set(['user',id],{id,role,isActive:true});
 await db.createRestaurant({id:'a',ownerId:'alice',name:'A',city:'A',address:'A'} as any);
 await db.createRestaurant({id:'b',ownerId:'bob',name:'B',city:'B',address:'B'} as any);
 const anon=connection();await wsModule.handlePosSocket(anon.ctx);check(!anon.ctx.upgraded && anon.ctx.response.status===401,'anonymous socket upgraded');
 const foreign=connection({id:'alice'});await wsModule.handlePosSocket(foreign.ctx);await send(foreign,{type:'join',restaurantId:'b',role:'kitchen'});check(foreign.socket.readyState===3 && foreign.socket.sent.length===0,'foreign restaurant subscription allowed');
 await db.kv.set(['staff','a','staff'],{userId:'staff',restaurantId:'a',status:'active',approvalStatus:'approved',permissions:['pos.kitchen']});
 const staff=connection({id:'staff'});await wsModule.handlePosSocket(staff.ctx);await send(staff,{type:'join',restaurantId:'a',role:'kitchen'});check(staff.socket.sent.some((m:any)=>m.type==='snapshot'),'authorized kitchen snapshot missing');
 const order=await pos.getOrCreateOpenOrder('b',1);
 const item={id:'foreign-item',orderId:order.id,restaurantId:'b',table:1,status:'received',quantity:1,unitPrice:20,createdAt:1};
 await db.kv.set(['pos','order_item',order.id,item.id],item);
 check(await pos.updateOrderItemStatus(item.id,order.id,'cancelled','a')===null,'cross-restaurant item status changed');
 check(await pos.updateOrderItemNotes(item.id,order.id,'injected','a')===null,'cross-restaurant item note changed');
 await send(staff,{type:'set_status',restaurantId:'a',orderId:order.id,orderItemId:item.id,status:'cancelled'});
 check((await db.kv.get<any>(['pos','order_item',order.id,item.id])).value?.status==='received','socket mutated foreign item');
 await db.kv.set(['staff','a','staff'],{userId:'staff',restaurantId:'a',status:'inactive',approvalStatus:'approved',permissions:['pos.kitchen']});
 const before=staff.socket.sent.length;
 wsModule.notifyOrderItemAdded({...item,restaurantId:'a'});
 await Promise.race([staff.closed,new Promise(r=>setTimeout(r,100))]);
 check(staff.socket.readyState===3 && staff.socket.sent.length===before,'revoked staff received live update');
 if(failures.length)throw Error(failures.join('\n'));
 console.log('PASS: anonymous/foreign WebSocket denied, valid kitchen allowed, scoped items, revoked live subscription');
}finally{await Deno.remove(fixture);db.kv.close();}
