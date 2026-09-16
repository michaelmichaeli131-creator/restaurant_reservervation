// SpotBook visual refinement v2.
// Runs after railway_design_patch.ts so the modernized overlay remains immutable.
const cssPath = "/app/public/css/spotbook.css";
const appPath = "/app/public/app.js";
const marker = "/* SpotBook Blue UX 2026 v2 */";

let css = await Deno.readTextFile(cssPath);

// Restore the original SpotBook blue identity and remove the champagne/gold
// treatment introduced by the first premium pass.
const replacements: Array<[string, string]> = [
  ["--sb-premium-gold:#f2c66d", "--sb-premium-gold:#3b82f6"],
  ["--sb-premium-gold-2:#ffe0a0", "--sb-premium-gold-2:#60a5fa"],
  ["rgba(242,198,109,", "rgba(59,130,246,"],
  ["rgba(255,224,160,", "rgba(96,165,250,"],
  ["#f7f1df", "#eaf2ff"],
  ["#f7efd9", "#eaf2ff"],
  ["#17120a", "#ffffff"],
];
for (const [from, to] of replacements) css = css.split(from).join(to);

const uxCss = `
${marker}
:root{
  --sb-premium-bg:#0b0f17;
  --sb-premium-surface:#111827;
  --sb-premium-surface-2:#172033;
  --sb-premium-text:#f8fafc;
  --sb-premium-muted:#a8b3c5;
  --sb-premium-gold:#3b82f6;
  --sb-premium-gold-2:#60a5fa;
  --sb-premium-blue:#3b82f6;
  --sb-blue-strong:#2563eb;
  --sb-blue-soft:rgba(59,130,246,.14);
  --sb-blue-line:rgba(96,165,250,.32);
  --sb-surface-glass:rgba(17,24,39,.72);
}

body.sb-body{
  background:
    radial-gradient(920px 560px at 6% -8%,rgba(59,130,246,.18),transparent 61%),
    radial-gradient(720px 480px at 94% 4%,rgba(37,99,235,.09),transparent 58%),
    linear-gradient(180deg,#0b0f17 0%,#0d1320 48%,#0b0f17 100%) !important;
}
::selection{background:rgba(59,130,246,.38);color:#fff}
:focus-visible{outline-color:#60a5fa !important}

/* Navigation: quieter, clearer, and more app-like. */
body.sb-body .sb-header{background:rgba(11,15,23,.76) !important;border-bottom-color:rgba(148,163,184,.12) !important}
body.sb-body .sb-header.is-scrolled{background:rgba(11,15,23,.94) !important;box-shadow:0 12px 34px rgba(0,0,0,.28)}
body.sb-body .sb-actions .btn.ghost{color:#dce5f3}
body.sb-body .sb-actions .btn.ghost:hover{background:rgba(59,130,246,.09) !important;border-color:rgba(96,165,250,.24) !important}
body.sb-body .lang-item.active{background:rgba(59,130,246,.13) !important;color:#93c5fd !important}

/* Primary actions use the original SpotBook blue, not gold. */
body.sb-body .btn.primary,
body.sb-body .sb-btn--primary,
body.sb-body a.btn[style*="background:var(--brand)"]{
  color:#fff !important;
  background:linear-gradient(135deg,#4f8df7 0%,#3b82f6 48%,#2563eb 100%) !important;
  border-color:rgba(147,197,253,.36) !important;
  box-shadow:0 10px 26px rgba(37,99,235,.28),inset 0 1px rgba(255,255,255,.20) !important;
}
body.sb-body .btn.primary:hover,
body.sb-body .sb-btn--primary:hover,
body.sb-body a.btn[style*="background:var(--brand)"]:hover{
  filter:brightness(1.07);
  box-shadow:0 14px 34px rgba(37,99,235,.36),inset 0 1px rgba(255,255,255,.24) !important;
}
body.sb-body .btn:active,body.sb-body .sb-btn:active{transform:translateY(0) scale(.975)}

/* Hero: more focused hierarchy and less visual noise. */
body.sb-body .home-hero-v3__frame{
  border-color:rgba(148,163,184,.14) !important;
  background:
    radial-gradient(circle at 10% 10%,rgba(59,130,246,.24),transparent 31%),
    radial-gradient(circle at 90% 6%,rgba(37,99,235,.11),transparent 34%),
    linear-gradient(145deg,rgba(18,27,45,.98),rgba(10,15,25,.99)) !important;
  box-shadow:0 32px 90px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.07) !important;
}
body.sb-body .home-hero-v3__title,
body.sb-body .owners-hero-title{
  background:linear-gradient(112deg,#ffffff 8%,#edf4ff 58%,#a9c8ff 100%) !important;
  -webkit-background-clip:text !important;background-clip:text !important;color:transparent !important;
}
body.sb-body .section-kicker,body.sb-body .owners-kicker{
  color:#93c5fd !important;background:rgba(59,130,246,.09) !important;
  border-color:rgba(96,165,250,.28) !important;
}

/* Search is the main conversion surface: larger target, stronger focus, clearer CTA. */
body.sb-body .home-search-shell{
  border-color:rgba(148,163,184,.16) !important;
  background:rgba(7,12,21,.78) !important;
  box-shadow:0 18px 50px rgba(0,0,0,.30),inset 0 1px rgba(255,255,255,.05) !important;
  transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease !important;
}
body.sb-body .home-search-shell:focus-within{
  border-color:rgba(96,165,250,.62) !important;
  box-shadow:0 20px 58px rgba(0,0,0,.34),0 0 0 4px rgba(59,130,246,.10) !important;
  transform:translateY(-1px);
}
body.sb-body .home-search-shell__icon{color:#60a5fa !important}
body.sb-body .home-search-shell input::placeholder{color:#8793a7 !important}
body.sb-body .home-search-ac{border-color:rgba(96,165,250,.20) !important;overflow:hidden}
body.sb-body .home-search-ac [role="option"]:hover,
body.sb-body .home-search-ac [aria-selected="true"]{background:rgba(59,130,246,.10) !important}

/* Chips and cards: consistent states, less decorative gold, more useful feedback. */
body.sb-body .chip.active{background:rgba(59,130,246,.14) !important;border-color:rgba(96,165,250,.40) !important;color:#bfdbfe !important}
body.sb-body .chip:focus-visible{box-shadow:0 0 0 4px rgba(59,130,246,.12)}
body.sb-body .home-stage-stat strong,body.sb-body .owners-command-stat strong,
body.sb-body .discovery-card__kicker{color:#7db2ff !important}
body.sb-body .home-stage-highlight__icon,body.sb-body .owners-outcome-card__icon{color:#7db2ff !important;background:rgba(59,130,246,.11) !important}
body.sb-body .discovery-card:hover,body.sb-body .owners-outcome-card:hover,
body.sb-body .owners-module-item:hover,body.sb-body .card:hover{
  border-color:rgba(96,165,250,.26) !important;
  box-shadow:0 24px 58px rgba(0,0,0,.30),0 0 0 1px rgba(59,130,246,.04) !important;
}
body.sb-body .restaurant-card,body.sb-body .featured-card{isolation:isolate}
body.sb-body .restaurant-card img,body.sb-body .featured-card img,body.sb-body .card-img{will-change:transform}

/* Forms: predictable touch targets and a strong accessible focus state. */
body.sb-body label{font-weight:650;color:#dbe4f2}
body.sb-body select,body.sb-body input:not([type="checkbox"]):not([type="radio"]),body.sb-body textarea{
  min-height:46px;background:rgba(8,13,23,.68);color:#f8fafc;
  border-color:rgba(148,163,184,.18) !important;
}
body.sb-body textarea{min-height:110px}
body.sb-body select:hover,body.sb-body input:not([type="checkbox"]):not([type="radio"]):hover,body.sb-body textarea:hover{border-color:rgba(148,163,184,.30) !important}
body.sb-body select:focus,body.sb-body input:not([type="checkbox"]):not([type="radio"]):focus,body.sb-body textarea:focus{
  border-color:rgba(96,165,250,.66) !important;box-shadow:0 0 0 4px rgba(59,130,246,.11) !important;
}
body.sb-body input::placeholder,body.sb-body textarea::placeholder{color:#7f8ba0;opacity:1}

/* Auth and owner surfaces feel like one product instead of separate tools. */
body.sb-body .sb-auth .card{border-color:rgba(96,165,250,.14) !important;background:linear-gradient(155deg,rgba(20,29,47,.94),rgba(11,16,27,.97)) !important}
body.sb-body .owner-shell,body.sb-body .owner-dashboard,body.sb-body .owner-card,body.sb-body .panel,body.sb-body .stat-card{--brand:#3b82f6}
body.sb-body .owner-card,body.sb-body .panel,body.sb-body .stat-card{border-color:rgba(148,163,184,.12) !important}
body.sb-body tbody tr:hover{background:rgba(59,130,246,.045)}
body.sb-body a:not(.btn):not(.brand):focus-visible{border-radius:6px}

/* Horizontal collections become intentional swipe surfaces on phones. */
body.sb-body .category-chips,body.sb-body .home-hero-v3__proofs{
  scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain;
}
body.sb-body .category-chips > *,body.sb-body .home-hero-v3__proofs > *{scroll-snap-align:start}

/* Loading state communicates progress without changing layout. */
body.sb-body button.is-loading,body.sb-body input.is-loading{position:relative;cursor:progress;opacity:.78;pointer-events:none}
body.sb-body button.is-loading::after{
  content:"";width:14px;height:14px;margin-inline-start:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;vertical-align:-2px;animation:sb-v2-spin .65s linear infinite;
}
@keyframes sb-v2-spin{to{transform:rotate(360deg)}}

/* Mobile polish: thumb-friendly, safe-area aware, and no cramped controls. */
@media (max-width:640px){
  body.sb-body .sb-container{padding-left:16px;padding-right:16px}
  body.sb-body .home-hero-v3{padding-top:10px !important}
  body.sb-body .home-hero-v3__frame{padding:24px 18px 22px !important;border-radius:24px !important}
  body.sb-body .home-hero-v3__title{font-size:clamp(2.2rem,11vw,3.25rem) !important;line-height:.98 !important}
  body.sb-body .home-search-shell{gap:6px !important;padding:7px !important}
  body.sb-body .home-search-shell__field{min-height:54px !important}
  body.sb-body .home-search-shell__btn{min-height:50px !important}
  body.sb-body .category-chips{margin-inline:-16px;padding-inline:16px !important;scroll-padding-inline:16px}
  body.sb-body .btn,body.sb-body .sb-btn,body.sb-body button{touch-action:manipulation}
  body.sb-body .sb-footer{padding-bottom:calc(28px + env(safe-area-inset-bottom))}
  body.sb-body table{font-size:.92rem}
}
@media (hover:none){
  body.sb-body .discovery-card:hover,body.sb-body .owners-outcome-card:hover,body.sb-body .owners-module-item:hover,body.sb-body .card:hover{transform:none !important}
  body.sb-body .btn:hover{transform:none}
}
@media (prefers-reduced-motion:reduce){@keyframes sb-v2-spin{to{transform:none}}}
`;

