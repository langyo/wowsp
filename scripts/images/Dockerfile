# WoWSP build image. Produces the webui bundle; the Tauri desktop binary is
# normally built on the host (it needs platform toolchains for Windows/macOS
# packaging), but this image lets CI verify the frontend build in isolation.

FROM node:22-slim AS frontend

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages/webui/package.json packages/webui/package.json

RUN pnpm install --frozen-lockfile

COPY packages/webui packages/webui

RUN pnpm --filter @wowsp/webui build

FROM scratch

LABEL org.opencontainers.image.source="https://github.com/celestia-island/wowsp"
LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.title="WoWSP"
LABEL org.opencontainers.image.description="World of Warship Panel — replay review & in-game overlay (frontend bundle)"

# Output the built webui bundle as a single layer under /dist.
COPY --from=frontend /app/dist/webui /dist/webui
