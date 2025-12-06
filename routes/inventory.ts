// src/routes/inventory.ts
// ----------------------------------------
// Owner inventory routes:
// - מתכונים: קישור מנות ↔ חומרי גלם
// - מלאי: רשימת חומרי גלם + עדכון / מחיקה
// - תנועות מלאי (משלוח / התאמה ידנית)
// - הוצאות חודשיות (מחושב ממשלוחים) + Override ידני
// - ספירות מלאי (sessions + lines + finalize)
// - Food Cost per Dish
// - ✅ ספקים (טבלה בסיסית + leadTimeDays לצפי הגעה)
// - ✅ הזמנות רכש (purchase_orders) – כדי שכפתור "הזמנות רכש" לא יחזיר Not Found
// ----------------------------------------

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { requireOwner } from "../lib/auth.ts";
import { getRestaurant } from "../database.ts";
import { listItems } from "../pos/pos_db.ts";

import {
  // ingredients
  listIngredients,
  upsertIngredient,
  deleteIngredient,

  // recipes
  listRecipesForRestaurant,
  saveRecipeForMenuItem,

  // tx
  applyInventoryTx,
  listInventoryTx,

  // costs overrides + cost effective
  getMonthlySpendOverride,
  setMonthlySpendOverride,
  getEffectiveCostPerUnit,

  // counts
  listInventoryCountSessions,
  createInventoryCountSession,
  getInventoryCountSession,
  listInventoryCountLines, // (יכול להיות לא בשימוש, אבל נשאר)
  ensureInventoryCountSnapshot,
  upsertInventoryCountLine,
  finalizeInventoryCount,

  // ✅ suppliers
  listSuppliers,
  upsertSupplier,
  deleteSupplier,
  getSupplier,

  // ✅ purchase orders
  listPurchaseOrders,
  createPurchaseOrder,
  getPurchaseOrder,
  savePurchaseOrder,
  setPurchaseOrderStatus,
  markPurchaseOrderDelivered,
} from "../inventory/inventory_db.ts";

export const inventoryRouter = new Router();

/* ------------ Helper: parse number safely ------------ */
function toNum(val: unknown, def = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// YYYY-MM validation + default (UTC)
function sanitizeMonth(maybe: string | null | undefined): string {
  const now = new Date();
  const def = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
  const v = (maybe || "").trim();
  if (!v) return def;
  if (!/^\d{4}-\d{2}$/.test(v)) return def;
  const [yStr, moStr] = v.split("-");
  const y = Number(yStr);
  const mo = Number(moStr);
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12)) return def;
  return `${yStr}-${moStr}`;
}

function monthRangeUtc(month: string): { start: number; end: number } {
  const [yStr, moStr] = month.split("-");
  const y = Number(yStr);
  const mo = Number(moStr);
  const start = Date.UTC(y, mo - 1, 1, 0, 0, 0, 0);
  const end = Date.UTC(y, mo, 1, 0, 0, 0, 0);
  return { start, end };
}

// YYYY-MM-DD -> UTC ms (00:00)
function parseYmdToUtcMs(maybe: string | null | undefined): number | undefined {
  const v = (maybe || "").trim();
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  return Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
}

/* ========================================================================== */
/*  Recipes                                                                    */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/recipes", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const [menuItems, ingredients, recipes] = await Promise.all([
    listItems(rid),
    listIngredients(rid),
    listRecipesForRestaurant(rid),
  ]);

  await render(ctx, "owner_inventory_recipes", {
    page: "owner_inventory_recipes",
    title: `מתכונים וחומרי גלם · ${restaurant.name}`,
    restaurant,
    menuItems,
    ingredients,
    recipes,
  });
});

