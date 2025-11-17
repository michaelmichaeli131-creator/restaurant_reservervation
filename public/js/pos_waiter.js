
const { rid, table } = (window.POS_CTX || {});
const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}/ws/pos?role=waiter&rid=${encodeURIComponent(rid)}&table=${encodeURIComponent(table)}`);

const menuList = document.getElementById("menuList");
const orderBody = document.getElementById("orderItems");
const totalEl = document.getElementById("total");

let total = 0;
const itemsById = new Map();

function addOrderRow(it) {
  itemsById.set(it.id, it);
  const tr = document.createElement("tr");
  tr.id = `row-${it.id}`;
  tr.innerHTML = `<td>${it.name}</td><td>${it.quantity}</td><td>${(it.unitPrice*it.quantity).toFixed(2)} ₪</td><td class="status">${formatStatus(it.status)}</td>`;
  orderBody.appendChild(tr);
  total += (it.unitPrice * it.quantity);
  totalEl.textContent = `${total.toFixed(2)} ₪`;
}

function formatStatus(s) {
  switch (s) {
    case "received": return "התקבלה";
    case "in_progress": return "בטיפול";
    case "ready": return "מוכנה";
    case "served": return "הוגשה";
    default: return s;
  }
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.event === "menu") {
    // Build menu list
    menuList.innerHTML = "";
    const cats = {}; // group by categoryId (simple)
    msg.menu.forEach(m => {
      const key = m.categoryId || "_";
      (cats[key] ||= []).push(m);
    });
    Object.values(cats).forEach(group => {
      group.forEach(m => {
        const li = document.createElement("li");
        li.className = "item";
        const title = document.createElement("span");
        title.textContent = `${m.name_he || m.name_en} — ${(m.price||0).toFixed(2)} ₪ (${m.destination === 'bar' ? 'בר' : 'מטבח'})`;
        const addBtn = document.createElement("button");
        addBtn.className = "btn ghost";
        addBtn.textContent = "הוסף";
        addBtn.onclick = () => {
          const qty = 1; // simple; can pop a prompt for quantity
          ws.send(JSON.stringify({ event: "place-order", itemId: m.id, quantity: qty }));
        };
        li.appendChild(title);
        li.appendChild(addBtn);
        menuList.appendChild(li);
      });
    });
  } else if (msg.event === "orderList") {
    // initial list for this table
    orderBody.innerHTML = "";
    total = 0;
    msg.items.forEach(addOrderRow);
  } else if (msg.event === "orderAdded") {
    addOrderRow(msg.item);
  } else if (msg.event === "orderUpdated") {
    const { id, status } = msg.item;
    const row = document.getElementById(`row-${id}`);
    if (row) row.querySelector(".status").textContent = formatStatus(status);
  }
};
