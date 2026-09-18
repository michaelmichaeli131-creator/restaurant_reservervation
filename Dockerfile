# SpotBook Railway source refresh — 2026-09-17
FROM node:22-bookworm-slim AS floor-build
WORKDIR /floor/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --ignore-scripts
COPY client/ ./
RUN npm run build

FROM denoland/deno:2.5.4

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends xz-utils ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# The archived overlay contains the verified production backend, but its public
# homepage shell predates the current SpotBook discovery UI. Preserve the
# current frontend shell before extraction, then restore it over the backend
# overlay so the cinematic v4 patch is applied to the template it was built for.
RUN mkdir -p /tmp/spotbook-ui/templates /tmp/spotbook-ui/public/css /tmp/spotbook-ui/public \
  && cp /app/templates/index.eta /tmp/spotbook-ui/templates/index.eta \
  && cp /app/templates/_layout.eta /tmp/spotbook-ui/templates/_layout.eta \
  && cp /app/public/css/spotbook.css /tmp/spotbook-ui/public/css/spotbook.css \
  && cp /app/public/app.js /tmp/spotbook-ui/public/app.js

# Reconstruct and apply the verified modernized SpotBook backend overlay.
RUN cat .deploy2/part* \
  | base64 -d \
  | xz -d \
  | tar -x -C /app \
  && rm -rf /app/.deploy /app/.deploy2 \
  && cp /tmp/spotbook-ui/templates/index.eta /app/templates/index.eta \
  && cp /tmp/spotbook-ui/templates/_layout.eta /app/templates/_layout.eta \
  && cp /tmp/spotbook-ui/public/css/spotbook.css /app/public/css/spotbook.css \
  && cp /tmp/spotbook-ui/public/app.js /app/public/app.js \
  && rm -rf /tmp/spotbook-ui \
  && mkdir -p /data \
  && chown -R deno:deno /app /data

# Keep production patch layers separate so Railway reports the exact failing
# layer instead of collapsing every patch into one opaque Docker build step.
RUN deno run --allow-env --allow-read --allow-write /app/railway_runtime_patch.ts
RUN deno run --allow-env --allow-read --allow-write /app/railway_privacy_patch.ts
RUN deno run --allow-read --allow-write /app/railway_design_patch.ts
RUN deno run --allow-read --allow-write /app/railway_design_v2_patch.ts
RUN cat /app/assets/patch/homepage-v4.part* > /tmp/railway_homepage_v4_patch.ts \
  && deno run --allow-read --allow-write /tmp/railway_homepage_v4_patch.ts \
  && rm -f /tmp/railway_homepage_v4_patch.ts

# Final design layer runs last so the homepage and every shared customer/owner
# surface use the same blue mobile-first visual system.
RUN deno run --allow-read --allow-write /app/railway_design_v3_patch.ts \
  && rm -rf /app/assets/hero /app/assets/patch \
  && rm -f /app/railway_runtime_patch.ts /app/railway_privacy_patch.ts /app/railway_design_patch.ts /app/railway_design_v2_patch.ts /app/railway_design_v3_patch.ts

# Approved page designs run after all legacy layers so the backend overlay cannot overwrite them.
RUN deno run --allow-env --allow-read --allow-write /app/railway_approved_design_patch.ts

# Final screenshot-alignment layer: quarter-hour selectors, fuller imagery, and
# page-specific workspace layout refinements.
RUN deno run --allow-env --allow-read --allow-write /app/railway_refinement_patch.ts

# Compile the authoritative editor source and restore it after the old overlay.
COPY --from=floor-build /floor/public/dist/ /app/public/dist/

# The base image keeps DENO_DIR at /deno-dir. Builds run as root up to this
# point, so make the cache writable before dropping privileges to the deno user.
RUN mkdir -p /deno-dir \
  && chown -R deno:deno /deno-dir /app

# Cache dependencies as the unprivileged runtime user.
USER deno
RUN deno cache --unstable-kv server.ts

ENV NODE_ENV=production \
    PORT=8000 \
    DENO_KV_PATH=/data/spotbook.db \
    COOKIE_SECURE=true

EXPOSE 8000

# Railway volumes are mounted at runtime, after image build. The mount may be
# root-owned even though /data was chowned during build, so fix ownership on
# every container start and then immediately drop privileges back to `deno`.
# R2_SMOKE_ON_BOOT is a one-shot operational check; it uploads, fetches, and
# deletes a tiny temporary PNG before the web server starts.
USER root
CMD ["sh", "-c", "chown -R deno:deno /data && if [ \"$R2_SMOKE_ON_BOOT\" = \"1\" ]; then gosu deno deno run --cached-only --allow-net --allow-env --allow-read --allow-sys --unstable-kv scripts/r2_smoke.ts || exit 1; fi && exec gosu deno deno run --cached-only --allow-net --allow-env --allow-read --allow-write=/data --allow-sys --unstable-kv server.ts"]