inventoryRouter.post("/owner/:rid/inventory/recipes/save", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const menuItemId = (form.get("menuItemId")?.toString() || "").trim();
  if (!menuItemId) ctx.throw(Status.BadRequest, "missing_menu_item");

  const rawComponents = form.get("components")?.toString() || "[]";
  let comps: Array<{ ingredientId: string; qty: number }> = [];
  try {
    const parsed = JSON.parse(rawComponents);
    if (Array.isArray(parsed)) {
      comps = parsed
        .map((c) => ({
          ingredientId: String(c.ingredientId || "").trim(),
          qty: Number(c.qty ?? 0),
        }))
        .filter((c) => c.ingredientId && c.qty > 0);
    }
  } catch {
    comps = [];
  }

  const note = (form.get("note")?.toString() || "").trim();

  await saveRecipeForMenuItem(rid, menuItemId, comps, note || undefined);
  ctx.response.redirect(`/owner/${rid}/inventory/recipes`);
});

/* ========================================================================== */
/*  Stock                                                                      */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/stock", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const ingredients = await listIngredients(rid);

  await render(ctx, "owner_inventory_stock", {
    page: "owner_inventory_stock",
    title: `מלאי חומרי גלם · ${restaurant.name}`,
    restaurant,
    ingredients,
  });
});

inventoryRouter.post("/owner/:rid/inventory/stock/ingredient", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const id = (form.get("id")?.toString() || "").trim() || undefined;
  const name = (form.get("name")?.toString() || "").trim();
  const unit = (form.get("unit")?.toString() || "unit").trim();
  const currentQty = toNum(form.get("currentQty"), 0);
  const minQty = toNum(form.get("minQty"), 0);

  const costPerUnit = form.get("costPerUnit")
    ? toNum(form.get("costPerUnit"), NaN)
    : NaN;

  const supplierName = (form.get("supplierName")?.toString() || "").trim();
  const notes = (form.get("notes")?.toString() || "").trim();

  if (!name) ctx.throw(Status.BadRequest, "missing_name");

  await upsertIngredient({
    id,
    restaurantId: rid,
    name,
    unit,
    currentQty,
    minQty,
    costPerUnit: Number.isFinite(costPerUnit) ? costPerUnit : undefined,
    supplierName: supplierName || undefined,
    notes: notes || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/stock`);
});

inventoryRouter.post(
  "/owner/:rid/inventory/stock/ingredient/:id/delete",
  async (ctx) => {
    if (!requireOwner(ctx)) return;
    const rid = ctx.params.rid!;
    const ingredientId = ctx.params.id!;
    await deleteIngredient(rid, ingredientId);
    ctx.response.redirect(`/owner/${rid}/inventory/stock`);
  },
);

inventoryRouter.post("/owner/:rid/inventory/stock/tx", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const ingredientId = (form.get("ingredientId")?.toString() || "").trim();
  const type = (form.get("type")?.toString() || "delivery") as
    | "delivery"
    | "adjustment";
  const deltaQty = toNum(form.get("deltaQty"), 0);
  const costTotal = form.get("costTotal")
    ? toNum(form.get("costTotal"), NaN)
    : NaN;
  const reason = (form.get("reason")?.toString() || "").trim();

  if (!ingredientId || !Number.isFinite(deltaQty) || deltaQty === 0) {
    ctx.throw(Status.BadRequest, "invalid_tx");
  }

  await applyInventoryTx({
    restaurantId: rid,
    ingredientId,
    type,
    deltaQty,
    costTotal: Number.isFinite(costTotal) ? costTotal : undefined,
    reason: reason || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/stock`);
});

/* ========================================================================== */
/*  ✅ Suppliers                                                                */
/*  מינימום הכרחי: name + leadTimeDays (+ phone/email/paymentTerms)            */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/suppliers", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const suppliers = await listSuppliers(rid);

  await render(ctx, "owner_inventory_suppliers", {
    page: "owner_inventory_suppliers",
    title: `ספקים · ${restaurant.name}`,
    restaurant,
    suppliers,
  });
});

