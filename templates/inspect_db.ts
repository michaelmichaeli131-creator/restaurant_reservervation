// Quick script to inspect Deno KV database
// Run: deno run --allow-env --unstable-kv inspect_db.ts

const kv = await Deno.openKv();

console.log("=== DATABASE CONTENTS ===\n");

// List all users
console.log("📧 USERS:");
for await (const entry of kv.list({ prefix: ["user"] })) {
  if (entry.key[0] === "user" && entry.key.length === 2) {
    const user = entry.value as any;
    console.log(`  - ${user.email} (${user.role}) - ${user.emailVerified ? "✅ verified" : "⏳ unverified"}`);
  }
}

// List all restaurants
console.log("\n🍽️  RESTAURANTS:");
for await (const entry of kv.list({ prefix: ["restaurant"] })) {
  if (entry.key[0] === "restaurant" && entry.key.length === 2) {
    const rest = entry.value as any;
    console.log(`  - ${rest.name} (${rest.city}) - ${rest.approved ? "✅ approved" : "⏳ pending"}`);
  }
}

// List all reservations
console.log("\n📅 RESERVATIONS:");
let count = 0;
for await (const entry of kv.list({ prefix: ["reservation"] })) {
  if (entry.key[0] === "reservation" && entry.key.length === 2) {
    const res = entry.value as any;
    console.log(`  - ${res.date} ${res.time} - ${res.people} people (${res.status || "new"})`);
    count++;
  }
}
if (count === 0) {
  console.log("  (none)");
}

console.log("\n=== END ===");

kv.close();
