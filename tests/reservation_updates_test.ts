// Integration regression: isolated KV only; no HTTP, emails or real bookings.
Deno.env.set('DENO_KV_PATH', ':memory:');
const db = await import('../database.ts');
const failures: string[] = [];
function check(ok: unknown, message: string) { if (!ok) failures.push(message); }
const seed = { id:'update-test',restaurantId:'r1',date:'2030-01-07',time:'18:00',people:2,userId:'u1',status:'new',note:'keep me',createdAt:1 } as any;
try {
 await db.createReservation(seed);
 await Promise.all([db.updateReservation(seed.id,{phone:'123'}),db.updateReservation(seed.id,{status:'confirmed'})]);
 let row=await db.getReservationById(seed.id);
 check(row?.phone==='123' && row?.status==='confirmed','concurrent partial updates lose data');
 await db.updateReservationFields(seed.id,{userId:'u2',date:'2030-01-08'});
 check(!(await db.kv.get(['reservation_user','u1',seed.id])).value,'old user index remains');
 check((await db.kv.get(['reservation_user','u2',seed.id])).value===1,'new user index missing');
 check(!(await db.kv.get(['reservation_by_day','r1',seed.date,seed.id])).value,'old day index remains');
 check((await db.kv.get(['reservation_by_day','r1','2030-01-08',seed.id])).value===1,'new day index missing');
 await db.markArrived(seed.id);
 row=await db.getReservationById(seed.id);
 check(row?.note==='keep me','markArrived erases existing customer note');
 check((await db.kv.get(['reservation_day_lock','r1','2030-01-08'])).versionstamp!==null,'updates do not invalidate booking capacity snapshot');
 const originalAtomic = db.kv.atomic.bind(db.kv);
 (db.kv as any).atomic = () => {
   const tx = originalAtomic();
   (tx as any).commit = async () => ({ok:false});
   return tx;
 };
 let rejected=false;
 try { await db.updateReservationFields(seed.id,{date:'2030-02-01',phone:'failed'}); } catch { rejected=true; }
 finally { (db.kv as any).atomic=originalAtomic; }
 row=await db.getReservationById(seed.id);
 check(rejected,'failed atomic update must report failure');
 check(row?.date==='2030-01-08' && row?.phone==='123','failed commit left partially updated reservation');
 check(!(await db.kv.get(['reservation_by_day','r1','2030-02-01',seed.id])).value,'failed commit wrote day index');
 await Promise.all([db.updateReservation(seed.id,{date:'2030-01-09'}),db.updateReservationFields(seed.id,{depositStatus:'received'})]);
 row=await db.getReservationById(seed.id);
 check(row?.date==='2030-01-09' && row?.depositStatus==='received','mixed update APIs lose concurrent changes');
 await db.updateReservationFields(seed.id,{id:'wrong',createdAt:999});
 row=await db.getReservationById(seed.id);
 check(row?.id===seed.id && row?.createdAt===1,'immutable reservation identity changed');
 if(failures.length) throw Error(failures.join('\n'));
 console.log('PASS: concurrent updates, day/user indices, arrival note preservation, capacity lock');
} finally { db.kv.close(); }
