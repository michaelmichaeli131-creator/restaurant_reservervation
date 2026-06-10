/* SpotBook embeddable booking widget loader.
 * Usage on any restaurant website:
 *   <script src="https://YOUR_SPOTBOOK_DOMAIN/embed.js"
 *           data-spotbook="RESTAURANT_ID"
 *           data-lang="he" data-theme="light" async></script>
 * Or place a container anywhere: <div data-spotbook-widget="RESTAURANT_ID"></div>
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var origin = "";
  try {
    origin = new URL(script.src).origin;
  } catch (_e) {
    return;
  }

  function buildUrl(rid, opts) {
    var u = origin + "/widget/" + encodeURIComponent(rid);
    var params = [];
    if (opts.lang) params.push("lang=" + encodeURIComponent(opts.lang));
    if (opts.theme) params.push("theme=" + encodeURIComponent(opts.theme));
    return params.length ? u + "?" + params.join("&") : u;
  }

  function mount(container, rid, opts) {
    var iframe = document.createElement("iframe");
    iframe.src = buildUrl(rid, opts);
    iframe.title = "SpotBook reservation widget";
    iframe.style.cssText =
      "width:100%;max-width:420px;height:540px;border:0;border-radius:16px;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.12);display:block;";
    iframe.setAttribute("loading", "lazy");
    container.appendChild(iframe);

    // Let the widget grow if its content needs more height
    window.addEventListener("message", function (ev) {
      if (ev.origin !== origin) return;
      var d = ev.data || {};
      if (d.type === "spotbook:height" && ev.source === iframe.contentWindow) {
        var h = parseInt(d.height, 10);
        if (h > 200 && h < 2000) iframe.style.height = h + "px";
      }
    });
  }

  function init() {
    var opts = {
      lang: script.getAttribute("data-lang") || "",
      theme: script.getAttribute("data-theme") || "",
    };
    var rid = script.getAttribute("data-spotbook");
    var containers = document.querySelectorAll("[data-spotbook-widget]");
    if (containers.length) {
      containers.forEach(function (el) {
        mount(el, el.getAttribute("data-spotbook-widget") || rid, opts);
      });
    } else if (rid) {
      var holder = document.createElement("div");
      script.parentNode.insertBefore(holder, script);
      mount(holder, rid, opts);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
