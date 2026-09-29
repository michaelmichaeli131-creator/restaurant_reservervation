// Final audited changes to runtime files reconstructed from the production archive.
const edits: [string, string, string][] = [
  [
    "database.ts",
    "import { validDate, validTime, validPeople } from \"./lib/booking_validation.ts\";",
    "import { readOnce, type RequestReads } from \"./lib/request_reads.ts\";\nimport { validDate, validTime, validPeople } from \"./lib/booking_validation.ts\";"
  ],
  [
    "database.ts",
    "export async function checkAvailability(restaurantId: string, date: string, time: string, people: number) {",
    "export async function checkAvailability(restaurantId: string, date: string, time: string, people: number, reads?: RequestReads) {"
  ],
  [
    "database.ts",
    "export async function checkAvailability(restaurantId: string, date: string, time: string, people: number, reads?: RequestReads) {\n  if (!validDate(date)) return { ok: false, reason: \"bad_date\" as const };\n  if (!validTime(time)) return { ok: false, reason: \"bad_time\" as const };\n  if (!validPeople(people)) return { ok: false, reason: \"bad_people\" as const };\n  const r0 = await getRestaurant(restaurantId);\n  if (!r0) return { ok: false, reason: \"not_found\" as const };\n  const r = coerceRestaurantDefaults(r0);\n\n  const seats = Math.max(1, Number.isFinite(people) ? people : 2);\n\n  // Compute total capacity from room capacities if defined, otherwise use restaurant capacity\n  const { listFloorLayouts } = await import(\"./services/floor_service.ts\");\n  const layouts = await listFloorLayouts(restaurantId).catch(() => []);\n  const roomCapacities = layouts.map((l: any) => deriveLayoutCapacity(l)).filter((c: number) => c > 0);\n  const totalCapacity = roomCapacities.length > 0\n    ? roomCapacities.reduce((sum: number, c: number) => sum + c, 0)\n    : r.capacity;\n\n  if (seats > totalCapacity) return { ok: false as const, reason: \"full\" as const };\n\n  const startRaw = toMinutes(time);\n  if (!Number.isFinite(startRaw)) return { ok: false as const, reason: \"bad_time\" as const };\n\n  const step = r.slotIntervalMinutes;\n  const span = r.serviceDurationMinutes;\n  const start = snapToGrid(startRaw, step);\n  const end = start + span;\n\n  if (end > 24 * 60) return { ok: false as const, reason: \"out_of_day\" as const };\n\n  // ✅ לפי התאריך שהלקוח בחר\n  if (!isWithinOpening(r, date, start, span)) {\n    return { ok: false as const, reason: \"closed\" as const };\n  }\n\n  const occ = await computeOccupancy(r, date);\n  for (let t = start; t < end; t += step) {\n    const used = occ.get(fromMinutes(t)) ?? 0;\n    if (used + seats > totalCapacity) return { ok: false, reason: \"full\" as const };\n  }\n  return { ok: true as const };\n}\n\n/**\n * Check if a specific room (FloorLayout) has capacity for additional guests\n * at the given date/time. Returns { ok: true } if room has space, or\n * { ok: false, reason: \"room_full\", roomLabel } if the room is at capacity.\n */\nexport async function checkRoomCapacity(\n  restaurantId: string,\n  layoutId: string,\n  date: string,\n  time: string,\n  people: number,\n): Promise<\n  | { ok: true; roomLabel: string; capacity: number; alreadyBooked: number; remaining: number }\n  | { ok: false; reason: \"room_full\"; roomLabel: string; capacity: number; alreadyBooked: number; remaining: number }\n> {\n  // Dynamic import to avoid circular dependency\n  const { getFloorLayout } = await import(\"./services/floor_service.ts\");\n  const layout = await getFloorLayout(restaurantId, layoutId);\n  if (!layout) {\n    // Layout not found – treat as invalid room selection and block the booking\n    return { ok: false, reason: \"room_full\", roomLabel: \"\", capacity: 0, alreadyBooked: 0, remaining: 0 };\n  }\n  const roomLabel = layout.floorLabel || layout.name;\n  const cap = deriveLayoutCapacity(layout);\n  if (!cap || cap <= 0 || !Number.isFinite(cap)) {\n    return { ok: false, reason: \"room_full\", roomLabel, capacity: 0, alreadyBooked: 0, remaining: 0 };\n  }\n\n  const ppl = Math.max(1, Number(people) || 1);\n\n  const r0 = await getRestaurant(restaurantId);\n  if (!r0) return { ok: false, reason: \"room_full\", roomLabel, capacity: cap, alreadyBooked: 0, remaining: 0 };\n  const r = coerceRestaurantDefaults(r0);\n\n  const step = r.slotIntervalMinutes;\n  const span = r.serviceDurationMinutes;\n\n  const startRaw = toMinutes(time);\n  if (!Number.isFinite(startRaw)) return { ok: false, reason: \"room_full\", roomLabel, capacity: cap, alreadyBooked: 0, remaining: 0 };\n  const start = snapToGrid(startRaw, step);\n  const end = start + span;\n\n  const { map } = await getRoomOccupancySnapshot(restaurantId, layoutId, date, step, span);\n\n  let usedAtRequestedTime = 0;\n  for (let t = start; t < end; t += step) {\n    const used = map.get(fromMinutes(t)) ?? 0;\n    if (used > usedAtRequestedTime) usedAtRequestedTime = used;\n    if (used + ppl > cap) {\n      return {\n        ok: false,\n        reason: \"room_full\",\n        roomLabel,\n        capacity: cap,\n        alreadyBooked: usedAtRequestedTime,\n        remaining: Math.max(0, cap - usedAtRequestedTime),\n      };\n    }\n  }\n\n  return {\n    ok: true,\n    roomLabel,\n    capacity: cap,\n    alreadyBooked: usedAtRequestedTime,\n    remaining: Math.max(0, cap - usedAtRequestedTime),\n  };\n}\n\n",
    "export async function checkAvailability(restaurantId: string, date: string, time: string, people: number, reads?: RequestReads) {\n  if (!validDate(date)) return { ok: false, reason: \"bad_date\" as const };\n  if (!validTime(time)) return { ok: false, reason: \"bad_time\" as const };\n  if (!validPeople(people)) return { ok: false, reason: \"bad_people\" as const };\n  const r0 = await readOnce(reads, [\"restaurant\", restaurantId], () => getRestaurant(restaurantId));\n  if (!r0) return { ok: false, reason: \"not_found\" as const };\n  const r = coerceRestaurantDefaults(r0);\n\n  const seats = Math.max(1, Number.isFinite(people) ? people : 2);\n\n  // Compute total capacity from room capacities if defined, otherwise use restaurant capacity\n  const { listFloorLayouts } = await import(\"./services/floor_service.ts\");\n  const layouts = await readOnce(reads, [\"layouts\", restaurantId], () => listFloorLayouts(restaurantId));\n  const roomCapacities = layouts.map((l: any) => deriveLayoutCapacity(l)).filter((c: number) => c > 0);\n  const totalCapacity = roomCapacities.length > 0\n    ? roomCapacities.reduce((sum: number, c: number) => sum + c, 0)\n    : r.capacity;\n\n  if (seats > totalCapacity) return { ok: false as const, reason: \"full\" as const };\n\n  const startRaw = toMinutes(time);\n  if (!Number.isFinite(startRaw)) return { ok: false as const, reason: \"bad_time\" as const };\n\n  const step = r.slotIntervalMinutes;\n  const span = r.serviceDurationMinutes;\n  const start = snapToGrid(startRaw, step);\n  const end = start + span;\n\n  if (end > 24 * 60) return { ok: false as const, reason: \"out_of_day\" as const };\n\n  // ✅ לפי התאריך שהלקוח בחר\n  if (!isWithinOpening(r, date, start, span)) {\n    return { ok: false as const, reason: \"closed\" as const };\n  }\n\n  const occ = await readOnce(reads, [\"occupancy\", restaurantId, date], () => computeOccupancy(r, date));\n  for (let t = start; t < end; t += step) {\n    const used = occ.get(fromMinutes(t)) ?? 0;\n    if (used + seats > totalCapacity) return { ok: false, reason: \"full\" as const };\n  }\n  return { ok: true as const };\n}\n\n/**\n * Check if a specific room (FloorLayout) has capacity for additional guests\n * at the given date/time. Returns { ok: true } if room has space, or\n * { ok: false, reason: \"room_full\", roomLabel } if the room is at capacity.\n */\nexport async function checkRoomCapacity(\n  restaurantId: string,\n  layoutId: string,\n  date: string,\n  time: string,\n  people: number,\n  reads?: RequestReads,\n): Promise<\n  | { ok: true; roomLabel: string; capacity: number; alreadyBooked: number; remaining: number }\n  | { ok: false; reason: \"room_full\"; roomLabel: string; capacity: number; alreadyBooked: number; remaining: number }\n> {\n  // Dynamic import to avoid circular dependency\n  const { getFloorLayout } = await import(\"./services/floor_service.ts\");\n  const layout = await readOnce(reads, [\"layout\", restaurantId, layoutId], () => getFloorLayout(restaurantId, layoutId));\n  if (!layout) {\n    // Layout not found – treat as invalid room selection and block the booking\n    return { ok: false, reason: \"room_full\", roomLabel: \"\", capacity: 0, alreadyBooked: 0, remaining: 0 };\n  }\n  const roomLabel = layout.floorLabel || layout.name;\n  const cap = deriveLayoutCapacity(layout);\n  if (!cap || cap <= 0 || !Number.isFinite(cap)) {\n    return { ok: false, reason: \"room_full\", roomLabel, capacity: 0, alreadyBooked: 0, remaining: 0 };\n  }\n\n  const ppl = Math.max(1, Number(people) || 1);\n\n  const r0 = await readOnce(reads, [\"restaurant\", restaurantId], () => getRestaurant(restaurantId));\n  if (!r0) return { ok: false, reason: \"room_full\", roomLabel, capacity: cap, alreadyBooked: 0, remaining: 0 };\n  const r = coerceRestaurantDefaults(r0);\n\n  const step = r.slotIntervalMinutes;\n  const span = r.serviceDurationMinutes;\n\n  const startRaw = toMinutes(time);\n  if (!Number.isFinite(startRaw)) return { ok: false, reason: \"room_full\", roomLabel, capacity: cap, alreadyBooked: 0, remaining: 0 };\n  const start = snapToGrid(startRaw, step);\n  const end = start + span;\n\n  const { map } = await readOnce(reads, [\"roomOccupancy\", restaurantId, layoutId, date, step, span], () => getRoomOccupancySnapshot(restaurantId, layoutId, date, step, span));\n\n  let usedAtRequestedTime = 0;\n  for (let t = start; t < end; t += step) {\n    const used = map.get(fromMinutes(t)) ?? 0;\n    if (used > usedAtRequestedTime) usedAtRequestedTime = used;\n    if (used + ppl > cap) {\n      return {\n        ok: false,\n        reason: \"room_full\",\n        roomLabel,\n        capacity: cap,\n        alreadyBooked: usedAtRequestedTime,\n        remaining: Math.max(0, cap - usedAtRequestedTime),\n      };\n    }\n  }\n\n  return {\n    ok: true,\n    roomLabel,\n    capacity: cap,\n    alreadyBooked: usedAtRequestedTime,\n    remaining: Math.max(0, cap - usedAtRequestedTime),\n  };\n}\n\n"
  ],
  [
    "middleware/i18n.ts",
    "  if (!header) return undefined;\n  const raw = header.toLowerCase();\n  if (raw.includes(\"he\")) return \"he\";\n  if (raw.includes(\"en\")) return \"en\";\n  if (raw.includes(\"ka\")) return \"ka\";\n  return undefined;",
    "  return preferredLanguage(header);"
  ],
  [
    "middleware/i18n.ts",
    "// /src/middleware/i18n.ts",
    "import { preferredLanguage } from \"../lib/accept_language.ts\";\n// /src/middleware/i18n.ts"
  ],
  [
    "templates/restaurant.eta",
    "  const roomOccupancyCache = {};",
    "  const roomOccupancyCache = {};\n  let roomOccupancyVersion = 0;\n  function resetRoomOccupancy() {\n    roomOccupancyVersion++;\n    Object.keys(roomOccupancyCache).forEach(k => delete roomOccupancyCache[k]);\n    document.querySelectorAll('.rsv-room-card__cap').forEach(b => {\n      if (b.dataset.origText) b.textContent = b.dataset.origText;\n      b.style.color = '';\n    });\n    clearRoomCapacityWarning();\n  }"
  ],
  [
    "templates/restaurant.eta",
    "    const request = ++openingRequest;",
    "    const request = ++openingRequest;\n    resetRoomOccupancy();"
  ],
  [
    "templates/restaurant.eta",
    "        hiddenTime.value = t;\n        updateCheckBtnState();\n        // Refresh room occupancy",
    "        resetRoomOccupancy();\n        hiddenTime.value = t;\n        updateCheckBtnState();\n        // Refresh room occupancy"
  ],
  [
    "templates/restaurant.eta",
    "    const occ = await fetchRoomOccupancy(layoutId, date, time, people);",
    "    const version = roomOccupancyVersion;\n    const request = String(Number(card.dataset.occupancyRequest || 0) + 1);\n    card.dataset.occupancyRequest = request;\n    delete roomOccupancyCache[layoutId];\n    const occ = await fetchRoomOccupancy(layoutId, date, time, people);\n    if (version !== roomOccupancyVersion || card.dataset.occupancyRequest !== request ||\n        date !== dateInput.value || time !== hiddenTime.value || people !== Number(peopleInput.value)) return;"
  ],
  [
    "templates/restaurant.eta",
    "<span>${msg}</span>`;",
    "<span></span>`;\n    warn.querySelector(\"span\").textContent = msg;"
  ],
  [
    "templates/restaurant.eta",
    "  let checkedSubmission=false;",
    "  let checkedSubmission=false;\n  let checkingSubmission=false;"
  ],
  [
    "templates/restaurant.eta",
    "    ev.preventDefault();ev.stopImmediatePropagation();",
    "    ev.preventDefault();ev.stopImmediatePropagation();\n    if(checkingSubmission)return;"
  ],
  [
    "templates/restaurant.eta",
    "    const button=document.getElementById('submit-btn');button.disabled=true;",
    "    checkingSubmission=true;\n    const button=document.getElementById('submit-btn');button.disabled=true;"
  ],
  [
    "templates/restaurant.eta",
    "    finally{button.removeAttribute('aria-busy');updateCheckBtnState();}",
    "    finally{checkingSubmission=false;button.removeAttribute('aria-busy');updateCheckBtnState();}"
  ],
  [
    "database.ts",
    "const layouts = await listFloorLayouts(restaurantId).catch(() => []);\n\n  const byLayoutId",
    "const layouts = await listFloorLayouts(restaurantId);\n\n  const byLayoutId"
  ],
  [
    "database.ts",
    "const layouts = await listLayouts(restaurantId).catch(() => []);",
    "const layouts = await listLayouts(restaurantId);"
  ]
];
for (const [path, before, after] of edits) {
  const source = await Deno.readTextFile(path);
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) throw new Error(`Audit patch missing or ambiguous hook: ${path}: ${before.slice(0, 100)}`);
  await Deno.writeTextFile(path, source.replace(before, after));
}
console.log('Availability request snapshots, language negotiation and booking race fixes applied');
