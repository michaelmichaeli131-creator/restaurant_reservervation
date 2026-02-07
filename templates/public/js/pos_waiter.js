// public/js/pos_waiter.js
// לוגיקה בצד המלצר: חשבון, ביטול פריטים, סימון הוגש, סגירת שולחן.

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

  // שיהיה זמין לסקריפט המשלים
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
        const btnCancel = row.querySelector(".btn-cancel-item");
        if (btnCancel) btnCancel.remove();
        const btnServe = row.querySelector(".btn-mark-served");
        if (btnServe) btnServe.remove();
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

  async function markServed(row) {
    const orderId = row.dataset.orderId;
    const itemId = row.dataset.itemId;
    if (!rid || !table || !orderId || !itemId) return;

    try {
      const res = await fetch("/api/pos/order-item/serve", {
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
        row.classList.remove(
          "status-received",
          "status-in_progress",
          "status-ready",
        );
        row.classList.add("status-served");
        const statusCell = row.querySelector("td.col-status");
        if (statusCell) {
          statusCell.textContent = "הוגש";
        }
        const btnServe = row.querySelector(".btn-mark-served");
        if (btnServe) btnServe.remove();
        // חשבון לא משתנה, אבל נחשב בכל זאת
        recalcTotals();
      }
    } catch (e) {
      console.error("markServed failed", e);
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

  if (rowsContainer) {
    rowsContainer.addEventListener("click", (ev) => {
      const cancelBtn = ev.target.closest(".btn-cancel-item");
      const serveBtn = ev.target.closest(".btn-mark-served");
      const row = ev.target.closest("tr.order-row");
      if (!row) return;

      if (cancelBtn) {
        cancelItem(row);
      } else if (serveBtn) {
        markServed(row);
      }
    });
  }

  if (btnClose) {
    btnClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      closeOrder();
    });
  }

  recalcTotals();
})();
