FROM denoland/deno:2.5.4

USER root
WORKDIR /app
COPY . /app
RUN mkdir -p /data && chown -R deno:deno /app /data

USER deno
RUN deno cache --unstable-kv server.ts

ENV NODE_ENV=production \
    PORT=8000 \
    COOKIE_SECURE=true

EXPOSE 8000
CMD ["run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "--allow-sys", "--unstable-kv", "server.ts"]
