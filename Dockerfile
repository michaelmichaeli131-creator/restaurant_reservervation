FROM denoland/deno:2.5.4

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends xz-utils ca-certificates \
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

USER deno
RUN deno cache --unstable-kv server.ts

ENV NODE_ENV=production \
    PORT=8000 \
    DENO_KV_PATH=/data/spotbook.db \
    COOKIE_SECURE=true

EXPOSE 8000
CMD ["run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "--allow-sys", "--unstable-kv", "server.ts"]