// שומר ספק (alias): /save וגם /upsert כדי שלא תישבר שום תבנית קיימת
async function handleSupplierUpsert(ctx: any) {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const form = await ctx.request.body.formData();

  const id = (form.get("id")?.toString() || "").trim() || undefined;
  const name = (form.get("name")?.toString() || "").trim();
  const phone = (form.get("phone")?.toString() || "").trim();
  const email = (form.get("email")?.toString() || "").trim();
  const paymentTerms = (form.get("paymentTerms")?.toString() || "").trim();

  // ✅ צפי הגעה (הכרחי)
  const leadTimeDays = toNum(form.get("leadTimeDays"), 0);

  // תואם לטמפלט הקיים
  const notes = (form.get("notes")?.toString() || "").trim();
  const isActive = form.get("isActive") ? true : false;

  if (!name) ctx.throw(Status.BadRequest, "missing_supplier_name");

  await upsertSupplier({
    id,
    restaurantId: rid,
    name,
    phone: phone || undefined,
    email: email || undefined,
    paymentTerms: paymentTerms || undefined,
    leadTimeDays:
      Number.isFinite(leadTimeDays) && leadTimeDays >= 0
        ? Math.floor(leadTimeDays)
        : 0,
    notes: notes || undefined,
    isActive,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/suppliers`);
}

inventoryRouter.post("/owner/:rid/inventory/suppliers/save", handleSupplierUpsert);
inventoryRouter.post("/owner/:rid/inventory/suppliers/upsert", handleSupplierUpsert);

inventoryRouter.post("/owner/:rid/inventory/suppliers/:sid/delete", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const sid = ctx.params.sid!;
  await deleteSupplier(rid, sid);
  ctx.response.redirect(`/owner/${rid}/inventory/suppliers`);
});

/* ========================================================================== */
/*  ✅ Purchase Orders (fix for "הזמנות רכש" Not Found)                        */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/purchase_orders", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const [suppliers, pos] = await Promise.all([
    listSuppliers(rid),
    listPurchaseOrders(rid, 200),
  ]);

  await render(ctx, "owner_inventory_purchase_orders", {
    page: "owner_inventory_purchase_orders",
    title: `הזמנות רכש · ${restaurant.name}`,
    restaurant,
    suppliers,
    pos,
  });
});

inventoryRouter.post("/owner/:rid/inventory/purchase_orders/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const form = await ctx.request.body.formData();
  const supplierId = (form.get("supplierId")?.toString() || "").trim();
  const expectedAt = parseYmdToUtcMs(form.get("expectedAt")?.toString() || "");
  const note = (form.get("note")?.toString() || "").trim();

  if (!supplierId) ctx.throw(Status.BadRequest, "missing_supplier");

  const supplier = await getSupplier(rid, supplierId);
  if (!supplier) ctx.throw(Status.BadRequest, "supplier_not_found");

  const po = await createPurchaseOrder({
    restaurantId: rid,
    supplier,
    expectedAt,
    note: note || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${po.id}`);
});

inventoryRouter.get("/owner/:rid/inventory/purchase_orders/:pid", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const pid = ctx.params.pid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const po = await getPurchaseOrder(rid, pid);
  if (!po) ctx.throw(Status.NotFound);

  const [suppliers, ingredients] = await Promise.all([
    listSuppliers(rid),
    listIngredients(rid),
  ]);

  await render(ctx, "owner_inventory_purchase_order", {
    page: "owner_inventory_purchase_order",
    title: `הזמנת רכש · ${restaurant.name}`,
    restaurant,
    po,
    suppliers,
    ingredients,
  });
});

