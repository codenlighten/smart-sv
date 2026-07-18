# syntax=docker/dockerfile:1

##########  build stage  ##########
# Full toolchain so better-sqlite3's native addon compiles from source if no
# prebuilt binary matches the target platform.
FROM node:22-bookworm AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY bin ./bin
COPY index.js ./index.js

##########  runtime stage  ##########
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SMARTSV_DATADIR=/data \
    SMARTSV_RPC_HOST=0.0.0.0 \
    SMARTSV_RPC_PORT=8432 \
    SMARTSV_P2P_PORT=8433

WORKDIR /app

# Persistent chainstate lives here; owned by the unprivileged node user so a
# named volume inherits writable ownership.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/index.js ./index.js
COPY --chown=node:node package.json ./package.json

USER node
VOLUME ["/data"]
EXPOSE 8432 8433

# Liveness probe hits the unauthenticated /health endpoint via Node's fetch.
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SMARTSV_RPC_PORT||8432)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/smartsvd.js"]
