import React from "react";
import ReactDOM from "react-dom";
import FloorMapRenderer from "../shared/FloorMapRenderer";
import type { FloorLayoutLike as FloorLayout } from "../shared/FloorMapRenderer";
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

type MountMode = "page" | "lobby" | "host";

type NormalStatus = "empty" | "occupied" | "reserved" | "dirty";

function normalizeStatus(s?: string | null): NormalStatus {
  const v = (s || "").toLowerCase();
  if (v === "occupied" || v === "busy" || v === "taken") return "occupied";
  if (v === "reserved" || v === "booked") return "reserved";
  if (v === "dirty" || v === "needs_cleaning") return "dirty";
  return "empty";
}



function getTableNumber(t: any): number | null {
  const candidates = [
    t?.tableNumber,
    t?.number,
    t?.table_number,
    t?.tableNum,
    t?.table,
    t?.name,
    t?.label,
  ];

  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (!s) continue;

    // 1) direct numeric
    const v = Number(s);
    if (Number.isFinite(v) && v > 0) return v;

    // 2) extract first number from strings like "Table 12" / "שולחן 12" / "T12"
    const m = s.match(/(\d{1,4})/);
    if (m) {
      const vv = Number(m[1]);
      if (Number.isFinite(vv) && vv > 0) return vv;
    }
  }

  return null;
}

