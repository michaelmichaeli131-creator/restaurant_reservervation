// Screenshot-aligned refinements for the September 2026 SpotBook surfaces.
// This layer runs after the approved wrapper so it can keep existing form hooks,
// API payloads, and page-specific behavior intact while improving presentation.
const root = Deno.env.get('SPOTBOOK_ROOT') || '/app';
const pages = JSON.parse(await Deno.readTextFile(`${root}/design-system/pages.json`));

const enhancement = String.raw`<script data-spotbook-time-picker>
(function () {
  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function totalMinutes(value) {
    var match = String(value || '').match(/^([0-9]{1,2}):([0-9]{2})/);
    if (!match) return null;
    var hour = Math.max(0, Math.min(23, Number(match[1])));
    var minute = Math.max(0, Math.min(59, Number(match[2])));
    return hour * 60 + minute;
  }

  function optionLabel(total) {
    return optionValue(total);
  }

  function optionValue(total) {
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
  }

  function convertTimeInput(input) {
    if (!input || input.dataset.sbTimePicker === '1') return;

    var current = input.value || '';
    var currentTotal = totalMinutes(current);
    if (currentTotal !== null) {
      current = optionValue(currentTotal);
    }

    var select = document.createElement('select');
    for (var i = 0; i < input.attributes.length; i += 1) {
      var attr = input.attributes[i];
      if (attr.name === 'type' || attr.name === 'value' || attr.name === 'step' || attr.name === 'class') continue;
      select.setAttribute(attr.name, attr.value);
    }

    if (!input.required || !current) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '—';
      select.appendChild(empty);
    }

    var times = Array.from({ length: 96 }, function (_, index) { return index * 15; });
    if (currentTotal !== null && currentTotal % 15 !== 0) times.push(currentTotal);
    times.sort(function (a, b) { return a - b; });
    for (var total of times) {
      var option = document.createElement('option');
      option.value = optionValue(total);
      option.textContent = optionLabel(total);
      select.appendChild(option);
    }

    select.className = (input.className ? input.className + ' ' : '') + 'sb-time-select';
    select.dataset.sbTimePicker = '1';
    if (input.disabled) select.disabled = true;
    if (input.required) select.required = true;
    // A few legacy pages listen for the old time input's input event.
    // Mirror select changes so their validation and previews stay live.
    select.addEventListener('change', function () {
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (current) select.value = current;
    input.replaceWith(select);
  }

  document.querySelectorAll('input[type="time"]').forEach(convertTimeInput);

  // The deposit reference has a deliberate order: title, broad waterfront image,
  // then the reservation and payment cards. Move the shared hero into that flow.
  var paymentPage = document.querySelector('.sb-page-reservation_payment');
  var payment = paymentPage && paymentPage.querySelector('.sb-payment');
  var paymentHeader = payment && payment.querySelector('.page-header');
  var paymentPhoto = paymentPage && paymentPage.querySelector('.sb-design-workspace > .sb-design-photo');
  if (payment && paymentHeader && paymentPhoto) {
    paymentHeader.insertAdjacentElement('afterend', paymentPhoto);
  }
})();
</script>`;

let changed = 0;
for (const name of [...Object.keys(pages), 'restaurant_detail', 'restaurant_system_time', 'host_seating']) {
  const path = `${root}/templates/${name}.eta`;
  let text = await Deno.readTextFile(path);
  if (text.includes('data-spotbook-time-picker')) continue;

  const marker = text.indexOf('<script');
  if (marker >= 0) text = text.slice(0, marker) + enhancement + '\n' + text.slice(marker);
  else text += '\n' + enhancement;
  await Deno.writeTextFile(path, text);
  changed += 1;
}

console.log(`[refinement] Added screenshot-aligned interactions to ${changed} page templates`);

// The production overlay owns this route; patch it after extraction. A canceled
// SSE stream must stop its heartbeat instead of crashing the server on enqueue.
const calendarPath = `${root}/routes/owner_calendar.ts`;
let calendar = await Deno.readTextFile(calendarPath);
calendar = calendar.replace('const stream = new ReadableStream({', 'let cleanupStream = () => {};\n  const stream = new ReadableStream({');
calendar = calendar.replace('controller.enqueue(new TextEncoder().encode(sseFormat(event, data)));',
  'try { controller.enqueue(new TextEncoder().encode(sseFormat(event, data))); } catch { cleanupStream(); }');
calendar = calendar.replace('try { controller.close(); } catch { /* ignore */ }',
  'cleanupStream();\n        try { controller.close(); } catch { /* ignore */ }');
calendar = calendar.replace('const pingTimer = setInterval(() => send("ping", { t: Date.now() }), 25000);',
  `const pingTimer = setInterval(() => send("ping", { t: Date.now() }), 25000);
      cleanupStream = () => {
        clearInterval(pingTimer);
        channels.get(key)?.delete(client);
        if (channels.get(key)?.size === 0) channels.delete(key);
      };`);
calendar = calendar.replace('cancel() {', 'cancel() {\n      cleanupStream();');
await Deno.writeTextFile(calendarPath, calendar);