inventoryRouter.post("/owner/:rid/inventory/purchase_orders/:pid/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const pid = ctx.params.pid!;
  const po = await getPurchaseOrder(rid, pid);
  if (!po) ctx.throw(Status.NotFound);

  if (po.status !== "draft") {
    ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}`);
    return;
  }

  const form = await ctx.request.body.formData();
  const note = (form.get("note")?.toString() || "").trim();
  const expectedAt = parseYmdToUtcMs(form.get("expectedAt")?.toString() || "");

  const rawLines = (form.get("lines")?.toString() || "[]").trim();
  let parsed: any[] = [];
  try {
    const v = JSON.parse(rawLines);
    if (Array.isArray(v)) parsed = v;
  } catch {
    parsed = [];
  }

  const lines = parsed
    .map((x: any) => ({
      ingredientId: String(x.ingredientId || "").trim(),
      qty: Number(x.qty || 0),
    }))
    .filter((l) => l.ingredientId && Number.isFinite(l.qty) && l.qty > 0);

  await savePurchaseOrder({
    restaurantId: rid,
    poId: pid,
    expectedAt,
    note: note || undefined,
    // ingredientName לא חובה (ה־DB יודע לשמור גם בלי)
    lines: lines.map((l) => ({
      ingredientId: l.ingredientId,
      qty: l.qty,
    })),
  });

  ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}?saved=1`);
});

inventoryRouter.post("/owner/:rid/inventory/purchase_orders/:pid/send", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const pid = ctx.params.pid!;
  const po = await getPurchaseOrder(rid, pid);
  if (!po) ctx.throw(Status.NotFound);

  if (po.status !== "draft") {
    ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}`);
    return;
  }

  await setPurchaseOrderStatus({ restaurantId: rid, poId: pid, status: "sent" });
  ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}?sent=1`);
});

inventoryRouter.post("/owner/:rid/inventory/purchase_orders/:pid/cancel", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const pid = ctx.params.pid!;
  const po = await getPurchaseOrder(rid, pid);
  if (!po) ctx.throw(Status.NotFound);

  if (po.status === "delivered") {
    ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}`);
    return;
  }

  await setPurchaseOrderStatus({ restaurantId: rid, poId: pid, status: "cancelled" });
  ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}?cancelled=1`);
});

