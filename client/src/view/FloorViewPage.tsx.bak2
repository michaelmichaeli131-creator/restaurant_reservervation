import React from "react";
import FloorMapRenderer from "../shared/FloorMapRenderer";
import type { BarAccountLike, FloorLayoutLike as FloorLayout } from "../shared/FloorMapRenderer";
import { t } from "../i18n";
import "./floorViewPage.css";

// Shape mirrors what the backend attaches as `tableStatuses` on the active layout.
type TableStatusEntry = {
  tableId?: string;
  tableNumber?: number;
  status?: string;
  guestName?: string | null;
  guestCount?: number | string | null;
  reservationTime?: string | null;
  itemsCount?: number | string | null;
  subtotal?: number | string | null;
  orderId?: string | null;
};

type MountMode = "page" | "lobby";


type BarAccountEntry = BarAccountLike & {
  itemsCount?: number;
  subtotal?: number;
  createdAt?: number;
  isMain?: boolean;
};

function isBarTable(table?: any | null): boolean {
  if (!table) return false;
  const asset = String(table.assetFile || "").toLowerCase();
  const name = String(table.name || "").toLowerCase();
  return asset.includes("bar.svg") || name.includes("bar");
}

function seatIdForBar(tableId: string, seatNumber: number): string {
  return `${tableId}:seat:${seatNumber}`;
}

