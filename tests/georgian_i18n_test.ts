// Georgian translations must stay in lockstep with English dictionaries.
function flatten(value: unknown, prefix = "", out = new Map<string, unknown>()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else out.set(prefix, value);
  return out;
}

function readJson(path: string) {
  return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
}

Deno.test("Georgian dictionaries cover every English key", () => {
  const baseEn = flatten(readJson("i18n/en.json"));
  const baseKa = flatten(readJson("i18n/ka.json"));
  const missingBase = [...baseEn.keys()].filter(key => !baseKa.has(key));
  if (missingBase.length) throw new Error(`Missing Georgian base keys: ${missingBase.join(", ")}`);

  for (const entry of Deno.readDirSync("i18n/pages")) {
    if (!entry.isFile || !entry.name.endsWith(".en.json")) continue;
    const stem = entry.name.slice(0, -".en.json".length);
    const en = flatten(readJson(`i18n/pages/${entry.name}`));
    const ka = flatten(readJson(`i18n/pages/${stem}.ka.json`));
    const missing = [...en.keys()].filter(key => !ka.has(key));
    if (missing.length) throw new Error(`${stem}: missing Georgian keys: ${missing.join(", ")}`);
  }
});

Deno.test("Georgian locale is wired as a first-class left-to-right locale", () => {
  const middleware = Deno.readTextFileSync("middleware/i18n.ts");
  if (!middleware.includes('["en", "he", "ka"]')) throw new Error("Georgian is not in middleware supported locales");
  if (!middleware.includes('ka: "ltr"')) throw new Error("Georgian direction is not configured");
  const client = Deno.readTextFileSync("client/src/i18n.ts");
  if (!client.includes("'ka'")) throw new Error("React i18n does not support Georgian");
});