inventoryRouter.post("/owner/:rid/inventory/purchase_orders/:pid/delivered", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const pid = ctx.params.pid!;
  const po = await getPurchaseOrder(rid, pid);
  if (!po) ctx.throw(Status.NotFound);

  if (po.status === "delivered" || po.status === "cancelled") {
    ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}`);
    return;
  }

  const actor =
    (ctx.state?.user?.username || ctx.state?.user?.firstName || "")
      .toString() || undefined;

  await markPurchaseOrderDelivered({ restaurantId: rid, poId: pid, actor });

  ctx.response.redirect(`/owner/${rid}/inventory/purchase_orders/${pid}?delivered=1`);
});

/* ========================================================================== */
/*  Costs (as you had)                                                         */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/costs", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const month = sanitizeMonth(ctx.request.url.searchParams.get("month"));
  const { start, end } = monthRangeUtc(month);

  const [ingredients, txList, overrideRow] = await Promise.all([
    listIngredients(rid),
    listInventoryTx(rid, 5000),
    getMonthlySpendOverride(rid, month),
  ]);

  let computedTotal = 0;
  let deliveriesCount = 0;
  let deliveriesMissingCost = 0;

  const perIngredient: Record<string, { cost: number; qty: number }> = {};
  const dailyMap: Record<string, number> = {};

  for (const tx of txList) {
    if (tx.type !== "delivery") continue;
    if (!(tx.createdAt >= start && tx.createdAt < end)) continue;

    deliveriesCount++;

    const hasCost = typeof tx.costTotal === "number" && Number.isFinite(tx.costTotal);
    if (!hasCost) {
      deliveriesMissingCost++;
      continue;
    }

    computedTotal += tx.costTotal!;

    if (!perIngredient[tx.ingredientId]) {
      perIngredient[tx.ingredientId] = { cost: 0, qty: 0 };
    }
    perIngredient[tx.ingredientId].cost += tx.costTotal!;
    if (Number.isFinite(tx.deltaQty) && tx.deltaQty > 0) {
      perIngredient[tx.ingredientId].qty += tx.deltaQty;
    }

    const d = new Date(tx.createdAt);
    const key =
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    dailyMap[key] = (dailyMap[key] || 0) + tx.costTotal!;
  }

  const overrideTotal = overrideRow?.overrideTotal;
  const effectiveTotal =
    typeof overrideTotal === "number" && Number.isFinite(overrideTotal)
      ? overrideTotal
      : computedTotal;

  const topIngredients = ingredients
    .map((ing) => ({
      id: ing.id,
      name: ing.name,
      spend: (perIngredient[ing.id]?.cost || 0),
    }))
    .filter((x) => Number(x.spend || 0) > 0)
    .sort((a, b) => Number(b.spend) - Number(a.spend))
    .slice(0, 10);

  const daily = Object.keys(dailyMap)
    .sort()
    .map((k) => ({ day: k, total: dailyMap[k] }));

  const summary = {
    totalSpend: effectiveTotal,
    deliveriesWithCost: deliveriesCount - deliveriesMissingCost,
    avgPerDelivery:
      (deliveriesCount - deliveriesMissingCost) > 0
        ? (computedTotal / (deliveriesCount - deliveriesMissingCost))
        : 0,
    maxDaily: daily.length ? Math.max(...daily.map((d) => Number(d.total || 0))) : 0,
  };

  await render(ctx, "owner_inventory_costs", {
    page: "owner_inventory_costs",
    title: `עלויות חומרי גלם · ${restaurant.name}`,
    restaurant,
    monthKey: month,
    summary,
    daily,
    topIngredients,
    ingredients,
  });
});

inventoryRouter.post("/owner/:rid/inventory/costs/override", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const form = await ctx.request.body.formData();

  const month = sanitizeMonth(form.get("month")?.toString());
  const raw = (form.get("overrideTotal")?.toString() || "").trim();
  const note = (form.get("note")?.toString() || "").trim();

  let val: number | null = null;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) val = n;
  }

  await setMonthlySpendOverride({
    restaurantId: rid,
    month,
    overrideTotal: val,
    note: note || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/costs?month=${encodeURIComponent(month)}`);
});

/* ========================================================================== */
/*  Counts: list + create                                                      */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/counts", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const sessions = await listInventoryCountSessions(rid, 200);
  const created = (ctx.request.url.searchParams.get("created") || "").trim();

  await render(ctx, "owner_inventory_counts", {
    page: "owner_inventory_counts",
    title: `ספירות מלאי · ${restaurant.name}`,
    restaurant,
    sessions,
    created,
  });
});

inventoryRouter.post("/owner/:rid/inventory/counts/new", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const form = await ctx.request.body.formData();
  const note = (form.get("note")?.toString() || "").trim();

  const session = await createInventoryCountSession({
    restaurantId: rid,
    note: note || undefined,
  });

  ctx.response.redirect(`/owner/${rid}/inventory/counts?created=${encodeURIComponent(session.id)}`);
});

