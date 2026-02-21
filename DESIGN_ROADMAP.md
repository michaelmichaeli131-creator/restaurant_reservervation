# SpotBook / GeoTable - Design Roadmap

## Current State Summary

The app has a solid feature set but suffers from:
- Two separate design systems (GeoTable legacy vs SpotBook new)
- Inconsistent CSS variables between templates and React app
- 221+ inline styles in templates
- No unified component library
- Missing loading states, empty states, and error UI
- Partial RTL support
- Limited mobile responsiveness on complex views

---

## Phase 1: Design System Unification (Priority: HIGH)

### 1.1 Create a Single Design Token File

Unify all CSS variables into one source of truth shared between Eta templates and React.

```
public/css/tokens.css
├── Colors (--bg, --panel, --ink, --brand, --accent, --danger, --success, --warning)
├── Typography (--font-family, --font-size-*, --font-weight-*, --line-height-*)
├── Spacing (--space-xs through --space-3xl)
├── Border Radius (--radius-sm, --radius-md, --radius-lg, --radius-pill)
├── Shadows (--shadow-sm, --shadow-md, --shadow-lg)
└── Transitions (--transition-fast, --transition-normal)
```

**Current conflict to resolve:**
- `spotbook.css`: `--bg: #0e1116`
- `client/index.css`: `--bg: #0d0f17`
- Pick one value and use everywhere

### 1.2 Remove Inline Styles

Migrate 221+ `style="..."` attributes in templates to CSS classes.
Priority files:
- `restaurant_detail.eta` (12 inline styles)
- `owner_dashboard.eta` (18 inline styles)
- `owner_calendar.eta` (15 inline styles)

### 1.3 Naming Convention

Adopt BEM-like naming with `sb-` prefix:
```css
.sb-card {}
.sb-card__header {}
.sb-card__body {}
.sb-card--highlighted {}
.sb-btn {}
.sb-btn--primary {}
.sb-btn--ghost {}
.sb-btn--danger {}
```

---

## Phase 2: Component Library (Priority: HIGH)

### 2.1 Shared UI Components (Eta Templates)

Create reusable partials in `templates/components/`:

| Component | Description | Used In |
|-----------|-------------|---------|
| `_card.eta` | Standard card with header/body/footer | Dashboard, listings |
| `_btn.eta` | Button with variants (primary, ghost, danger, icon) | All pages |
| `_input.eta` | Form input with label, error state, RTL support | Auth, forms |
| `_modal.eta` | Modal dialog (replace inline JS modals) | Calendar, management |
| `_toast.eta` | Toast notification (server-side flash messages) | All pages |
| `_empty_state.eta` | Empty state with icon, message, CTA | Lists, search |
| `_loading.eta` | Loading skeleton / spinner | All async pages |
| `_badge.eta` | Status badges (open, closed, full, etc.) | Reservations, restaurants |

### 2.2 React Component Improvements

| Component | Change |
|-----------|--------|
| `FloorEditor.tsx` | Split into: `FloorToolbar`, `FloorCanvas`, `FloorSidebar`, `TableProperties` |
| All components | Use `useToast()` instead of `alert()` (partially done) |
| New: `ConfirmDialog` | Custom confirm dialog replacing `window.confirm()` (done) |
| New: `ErrorBoundary` | Global error boundary (done) |
| New: `LoadingSkeleton` | Animated skeleton placeholder for async loading |

---

## Phase 3: Empty States & Loading (Priority: MEDIUM)

### 3.1 Empty States

Every list/collection page needs an empty state with:
- Relevant illustration or icon
- Descriptive message in Hebrew + English
- Call-to-action button

Pages needing empty states:
- Owner dashboard (no restaurants yet)
- Restaurant search results (no matches)
- Calendar (no reservations for date)
- Shift board (no staff / no shifts)
- Reviews (no reviews yet)
- Inventory (no items)

### 3.2 Loading States

Replace all "Loading..." text with:
- **Skeleton screens** for content pages (dashboard, lists)
- **Inline spinners** for buttons during async operations
- **Progress bars** for file uploads (photos)
- **Optimistic updates** for status toggles (table status, reservation status)

### 3.3 Error States

- Inline error messages for form fields (not just top-of-form)
- Network error retry UI
- 404 page with search suggestion
- Session expired notification with re-login link

---

## Phase 4: Mobile & Responsive (Priority: MEDIUM)

### 4.1 Responsive Breakpoints

```css
--bp-mobile:  480px;
--bp-tablet:  768px;
--bp-desktop: 1024px;
--bp-wide:    1280px;
```

### 4.2 Mobile-First Pages

