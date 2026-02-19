import React from "react";
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

type MountMode = "page" | "lobby";

type NormalStatus = "empty" | "occupied" | "reserved" | "dirty";

function normalizeStatus(s?: string | null): NormalStatus {
  const v = (s || "").toLowerCase();
  if (v === "occupied" || v === "busy" || v === "taken") return "occupied";
  if (v === "reserved" || v === "booked") return "reserved";
  if (v === "dirty" || v === "needs_cleaning") return "dirty";
  return "empty";
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
    return statuses.find((s) => (s as any).tableNumber === (selectedTable as any).number) ?? null;
  }, [currentLayout, selectedTable]);

  const selectedStatus: NormalStatus = React.useMemo(() => {
    return normalizeStatus((selectedStatusEntry as any)?.status);
  }, [selectedStatusEntry]);

  const onTableClick = (tableId: string) => {
    setSelectedTableId(tableId);
  };

  const closeDrawer = () => setSelectedTableId(null);

  const rootClass = `floor-editor sb-floor-view ${mountMode === "lobby" ? "is-embed" : ""}`;

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
      <div className="sbv-shell">
        {/* LEFT: map frame (same chrome as editor) */}
        <div className="sbv-left">
          {/* Use the same top-bar structure as the editor to avoid flex bugs (layout-tabs has flex:1 in editor CSS) */}
          <div className="layout-tabs-bar sbv-view-topbar">
            <div className="sbv-topbar-left">
              <div className="sbv-topbar-title">עדכון סידור שולחנות</div>
              <div className="sbv-topbar-sub">גרור כדי להזיז • Ctrl+גלגלת כדי להגדיל • ⤢ להתאמה למסך</div>
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
              onTableClick={onTableClick}
              mode="view"
            />
          </div>
        </div>

        {/* RIGHT: details panel OUTSIDE the map frame (as requested) */}
        <aside className="sbv-right" aria-label="Table details">
          {selectedTableId ? (
            <div className="sbv-right-panel" role="dialog" aria-modal="false">
              <div className="sbv-drawer-header">
                <div className="sbv-drawer-title">פרטי שולחן</div>
                <button className="sbv-close" onClick={closeDrawer} aria-label="Close">
                  ✕
                </button>
              </div>

              <div className="sbv-drawer-body">
                <div className="sbv-table-number">שולחן {(selectedTable as any)?.number ?? "—"}</div>

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
                      {(selectedStatusEntry as any)?.guestCount != null ? String((selectedStatusEntry as any).guestCount) : "—"}
                    </div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">שעת ההזמנה</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.reservationTime ?? "—"}</div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">מספר פריטים</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.itemsCount ?? "—"}</div>
                  </div>
                  <div className="sbv-kv-row">
                    <div className="sbv-kv-key">סכום ביניים</div>
                    <div className="sbv-kv-val">{(selectedStatusEntry as any)?.subtotal ?? "—"}</div>
                  </div>
                </div>
              </div>

              <div className="sbv-drawer-footer">
                {selectedStatus === "occupied" && (selectedTable as any)?.number ? (
                  <a className="sbv-primary-btn" href={`/waiter/${restaurantId}/${(selectedTable as any).number}`}>
                    פתח הזמנה
                  </a>
                ) : (
                  <button className="sbv-secondary-btn" onClick={closeDrawer}>
                    סגור
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="sbv-right-empty">
              <div className="sbv-right-empty-title">פרטי שולחן</div>
              <div className="sbv-right-empty-sub">בחר שולחן במפה כדי לראות סטטוס ופרטים.</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