/* ========================================================================== */
/*  ✅ Food Cost per Dish (עלות מנה ורווחיות)                                   */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/foodcost", async (ctx) => {
  if (!requireOwner(ctx)) return;
  const rid = ctx.params.rid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const [menuItems, recipes, ingredients] = await Promise.all([
    listItems(rid),
    listRecipesForRestaurant(rid),
    listIngredients(rid),
  ]);

  const recipeByMenuItem: Record<string, any> = {};
  for (const r of recipes) {
    if (r?.menuItemId) recipeByMenuItem[r.menuItemId] = r;
  }

  const ingById: Record<string, any> = {};
  for (const ing of ingredients) {
    if (ing?.id) ingById[ing.id] = ing;
  }

  const rows = menuItems.map((mi) => {
    const r = recipeByMenuItem[mi.id];
    const comps = Array.isArray(r?.components) ? r.components : [];

    const hasRecipe = comps.length > 0;
    let missingIngredients = 0;
    let missingCosts = 0;

    const breakdown = comps.map((c: any) => {
      const ingId = String(c?.ingredientId || "").trim();
      const qty = Number(c?.qty ?? 0);
      const ing = ingById[ingId] || null;

      if (!ing) missingIngredients++;

      const effCost = ing ? (getEffectiveCostPerUnit(ing) ?? null) : null;
      if (ing && (effCost === null || !Number.isFinite(effCost))) missingCosts++;

      const lineCost =
        Number.isFinite(qty) && qty > 0 && typeof effCost === "number"
          ? qty * effCost
          : 0;

      return {
        ingredientId: ingId,
        name: ing?.name || "חומר גלם חסר",
        unit: ing?.unit || "",
        qty: Number.isFinite(qty) ? qty : 0,
        costPerUnitEffective: effCost,
        lineCost,
        hasIng: !!ing,
      };
    });

    const foodCost = breakdown.reduce((s, x) => s + Number(x.lineCost || 0), 0);
    const price = Number(mi.price || 0);
    const gross = price - foodCost;
    const marginPct = price > 0 ? (gross / price) * 100 : null;

    const name = mi.name_he || mi.name_en || mi.name_ka || "ללא שם";

    return {
      menuItem: mi,
      name,
      price,
      hasRecipe,
      missingIngredients,
      missingCosts,
      breakdown,
      foodCost,
      gross,
      marginPct,
    };
  });

  const totalItems = rows.length;
  const withRecipe = rows.filter((x) => x.hasRecipe).length;
  const missingRecipe = totalItems - withRecipe;
  const withMissingCosts = rows.filter((x) => x.missingCosts > 0).length;

  const avgFoodCost =
    totalItems > 0 ? rows.reduce((s, x) => s + x.foodCost, 0) / totalItems : 0;

  const avgMarginPct = (() => {
    const rel = rows.filter((x) => x.price > 0 && typeof x.marginPct === "number");
    if (!rel.length) return null;
    return rel.reduce((s, x) => s + (x.marginPct || 0), 0) / rel.length;
  })();

  const topCostly = [...rows]
    .filter((x) => x.hasRecipe)
    .sort((a, b) => b.foodCost - a.foodCost)
    .slice(0, 8);

  const topProfitable = [...rows]
    .filter((x) => x.price > 0 && typeof x.marginPct === "number")
    .sort((a, b) => (b.marginPct || 0) - (a.marginPct || 0))
    .slice(0, 8);

  await render(ctx, "owner_inventory_foodcost", {
    page: "owner_inventory_foodcost",
    title: `עלות מנה ורווחיות · ${restaurant.name}`,
    restaurant,
    rows,
    summary: {
      totalItems,
      withRecipe,
      missingRecipe,
      withMissingCosts,
      avgFoodCost,
      avgMarginPct,
    },
    topCostly,
    topProfitable,
  });
});

/* ========================================================================== */
/*  Counts: page (table) + save + finalize                                     */
/* ========================================================================== */

inventoryRouter.get("/owner/:rid/inventory/counts/:cid", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const cid = ctx.params.cid!;
  const restaurant = await getRestaurant(rid);
  if (!restaurant) ctx.throw(Status.NotFound);

  const session = await getInventoryCountSession(rid, cid);
  if (!session) ctx.throw(Status.NotFound);

  const ingredients = await listIngredients(rid);

  const lines = await ensureInventoryCountSnapshot({
    restaurantId: rid,
    countId: cid,
    ingredients,
  });

  let expectedValue = 0;
  let actualValue = 0;
  let filled = 0;

  for (const ln of lines) {
    const cost = Number(ln.costPerUnitSnapshot || 0);
    const exp = Number(ln.expectedQty || 0);
    const act =
      (typeof ln.actualQty === "number" && Number.isFinite(ln.actualQty))
        ? ln.actualQty
        : exp;

    expectedValue += exp * cost;
    actualValue += act * cost;

    if (typeof ln.actualQty === "number" && Number.isFinite(ln.actualQty)) filled++;
  }

  await render(ctx, "owner_inventory_count", {
    page: "owner_inventory_count",
    title: `ספירת מלאי · ${restaurant.name}`,
    restaurant,
    session,
    lines,
    summary: {
      items: lines.length,
      filled,
      expectedValue,
      actualValue,
      deltaValue: actualValue - expectedValue,
    },
  });
});

