import React from "react";
import FloorMapRenderer from "../shared/FloorMapRenderer";
import type { FloorLayoutLike as FloorLayout } from "../shared/FloorMapRenderer";
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
  const anchorTableIdRef = React.useRef<string | null>(null);


  // Section filtering
  type SectionInfo = { id: string; name: string; displayOrder?: number };
  const [sections, setSections] = React.useState<SectionInfo[]>([]);
  const [activeSectionId, setActiveSectionId] = React.useState<string | null>(null);

  // clickMode is used to decide which actions to show in Table Details (host vs. waiter lobby).
  // It must be defined here (not as an undeclared global) to avoid runtime crashes when opening Table Details.
  const __sbRootEl = typeof document !== "undefined" ? document.getElementById("sb-floor-root") : null;
  const clickMode = String(
    __sbRootEl?.getAttribute("data-click-mode") ||
      __sbRootEl?.getAttribute("data-mode") ||
      (mountMode === "lobby" ? "lobby" : "page")
  ).toLowerCase();


  // Load sections once
  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/floor-sections/${restaurantId}`);
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data?.sections ?? []);
        list.sort((a: SectionInfo, b: SectionInfo) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
        setSections(list);
      } catch { /* sections are optional */ }
    })();
  }, [restaurantId]);

  const loadActive = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/floor-layouts/${restaurantId}/active`, {
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

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
      setActiveLayoutId(active.id);
      setSelectedLayoutId((prev) => prev ?? active.id);
      setError(null);
      setLoading(false);
      // Keep selection stable across refreshes (supports host multi-select)
      setSelectedTableIds((prev) => {
        const allowed = new Set((active.tables || []).map((t: any) => String(t.id)));
        const next = (prev || []).map(String).filter((id) => allowed.has(id));

        // Keep focused table valid
        setSelectedTableId((focusPrev) => {
          const fp = focusPrev ? String(focusPrev) : null;
          if (fp && allowed.has(fp)) return fp;
          return next.length ? String(next[0]) : null;
        });

        // Keep anchor valid
        if (anchorTableIdRef.current && !allowed.has(String(anchorTableIdRef.current))) {
          anchorTableIdRef.current = next.length ? String(next[0]) : null;
        }

        return next;
      });
    } catch (e: any) {
      setError(t("host.err_load_map", "Error loading floor map") + `: ${e?.message ?? "unknown"}`);
      setLoading(false);
    }
  }, [restaurantId]);

  React.useEffect(() => {
    loadActive();
    const id = setInterval(loadActive, 5000);
    return () => clearInterval(id);
  }, [loadActive]);

  const currentLayout = React.useMemo(() => {
    if (!selectedLayoutId) return null;
    return layouts.find((l) => l.id === selectedLayoutId) ?? null;
  }, [layouts, selectedLayoutId]);

  // Filter layout by active section
  const filteredLayout = React.useMemo(() => {
    if (!currentLayout) return null;
    if (!activeSectionId) return currentLayout; // "All" - show everything
    return {
      ...currentLayout,
      tables: (currentLayout.tables || []).filter(
        (tbl: any) => tbl.sectionId === activeSectionId
      ),
    };
  }, [currentLayout, activeSectionId]);

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
    return statuses.find((s) => (s as any).tableNumber === (selectedTable as any).number) ?? null;
  }, [currentLayout, selectedTable]);

  const selectedStatus: NormalStatus = React.useMemo(() => {
    return normalizeStatus((selectedStatusEntry as any)?.status);
  }, [selectedStatusEntry]);

  const effectiveSelectedIds = React.useMemo(() => {
    if (clickMode === 'host') return selectedTableIds;
    return selectedTableId ? [selectedTableId] : [];
  }, [clickMode, selectedTableIds, selectedTableId]);

  // Notify non-React pages (host seating) about current selection
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const layout = currentLayout;
    const idToNum = new Map<string, number>();
    (layout?.tables || []).forEach((t: any) => {
      const id = String(t.id);
      const n = Number((t as any).tableNumber ?? (t as any).number ?? (t as any).tableNum ?? 0);
      if (Number.isFinite(n) && n > 0) idToNum.set(id, n);
    });

    const ids = (effectiveSelectedIds || []).map(String).filter(Boolean);
    const nums = ids
      .map((id) => idToNum.get(String(id)))
      .filter((n): n is number => Number.isFinite(Number(n)) && Number(n) > 0)
      .map((n) => Number(n));

    window.dispatchEvent(
      new CustomEvent('sb-floor-selection', {
        detail: {
          tableIds: ids,
          tableNumbers: nums,
        },
      })
    );
  }, [currentLayout?.id, currentLayout?.tables?.length, effectiveSelectedIds.join('|')]);

  const onTableClick = (
    tableId: string,
    mods?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  ) => {
    const id = String(tableId);

    // In waiter/lobby/page mode we keep the old single-select behavior
    if (clickMode !== 'host') {
      setSelectedTableId(id);
      setSelectedTableIds([id]);
      anchorTableIdRef.current = id;
      return;
    }

    const ctrl = !!mods?.ctrlKey || !!mods?.metaKey;
    const shift = !!mods?.shiftKey;

    setSelectedTableIds((prev) => {
      const prevSet = new Set((prev || []).map(String));
      const tables = (currentLayout?.tables || []) as any[];
      const numById = new Map<string, number>();
      tables.forEach((t) => {
        const n = Number((t as any).tableNumber ?? (t as any).number ?? 0);
        if (Number.isFinite(n) && n > 0) numById.set(String(t.id), n);
      });

      let nextSet: Set<string>;

      // Shift = range selection between anchor and clicked (by table number).
      if (shift && anchorTableIdRef.current && numById.size > 0) {
        const aId = String(anchorTableIdRef.current);
        const aNum = numById.get(aId);
        const bNum = numById.get(id);

        if (aNum != null && bNum != null) {
          const lo = Math.min(aNum, bNum);
          const hi = Math.max(aNum, bNum);
          const rangeIds = tables
            .filter((t) => {
              const n = numById.get(String(t.id));
              return n != null && n >= lo && n <= hi;
            })
            .map((t) => String(t.id));

          nextSet = ctrl ? new Set(prevSet) : new Set<string>();
          rangeIds.forEach((rid) => nextSet.add(rid));
        } else {
          // Fallback: behave like additive select
          nextSet = ctrl ? new Set(prevSet) : new Set<string>();
          nextSet.add(id);
        }
      } else if (ctrl) {
        // Ctrl/Cmd = toggle
        nextSet = new Set(prevSet);
        if (nextSet.has(id)) nextSet.delete(id);
        else nextSet.add(id);
      } else {
        // Plain click = single selection
        nextSet = new Set([id]);
      }

      const next = Array.from(nextSet);
      // Sort by table number when possible (nice UX for merged tables)
      next.sort((a, b) => (numById.get(a) ?? 0) - (numById.get(b) ?? 0));

      // Focus / drawer table
      const nextFocus = nextSet.has(id) ? id : (next[0] ?? null);
      setSelectedTableId(nextFocus);

      // Update anchor ONLY on non-shift clicks (classic behavior)
      if (!shift) anchorTableIdRef.current = id;
      if (!anchorTableIdRef.current && next[0]) anchorTableIdRef.current = String(next[0]);

      return next;
    });
  };

  const closeDrawer = () => {
    setSelectedTableId(null);
    if (clickMode === 'host') setSelectedTableIds([]);
  };

  
