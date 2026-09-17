// SpotBook design system v3 — final blue-first responsive polish.
// Runs LAST, after the homepage v4 patch, so every customer-facing surface
// shares one visual language without changing business logic.
const cssOut = "/app/public/css/spotbook-v3.css";
const layouts = [
  "/app/templates/_layout.eta",
  "/app/templates/auth/_layout.eta",
];
const marker = "<!-- SpotBook design system v3 -->";

const css = String.raw`
/* SpotBook Design System v3 — blue, premium, mobile-first */
:root{
  --sb-v3-blue:#3b82f6;
  --sb-v3-blue-strong:#2563eb;
  --sb-v3-blue-bright:#60a5fa;
  --sb-v3-blue-pale:#bfdbfe;
  --sb-v3-bg:#07101d;
  --sb-v3-bg-2:#0a1423;
  --sb-v3-surface:#101b2d;
  --sb-v3-surface-2:#142238;
  --sb-v3-line:rgba(148,163,184,.14);
  --sb-v3-line-blue:rgba(96,165,250,.28);
  --sb-v3-text:#f8fbff;
  --sb-v3-muted:#a9b7cb;
  --sb-v3-shadow:0 22px 64px rgba(0,0,0,.28);
  --sb-v3-shadow-blue:0 14px 34px rgba(37,99,235,.28);
  --sb-v3-radius:20px;
  --sb-v3-radius-lg:28px;
  --sb-premium-gold:#3b82f6 !important;
  --sb-premium-gold-2:#60a5fa !important;
  --brand:#3b82f6;
  --brand-2:#2563eb;
}

html{background:var(--sb-v3-bg);-webkit-text-size-adjust:100%}
body.sb-body{
  color:var(--sb-v3-text) !important;
  background:
    radial-gradient(900px 520px at 4% -6%,rgba(59,130,246,.16),transparent 62%),
    radial-gradient(760px 500px at 96% 3%,rgba(37,99,235,.09),transparent 58%),
    linear-gradient(180deg,#07101d 0%,#0a1423 48%,#07101d 100%) !important;
  min-height:100svh;
}
body.sb-body::before{opacity:.24 !important}
body.sb-body main{min-width:0}
body.sb-body .sb-container{width:min(100% - 36px,1240px);margin-inline:auto}
body.sb-body .sb-container main,body.sb-body main.sb-container{min-width:0}
::selection{background:rgba(59,130,246,.38) !important;color:#fff !important}
:focus-visible{outline:3px solid rgba(96,165,250,.9) !important;outline-offset:3px !important}

/* No champagne/gold accents: every interactive emphasis is SpotBook blue. */
body.sb-body .section-kicker,body.sb-body .owners-kicker,
body.sb-body .discovery-card__kicker,body.sb-body .home-stage-stat strong,
body.sb-body .owners-command-stat strong,body.sb-body .text-brand,
body.sb-body [style*="color:var(--sb-premium-gold"]{color:var(--sb-v3-blue-bright) !important}
body.sb-body .section-kicker,body.sb-body .owners-kicker{
  background:rgba(59,130,246,.10) !important;
  border-color:rgba(96,165,250,.27) !important;
}
body.sb-body .chip.active,body.sb-body .lang-item.active{
  color:var(--sb-v3-blue-pale) !important;
  background:rgba(59,130,246,.13) !important;
  border-color:rgba(96,165,250,.34) !important;
}

/* Header — compact glass navigation on every page. */
body.sb-body .sb-header{
  background:rgba(7,16,29,.80) !important;
  border-bottom:1px solid rgba(148,163,184,.11) !important;
  backdrop-filter:blur(22px) saturate(145%) !important;
  -webkit-backdrop-filter:blur(22px) saturate(145%) !important;
}
body.sb-body .sb-header.is-scrolled{background:rgba(7,16,29,.95) !important;box-shadow:0 12px 36px rgba(0,0,0,.24) !important}
body.sb-body .sb-header-row{min-height:64px}
body.sb-body .brand-logo{filter:drop-shadow(0 5px 16px rgba(0,0,0,.24))}
body.sb-body .lang-btn{border-color:rgba(148,163,184,.16) !important;background:rgba(255,255,255,.045) !important}
body.sb-body .lang-btn:hover{border-color:rgba(96,165,250,.32) !important;background:rgba(59,130,246,.09) !important}
body.sb-body .lang-menu{background:rgba(10,20,35,.98) !important;border-color:rgba(96,165,250,.18) !important}

/* Buttons — one unmistakable primary action. */
body.sb-body .btn,body.sb-body .sb-btn,body.sb-body button{
  -webkit-tap-highlight-color:transparent;
}
body.sb-body .btn.primary,body.sb-body .sb-btn--primary,
body.sb-body button.primary,body.sb-body a.btn[style*="background:var(--brand)"]{
  color:#fff !important;
  background:linear-gradient(135deg,#4f8df7 0%,#3b82f6 48%,#2563eb 100%) !important;
  border-color:rgba(147,197,253,.35) !important;
  box-shadow:var(--sb-v3-shadow-blue),inset 0 1px rgba(255,255,255,.18) !important;
}
body.sb-body .btn.primary:hover,body.sb-body .sb-btn--primary:hover,
body.sb-body button.primary:hover{filter:brightness(1.07);box-shadow:0 18px 42px rgba(37,99,235,.34) !important}
body.sb-body .btn.ghost,body.sb-body .sb-btn--ghost{
  background:rgba(255,255,255,.035) !important;border-color:rgba(148,163,184,.16) !important;color:#e6eef9 !important;
}
body.sb-body .btn.ghost:hover,body.sb-body .sb-btn--ghost:hover{background:rgba(59,130,246,.08) !important;border-color:rgba(96,165,250,.28) !important}

/* Shared surfaces — restaurant cards, reservation flows, owner tools, auth. */
body.sb-body .card,body.sb-body .panel,body.sb-body .stat-card,
body.sb-body .owner-card,body.sb-body .owners-outcome-card,
body.sb-body .owners-module-item,body.sb-body .results-filter-bar,
body.sb-body .restaurant-card,body.sb-body .featured-card{
  border-color:var(--sb-v3-line) !important;
  box-shadow:0 14px 42px rgba(0,0,0,.18) !important;
}
body.sb-body .card,body.sb-body .panel,body.sb-body .stat-card,body.sb-body .owner-card{
  background:linear-gradient(155deg,rgba(17,29,48,.94),rgba(9,18,32,.96)) !important;
  border-radius:var(--sb-v3-radius) !important;
}
body.sb-body .card:hover,body.sb-body .owner-card:hover,
body.sb-body .restaurant-card:hover,body.sb-body .featured-card:hover{
  border-color:rgba(96,165,250,.24) !important;
  box-shadow:0 22px 58px rgba(0,0,0,.25),0 0 0 1px rgba(59,130,246,.035) !important;
}
body.sb-body hr{border-color:rgba(148,163,184,.12) !important}
body.sb-body a:not(.btn):not(.brand){text-underline-offset:3px}
body.sb-body a:not(.btn):not(.brand):hover{color:#93c5fd}

/* Forms — large touch targets, calm hierarchy, iOS-safe 16px text. */
body.sb-body label{color:#dce6f4;font-weight:650}
body.sb-body input:not([type="checkbox"]):not([type="radio"]),
body.sb-body select,body.sb-body textarea{
  min-height:48px !important;
  font-size:max(16px,1em) !important;
  color:#f8fbff !important;
  background:rgba(7,15,27,.72) !important;
  border:1px solid rgba(148,163,184,.18) !important;
  border-radius:13px !important;
}
body.sb-body textarea{min-height:116px !important}
body.sb-body input::placeholder,body.sb-body textarea::placeholder{color:#7f90a8 !important;opacity:1}
body.sb-body input:focus,body.sb-body select:focus,body.sb-body textarea:focus{
  border-color:rgba(96,165,250,.68) !important;
  box-shadow:0 0 0 4px rgba(59,130,246,.11) !important;
  outline:none !important;
}
body.sb-body select option{background:#0d192a;color:#fff}

/* Tables stay usable on narrow screens instead of crushing columns. */
body.sb-body .table-wrap,body.sb-body .table-responsive,
body.sb-body .owner-table-wrap,body.sb-body .sb-table-wrap{
  overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain;
  border-radius:16px;
}
body.sb-body table{border-collapse:separate;border-spacing:0}
body.sb-body thead th{color:#c9d6e7;background:rgba(7,15,27,.58)}
body.sb-body tbody tr:hover{background:rgba(59,130,246,.05) !important}

/* Homepage — preserve the cinematic photo, but make the blue system cleaner. */
body.sb-body:has(.sb-home-v4){background:#07101d !important}
body.sb-body:has(.sb-home-v4) .sb-home-hero__title strong{
  background:linear-gradient(108deg,#9bc4ff 0%,#60a5fa 42%,#3b82f6 72%,#2563eb 100%) !important;
  -webkit-background-clip:text !important;background-clip:text !important;color:transparent !important;
}
body.sb-body:has(.sb-home-v4) .sb-home-search{
  border-color:rgba(147,197,253,.20) !important;
  background:linear-gradient(135deg,rgba(8,20,39,.90),rgba(12,25,45,.78)) !important;
  box-shadow:0 26px 72px rgba(0,0,0,.38),0 0 0 1px rgba(59,130,246,.035),inset 0 1px rgba(255,255,255,.08) !important;
}
body.sb-body:has(.sb-home-v4) .sb-home-search:focus-within{border-color:rgba(96,165,250,.46) !important;box-shadow:0 28px 78px rgba(0,0,0,.40),0 0 0 4px rgba(59,130,246,.08) !important}
body.sb-body:has(.sb-home-v4) .sb-home-search__submit{
  background:linear-gradient(135deg,#4f8df7,#3b82f6 50%,#2563eb) !important;
  box-shadow:0 14px 34px rgba(37,99,235,.34) !important;
}
body.sb-body:has(.sb-home-v4) .sb-home-trust__icon{background:rgba(59,130,246,.16) !important;border-color:rgba(96,165,250,.24) !important;color:#dbeafe !important}
body.sb-body:has(.sb-home-v4) .featured-card{background:#0e1a2b !important}

/* Auth — focused, premium single-column experience. */
body.sb-body .sb-auth,body.sb-body .auth-shell{width:min(100%,520px);margin-inline:auto}
body.sb-body .sb-auth .card,body.sb-body .auth-card{
  border:1px solid rgba(96,165,250,.16) !important;
  background:linear-gradient(155deg,rgba(18,31,51,.97),rgba(8,17,30,.98)) !important;
  box-shadow:0 28px 80px rgba(0,0,0,.30) !important;
  border-radius:26px !important;
}

/* Owner/business pages — same blue product, denser but still touch friendly. */
body.sb-body .owner-shell,body.sb-body .owner-dashboard{--brand:#3b82f6 !important;--accent:#3b82f6 !important}
body.sb-body .owner-tabs,body.sb-body .tabs{scrollbar-width:none;-webkit-overflow-scrolling:touch}
body.sb-body .owner-tabs::-webkit-scrollbar,body.sb-body .tabs::-webkit-scrollbar{display:none}
body.sb-body .owner-tabs a.active,body.sb-body .tabs a.active{color:#dbeafe !important;border-color:#3b82f6 !important;background:rgba(59,130,246,.10) !important}

/* Reservation/restaurant details: media and actions feel like native cards. */
body.sb-body .restaurant-card img,body.sb-body .featured-card img,
body.sb-body .restaurant-gallery img,body.sb-body .card-img{object-fit:cover}
body.sb-body .restaurant-card,body.sb-body .featured-card{overflow:hidden;border-radius:22px !important}
body.sb-body .restaurant-card img,body.sb-body .featured-card img{transition:transform .45s cubic-bezier(.2,.8,.2,1),filter .3s ease}
@media (hover:hover){body.sb-body .restaurant-card:hover img,body.sb-body .featured-card:hover img{transform:scale(1.025);filter:saturate(1.05)}}

/* Mobile is the primary layout, not a compressed desktop page. */
@media (max-width:700px){
  body.sb-body{background:linear-gradient(180deg,#07101d,#0a1423 54%,#07101d) !important}
  body.sb-body .sb-container{width:100%;padding-inline:16px !important}
  body.sb-body main.sb-container{padding-top:18px !important;padding-bottom:24px !important}
  body.sb-body .section{margin-top:38px !important}
  body.sb-body .section-title{font-size:clamp(1.75rem,8.5vw,2.35rem) !important;line-height:1.04 !important}
  body.sb-body h1{font-size:clamp(2rem,9vw,2.75rem);line-height:1.02}
  body.sb-body h2{line-height:1.08}

  body.sb-body .sb-header{padding:calc(env(safe-area-inset-top,0px) + 5px) 10px 5px !important}
  body.sb-body .sb-header-row{min-height:54px !important;padding:0 !important;gap:8px !important;flex-wrap:nowrap !important}
  body.sb-body .brand{min-width:0 !important;max-width:132px}
  body.sb-body .brand-logo{max-width:128px;max-height:38px !important}
  body.sb-body .sb-actions{width:auto !important;margin-inline-start:auto !important;gap:5px !important;flex-wrap:nowrap !important}
  body.sb-body .sb-actions .btn{min-height:40px !important;padding:8px 11px !important;border-radius:12px !important;font-size:.82rem !important;white-space:nowrap}
  body.sb-body .lang-btn{width:40px !important;height:40px !important}
  body.sb-body .lang-switch{margin-inline-start:0 !important}

  body.sb-body .card,body.sb-body .panel,body.sb-body .owner-card,body.sb-body .stat-card{
    border-radius:18px !important;
    box-shadow:0 12px 34px rgba(0,0,0,.17) !important;
  }
  body.sb-body .grid,body.sb-body .cards-grid,body.sb-body .owner-grid,
  body.sb-body .stats-grid{gap:12px !important}
  body.sb-body .btn,body.sb-body .sb-btn,body.sb-body button[type="submit"]{min-height:46px}
  body.sb-body form .btn.primary,body.sb-body form button[type="submit"]{width:100%;justify-content:center}
  body.sb-body input:not([type="checkbox"]):not([type="radio"]),body.sb-body select{min-height:50px !important}

  body.sb-body .owner-tabs,body.sb-body .tabs,body.sb-body .category-chips{
    display:flex !important;overflow-x:auto !important;flex-wrap:nowrap !important;
    margin-inline:-16px !important;padding-inline:16px !important;padding-bottom:5px;
    scroll-snap-type:x proximity;scroll-padding-inline:16px;overscroll-behavior-inline:contain;
  }
  body.sb-body .owner-tabs > *,body.sb-body .tabs > *,body.sb-body .category-chips > *{flex:0 0 auto;scroll-snap-align:start}
  body.sb-body table{min-width:640px;font-size:.88rem}
  body.sb-body .sb-footer{margin-top:38px !important;padding:22px 16px calc(24px + env(safe-area-inset-bottom)) !important}

  /* Mobile homepage: image first, text readable, search card comfortably tappable. */
  body.sb-body:has(.sb-home-v4) .sb-header{position:absolute !important;background:linear-gradient(180deg,rgba(2,8,18,.72),rgba(2,8,18,0)) !important;border:0 !important}
  body.sb-body:has(.sb-home-v4) main.sb-container{padding:0 !important}
  .sb-home-hero{min-height:100svh !important;align-items:flex-end !important;background-position:62% center !important}
  .sb-home-hero__shade{background:linear-gradient(180deg,rgba(2,8,18,.28) 0%,rgba(2,8,18,.42) 28%,rgba(2,8,18,.80) 56%,#07101d 86%,#07101d 100%) !important}
  .sb-home-hero__content{padding:96px 16px calc(24px + env(safe-area-inset-bottom)) !important}
  .sb-home-hero__copy{max-width:100% !important}
  .sb-home-hero__kicker{font-size:.61rem !important;letter-spacing:.20em !important;margin-bottom:10px !important;color:#dbeafe !important}
  .sb-home-hero__title{font-size:clamp(2.75rem,14vw,4.1rem) !important;line-height:.90 !important;letter-spacing:-.055em !important;max-width:9.8ch !important}
  html[dir="rtl"] .sb-home-hero__title{font-size:clamp(2.65rem,13vw,3.85rem) !important;max-width:11ch !important;letter-spacing:-.035em !important}
  .sb-home-hero__sub{font-size:.98rem !important;line-height:1.46 !important;margin-top:14px !important;max-width:34ch !important;color:#dce6f4 !important}
  .sb-home-search-wrap{margin-top:20px !important}
  .sb-home-search{padding:6px !important;border-radius:18px !important;gap:0 !important;background:rgba(7,17,31,.88) !important;backdrop-filter:blur(18px) saturate(135%) !important;-webkit-backdrop-filter:blur(18px) saturate(135%) !important}
  .sb-home-search__segment{min-height:58px !important;padding:7px 11px !important;gap:9px !important}
  .sb-home-search__icon{width:30px !important;height:30px !important;flex-basis:30px !important;font-size:1.08rem !important;color:#93c5fd !important}
  .sb-home-search__label{font-size:.74rem !important}
  .sb-home-search input,.sb-home-search select{font-size:16px !important;min-height:26px !important}
  .sb-home-search__submit{min-height:52px !important;margin-top:5px !important;border-radius:13px !important;font-size:.96rem !important}
  .sb-home-reservation-link{display:block !important;text-align:center !important;margin-top:10px !important;font-size:.80rem !important;color:#bfdbfe !important}
  .sb-home-trust{display:flex !important;overflow-x:auto !important;gap:9px !important;margin:18px -16px 0 !important;padding:2px 16px 8px !important;scroll-snap-type:x proximity;scrollbar-width:none}
  .sb-home-trust::-webkit-scrollbar{display:none}
  .sb-home-trust__item{flex:0 0 178px !important;min-height:66px;padding:10px !important;border:1px solid rgba(96,165,250,.14);border-radius:15px;background:rgba(12,26,46,.58);scroll-snap-align:start}
  .sb-home-trust__icon{width:34px !important;height:34px !important;flex-basis:34px !important}
  .sb-home-trust strong{font-size:.72rem !important}
  .sb-home-trust small{font-size:.64rem !important;display:block !important}
  .sb-home-explore{display:none !important}
  body.sb-body:has(.sb-home-v4) .home-featured-v3{padding:32px 0 18px !important}
  body.sb-body:has(.sb-home-v4) .home-featured-v3__head{padding-inline:16px}
  body.sb-body:has(.sb-home-v4) .featured-card{border-radius:18px !important}
  body.sb-body:has(.sb-home-v4) .featured-card__image{min-height:230px !important}
}

@media (max-width:390px){
  body.sb-body .sb-container{padding-inline:14px !important}
  body.sb-body .sb-actions .btn{padding-inline:9px !important;font-size:.78rem !important}
  .sb-home-hero__content{padding-inline:14px !important}
  .sb-home-hero__title{font-size:clamp(2.6rem,13.5vw,3.5rem) !important}
  .sb-home-trust{margin-inline:-14px !important;padding-inline:14px !important}
}

@media (hover:none){
  body.sb-body .card:hover,body.sb-body .owner-card:hover,body.sb-body .restaurant-card:hover,body.sb-body .featured-card:hover{transform:none !important}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto !important;transition-duration:.01ms !important;animation-duration:.01ms !important;animation-iteration-count:1 !important}
}

/* Homepage photo visibility fix — keep the restaurant scene readable behind the search card. */
body.sb-body:has(.sb-home-v4) .sb-home-search{
  background:linear-gradient(180deg,rgba(7,17,31,.66),rgba(7,17,31,.48)) !important;
  border-color:rgba(147,197,253,.24) !important;
  box-shadow:0 20px 52px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.10) !important;
  backdrop-filter:blur(8px) saturate(125%) !important;
  -webkit-backdrop-filter:blur(8px) saturate(125%) !important;
}
body.sb-body:has(.sb-home-v4) .sb-home-search__segment{
  background:rgba(4,12,26,.12) !important;
  border-color:rgba(255,255,255,.13) !important;
}
@media (max-width:560px){
  body.sb-body:has(.sb-home-v4) .sb-home-hero{
    background-position:62% calc(36% - clamp(210px,27vh,300px)) !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-hero__shade{
    background:
      linear-gradient(180deg,rgba(2,8,18,.20) 0%,rgba(2,8,18,.30) 34%,rgba(2,8,18,.62) 66%,rgba(7,16,29,.92) 86%,#07101d 100%) !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search-wrap{
    margin-top:16px !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search{
    display:grid !important;
    grid-template-columns:repeat(2,minmax(0,1fr)) !important;
    gap:0 !important;
    padding:5px !important;
    border-radius:17px !important;
    background:rgba(7,17,31,.58) !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__segment{
    min-height:52px !important;
    padding:5px 8px !important;
    gap:7px !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__segment--query{
    grid-column:1/-1 !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__segment:nth-of-type(2),
  body.sb-body:has(.sb-home-v4) .sb-home-search__segment:nth-of-type(3){
    border-bottom:0 !important;
    border-inline-end:0 !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__icon{
    width:25px !important;
    height:25px !important;
    flex-basis:25px !important;
    font-size:.95rem !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__label{
    font-size:.68rem !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search input,
  body.sb-body:has(.sb-home-v4) .sb-home-search select{
    font-size:15px !important;
    min-height:24px !important;
  }
  body.sb-body:has(.sb-home-v4) .sb-home-search__submit{
    grid-column:1/-1 !important;
    min-height:48px !important;
    margin-top:4px !important;
    border-radius:12px !important;
    font-size:.92rem !important;
  }
}

`;

await Deno.writeTextFile(cssOut, css);

for (const path of layouts) {
  try {
    let html = await Deno.readTextFile(path);
    if (html.includes(marker)) continue;
    const link = `${marker}\n  <link rel="stylesheet" href="/public/css/spotbook-v3.css?v=<%= it.BUILD_TAG || Date.now() %>"/>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", `  ${link}\n</head>`);
      await Deno.writeTextFile(path, html);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

console.log("[design-v3] Applied final blue design system and mobile-first polish across SpotBook");
