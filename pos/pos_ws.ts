// src/pos/pos_ws.ts
// WebSocket ל-POS: סינכרון ריל-טיים בין מלצרים למטבח.

import { Status, type Context } from "jsr:@oak/oak";
import { kv } from "../database.ts";
import type {
  Order,
  OrderItem,
  OrderItemStatus,
} from "./pos_db.ts";
import { updateOrderItemStatus } from "./pos_db.ts";

interface PosClient {
  ws: WebSocket;
  restaurantId?: string;
  role?: "waiter" | "kitchen";
  table?: number;
}

const clients = new Set<PosClient>();

/** helper: שולח לכולם לפי predicate */
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
      // נתעלם משגיאות של client מת
    }
  }
}

/** helper: מביא את כל ה-OrderItem הפעילים למסעדה (הזמנות פתוחות בלבד, לא cancelled) */
async function loadActiveItemsForRestaurant(
  restaurantId: string,
): Promise<OrderItem[]> {
  const out: OrderItem[] = [];

  // כל ההזמנות למסעדה
  for await (
    const row of kv.list<Order>({
      prefix: ["pos", "order", restaurantId],
    })
  ) {
    const order = row.value;
    if (!order || order.status !== "open") continue;

    // כל ה-items של אותה הזמנה
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

    // --- הצטרפות של קליינט ---
    if (type === "join") {
      const role = msg.role === "kitchen"
        ? "kitchen"
        : msg.role === "waiter"
        ? "waiter"
        : undefined;
      const restaurantId = String(msg.restaurantId ?? "");
      const table = msg.table != null ? Number(msg.table) : undefined;

      if (!role || !restaurantId) {
        return;
      }

      client.role = role;
      client.restaurantId = restaurantId;
      if (role === "waiter" && typeof table === "number" && table > 0) {
        client.table = table;
      }

      // למטבח – שולחים snapshot מלא של כל המנות הפעילות
      if (role === "kitchen") {
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

    // --- שינוי סטטוס של פריט (מהמטבח) ---
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

        // 1) שולחים לכל ה-mitbach באותה מסעדה עדכון מלא על הפריט
        broadcast(
          (c) =>
            c.role === "kitchen" &&
            c.restaurantId === restaurantId,
          {
            type: "order_item_updated",
            restaurantId,
            item: updated,
          },
        );

        // 2) לכל המלצרים של אותו שולחן באותה מסעדה – רק רמז לרענן/להתעדכן
        broadcast(
          (c) =>
            c.role === "waiter" &&
            c.restaurantId === restaurantId &&
            c.table === updated.table,
          {
            type: "order_updated",
            restaurantId,
            table: updated.table,
          },
        );
      } catch (e) {
        console.error("set_status failed", e);
      }

      return;
    }

    // בהמשך אפשר להוסיף:
    // - type: "ping"
    // - type: "close_order" (אם המטבח יסגור חשבון)
  };
}
