// Runs after legacy overlays and design patches. No database migration.
const root = Deno.env.get("SPOTBOOK_ROOT") || "/app";
const path = `${root}/templates/restaurant.eta`;
let template = await Deno.readTextFile(path);
const script = '<script src="/static/js/calendar_guest_entry.js?v=2" defer></script>';
if (!template.includes('calendar_guest_entry.js')) {
  template = template.includes('</body>') ? template.replace('</body>', script + '\n</body>') : template + '\n' + script;
  await Deno.writeTextFile(path, template);
}

// Align public availability with the calendar's inactive statuses.
const dbPath = `${root}/database.ts`;
let db = await Deno.readTextFile(dbPath);
db = db.replace('!["canceled", "cancelled", "completed"].includes(normalized)', '!["canceled", "cancelled", "completed", "no_show", "no-show", "noshow", "rescheduled", "rejected", "declined"].includes(normalized)');
await Deno.writeTextFile(dbPath, db);