function seatNumberFromSeatId(seatId: string): number {
  const match = String(seatId || '').match(/:seat:(\d+)/);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function findAdjacentBarSeats(
  capacityRaw: number,
  occupiedSeatNumbersRaw: number[],
  anchorSeatNumberRaw: number,
  neededRaw: number,
): number[] | null {
  const capacity = Math.max(1, Number(capacityRaw || 1));
  const needed = Math.max(1, Math.min(capacity, Number(neededRaw || 1)));
  const anchor = Math.max(1, Math.min(capacity, Number(anchorSeatNumberRaw || 1)));
  const occupied = new Set((occupiedSeatNumbersRaw || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0));

  const starts: number[] = [];
  for (let delta = 0; delta < capacity; delta++) {
    const left = anchor - delta;
    const right = anchor + delta;
    if (left >= 1 && left <= capacity - needed + 1) starts.push(left);
    if (right !== left && right >= 1 && right <= capacity - needed + 1) starts.push(right);
  }

  for (const start of starts) {
    const seq = Array.from({ length: needed }, (_, idx) => start + idx);
    if (!seq.includes(anchor)) continue;
    if (seq.every((seatNo) => !occupied.has(seatNo))) return seq;
  }

  for (let start = 1; start <= capacity - needed + 1; start++) {
    const seq = Array.from({ length: needed }, (_, idx) => start + idx);
    if (seq.every((seatNo) => !occupied.has(seatNo))) return seq;
  }

  return null;
}

function normalizeBarAccountsForTable(table: any, accounts: BarAccountEntry[]): BarAccountEntry[] {
  const seatCapacity = Math.max(1, Number(table?.seats || 1));
  const used = new Set<string>();
  return (accounts || []).map((account, idx) => {
    let seatIds = Array.isArray((account as any).seatIds)
      ? (account as any).seatIds.map((v: any) => String(v || "").trim()).filter(Boolean)
      : [];
    let primarySeatId = String(account.seatId || "").trim();

    if (!seatIds.length && primarySeatId) seatIds = [primarySeatId];

    if (!seatIds.length) {
      for (let seatNumber = 1; seatNumber <= seatCapacity; seatNumber++) {
        const candidate = seatIdForBar(String(table.id), seatNumber);
        if (!used.has(candidate)) {
          seatIds = [candidate];
          break;
        }
      }
    }

    if (!seatIds.length) {
      seatIds = [seatIdForBar(String(table.id), Math.min(idx + 1, seatCapacity))];
    }

    seatIds = seatIds.map((seatId: string) => {
      if (!used.has(seatId)) {
        used.add(seatId);
        return seatId;
      }
      for (let seatNumber = 1; seatNumber <= seatCapacity; seatNumber++) {
        const candidate = seatIdForBar(String(table.id), seatNumber);
        if (!used.has(candidate)) {
          used.add(candidate);
          return candidate;
        }
      }
      return seatId;
    });

    primarySeatId = seatIds[0] || primarySeatId;
    return { ...account, seatId: primarySeatId, seatIds };
  });
}

type NormalStatus = "empty" | "occupied" | "reserved" | "dirty";

function normalizeStatus(s?: string | null): NormalStatus {
  const v = (s || "").toLowerCase();
  if (v === "occupied" || v === "busy" || v === "taken") return "occupied";
  if (v === "reserved" || v === "booked") return "reserved";
  if (v === "dirty" || v === "needs_cleaning") return "dirty";
  return "empty";
}

function statusLabel(s: NormalStatus): string {
  return t(`floor.status.${s}`, s);
}

function barUiDebug(stage: string, payload?: unknown) {
  try {
    console.log(`[BAR_DEBUG][floor-view] ${stage}`, payload ?? {});
  } catch {
    // ignore
  }
}

export default function FloorViewPage({
  restaurantId,
  mountMode = "page",
}: {
  restaurantId: string;
  mountMode?: MountMode;
}) {
  const [layouts, setLayouts] = React.useState<FloorLayout[]>([]);
  const [activeLayoutId, setActiveLayoutId] = React.useState<string | null>(null);
  const [selectedLayoutId, setSelectedLayoutId] = React.useState<string | null>(null);

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [selectedTableId, setSelectedTableId] = React.useState<string | null>(null);
  const [selectedBarSeatId, setSelectedBarSeatId] = React.useState<string | null>(null);
  const [barAccountsByTable, setBarAccountsByTable] = React.useState<Record<string, BarAccountEntry[]>>({});

  // clickMode is used to decide which actions to show in Table Details (host vs. waiter lobby).
  // It must be defined here (not as an undeclared global) to avoid runtime crashes when opening Table Details.
  const __sbRootEl = typeof document !== "undefined" ? document.getElementById("sb-floor-root") : null;
  const clickMode = String(
    __sbRootEl?.getAttribute("data-click-mode") ||
      __sbRootEl?.getAttribute("data-mode") ||
      (mountMode === "lobby" ? "lobby" : "page")
  ).toLowerCase();


  const loadBarAccounts = React.useCallback(async (layoutsInput: FloorLayout[]) => {
    const barTables = layoutsInput.flatMap((layout) =>
      (layout.tables || []).filter((table) => isBarTable(table)).map((table) => ({ layoutId: layout.id, table }))
    );
    if (barTables.length === 0) {
      setBarAccountsByTable({});
      return;
    }

    const entries = await Promise.all(barTables.map(async ({ table }) => {
      const tableNumber = Number((table as any).tableNumber ?? (table as any).number ?? 0);
      try {
        const params = new URLSearchParams({
          restaurantId,
          tableId: String((table as any).id || ''),
        });
        if (tableNumber) params.set('table', String(tableNumber));
        barUiDebug('loadBarAccounts.request', {
          restaurantId,
          tableId: String((table as any).id || ''),
          tableNumber,
          url: `/api/pos/table-accounts?${params.toString()}`,
        });
        const res = await fetch(`/api/pos/table-accounts?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const normalized = normalizeBarAccountsForTable(table, Array.isArray(data?.accounts) ? data.accounts : []);
        barUiDebug('loadBarAccounts.response', {
          restaurantId,
          tableId: String((table as any).id || ''),
          tableNumber: Number(data?.table || tableNumber || 0),
          accounts: normalized.map((acc) => ({
            accountId: (acc as any).accountId ?? null,
            reservationId: (acc as any).reservationId ?? null,
            seatId: (acc as any).seatId ?? null,
            seatIds: Array.isArray((acc as any).seatIds) ? (acc as any).seatIds : [],
          })),
        });
        return [String(table.id), normalized] as const;
      } catch (error) {
        barUiDebug('loadBarAccounts.error', {
          restaurantId,
          tableId: String((table as any).id || ''),
          tableNumber,
          message: error instanceof Error ? error.message : String(error),
        });
        return [String(table.id), []] as const;
      }
    }));

    setBarAccountsByTable(Object.fromEntries(entries));
  }, [restaurantId]);

  // Load all layouts (rooms/floors) with live statuses
  const loadAllLayouts = React.useCallback(async () => {
    try {
      // Try /all endpoint first (returns all layouts with statuses)
      let res = await fetch(`/api/floor-layouts/${restaurantId}/all`, {
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        const data = await res.json();
        const list: FloorLayout[] = Array.isArray(data) ? data : [];

        if (list.length === 0) {
          setLayouts([]);
          setActiveLayoutId(null);
          setSelectedLayoutId(null);
          setError(t("host.no_floor_plan", "No active floor plan"));
          setLoading(false);
          return;
        }

        setLayouts(list);
        await loadBarAccounts(list);
        const active = list.find((l) => (l as any).isActive) ?? list[0];
        setActiveLayoutId(active.id);
        setSelectedLayoutId((prev) => {
          // Keep current selection if it still exists
          if (prev && list.some((l) => l.id === prev)) return prev;
          return active.id;
        });
        setError(null);
        setLoading(false);

        if (selectedTableId) {
          const currentLay = list.find((l) => l.id === selectedLayoutId) ?? active;
          const stillExists = (currentLay.tables || []).some((t) => String(t.id) === String(selectedTableId));
          if (!stillExists) setSelectedTableId(null);
        }
        return;
      }

      // Fallback: load only active layout (older backend)
      res = await fetch(`/api/floor-layouts/${restaurantId}/active`, {
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const active: FloorLayout | null = (data && (data as any).id)
        ? (data as FloorLayout)
        : (data?.activeLayout ?? null);

      if (!active) {
        setLayouts([]);
        setActiveLayoutId(null);
        setSelectedLayoutId(null);
        setError(t("host.no_floor_plan", "No active floor plan"));
        setLoading(false);
        return;
      }

      setLayouts([active]);
      await loadBarAccounts([active]);
      setActiveLayoutId(active.id);
      setSelectedLayoutId((prev) => prev ?? active.id);
      setError(null);
      setLoading(false);
    } catch (e: any) {
      setError(t("host.err_load_map", "Error loading floor map") + `: ${e?.message ?? "unknown"}`);
      setLoading(false);
    }
  }, [restaurantId, selectedTableId, selectedLayoutId, loadBarAccounts]);

  React.useEffect(() => {
    loadAllLayouts();
    const id = setInterval(loadAllLayouts, 5000);
    return () => clearInterval(id);
  }, [loadAllLayouts]);

  React.useEffect(() => {
    const onRefresh = () => { loadAllLayouts(); };
    const onClear = () => {
      setSelectedTableId(null);
      setSelectedBarSeatId(null);
      try {
        const root = typeof document !== "undefined" ? document.getElementById("sb-floor-root") : null;
        if (root && (root as any).dataset) {
          delete (root as any).dataset.selectedTableId;
          delete (root as any).dataset.selectedTableNumber;
          delete (root as any).dataset.selectedBarSeatId;
          delete (root as any).dataset.selectedBarSeatNumber;
        }
      } catch (_e) {
        // no-op
      }
    };
    window.addEventListener("sb-floor-refresh", onRefresh as EventListener);
    window.addEventListener("sb-floor-clear-selection", onClear as EventListener);
    return () => {
      window.removeEventListener("sb-floor-refresh", onRefresh as EventListener);
      window.removeEventListener("sb-floor-clear-selection", onClear as EventListener);
    };
  }, [loadAllLayouts]);

  const currentLayout = React.useMemo(() => {
    if (!selectedLayoutId) return null;
    return layouts.find((l) => l.id === selectedLayoutId) ?? null;
  }, [layouts, selectedLayoutId]);

  const selectedTable = React.useMemo(() => {
    if (!currentLayout || !selectedTableId) return null;
    return (currentLayout.tables || []).find((t) => String(t.id) === String(selectedTableId)) ?? null;
  }, [currentLayout, selectedTableId]);

  const selectedStatusEntry = React.useMemo<TableStatusEntry | null>(() => {
    if (!currentLayout || !selectedTable) return null;
    const statuses = (currentLayout as any).tableStatuses as TableStatusEntry[] | undefined;
    if (!Array.isArray(statuses)) return null;

    const byId = statuses.find((s) => String((s as any).tableId) === String(selectedTable.id));
    if (byId) return byId;
    // Some layouts store the visible number under tableNumber (not number)
    const tableNum = (selectedTable as any)?.tableNumber ?? (selectedTable as any)?.number;
    return statuses.find((s) => (s as any).tableNumber === tableNum) ?? null;
  }, [currentLayout, selectedTable]);

  const selectedStatus: NormalStatus = React.useMemo(() => {
    return normalizeStatus((selectedStatusEntry as any)?.status);
  }, [selectedStatusEntry]);

  const selectedBarAccounts = React.useMemo(() => {
    if (!selectedTable) return [] as BarAccountEntry[];
    return barAccountsByTable[String(selectedTable.id)] || [];
  }, [barAccountsByTable, selectedTable]);

  const selectedBarSeatAccount = React.useMemo(() => {
    if (!selectedBarSeatId) return null;
    return selectedBarAccounts.find((acc) => {
      const seatIds = Array.isArray((acc as any).seatIds) && (acc as any).seatIds.length
        ? (acc as any).seatIds
        : [acc.seatId];
      return seatIds.map((v: any) => String(v || '')).includes(String(selectedBarSeatId));
    }) ?? null;
  }, [selectedBarAccounts, selectedBarSeatId]);

  const onTableClick = React.useCallback((tableId: string) => {
    setSelectedTableId(tableId);
    setSelectedBarSeatId(null);

    // Host screen relies on an external selection signal (for seating action + title)
    // Keep this minimal: emit a small event + set dataset fields on the mount root.
    try {
      const root = typeof document !== "undefined" ? document.getElementById("sb-floor-root") : null;
      const tbl = (currentLayout?.tables || []).find((t) => String((t as any).id) === String(tableId));
      const tableNumber = (tbl as any)?.tableNumber ?? (tbl as any)?.number ?? null;

      if (root && (root as any).dataset) {
        (root as any).dataset.selectedTableId = String(tableId);
        (root as any).dataset.selectedTableNumber = tableNumber != null ? String(tableNumber) : "";
      }

      window.dispatchEvent(
        new CustomEvent("sb-floor-selection", {
          detail: {
            tableIds: [String(tableId)],
            tableNumbers: tableNumber != null ? [Number(tableNumber)] : [],
          },
        }),
      );
    } catch (_e) {
      // no-op
    }
  }, [currentLayout]);

  const closeDrawer = () => { setSelectedTableId(null); setSelectedBarSeatId(null); };

  React.useEffect(() => {
    if (!selectedTable || !isBarTable(selectedTable)) {
      setSelectedBarSeatId(null);
    }
  }, [selectedTable?.id]);

  const handleBarSeatClick = React.useCallback(async (tableId: string, seatId: string) => {
    setSelectedTableId(tableId);
    setSelectedBarSeatId(seatId);
    barUiDebug('handleBarSeatClick.start', { clickMode, tableId, seatId });

    const table = layouts.flatMap((layout) => layout.tables || []).find((t) => String(t.id) === String(tableId));
    if (!table) {
      barUiDebug('handleBarSeatClick.tableMissing', { tableId, seatId });
      return;
    }

    const seatNumber = seatNumberFromSeatId(seatId) || 1;
    const seatAccounts = normalizeBarAccountsForTable(table, barAccountsByTable[String(tableId)] || []);
    const tableNumber = Number((table as any).tableNumber ?? (table as any).number ?? (seatAccounts[0] as any)?.table ?? 0);

    if (clickMode !== 'host' && !tableNumber) return;
    const occupiedSeatNumbers = seatAccounts
      .flatMap((acc) => {
        const seatIds = Array.isArray((acc as any).seatIds) && (acc as any).seatIds.length
          ? (acc as any).seatIds
          : [acc.seatId];
        return seatIds.map((seat: any) => seatNumberFromSeatId(String(seat || '')));
      })
      .filter((n) => Number.isFinite(n) && n > 0);
    const seatCapacity = Math.max(1, Number((table as any).seats || 1));
    const freeSeatNumbers = Array.from({ length: seatCapacity }, (_, idx) => idx + 1).filter((n) => !occupiedSeatNumbers.includes(n));
    barUiDebug('handleBarSeatClick.snapshot', {
      clickMode,
      tableId,
      tableNumber,
      seatId,
      seatNumber,
      seatCapacity,
      occupiedSeatNumbers,
      freeSeatNumbers,
      seatAccounts: seatAccounts.map((acc) => ({
        accountId: (acc as any).accountId ?? null,
        reservationId: (acc as any).reservationId ?? null,
        seatId: (acc as any).seatId ?? null,
        seatIds: Array.isArray((acc as any).seatIds) ? (acc as any).seatIds : [],
      })),
    });

    if (clickMode === 'host') {
      try {
        const root = typeof document !== "undefined" ? document.getElementById("sb-floor-root") : null;
        if (root && (root as any).dataset) {
          (root as any).dataset.selectedTableId = String(tableId);
          (root as any).dataset.selectedTableNumber = String(tableNumber);
          (root as any).dataset.selectedBarSeatId = String(seatId);
          (root as any).dataset.selectedBarSeatNumber = String(seatNumber);
        }
        window.dispatchEvent(
          new CustomEvent("sb-floor-selection", {
            detail: {
              tableIds: [String(tableId)],
              tableNumbers: [Number(tableNumber)],
              isBarSeat: true,
              barSeatId: String(seatId),
              barSeatNumber: Number(seatNumber),
              barSeatCapacity: seatCapacity,
              occupiedBarSeatNumbers: occupiedSeatNumbers,
              freeBarSeatNumbers: freeSeatNumbers,
            },
          }),
        );
      } catch (_e) {
        // no-op
      }
      barUiDebug('handleBarSeatClick.hostSelection', {
        tableId,
        tableNumber,
        seatId,
        seatNumber,
        freeSeatNumbers,
        occupiedSeatNumbers,
      });
      return;
    }

    const existing = seatAccounts.find((acc) => {
      const seatIds = Array.isArray((acc as any).seatIds) && (acc as any).seatIds.length
        ? (acc as any).seatIds
        : [acc.seatId];
      return seatIds.map((v: any) => String(v || '')).includes(String(seatId));
    }) || null;
    if (!existing?.accountId) {
      barUiDebug('handleBarSeatClick.noExistingAccount', { tableId, tableNumber, seatId });
      return;
    }
    barUiDebug('handleBarSeatClick.navigate', {
      tableId,
      tableNumber,
      seatId,
      accountId: String(existing.accountId),
      reservationId: (existing as any).reservationId ?? null,
      seatIds: Array.isArray((existing as any).seatIds) ? (existing as any).seatIds : [],
    });
    const url = new URL(`/waiter/${encodeURIComponent(restaurantId)}/${encodeURIComponent(tableNumber)}`, window.location.origin);
    url.searchParams.set('account', String(existing.accountId));
    window.location.href = url.pathname + url.search;
  }, [barAccountsByTable, clickMode, layouts, restaurantId]);

  const postTableOverrideStatus = async (status: "empty" | "dirty" | "reserved") => {
    const tableId = (selectedTable as any)?.id;
    if (!tableId) return;

    try {
      // Send status both in JSON body and query-string as a safety net (some proxies/envs drop POST bodies).
      const res = await fetch(`/api/tables/${restaurantId}/${tableId}/status?status=${encodeURIComponent(status)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `HTTP ${res.status}`);
      }
      await loadAllLayouts();
    } catch (err) {
      console.error("Failed to update table status:", err);
    }
  };

  const handleMarkDirty = async () => {
    await postTableOverrideStatus("dirty");
  };

  const handleMarkClean = async () => {
    // "Clean" means: remove dirty/override (not forcing the table to be free).
    await postTableOverrideStatus("empty");
  };

  const handleMarkReserved = async () => {
    await postTableOverrideStatus("reserved");
  };

  const handleMarkEmpty = async () => {
    await postTableOverrideStatus("empty");
  };

  const rootClass = `floor-editor sb-floor-view ${mountMode === "lobby" ? "is-embed" : ""}`;

  if (loading) {
    return (
      <div className={rootClass}>
        <div className="sbv-loading">{t("floor.loading", "Loading floor plan...")}</div>
      </div>
    );
  }

  if (error || !currentLayout) {
    return (
      <div className={rootClass}>
        <div className="sbv-error">
          <div className="sbv-error-title">{t("host.err_load_map", "Cannot load floor map")}</div>
          <div className="sbv-error-sub">{error ?? t("host.err_load_map", "Error loading floor map")}</div>
          <button className="sbv-retry" onClick={loadAllLayouts}>
            {t("common.btn_refresh", "Retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClass}>
      <div className="sbv-shell">
        <div className="sbv-left">
          <div className="layout-tabs-bar sbv-view-topbar">
            <div className="sbv-topbar-left">
              <div className="sbv-topbar-title">{t("host.floor_map_title", "Restaurant Map (Live)")}</div>
              <div className="sbv-topbar-sub">{t("floor.hints.controls", "Drag to pan, Ctrl+wheel to zoom")}</div>
            </div>

            <div className="sbv-legend" aria-label="Legend">
              <span className="sbv-pill is-empty">
                <span className="sbv-dot" /> {statusLabel("empty")}
              </span>
              <span className="sbv-pill is-occupied">
                <span className="sbv-dot" /> {statusLabel("occupied")}
              </span>
              <span className="sbv-pill is-reserved">
                <span className="sbv-dot" /> {statusLabel("reserved")}
              </span>
              <span className="sbv-pill is-dirty">
                <span className="sbv-dot" /> {statusLabel("dirty")}
              </span>
            </div>

            {layouts.length > 1 && (
              <div className="sbv-room-tabs" role="tablist" aria-label={t("floor.rooms.title", "Rooms")}>
                {layouts.map((layout) => {
                  const label = (layout as any).floorLabel || layout.name;
                  const isSelected = selectedLayoutId === layout.id;
                  const occupiedCount = ((layout as any).tableStatuses || []).filter(
                    (s: any) => normalizeStatus(s?.status) === "occupied"
                  ).length;
                  const totalTables = (layout.tables || []).length;
                  return (
                    <button
                      key={layout.id}
                      className={`sbv-room-tab ${isSelected ? "is-active" : ""}`}
                      onClick={() => { setSelectedLayoutId(layout.id); setSelectedTableId(null); setSelectedBarSeatId(null); }}
                      role="tab"
                      aria-selected={isSelected}
                    >
                      <span className="sbv-room-tab-label">{label}</span>
                      <span className="sbv-room-tab-count">{occupiedCount}/{totalTables}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="editor-content sbv-editor-content">
            <FloorMapRenderer
              layout={currentLayout!}
              selectedTableId={selectedTableId}
              barAccountsByTable={barAccountsByTable}
              selectedBarSeatId={selectedBarSeatId}
              onBarSeatClick={handleBarSeatClick}
              onTableClick={onTableClick}
              mode="view"
            />
          </div>
        </div>

        {/* Mobile backdrop overlay */}
        {selectedTableId && (
          <div className="sbv-mobile-backdrop" onClick={closeDrawer} />
        )}

        <aside className={`sbv-right ${mountMode === "lobby" && selectedTableId ? "open" : ""} ${selectedTableId ? "has-selection" : ""}`} aria-label={t("host.table_details", "Table details")}>
          {selectedTableId ? (
            <div className="sbv-right-panel" role="dialog" aria-modal="false">
              <div className="sbv-drawer-header">
                <div className="sbv-drawer-title">{t("host.table_details", "Table Details")}</div>
                <button className="sbv-close" onClick={closeDrawer} aria-label={t("common.btn_close", "Close")}>
                  &#10005;
                </button>
              </div>

              <div className="sbv-drawer-body">
                <div className="sbv-table-number">
                  {t("host.table_label", "Table")} {(selectedTable as any)?.tableNumber ?? (selectedTable as any)?.number ?? "—"}
                </div>

                <div className={`sbv-status-row is-${selectedStatus}`}>
                  <span className="sbv-status-dot" />
                  <span className="sbv-status-label">{t("host.table_status_label", "Table Status")}</span>
                  <span className="sbv-status-value">{statusLabel(selectedStatus)}</span>
                </div>

                <div className="sbv-kv">
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">{t("host.guest_name", "Guest Name")}</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.guestName ?? "—"}</div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">{t("host.num_guests", "Guests")}</div>
                    <div className="sbv-kv-val">
                      {(selectedStatusEntry as any)?.guestCount != null ? String((selectedStatusEntry as any).guestCount) : "—"}
                    </div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">{t("host.reservation_time", "Reservation Time")}</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.reservationTime ?? "—"}</div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">{t("pos.waiter.items_label", "Items")}</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.itemsCount ?? "—"}</div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">{t("pos.waiter.subtotal", "Subtotal")}</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.subtotal ?? "—"}</div>
                  </div>
                </div>

                {selectedTable && isBarTable(selectedTable) && (
                  <div className="sbv-bar-drawer-section">
                    <div className="sbv-bar-drawer-title">{t('floor.bar.title', 'Bar seats')}</div>
                    <div className="sbv-bar-drawer-sub">{clickMode === 'host' ? t('floor.bar.host_help', 'Pick the first free seat. The host can seat groups on adjacent bar seats.') : t('floor.bar.help', 'Seats from the same reservation open the same order screen.')}</div>
                    <div className="sbv-bar-drawer-grid">
                      {Array.from({ length: Math.max(1, Number((selectedTable as any)?.seats || 1)) }).map((_, seatIndex) => {
                        const seatNumber = seatIndex + 1;
                        const seatId = seatIdForBar(String((selectedTable as any).id), seatNumber);
                        const seatAccount = selectedBarAccounts.find((acc) => {
                          const seatIds = Array.isArray((acc as any).seatIds) && (acc as any).seatIds.length
                            ? (acc as any).seatIds
                            : [acc.seatId];
                          return seatIds.map((v: any) => String(v || '')).includes(seatId);
                        }) ?? null;
                        const occupied = Boolean(seatAccount);
                        const selected = selectedBarSeatId === seatId;
                        return (
                          <button
                            key={seatId}
                            type="button"
                            className={`sbv-bar-drawer-seat ${occupied ? 'is-occupied' : 'is-free'} ${selected ? 'is-selected' : ''}`}
                            onClick={() => handleBarSeatClick(String((selectedTable as any).id), seatId)}
                          >
                            <span className="sbv-bar-drawer-seat-no">{t('floor.bar.seat_label', 'Bar Seat')} {seatNumber}</span>
                            <span className="sbv-bar-drawer-seat-status">{occupied ? (seatAccount?.accountLabel || t('pos.waiter.main_check', 'Main Check')) : t('floor.bar.free', 'Free')}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="sbv-drawer-footer">
  {(clickMode === "lobby" || clickMode === "waiter") ? (
    <>
      <button
        className="sbv-secondary-btn"
        onClick={handleMarkDirty}
        disabled={selectedStatus === "dirty"}
      >
        {t("floor.mark_dirty", "Mark Dirty")}
      </button>

      <button
        className="sbv-success-btn"
        onClick={handleMarkClean}
        disabled={selectedStatus !== "dirty"}
      >
        {t("floor.mark_clean", "Mark Clean")}
      </button>
    </>
  ) : null}

  {clickMode === "host" ? (
    <>
      <button
        className="sbv-primary-btn"
        onClick={handleMarkReserved}
        disabled={selectedStatus === "reserved"}
      >
        {t("floor.mark_reserved", "Mark Reserved")}
      </button>

      <button
        className="sbv-secondary-btn"
        onClick={handleMarkEmpty}
        disabled={selectedStatus === "empty"}
      >
        {t("floor.mark_empty", "Mark Empty")}
      </button>
    </>
  ) : null}

  {clickMode !== 'host' && selectedTable && isBarTable(selectedTable) && selectedBarSeatId ? (
    <button
      className="sbv-primary-btn"
      onClick={() => handleBarSeatClick(String((selectedTable as any).id), String(selectedBarSeatId))}
    >
      {t("pos.waiter.btn_open_order", "Open Order")}
    </button>
  ) : selectedStatus === "occupied" &&
  (selectedStatusEntry as any)?.orderId &&
  ((selectedTable as any)?.tableNumber ?? (selectedTable as any)?.number) ? (
    <a
      className="sbv-primary-btn"
      href={`/waiter/${restaurantId}/${(selectedTable as any).tableNumber ?? (selectedTable as any).number}`}
    >
      {t("pos.waiter.btn_open_order", "Open Order")}
    </a>
  ) : null}

  <button className="sbv-secondary-btn" onClick={closeDrawer}>
    {t("common.btn_close", "Close")}
  </button>
</div>
            </div>
          ) : (
            <div className="sbv-right-empty">
              <div className="sbv-right-empty-title">{t("host.table_details", "Table Details")}</div>
              <div className="sbv-right-empty-sub">{t("host.floor_map_help", "Select a table on the map to view details.")}</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
