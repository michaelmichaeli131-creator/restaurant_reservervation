// src/routes/owner_bills.ts
// מסכי "חשבונות אחרונים" + "הצגת חשבון" לבעלים.

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";
import {
  listBillsForRestaurant,
  getBill,
  deleteBill,
} from "../pos/pos_db.ts";

const ownerBillsRouter = new Router();

/* ---------- רשימת חשבונות אחרונים ---------- */
// GET /owner/:rid/bills
ownerBillsRouter.get("/owner/:rid/bills", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  console.debug("[OWNER_BILLS] list route enter", {
    method: ctx.request.method,
    path: ctx.request.url.pathname,
    rid,
  });

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    console.warn("[OWNER_BILLS] restaurant not found", { rid });
    ctx.throw(Status.NotFound, "restaurant_not_found");
  }

  const bills = await listBillsForRestaurant(rid, 100);
  console.debug("[OWNER_BILLS] bills loaded", {
    rid,
    count: bills.length,
  });

await render(ctx, "owner/owner_bills", {
    page: "owner_bills",
    title: `חשבונות אחרונים · ${restaurant.name}`,
    restaurant,
    bills,
  });
});

/* ---------- הצגת חשבון בודד (להדפסה/תצוגה) ---------- */
// GET /owner/:rid/bills/:billId
ownerBillsRouter.get("/owner/:rid/bills/:billId", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const billId = ctx.params.billId!;

  console.debug("[OWNER_BILL] route enter", {
    method: ctx.request.method,
    path: ctx.request.url.pathname,
    rid,
    billId,
  });

  const restaurant = await getRestaurant(rid);
  if (!restaurant) {
    console.warn("[OWNER_BILL] restaurant not found", { rid });
    ctx.throw(Status.NotFound, "restaurant_not_found");
  }

  const bill = await getBill(rid, billId);
  if (!bill) {
    console.warn("[OWNER_BILL] bill not found", {
      rid,
      billId,
    });
    ctx.throw(Status.NotFound, "bill_not_found");
  }

  console.debug("[OWNER_BILL] bill ready for render", {
    rid,
    billId: bill.id,
    createdAtIso: new Date(bill.createdAt).toISOString(),
    itemsCount: bill.items?.length ?? 0,
    total: bill.totals?.total ?? bill.totals?.subtotal ?? null,
  });

  await render(ctx, "owner_bill_print", {
    page: "owner_bill_print",
    title: `חשבונית · ${restaurant.name}`,
    restaurant,
    bill,
  });
});

/* ---------- מחיקת חשבון (אופציונלי) ---------- */
// POST /owner/:rid/bills/:billId/delete
ownerBillsRouter.post("/owner/:rid/bills/:billId/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const billId = ctx.params.billId!;

  console.debug("[OWNER_BILL] delete route enter", {
    rid,
    billId,
  });

  const ok = await deleteBill(rid, billId);
  console.debug("[OWNER_BILL] delete result", {
    rid,
    billId,
    ok,
  });

  ctx.response.redirect(`/owner/${rid}/bills`);
});

export default ownerBillsRouter;
