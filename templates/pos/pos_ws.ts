// src/pos/pos_ws.ts
// WebSocket ל-POS: סינכרון ריל-טיים בין מלצרים, מטבח ובר.

import { Status, type Context } from "jsr:@oak/oak";
import { kv } from "../database.ts";
import type {
  Order,
  OrderItem,
  OrderItemStatus,
} from "./pos_db.ts";
import { updateOrderItemStatus } from "./pos_db.ts";

type PosRole = "waiter" | "kitchen" | "bar";

interface PosClient {
  ws: WebSocket;
  restaurantId?: string;
  role?: PosRole;
  table?: number;
}

const clients = new Set<PosClient>();

function broadcast(
  predicate: (c: PosClient) => boolean,
  payload: unknown,
) {
  const data = JSON.stringify(payload);
  for (const c of clients) {
    try {
      if (c.ws.readyState === WebSocket.OPEN && predicate(c)) {
        c.ws.send(data);
      }
    } catch {
      // ignore dead clients
    }
  }
}

// כל ה-OrderItem הפעילים (open orders, לא cancelled)
async function loadActiveItemsForRestaurant(
  restaurantId: string,
): Promise<OrderItem[]> {
  const out: OrderItem[] = [];

  for await (
    const row of kv.list<Order>({
      prefix: ["pos", "order", restaurantId],
    })
  ) {
    const order = row.value;
    if (!order || order.status !== "open") continue;

    for await (
      const itemRow of kv.list<OrderItem>({
        prefix: ["pos", "order_item", order.id],
      })
    ) {
      const it = itemRow.value;
      if (!it) continue;
      if (it.status === "cancelled") continue;
      out.push(it);
    }
  }

  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/* ----- helpers ל-HTTP ----- */

export function notifyOrderItemAdded(item: OrderItem) {
  const restaurantId = item.restaurantId;
  broadcast(
    (c) =>
      (c.role === "kitchen" || c.role === "bar") &&
      c.restaurantId === restaurantId,
    {
      type: "order_item",
      restaurantId,
      item,
    },
  );
  broadcast(
    (c) =>
      c.role === "waiter" &&
      c.restaurantId === restaurantId &&
      c.table === item.table,
    {
      type: "order_updated",
      restaurantId,
      table: item.table,
    },
  );
}

export function notifyOrderItemUpdated(item: OrderItem) {
  const restaurantId = item.restaurantId;
  broadcast(
    (c) =>
      (c.role === "kitchen" || c.role === "bar") &&
      c.restaurantId === restaurantId,
    {
      type: "order_item_updated",
      restaurantId,
      item,
    },
  );
  broadcast(
    (c) =>
      c.role === "waiter" &&
      c.restaurantId === restaurantId &&
      c.table === item.table,
    {
      type: "order_updated",
      restaurantId,
      table: item.table,
    },
  );
}

export function notifyOrderClosed(
  restaurantId: string,
  table: number,
) {
  broadcast(
    (c) => c.restaurantId === restaurantId,
    {
      type: "order_closed",
      restaurantId,
      table,
    },
  );
}

/** handler הראשי ל-WebSocket */
export async function handlePosSocket(ctx: Context) {
  if (!ctx.isUpgradable) {
    ctx.throw(Status.BadRequest, "WebSocket upgrade required");
  }

  const ws = ctx.upgrade();
  const client: PosClient = { ws };
  clients.add(client);

  ws.onclose = () => {
    clients.delete(client);
  };
  ws.onerror = () => {
    clients.delete(client);
  };

  ws.onmessage = async (event) => {
    let msg: any;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const type = msg.type;

    // --- join ---
    if (type === "join") {
      const rawRole = String(msg.role ?? "");
      const restaurantId = String(msg.restaurantId ?? "");
      const table = msg.table != null ? Number(msg.table) : undefined;

      let role: PosRole | undefined;
      if (rawRole === "waiter") role = "waiter";
      else if (rawRole === "kitchen") role = "kitchen";
      else if (rawRole === "bar") role = "bar";

      if (!role || !restaurantId) return;

      client.role = role;
      client.restaurantId = restaurantId;
      if (role === "waiter" && typeof table === "number" && table > 0) {
        client.table = table;
      }

      // snapshot למסכי מטבח/בר
      if (role === "kitchen" || role === "bar") {
        try {
          const items = await loadActiveItemsForRestaurant(restaurantId);
          ws.send(
            JSON.stringify({
              type: "snapshot",
              restaurantId,
              items,
            }),
          );
        } catch (e) {
          console.error("snapshot error", e);
        }
      }
      return;
    }

    // --- שינוי סטטוס (בעיקר מהמטבח / אולי בר בעתיד) ---
    if (type === "set_status") {
      const restaurantId = String(msg.restaurantId ?? "");
      const orderItemId = String(msg.orderItemId ?? "");
      const orderId = String(msg.orderId ?? "");
      const next: OrderItemStatus = msg.status;

      if (
        !restaurantId || !orderItemId || !orderId ||
        !["received", "in_progress", "ready", "served", "cancelled"]
          .includes(next)
      ) {
        return;
      }

      try {
        const updated = await updateOrderItemStatus(
          orderItemId,
          orderId,
          next,
        );
        if (!updated) return;
        notifyOrderItemUpdated(updated);
      } catch (e) {
        console.error("set_status failed", e);
      }

      return;
    }
  };
}
