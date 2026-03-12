const KV_PATH = (Deno.env.get("KV_PATH") || "").trim();

let kvPromise: Promise<Deno.Kv> | null = null;

export function getKv(): Promise<Deno.Kv> {
  if (!kvPromise) {
    kvPromise = (async () => {
      try {
        if (KV_PATH) {
          console.log(`[kv] opening local KV at ${KV_PATH}`);
          return await Deno.openKv(KV_PATH);
        }
        console.log("[kv] opening default KV");
        return await Deno.openKv();
      } catch (err) {
        console.error("[kv] failed to open default KV, retrying with local file", err);
        return await Deno.openKv("./.data/app.kv");
      }
    })();
  }
  return kvPromise;
}

export async function kvSafeGet<T>(key: Deno.KvKey): Promise<Deno.KvEntryMaybe<T>> {
  const kv = await getKv();
  return await kv.get<T>(key);
}
