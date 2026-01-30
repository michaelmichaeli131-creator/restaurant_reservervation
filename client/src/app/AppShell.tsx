import type { ReactNode } from 'react';
import { NAV_ITEMS, type AppRouteKey } from './nav';
import { useBreakpoint } from '../shared/hooks/useBreakpoint';

type Props = {
  title: string;
  activeRoute: AppRouteKey;
  onNavigate: (route: AppRouteKey) => void;
  children: ReactNode;
  topRight?: ReactNode;
};

export default function AppShell({ title, activeRoute, onNavigate, children, topRight }: Props) {
  const { isMobile, isTablet } = useBreakpoint();
  const compactSideNav = isTablet; // tablet = rail-like

  return (
    <div className={`app-shell ${isMobile ? 'app-shell--mobile' : ''}`}>
      {!isMobile && (
        <aside className={`app-sidenav ${compactSideNav ? 'app-sidenav--compact' : ''}`}>
          <div className="app-sidenav__brand">
            <span className="app-sidenav__logo">🍽️</span>
            {!compactSideNav && <span className="app-sidenav__name">SpotBook</span>}
          </div>

          <nav className="app-sidenav__nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => {
              const active = item.key === activeRoute;
              return (
                <button
                  key={item.key}
                  className={`nav-item ${active ? 'is-active' : ''}`}
                  onClick={() => onNavigate(item.key)}
                  aria-current={active ? 'page' : undefined}
                  title={item.label}
                  type="button"
                >
                  <span className="nav-item__icon" aria-hidden="true">{item.icon}</span>
                  {!compactSideNav && <span className="nav-item__label">{item.label}</span>}
                </button>
              );
            })}
          </nav>

          {!compactSideNav && (
            <div className="app-sidenav__hint">
              <div className="hint-card">
                <div className="hint-title">Tip</div>
                <div className="hint-text">Try the Layout screen on tablet – it’s built for touch.</div>
              </div>
            </div>
          )}
        </aside>
      )}

      <div className="app-shell__main">
        <header className="app-topbar">
          <div className="app-topbar__title">
            <h1>{title}</h1>
          </div>
          <div className="app-topbar__right">{topRight}</div>
        </header>

        <main className={`app-content ${isMobile ? 'app-content--with-bottomnav' : ''}`}>
          {children}
        </main>

        {isMobile && (
          <nav className="app-bottomnav" aria-label="Primary">
            {NAV_ITEMS.map((item) => {
              const active = item.key === activeRoute;
              return (
                <button
                  key={item.key}
                  className={`bottomnav-item ${active ? 'is-active' : ''}`}
                  onClick={() => onNavigate(item.key)}
                  aria-current={active ? 'page' : undefined}
                  type="button"
                >
                  <span className="bottomnav-item__icon" aria-hidden="true">{item.icon}</span>
                  <span className="bottomnav-item__label">{item.label}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>
    </div>
  );
}