inventoryRouter.post("/owner/:rid/inventory/counts/:cid/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const cid = ctx.params.cid!;
  const session = await getInventoryCountSession(rid, cid);
  if (!session) ctx.throw(Status.NotFound);
  if (session.status !== "draft") {
    ctx.response.redirect(`/owner/${rid}/inventory/counts/${cid}`);
    return;
  }

  const form = await ctx.request.body.formData();
  const raw = (form.get("lines")?.toString() || "[]").trim();

  let parsed: any[] = [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) parsed = v;
  } catch {
    parsed = [];
  }

  for (const row of parsed) {
    const ingredientId = String(row.ingredientId || "").trim();
    if (!ingredientId) continue;

    const actualRaw = row.actualQty;
    const actual =
      (actualRaw === "" || actualRaw === null || typeof actualRaw === "undefined")
        ? null
        : Number(actualRaw);

    const kind = String(row.adjustKind || "adjustment").trim();
    const adjustKind = (kind === "waste") ? "waste" : "adjustment";
    const note = String(row.note || "").trim();

    if (actual !== null) {
      if (!Number.isFinite(actual) || actual < 0) continue;
    }

    await upsertInventoryCountLine({
      restaurantId: rid,
      countId: cid,
      ingredientId,
      actualQty: actual,
      adjustKind,
      note: note ? note : null,
    });
  }

  ctx.response.redirect(`/owner/${rid}/inventory/counts/${cid}?saved=1`);
});

inventoryRouter.post("/owner/:rid/inventory/counts/:cid/finalize", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const rid = ctx.params.rid!;
  const cid = ctx.params.cid!;
  const session = await getInventoryCountSession(rid, cid);
  if (!session) ctx.throw(Status.NotFound);
  if (session.status !== "draft") {
    ctx.response.redirect(`/owner/${rid}/inventory/counts/${cid}`);
    return;
  }

  const form = await ctx.request.body.formData();
  const raw = (form.get("lines")?.toString() || "[]").trim();

  let parsed: any[] = [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) parsed = v;
  } catch {
    parsed = [];
  }

  for (const row of parsed) {
    const ingredientId = String(row.ingredientId || "").trim();
    if (!ingredientId) continue;

    const actualRaw = row.actualQty;
    const actual =
      (actualRaw === "" || actualRaw === null || typeof actualRaw === "undefined")
        ? null
        : Number(actualRaw);

    const kind = String(row.adjustKind || "adjustment").trim();
    const adjustKind = (kind === "waste") ? "waste" : "adjustment";
    const note = String(row.note || "").trim();

    if (actual !== null) {
      if (!Number.isFinite(actual) || actual < 0) continue;
    }

    await upsertInventoryCountLine({
      restaurantId: rid,
      countId: cid,
      ingredientId,
      actualQty: actual,
      adjustKind,
      note: note ? note : null,
    });
  }

  const actor =
    (ctx.state?.user?.username || ctx.state?.user?.firstName || "")
      .toString() || undefined;

  await finalizeInventoryCount({ restaurantId: rid, countId: cid, actor });

  ctx.response.redirect(`/owner/${rid}/inventory/counts/${cid}?final=1`);
});

export default inventoryRouter;
