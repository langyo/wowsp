# wowsp-server — multi-stage build (contract docs/en/designs/cache-mesh.md §7:
# "VPS / LAN / Docker"). Stage 1 compiles on rust:1-bookworm (the relay
# workspace pins rust-version 1.85; rusqlite's bundled SQLite needs the
# C toolchain and libc-dev the image carries). Stage 2 is a minimal
# runtime — distroless cc-debian12:nonroot ships just glibc + libgcc
# and runs as non-root out of the box; the binary is statically linked
# against the bundled SQLite, so nothing else rides along. Bases are
# pinned (rust to the rolling 1-bookworm tag, distroless to a digest
# resolved from gcr.io) so image builds are reproducible.

FROM rust:1-bookworm AS build
WORKDIR /build

# Cache the dependency tree independently of the crate sources.
COPY Cargo.toml Cargo.lock* ./
COPY crates/relay-core ./crates/relay-core
COPY crates/relay-server ./crates/relay-server
COPY crates/relay-worker ./crates/relay-worker
RUN --mount=type=cache,target=/build/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release -p relay-server && \
    cp target/release/wowsp-server /wowsp-server

# Digest pinned to distroless/cc-debian12:nonroot (resolved from
# gcr.io; re-resolve deliberately when you want to ride a base update).
FROM gcr.io/distroless/cc-debian12@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
# State (SQLite db + node id) lives on the mounted volume.
VOLUME ["/data"]
ENV WOWSP_SERVER_DATA_DIR=/data
EXPOSE 8787
COPY --from=build /wowsp-server /wowsp-server
# distroless nonroot is uid 65532.
USER nonroot:nonroot
ENTRYPOINT ["/wowsp-server"]
