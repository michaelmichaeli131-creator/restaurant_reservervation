
const { rid } = (window.POS_CTX || {});
const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}/ws/pos?role=kitchen&rid=${encodeURIComponent(rid)}`);

const tbody = document.getElementById("orders");
const orders = new Map();

function formatStatus(s) {
  switch (s) {
    case "received": return "התקבלה";
    case "in_progress": return "בטיפול";
    case "ready": return "מוכנה";
    case "served": return "הוגשה";
    default: return s;
  }
}

function renderRow(it) {
  let tr = document.getElementById(`row-${it.id}`);
  const actionCellHtml = () => {
    if (it.status === "received") return `<button class="btn" data-action="start" data-id="${it.id}" data-order="${it.orderId}">התחל</button>`;
    if (it.status === "in_progress") return `<button class="btn" data-action="done" data-id="${it.id}" data-order="${it.orderId}">מוכן</button>`;
    return `<span class="muted">—</span>`;
  };
  const inner = `<td>${it.table}</td><td>${it.name}</td><td>${it.quantity}</td><td class="status">${formatStatus(it.status)}</td><td class="actions">${actionCellHtml()}</td>`;
  if (!tr) {
    tr = document.createElement("tr");
    tr.id = `row-${it.id}`;
    tr.innerHTML = inner;
    tbody.appendChild(tr);
  } else {
    tr.innerHTML = inner;
  }
}

tbody.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const action = t.dataset.action;
  if (!action) return;
  const id = t.dataset.id;
  const orderId = t.dataset.order;
  if (!id || !orderId) return;
  if (action === "start") {
    ws.send(JSON.stringify({ event: "update-status", id, orderId, status: "in_progress" }));
  } else if (action === "done") {
    ws.send(JSON.stringify({ event: "update-status", id, orderId, status: "ready" }));
  }
});

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.event === "orderList") {
    tbody.innerHTML = "";
    (msg.items || []).forEach(it => {
      orders.set(it.id, it);
      renderRow(it);
    });
  } else if (msg.event === "orderAdded") {
    const it = msg.item;
    orders.set(it.id, it);
    renderRow(it);
  } else if (msg.event === "orderUpdated") {
    const it = orders.get(msg.item.id);
    if (it) {
      it.status = msg.item.status;
      renderRow(it);
    }
  }
};
