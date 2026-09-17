FROM denoland/deno:2.5.4

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends xz-utils ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# Reconstruct and apply the verified modernized SpotBook overlay.
RUN cat .deploy2/part* \
  | base64 -d \
  | xz -d \
  | tar -x -C /app \
  && rm -rf /app/.deploy /app/.deploy2 \
  && mkdir -p /data \
  && chown -R deno:deno /app /data

# Apply Railway/TLS compatibility, privacy hardening, then the reproducible
# design layers after the overlay has replaced the source tree.
RUN deno run --allow-env --allow-read --allow-write /app/railway_runtime_patch.ts \
  && deno run --allow-env --allow-read --allow-write /app/railway_privacy_patch.ts \
  && deno run --allow-read --allow-write /app/railway_design_patch.ts \
  && deno run --allow-read --allow-write /app/railway_design_v2_patch.ts \
  && cat /app/assets/patch/homepage-v4.part* > /tmp/railway_homepage_v4_patch.ts \
  && deno run --allow-read --allow-write /tmp/railway_homepage_v4_patch.ts \
  && rm -f /tmp/railway_homepage_v4_patch.ts \
  && rm -rf /app/assets/hero /app/assets/patch \
  && rm -f /app/railway_runtime_patch.ts /app/railway_privacy_patch.ts /app/railway_design_patch.ts /app/railway_design_v2_patch.ts

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
