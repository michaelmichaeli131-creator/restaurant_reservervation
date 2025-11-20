// public/js/pos_waiter.js
// לוגיקה בצד המלצר: חישוב חשבון, ביטול פריטים, וסגירת שולחן.

(function () {
  const root = document.getElementById("bill-summary");
  if (!root) return;

  const rid = root.dataset.rid;
  const table = Number(root.dataset.table || "0");

  const rowsContainer = document.getElementById("order-items");
  const itemsSpan = document.getElementById("bill-items");
  const totalSpan = document.getElementById("bill-total");
  const btnClose = document.getElementById("btn-close-order");

  function recalcTotals() {
    if (!rowsContainer) return;
    const rows = Array.from(
      rowsContainer.querySelectorAll("tr.order-row"),
    );
    let itemsCount = 0;
    let subtotal = 0;

    rows.forEach((row) => {
      if (row.classList.contains("status-cancelled")) return;
      const qty = Number(row.dataset.qty || "0");
      const price = Number(row.dataset.price || "0");
      itemsCount += qty;
      subtotal += qty * price;
    });

    if (itemsSpan) itemsSpan.textContent = `${itemsCount} פריטים`;
    if (totalSpan)
      totalSpan.textContent = `${subtotal.toFixed(2)} ₪`;
  }

  // שיהיה זמין לסקריפט האחר בעמוד
  window.sbRecalcBill = recalcTotals;

  async function cancelItem(row) {
    const orderId = row.dataset.orderId;
    const itemId = row.dataset.itemId;
    if (!rid || !table || !orderId || !itemId) return;

    try {
      const res = await fetch("/api/pos/order-item/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantId: rid,
          table,
          orderId,
          orderItemId: itemId,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        row.classList.add("status-cancelled");
        const btn = row.querySelector(".btn-cancel-item");
        if (btn) btn.remove();
        const statusCell = row.querySelector("td.col-status");
        if (statusCell) {
          statusCell.textContent = "בוטל";
          statusCell.classList.add("muted");
        }
        recalcTotals();
      }
    } catch (e) {
      console.error("cancelItem failed", e);
    }
  }

  async function closeOrder() {
    if (!rid || !table) return;
    try {
      const res = await fetch("/api/pos/order/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restaurantId: rid, table }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        window.location.href = `/waiter/${encodeURIComponent(rid)}`;
      }
    } catch (e) {
      console.error("closeOrder failed", e);
    }
  }

  // האזנה לכפתורי "ביטול"
  if (rowsContainer) {
    rowsContainer.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".btn-cancel-item");
      if (!btn) return;
      const row = btn.closest("tr.order-row");
      if (!row) return;
      cancelItem(row);
    });
  }

  if (btnClose) {
    btnClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      closeOrder();
    });
  }

  // חישוב ראשוני
  recalcTotals();
})();
