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
                setSelectedTableId(tableId);
                const st = getTableStatus(tableId);
                if (st.status === 'occupied') {
                  // Preserve legacy navigation behavior
                  const t = (layout?.tables || []).find((x) => String(x.id) === String(tableId));
                  const tn = t?.tableNumber;
                  if (tn != null) {
                    window.location.href = `/waiter/${encodeURIComponent(rid)}/${encodeURIComponent(String(tn))}`;
                    return;
                  }
                }
                alert('שולחן לא תפוס כרגע. הושבה נעשית דרך מסך המארחת.');
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
