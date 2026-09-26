// Preserve backend/privacy patches while fixing the auth dictionary namespace.
const path = "lib/view.ts";
let source = await Deno.readTextFile(path);
const before = "  const pageNs =\n    (typeof data.page === \"string\" && data.page) ||";
const after = "  const pageNs =\n    (template.startsWith(\"auth/\") ? \"auth\" : \"\") ||\n    (typeof data.page === \"string\" && data.page) ||";
if (!source.includes(after)) {
  if (!source.includes(before)) throw new Error("Auth renderer patch: unexpected source");
  source = source.replace(before, after);
  await Deno.writeTextFile(path, source);
}
console.log("Auth page translations enabled");