if (!css.includes(marker)) css += uxCss;
await Deno.writeTextFile(cssPath, css);

// Small progressive UX additions; no business logic is touched.
const jsMarker = "/* SpotBook Blue UX JS v2 */";
let app = await Deno.readTextFile(appPath);
if (!app.includes(jsMarker)) {
  app += `\n${jsMarker}\n(() => {\n  const run = () => {\n    // Prevent double submits while preserving forms that explicitly opt out.\n    document.querySelectorAll('form').forEach((form) => {\n      form.addEventListener('submit', () => {\n        if (form.dataset.allowDoubleSubmit === '1') return;\n        const submit = form.querySelector('button[type="submit"],input[type="submit"]');\n        if (!submit) return;\n        requestAnimationFrame(() => { submit.setAttribute('aria-disabled','true'); });\n      });\n    });\n\n    // Make horizontally scrollable chip rows keyboard accessible.\n    document.querySelectorAll('.category-chips,.home-hero-v3__proofs').forEach((row) => {\n      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex','0');\n      if (!row.hasAttribute('aria-label')) row.setAttribute('aria-label','Scrollable options');\n    });\n\n    // Give images stable browser-native loading behaviour without changing markup.\n    document.querySelectorAll('img:not([loading])').forEach((img, i) => {\n      if (i > 1) img.setAttribute('loading','lazy');\n      img.setAttribute('decoding','async');\n    });\n  };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once:true});\n  else run();\n})();\n`;
  await Deno.writeTextFile(appPath, app);
}

console.log("[design-v2] Restored SpotBook blue palette and applied UX refinement layer");
