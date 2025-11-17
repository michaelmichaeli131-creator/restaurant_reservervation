
// src/pos/pos_ws.ts
import { Context } from "jsr:@oak/oak";
import { listItems, addOrderItem, listOrderItemsForTable, updateOrderItemStatus } from "./pos_db.ts";

type Role = "waiter" | "kitchen";

type WS = WebSocket & {
  rid?: string;
  role?: Role;
  table?: number;
};

// Simple channel maps per restaurant
const waitersByRestaurantTable = new Map<string, Map<number, Set<WS>>>(); // rid -> table -> set
const kitchensByRestaurant = new Map<string, Set<WS>>(); // rid -> set

export async function handlePosSocket(ctx: Context) {
  if (!ctx.isUpgradable) {
    ctx.throw(501);
  }
  const socket = ctx.upgrade() as WS;
  const url = ctx.request.url;
  const rid = url.searchParams.get("rid") || "";
  const role = (url.searchParams.get("role") as Role) || undefined;
  const tableStr = url.searchParams.get("table") || "";
  const table = tableStr ? Number(tableStr) : undefined;

  if (!rid || !role) {
    socket.close(1008, "rid and role required");
    return;
  }
  socket.rid = rid;
  socket.role = role;
  if (role === "waiter") {
    if (!table || isNaN(table)) {
      socket.close(1008, "table required for waiter");
      return;
    }
    socket.table = table;
    let tables = waitersByRestaurantTable.get(rid);
    if (!tables) { tables = new Map(); waitersByRestaurantTable.set(rid, tables); }
    let set = tables.get(table);
    if (!set) { set = new Set(); tables.set(table, set); }
    set.add(socket);

    socket.onopen = async () => {
      // initial payload: menu + current items
      const menu = await listItems(rid);
      socket.send(JSON.stringify({ event: "menu", menu }));
      const items = await listOrderItemsForTable(rid, table);
      socket.send(JSON.stringify({ event: "orderList", items }));
    };
  } else if (role === "kitchen") {
    let set = kitchensByRestaurant.get(rid);
    if (!set) { set = new Set(); kitchensByRestaurant.set(rid, set); }
    set.add(socket);

    socket.onopen = async () => {
      // initial payload: all current items across tables
      // naive: collect items by iterating all waiter tables we track
      const all: any[] = [];
      const tables = waitersByRestaurantTable.get(rid);
      if (tables) {
        for (const [t, wsSet] of tables.entries()) {
          const items = await listOrderItemsForTable(rid, t);
          for (const it of items) all.push(it);
        }
      }
      all.sort((a,b)=> a.createdAt - b.createdAt);
      socket.send(JSON.stringify({ event: "orderList", items: all }));
    };
  }

  socket.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!data.event) return;
      const rid = socket.rid!;
      if (data.event === "place-order" && socket.role === "waiter") {
        const { itemId, quantity } = data;
        const menu = await listItems(rid);
        const m = menu.find(m => m.id === itemId);
        if (!m) return;
        const { orderItem } = await addOrderItem({ restaurantId: rid, table: socket.table!, menuItem: m, quantity });
        broadcastOrderAdded(rid, orderItem);
      } else if (data.event === "update-status" && socket.role === "kitchen") {
        const { orderId, id, status } = data;
        const updated = await updateOrderItemStatus(id, orderId, status);
        if (updated) {
          broadcastOrderUpdated(rid, updated);
        }
      }
    } catch (e) {
      console.error("pos_ws message error", e);
    }
  };

  socket.onclose = () => {
    const rid = socket.rid!;
    if (socket.role === "waiter") {
      const tmap = waitersByRestaurantTable.get(rid);
      if (tmap) {
        const set = tmap.get(socket.table!);
        if (set) {
          set.delete(socket);
          if (set.size === 0) tmap.delete(socket.table!);
        }
      }
    } else if (socket.role === "kitchen") {
      const set = kitchensByRestaurant.get(rid);
      if (set) set.delete(socket);
    }
  };
}

function broadcastOrderAdded(rid: string, item: any) {
  const msg = JSON.stringify({ event: "orderAdded", item });
  // to kitchen
  const kset = kitchensByRestaurant.get(rid);
  if (kset) for (const s of kset) try { s.send(msg); } catch {}
  // to waiters of that table
  const tables = waitersByRestaurantTable.get(rid);
  if (tables) {
    const wset = tables.get(item.table);
    if (wset) for (const s of wset) try { s.send(msg); } catch {}
  }
}

function broadcastOrderUpdated(rid: string, updated: any) {
  const msg = JSON.stringify({ event: "orderUpdated", item: { id: updated.id, orderId: updated.orderId, status: updated.status } });
  const kset = kitchensByRestaurant.get(rid);
  if (kset) for (const s of kset) try { s.send(msg); } catch {}
  const tables = waitersByRestaurantTable.get(rid);
  if (tables) {
    const wset = tables.get(updated.table);
    if (wset) for (const s of wset) try { s.send(msg); } catch {}
  }
}
