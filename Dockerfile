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

# Railway terminates TLS at its proxy. Tell Oak to trust X-Forwarded-Proto so
# secure cookies can be emitted correctly on public HTTPS requests.
RUN sed -i 's/const app = new Application();/const app = new Application({ proxy: true });/' /app/server.ts \
  && grep -q 'new Application({ proxy: true })' /app/server.ts

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
