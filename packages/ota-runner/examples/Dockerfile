# Supply an inspected digest-pinned official Node image, matching flora.config.json.
# This template was not built in an environment without Docker.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG PNPM_VERSION=11.19.0
RUN test "$(node --version)" = "v24.19.0" \
 && npm install --global --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org npm@10.9.8 pnpm@${PNPM_VERSION} \
 && test "$(npm --version)" = "10.9.8"
# Optionally COPY an operator-prepared offline cache to /opt/flora/cache.
# No app checkout, publication token, GitHub token or Docker socket belongs here.
WORKDIR /workspace
