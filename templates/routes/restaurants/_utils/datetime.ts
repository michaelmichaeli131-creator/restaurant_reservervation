// src/routes/restaurants/_utils/datetime.ts
export function pad2(n: number) { return n.toString().padStart(2, "0"); }

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

export function normalizeDate(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  if (iso) return iso[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (dmy) {
    const dd = pad2(+dmy[1]);
    const mm = pad2(+dmy[2]);
    const yyyy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return s;
}

export function normalizeTime(input: unknown): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  if (/^\d{1,2}\.\d{2}(\s*[ap]m)?$/i.test(s)) s = s.replace(".", ":");
  const ampm = s.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i);
  if (ampm) {
    let h = Math.max(0, Math.min(12, Number(ampm[1])));
    const mi = Math.max(0, Math.min(59, Number(ampm[2])));
    const isPM = /pm/i.test(ampm[3]);
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return `${pad2(h)}:${pad2(mi)}`;
  }
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) s = `${iso[1]}:${iso[2]}`;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  let mi = Math.max(0, Math.min(59, Number(m[2])));
  mi = Math.floor(mi / 15) * 15;
  return `${pad2(h)}:${pad2(mi)}`;
}

export function toIntLoose(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  if (typeof input === "bigint") return Number(input);
  if (typeof input === "boolean") return input ? 1 : 0;
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Math.trunc(Number(s));
  const onlyDigits = s.replace(/[^\d]/g, "");
  return onlyDigits ? Math.trunc(Number(onlyDigits)) : null;
}

export function pickNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}
