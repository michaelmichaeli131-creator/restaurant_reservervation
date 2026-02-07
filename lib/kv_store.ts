// src/lib/kv_store.ts
// Graceful KV wrapper: uses Deno KV when available, otherwise falls back to an
// in-memory KV-like store. This prevents crashes like:
//   txnproxy call failed ... transactionDomainNotFound
// in environments where Deno KV is not provisioned.

type KeyPart = string | number | bigint | boolean | Uint8Array;
export type KvKey = KeyPart[];

export type KvGetResult<T> = { value: T | null };
export type KvListItem = { key: KvKey };
export type KvCommitResult = { ok: boolean };

export interface KvAtomicLike {
  check(check: { key: KvKey; versionstamp: unknown }): KvAtomicLike;
  set(key: KvKey, value: unknown): KvAtomicLike;
  delete(key: KvKey): KvAtomicLike;
  commit(): Promise<KvCommitResult>;
}

export interface KvLike {
  get<T>(key: KvKey): Promise<KvGetResult<T>>;
  set(key: KvKey, value: unknown): Promise<void>;
  delete(key: KvKey): Promise<void>;
  list(opts: { prefix: KvKey }): AsyncIterable<KvListItem>;
  atomic(): KvAtomicLike;
}

function encodeKeyPart(p: KeyPart): unknown {
  if (p instanceof Uint8Array) return { __u8: Array.from(p) };
  return p;
}

function keyToString(key: KvKey): string {
  return JSON.stringify(key.map(encodeKeyPart));
}

function isPrefix(full: KvKey, prefix: KvKey): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const a = full[i];
    const b = prefix[i];
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      const aa = a instanceof Uint8Array ? a : new Uint8Array();
      const bb = b instanceof Uint8Array ? b : new Uint8Array();
      if (aa.length !== bb.length) return false;
      for (let j = 0; j < aa.length; j++) if (aa[j] !== bb[j]) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

class MemoryKv implements KvLike {
  private store = new Map<string, { key: KvKey; value: unknown }>();

  async get<T>(key: KvKey): Promise<KvGetResult<T>> {
    const hit = this.store.get(keyToString(key));
    return { value: (hit?.value as T) ?? null };
  }

  async set(key: KvKey, value: unknown): Promise<void> {
    this.store.set(keyToString(key), { key, value });
  }

  async delete(key: KvKey): Promise<void> {
    this.store.delete(keyToString(key));
  }

  async *list(opts: { prefix: KvKey }): AsyncIterable<KvListItem> {
    for (const { key } of this.store.values()) {
      if (isPrefix(key, opts.prefix)) yield { key };
    }
  }

  atomic(): KvAtomicLike {
    return new MemoryAtomic(this);
  }

  // Internal helpers
  _has(key: KvKey): boolean {
    return this.store.has(keyToString(key));
  }
}

class MemoryAtomic implements KvAtomicLike {
  private checks: Array<{ key: KvKey; mustBeAbsent: boolean }> = [];
  private sets: Array<{ key: KvKey; value: unknown }> = [];
  private dels: KvKey[] = [];

  constructor(private kv: MemoryKv) {}

  check(check: { key: KvKey; versionstamp: unknown }): KvAtomicLike {
    // In this codebase we use versionstamp:null to mean "must not exist".
    const mustBeAbsent = check.versionstamp === null;
    this.checks.push({ key: check.key, mustBeAbsent });
    return this;
  }

  set(key: KvKey, value: unknown): KvAtomicLike {
    this.sets.push({ key, value });
    return this;
  }

  delete(key: KvKey): KvAtomicLike {
    this.dels.push(key);
    return this;
  }

  async commit(): Promise<KvCommitResult> {
    for (const c of this.checks) {
      const exists = this.kv._has(c.key);
      if (c.mustBeAbsent && exists) return { ok: false };
    }
    for (const d of this.dels) await this.kv.delete(d);
    for (const s of this.sets) await this.kv.set(s.key, s.value);
    return { ok: true };
  }
}

let kvPromise: Promise<KvLike> | null = null;
let warned = false;

export async function getKv(): Promise<KvLike> {
  if (kvPromise) return kvPromise;
  kvPromise = (async () => {
    try {
      // @ts-ignore Deno KV available in runtime
      const real = await Deno.openKv();
      return real as unknown as KvLike;
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn(
          "[kv_store] Deno KV not available. Falling back to in-memory KV. " +
            "Sessions/data won't persist across deploy restarts.",
          e,
        );
      }
      return new MemoryKv();
    }
  })();
  return kvPromise;
}

export const kv: KvLike = await getKv();
