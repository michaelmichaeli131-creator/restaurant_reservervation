(() => {
  const ready = (fn) => document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", fn, { once: true })
    : fn();

  ready(() => {
    const body = document.body;
    const menu = document.getElementById("sbMobileMenu");
    const menuButton = document.querySelector(".sb-menu-button");
    const backdrop = document.querySelector(".sb-menu-backdrop");
    let previousFocus = null;

    const focusable = () => menu
      ? Array.from(menu.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      : [];

    function openMenu() {
      if (!menu || !menuButton || !backdrop) return;
      previousFocus = document.activeElement;
      body.classList.add("menu-open");
      menu.classList.add("open");
      menu.setAttribute("aria-hidden", "false");
      menuButton.setAttribute("aria-expanded", "true");
      backdrop.hidden = false;
      requestAnimationFrame(() => focusable()[0]?.focus());
    }

    function closeMenu() {
      if (!menu || !menuButton || !backdrop) return;
      body.classList.remove("menu-open");
      menu.classList.remove("open");
      menu.setAttribute("aria-hidden", "true");
      menuButton.setAttribute("aria-expanded", "false");
      backdrop.hidden = true;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }

    menuButton?.addEventListener("click", () => {
      if (menu?.classList.contains("open")) closeMenu();
      else openMenu();
    });
    document.querySelectorAll("[data-menu-close]").forEach((node) => node.addEventListener("click", closeMenu));
    menu?.addEventListener("click", (event) => {
      if (event.target.closest("a[href]")) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (!menu?.classList.contains("open")) return;
      if (event.key === "Escape") return closeMenu();
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const signup = document.getElementById("owner-signup");
    const planInput = signup?.querySelector('input[name="requestedPlan"]');
    const planName = signup?.querySelector("[data-selected-plan-name]");
    const validPlans = new Set(["free", "pro", "enterprise"]);
    const labels = {
      free: signup?.getAttribute("data-plan-free") || "Free",
      pro: signup?.getAttribute("data-plan-pro") || "Pro",
      enterprise: signup?.getAttribute("data-plan-enterprise") || "Business",
    };

    function selectPlan(plan, shouldScroll = false) {
      const selected = validPlans.has(plan) ? plan : "free";
      if (planInput) planInput.value = selected;
      if (planName) planName.textContent = labels[selected];
      document.querySelectorAll("[data-plan]").forEach((card) => {
        const active = card.getAttribute("data-plan") === selected;
        card.classList.toggle("is-selected", active);
        card.setAttribute("aria-selected", String(active));
      });
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("plan", selected);
        history.replaceState(null, "", `${url.pathname}${url.search}${shouldScroll ? "#owner-signup" : url.hash}`);
      } catch { /* URL state is a convenience only. */ }
      if (shouldScroll) signup?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }

    document.querySelectorAll("[data-plan]").forEach((card) => {
      const plan = card.getAttribute("data-plan") || "free";
      card.addEventListener("click", (event) => {
        if (!event.target.closest("a,button")) selectPlan(plan, true);
      });
      card.querySelectorAll("[data-select-plan]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          selectPlan(plan, true);
        });
      });
    });

    if (signup && planInput) {
      let initial = planInput.value || "free";
      try { initial = new URL(window.location.href).searchParams.get("plan") || initial; } catch { /* ignore */ }
      selectPlan(initial, false);
    }

    document.querySelectorAll("form").forEach((form) => {
      form.addEventListener("submit", () => {
        if (!form.checkValidity()) return;
        const submit = form.querySelector('button[type="submit"],input[type="submit"]');
        if (!submit || submit.dataset.noLoading === "1") return;
        submit.classList.add("is-loading");
        submit.setAttribute("aria-busy", "true");
      });
    });
  });
})();