| Page | Current | Target |
|------|---------|--------|
| Homepage | Mostly responsive | Full responsive + touch carousel |
| Restaurant detail | Partially responsive | Stack layout, full-width booking form |
| Owner dashboard | Not responsive | Card grid → single column stack |
| Floor editor | Desktop only | Touch gestures, pinch-to-zoom |
| Calendar | Desktop only | Swipeable day view |
| POS waiter | Mostly responsive | Large touch targets (48px min) |

### 4.3 Touch Interactions

- Swipe to navigate between days (calendar, shifts)
- Pull-to-refresh for live views
- Long-press for context menus (table actions)
- Pinch-to-zoom on floor plan

---

## Phase 5: Accessibility (Priority: HIGH)

### 5.1 WCAG 2.1 AA Compliance

**Completed:**
- ErrorBoundary with recovery UI
- `aria-label` on App mode switches
- `aria-pressed` on toggle buttons
- Toast notifications with `role="alert"` and `aria-live`
- Confirm dialog with `aria-modal`

**Still needed:**
- [ ] Add `aria-label` to all icon-only buttons in FloorEditor
- [ ] Add `alt` text to all decorative images (or `role="presentation"`)
- [ ] Add `aria-describedby` to form inputs linking to error messages
- [ ] Keyboard navigation for drag-drop operations in floor editor
- [ ] Focus trap in all modal dialogs
- [ ] Skip-to-content link in main layout
- [ ] Color contrast audit (ensure 4.5:1 minimum)
- [ ] Screen reader testing with NVDA/VoiceOver

### 5.2 RTL Improvements

- [ ] Dynamic `dir` attribute based on language (not hardcoded)
- [ ] CSS logical properties (`margin-inline-start` instead of `margin-left`)
- [ ] Fix `direction: 'ltr'` overrides in FloorMapRenderer grid
- [ ] Test all forms in RTL mode
- [ ] Bidirectional text handling for mixed Hebrew/English content

---

## Phase 6: Visual Polish (Priority: LOW)

### 6.1 Animations & Transitions

- Page transitions (fade/slide between routes)
- Card hover effects (subtle lift + shadow)
- Loading skeleton shimmer animation
- Toast slide-in/slide-out
- Status change animations (color pulse)

### 6.2 Dark/Light Theme

Current: Dark theme only.
Future:
- Add light theme CSS variables
- Theme toggle in header
- Respect `prefers-color-scheme` media query
- Persist preference in cookie

### 6.3 Typography

- Use `Rubik` for Hebrew/RTL (already set)
- Add `Inter` or `DM Sans` for English/Latin
- Establish type scale: 12, 14, 16, 18, 20, 24, 32px
- Consistent line heights: 1.2 (headings), 1.5 (body)

### 6.4 Iconography

Current: Mix of emoji and no icons.
Target:
- Use a consistent icon set (Lucide, Phosphor, or Heroicons)
- Replace emoji in buttons with proper SVG icons
- Icon + text for primary actions, icon-only for secondary with tooltips

---

## Phase 7: Performance (Priority: MEDIUM)

### 7.1 Asset Optimization

- [ ] Lazy load images below the fold
- [ ] Use `srcset` for restaurant photos (multiple sizes)
- [ ] Code-split React app (floor editor vs shift scheduler)
- [ ] Minify public JS/CSS files
- [ ] Add `loading="lazy"` to all `<img>` tags

### 7.2 Caching

- [ ] Add cache headers to static assets
- [ ] Service worker for offline support (at least read-only)
- [ ] Cache API responses for restaurant data (5 min TTL)

---

## Implementation Priority

| Phase | Priority | Effort | Impact |
|-------|----------|--------|--------|
| 1. Design System Unification | HIGH | Medium | High - foundation for everything |
| 2. Component Library | HIGH | Large | High - reusability + consistency |
| 5. Accessibility | HIGH | Medium | High - legal compliance + UX |
| 3. Empty/Loading States | MEDIUM | Small | Medium - professional feel |
| 4. Mobile & Responsive | MEDIUM | Large | High - mobile users |
| 7. Performance | MEDIUM | Medium | Medium - user satisfaction |
| 6. Visual Polish | LOW | Large | Medium - delight factor |

---

## Quick Wins (Can do now)

1. Unify `--bg` color value across all CSS files
2. Add `skip-to-content` link to `_layout.eta`
3. Add `loading="lazy"` to all `<img>` in templates
4. Replace remaining `alert()` calls with Toast system
5. Add empty state partials for top 3 pages
6. Set `dir` attribute dynamically based on language cookie