const postTableOverrideStatus = async (status: "empty" | "dirty" | "reserved") => {
  const tableId = (selectedTable as any)?.id;
  if (!tableId) return;

  try {
    const res = await fetch(`/api/tables/${restaurantId}/${tableId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `HTTP ${res.status}`);
    }
    await loadActive();
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
          <button className="sbv-retry" onClick={loadActive}>
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

            {sections.length > 1 && (
              <div className="sbv-section-tabs" role="tablist" aria-label={t("floor.sections.title", "Sections")}>
                <button
                  className={`sbv-section-tab ${activeSectionId === null ? "is-active" : ""}`}
                  onClick={() => setActiveSectionId(null)}
                  role="tab"
                  aria-selected={activeSectionId === null}
                >
                  {t("common.all", "All")}
                </button>
                {sections.map((sec) => (
                  <button
                    key={sec.id}
                    className={`sbv-section-tab ${activeSectionId === sec.id ? "is-active" : ""}`}
                    onClick={() => setActiveSectionId(sec.id)}
                    role="tab"
                    aria-selected={activeSectionId === sec.id}
                  >
                    {sec.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="editor-content sbv-editor-content">
            <FloorMapRenderer
              layout={filteredLayout!}
              selectedTableId={selectedTableId}
              selectedTableIds={effectiveSelectedIds}
              onTableClick={onTableClick}
              mode="view"
            />
          </div>
        </div>

        <aside className={`sbv-right ${mountMode === "lobby" && selectedTableId ? "open" : ""}`} aria-label={t("host.table_details", "Table details")}>
          {selectedTableId ? (
            <div className="sbv-right-panel" role="dialog" aria-modal="false">
              <div className="sbv-drawer-header">
                <div className="sbv-drawer-title">{t("host.table_details", "Table Details")}</div>
                <button className="sbv-close" onClick={closeDrawer} aria-label={t("common.btn_close", "Close")}>
                  &#10005;
                </button>
              </div>

              <div className="sbv-drawer-body">
                <div className="sbv-table-number">{t("host.table_label", "Table")} {(selectedTable as any)?.number ?? "—"}</div>

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

  {selectedStatus === "occupied" &&
  (selectedStatusEntry as any)?.orderId &&
  (selectedTable as any)?.number ? (
    <a
      className="sbv-primary-btn"
      href={`/waiter/${restaurantId}/${(selectedTable as any).number}`}
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