function statusLabelHe(s: NormalStatus): string {
  switch (s) {
    case "occupied":
      return "תפוס";
    case "reserved":
      return "שמור";
    case "dirty":
      return "מלוכלך";
    default:
      return "פנוי";
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
  const [selectedTableIds, setSelectedTableIds] = React.useState<string[]>([]);

  const loadActive = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/floor-layouts/${restaurantId}/active`, {
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      // Backend compatibility:
      // - Preferred: the API returns the active layout object directly (with tableStatuses attached).
      // - Legacy/alternate: { activeLayout: <layout> }.
      const active: FloorLayout | null = (data && (data as any).id)
        ? (data as FloorLayout)
        : (data?.activeLayout ?? null);

      if (!active) {
        setLayouts([]);
        setActiveLayoutId(null);
        setSelectedLayoutId(null);
        setError("אין מפת מסעדה פעילה");
        setLoading(false);
        return;
      }

      // In this project, we only keep a single active layout.
      setLayouts([active]);
      setActiveLayoutId(active.id);
      setSelectedLayoutId((prev) => prev ?? active.id);
      setError(null);
      setLoading(false);

      // If the selected table no longer exists, close the drawer
      if (selectedTableId) {
        const stillExists = (active.tables || []).some((t) => String(t.id) === String(selectedTableId));
        if (!stillExists) setSelectedTableId(null);
      }
    } catch (e: any) {
      setError(`שגיאה בטעינת המפה: ${e?.message ?? "unknown"}`);
      setLoading(false);
    }
  }, [restaurantId, selectedTableId]);

  React.useEffect(() => {
    loadActive();
    const id = setInterval(loadActive, 5000);
    return () => clearInterval(id);
  }, [loadActive]);

  React.useEffect(() => {
    const handler = () => loadActive();
    window.addEventListener("sb-floor-refresh", handler as any);
    return () => window.removeEventListener("sb-floor-refresh", handler as any);
  }, [loadActive]);

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

    // prefer by id, fall back to number
    const byId = statuses.find((s) => String((s as any).tableId) === String(selectedTable.id));
    if (byId) return byId;
    return statuses.find((s) => (s as any).tableNumber === getTableNumber(selectedTable)) ?? null;
  }, [currentLayout, selectedTable]);

  const selectedStatus: NormalStatus = React.useMemo(() => {
    return normalizeStatus((selectedStatusEntry as any)?.status);
  }, [selectedStatusEntry]);

  const isHostMode = mountMode === "host";
  const isWaiterLobby = mountMode === "lobby";

  // Host mode: allow multi-select for seating flow.
  const onTableClick = (tableId: string) => {
    if (isHostMode) {
      setSelectedTableIds((prev) => {
        const next = new Set(prev);
        if (next.has(tableId)) next.delete(tableId);
        else next.add(tableId);
        return Array.from(next);
      });
      return;
    }
    setSelectedTableId(tableId);
  };

  const closeDrawer = () => setSelectedTableId(null);

  // Dispatch selected tables for the host page (so the existing template logic can remain mostly unchanged).
  React.useEffect(() => {
    if (!isHostMode) return;
    const layout = currentLayout;
    if (!layout) return;

    const byId = new Map<string, any>();
    (layout.tables || []).forEach((t: any) => byId.set(String(t.id), t));

    const tableNumbers = selectedTableIds
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .map((t: any) => getTableNumber(t) ?? 0)
      .filter((n: number) => Number.isFinite(n) && n > 0);

    window.dispatchEvent(
      new CustomEvent("sb-floor-selection", {
        detail: {
          tableIds: selectedTableIds,
          tableNumbers,
        },
      })
    );
  }, [isHostMode, currentLayout, selectedTableIds]);

  // Allow host template to clear selection after seating.
  React.useEffect(() => {
    if (!isHostMode) return;
    const handler = () => setSelectedTableIds([]);
    window.addEventListener("sb-floor-clear-selection", handler as any);
    return () => window.removeEventListener("sb-floor-clear-selection", handler as any);
  }, [isHostMode]);

  const updateTableStatus = React.useCallback(
    async (tableId: string, status: NormalStatus) => {
      try {
        const res = await fetch(`/api/tables/${restaurantId}/${tableId}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadActive();
      } catch (e) {
        console.warn("Failed to update table status", e);
      }
    },
    [restaurantId, loadActive]
  );

  const rootClass = `floor-editor sb-floor-view ${mountMode === "lobby" || mountMode === "host" ? "is-embed" : ""}`;

  if (loading) {
    return (
      <div className={rootClass}>
        <div className="sbv-loading">טוען מפת מסעדה…</div>
      </div>
    );
  }

  if (error || !currentLayout) {
    return (
      <div className={rootClass}>
        <div className="sbv-error">
          <div className="sbv-error-title">לא ניתן לטעון את מפת המסעדה</div>
          <div className="sbv-error-sub">{error ?? "קרתה שגיאה בטעינת המפה"}</div>
          <button className="sbv-retry" onClick={loadActive}>
            נסה שוב
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClass}>
      {/* Use the same top-bar structure as the editor to avoid flex bugs (layout-tabs has flex:1 in editor CSS) */}
      <div className="layout-tabs-bar sbv-view-topbar">
        <div className="sbv-topbar-left">
          <div className="sbv-topbar-title">עדכון סידור שולחנות</div>
          <div className="sbv-topbar-sub">גרור כדי להזיז • ⤢ למרכז למסך</div>
        </div>

        <div className="sbv-legend" aria-label="Legend">
          <span className="sbv-pill is-empty">
            <span className="sbv-dot" /> פנוי
          </span>
          <span className="sbv-pill is-occupied">
            <span className="sbv-dot" /> תפוס
          </span>
          <span className="sbv-pill is-reserved">
            <span className="sbv-dot" /> שמור
          </span>
          <span className="sbv-pill is-dirty">
            <span className="sbv-dot" /> מלוכלך
          </span>
        </div>
      </div>

      {/* IMPORTANT: renderer root is `.editor-canvas` which expects to be a direct flex-item of `.editor-content` */}
      <div className="editor-content sbv-editor-content">
        <FloorMapRenderer
          layout={currentLayout}
          selectedTableId={selectedTableId}
          selectedTableIds={isHostMode ? selectedTableIds : null}
          onTableClick={onTableClick}
          mode="view"
        />
      </div>

      {/* Side drawer */}
      {selectedTableId && !isHostMode
        ? ReactDOM.createPortal(
            <>
              <div className="sbv-drawer-backdrop" onMouseDown={closeDrawer} />
                        <aside className="sbv-drawer" role="dialog" aria-modal="true">
                          <div className="sbv-drawer-header">
                            <div className="sbv-drawer-title">פרטי שולחן</div>
                            <button className="sbv-close" onClick={closeDrawer} aria-label="Close">
                              ✕
                            </button>
                          </div>
              
                          <div className="sbv-drawer-body">
                            <div className="sbv-table-number">שולחן {getTableNumber(selectedTable) ?? "—"}</div>
              
                            <div className={`sbv-status-row is-${selectedStatus}`}>
                              <span className="sbv-status-dot" />
                              <span className="sbv-status-label">סטטוס שולחן</span>
                              <span className="sbv-status-value">{statusLabelHe(selectedStatus)}</span>
                            </div>
              
                            <div className="sbv-kv">
                              <div className="sbv-kv-row">
                                <div className="sbv-kv-key">שם המזמין</div>
                                <div className="sbv-kv-val">{(selectedStatusEntry as any)?.guestName ?? "—"}</div>
                              </div>
                              <div className="sbv-kv-row">
                                <div className="sbv-kv-key">מספר סועדים</div>
                                <div className="sbv-kv-val">
                                  {(() => { const gc = (selectedStatusEntry as any)?.guestCount ?? (selectedStatusEntry as any)?.people; return (gc != null && gc !== "") ? String(gc) : "—"; })()}
                                </div>
                              </div>
                              <div className="sbv-kv-row">
                                <div className="sbv-kv-key">שעת ההזמנה</div>
                                <div className="sbv-kv-val">{(selectedStatusEntry as any)?.reservationTime ?? (selectedStatusEntry as any)?.time ?? "—"}</div>
                              </div>
                              <div className="sbv-kv-row">
                                <div className="sbv-kv-key">מספר פריטים</div>
                                <div className="sbv-kv-val">{(selectedStatusEntry as any)?.itemsCount ?? ((selectedStatusEntry as any)?.itemsReady != null && (selectedStatusEntry as any)?.itemsPending != null ? ((selectedStatusEntry as any).itemsReady + (selectedStatusEntry as any).itemsPending) : null) ?? "—"}</div>
                              </div>
                              <div className="sbv-kv-row">
                                <div className="sbv-kv-key">סכום ביניים</div>
                                <div className="sbv-kv-val">{(selectedStatusEntry as any)?.subtotal ?? (selectedStatusEntry as any)?.orderTotal ?? "—"}</div>
                              </div>
                            </div>
                          </div>
              
                          <div className="sbv-drawer-footer">
                            <div className="sbv-actions-row">
                              {/* Waiter: mark dirty / clean */}
                              {isWaiterLobby ? (
                                <>
                                  <button
                                    className="sbv-secondary-btn"
                                    onClick={(e) => { e.stopPropagation(); updateTableStatus(selectedTableId, "dirty"); window.dispatchEvent(new Event("sb-floor-refresh")); }}
                                  >
                                    סמן מלוכלך
                                  </button>
                                  <button
                                    className="sbv-secondary-btn"
                                    onClick={(e) => { e.stopPropagation(); updateTableStatus(selectedTableId, "empty"); window.dispatchEvent(new Event("sb-floor-refresh")); }}
                                  >
                                    סמן נקי
                                  </button>
                                </>
                              ) : null}

                              {/* Quick jump to the order screen (only if an open order exists) */}
                              {(() => {
                                const num = getTableNumber(selectedTable);
                                const hasOpenOrder = Boolean((selectedStatusEntry as any)?.orderId);
                                const canGo = Boolean(num) && (!isWaiterLobby || hasOpenOrder);
                                const href = num ? `/pos/${encodeURIComponent(restaurantId)}/table/${encodeURIComponent(String(num))}` : "";
                                return (
                                  <button
                                    type="button"
                                    className="sbv-primary-btn"
                                    disabled={!canGo}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!canGo) return;
                                      window.location.href = href;
                                    }}
                                    title={isWaiterLobby && !hasOpenOrder ? "אין הזמנה פתוחה לשולחן הזה" : undefined}
                                  >
                                    למסך ההזמנה
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                        </aside>
            </>,
            document.body
          )
        : null}
    </div>
  );
}
