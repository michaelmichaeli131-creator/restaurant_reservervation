import { useEffect, useMemo, useRef, useState } from 'react';
import FloorMapRenderer, { type FloorLayoutLike } from '../shared/FloorMapRenderer';
import './floorViewPage.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export default function FloorViewPage({ restaurantId }: { restaurantId: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [layout, setLayout] = useState<FloorLayoutLike | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string>('');
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(0);
  const refreshTimer = useRef<number | null>(null);

  const rid = useMemo(() => String(restaurantId || '').trim(), [restaurantId]);

  const sectionIds = useMemo(() => {
    const ids = new Set<string>();
    (layout?.tables || []).forEach((t) => {
      const sid = String((t as any).sectionId || '').trim();
      if (sid) ids.add(sid);
    });
    const arr = Array.from(ids);
    // Always show "All" first
    return [''].concat(arr);
  }, [layout?.id, layout?.tables]);

  const sectionLabel = (sid: string, idx: number) => {
    if (!sid) return 'כל המסעדה';
    // If it's a friendly name already - show as is
    const s = String(sid);
    if (s.length <= 22) return s;
    return `אזור ${idx}`;
  };

  const getTableStatus = (tableId: string) => {
    const st = (layout as any)?.tableStatuses;
    if (!Array.isArray(st)) return { status: 'empty' as string };
    const byId = st.find((x: any) => x && String(x.tableId || '') === String(tableId));
    if (byId) return { status: String(byId.status || 'empty') };
    return { status: 'empty' as string };
  };


  const statusLabelHe = (status: string) => {
    if (status === 'occupied') return 'תפוס';
    if (status === 'reserved') return 'שמור';
    if (status === 'dirty') return 'מלוכלך';
    return 'פנוי';
  };

  const statusDotClass = (status: string) => {
    if (status === 'occupied') return 'occupied';
    if (status === 'reserved') return 'reserved';
    if (status === 'dirty') return 'dirty';
    return 'empty';
  };

  const selectedTable = useMemo(() => {
    if (!layout || !selectedTableId) return null;
    return (layout.tables || []).find((t: any) => String(t.id) === String(selectedTableId)) || null;
  }, [layout, selectedTableId]);

  const selectedStatus = useMemo(() => {
    if (!selectedTableId) return { status: 'empty' as string };
    return getTableStatus(selectedTableId);
  }, [layout, selectedTableId]);

  const selectedTableNumber = selectedTable?.tableNumber ?? null;

  const selectedMeta = useMemo(() => {
    const st: any = selectedStatus as any;
    const guestName = st.guestName ?? st.customerName ?? null;
    const guestCount = st.guestCount ?? st.partySize ?? null;
    const reservedAt = st.reservationTime ?? st.reservedAt ?? null;
    const occupiedSince = st.occupiedSince ?? null;
    const orderTotal = st.orderTotal ?? st.subtotal ?? null;
    const itemsCount = st.itemsCount ?? (Number.isFinite(st.itemsReady) || Number.isFinite(st.itemsPending)
      ? (Number(st.itemsReady || 0) + Number(st.itemsPending || 0))
      : null);

    const timeStr = (() => {
      const v = reservedAt ?? occupiedSince;
      if (!v) return null;
      const n = Number(v);
      if (Number.isFinite(n) && n > 1000000000) {
        try { return new Date(n).toLocaleTimeString(); } catch { return null; }
      }
      if (typeof v === 'string') return v;
      return null;
    })();

    return { guestName, guestCount, timeStr, itemsCount, orderTotal };
  }, [selectedStatus]);

  useEffect(() => {
    let cancelled = false;

    const loadActive = async (silent = false) => {
      if (!rid) {
        setState({ kind: 'error', message: 'Missing restaurant id (rid)' });
        return;
      }

      if (!silent) setState({ kind: 'loading' });
      try {
        const res = await fetch(`/api/floor-layouts/${encodeURIComponent(rid)}/active`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = (body && (body.error || body.message)) || `${res.status} ${res.statusText}`;
          throw new Error(msg);
        }
        const data = (await res.json()) as FloorLayoutLike;
        if (cancelled) return;
        setLayout(data);
        setState({ kind: 'ready' });
        setLastRefreshAt(Date.now());

        // If current active section doesn't exist anymore, reset to "All"
        const exists = !activeSectionId || (data.tables || []).some((t: any) => String(t.sectionId || '') === String(activeSectionId));
        if (!exists) setActiveSectionId('');
      } catch (e) {
        if (cancelled) return;
        setLayout(null);
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    };

    loadActive();

    // Poll like legacy sb_floor_map.js (every 5s) to keep table statuses in sync.
    if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    refreshTimer.current = window.setInterval(() => {
      loadActive(true);
    }, 5000);

    return () => {
      cancelled = true;
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [rid]);

  // IMPORTANT: hooks must be called unconditionally.
  // We compute the filtered layout before any early returns.
  const filteredLayout = useMemo(() => {
    if (!layout) return null;
    if (!activeSectionId) return layout;
    const sid = String(activeSectionId);
    return {
      ...layout,
      tables: (layout.tables || []).filter((t: any) => String(t.sectionId || '') === sid),
      // Keep statuses as-is; renderer resolves by id/number.
    } as FloorLayoutLike;
  }, [layout, activeSectionId]);

  if (state.kind === 'loading') {
    return (
      <div className="sb-floor-view-shell">
        <div className="sb-floor-view-loading">Loading floor map…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="sb-floor-view-shell">
        <div className="sb-floor-view-error">
          <div className="title">לא ניתן לטעון את מפת המסעדה.</div>
          <div className="desc">{state.message}</div>
          <div className="hint">(בדוק את ה-Console לפרטי דיבוג)</div>
        </div>
      </div>

    );
  }
return (
    <>
    <div className="floor-editor sb-floor-view">
      <div className="layout-tabs-bar">
        <div className="layout-tabs" role="tablist" aria-label="Sections">
          {sectionIds.map((sid, i) => (
            <button
              key={sid || 'all'}
              className={`layout-tab ${String(activeSectionId) === String(sid) ? 'active' : ''}`}
              onClick={() => setActiveSectionId(String(sid))}
              type="button"
              role="tab"
              aria-selected={String(activeSectionId) === String(sid)}
            >
              {sectionLabel(String(sid), i)}
            </button>
          ))}
        </div>

        <div className="layout-actions">
          <div className="sbv-legend" title="Legend">
            <span className="sbv-leg"><span className="sbv-dot empty"/>פנוי</span>
            <span className="sbv-leg"><span className="sbv-dot occupied"/>תפוס</span>
            <span className="sbv-leg"><span className="sbv-dot reserved"/>שמור</span>
            <span className="sbv-leg"><span className="sbv-dot dirty"/>מלוכלך</span>
          </div>

          <button
            type="button"
            className="btn-icon-small"
            title="Refresh"
            onClick={async () => {
              // Manual refresh
              try {
                const res = await fetch(`/api/floor-layouts/${encodeURIComponent(rid)}/active`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                const data = (await res.json()) as FloorLayoutLike;
                setLayout(data);
                setLastRefreshAt(Date.now());
              } catch (e) {
                console.error('[FloorView] manual refresh failed', e);
              }
            }}
          >
            ↻
          </button>

          <div className="sbv-refresh">
            {lastRefreshAt ? `עודכן: ${new Date(lastRefreshAt).toLocaleTimeString()}` : ''}
          </div>
        </div>
      </div>

      <div className="editor-content sbv-content">
        <div className="editor-main sbv-main">
          {filteredLayout && (
            <FloorMapRenderer
              layout={filteredLayout}
              mode="view"
              selectedTableId={selectedTableId}
              onTableClick={(tableId) => {
                // Always open details panel (like legacy waiter map)
                setSelectedTableId(tableId);
              }}
            />
          )}
        </div>
      </div>
    </div>



      {/* Table details modal */}
      {selectedTableId && (
        <div className="sbv-modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelectedTableId(null);
        }}>
          <div className="sbv-modal" dir="rtl">
            <div className="sbv-modal-header">
              <div className="sbv-modal-title">פרטי שולחן</div>
              <button className="sbv-x" type="button" aria-label="Close" onClick={() => setSelectedTableId(null)}>✕</button>
            </div>

            <div className="sbv-modal-subtitle">
              שולחן {selectedTable?.tableNumber ?? selectedTable?.name ?? '—'}
            </div>

            <div className="sbv-kv">
              <div className="sbv-row">
                <div className="k">שם המזמין</div>
                <div className="v">{selectedMeta.guestName || '—'}</div>
              </div>
              <div className="sbv-row">
                <div className="k">מספר סועדים</div>
                <div className="v">{selectedMeta.guestCount ?? '—'}</div>
              </div>
              <div className="sbv-row">
                <div className="k">שעת ההזמנה</div>
                <div className="v">{selectedMeta.timeStr || '—'}</div>
              </div>
              <div className="sbv-row">
                <div className="k">סטטוס שולחן</div>
                <div className="v">
                  <span className={`sbv-dot ${statusDotClass(String((selectedStatus as any).status || 'empty'))}`} />
                  <span className="sbv-status-label">{statusLabelHe(String((selectedStatus as any).status || 'empty'))}</span>
                </div>
              </div>
              <div className="sbv-row">
                <div className="k">מספר פריטים</div>
                <div className="v">{selectedMeta.itemsCount ?? '—'}</div>
              </div>
              <div className="sbv-row">
                <div className="k">סכום ביניים</div>
                <div className="v">{selectedMeta.orderTotal != null ? `${Number(selectedMeta.orderTotal).toFixed(2)} ₪` : '—'}</div>
              </div>
            </div>

            <div className="sbv-modal-actions">
              {selectedTableNumber != null && (
                <a className="btn primary" href={`/waiter/${encodeURIComponent(rid)}/${encodeURIComponent(String(selectedTableNumber))}`}>
                  פתח הזמנה
                </a>
              )}
              <button className="btn ghost" type="button" onClick={() => setSelectedTableId(null)}>סגור</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
