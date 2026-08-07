ARG N8N_VERSION="latest"

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY tracing/package.json tracing/pnpm-lock.yaml ./

# Install the pnpm version pinned by packageManager, via npm rather than
# get.pnpm.io: that installer always fetches latest (pnpm 11, which disagrees
# with our lockfile) and its standalone binary links against libatomic.so.1,
# which node:*-slim does not ship.
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" && \
    npm install -g "pnpm@${PNPM_VERSION}"

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# Pulled from GHCR (same image/digest as docker.n8n.io) because the n8n mirror
# rate-limits (429) the parallel matrix jobs when they resolve the manifest.
FROM ghcr.io/n8n-io/n8n:$N8N_VERSION

USER root

# Create machine-id
# This fixes OTEL log error messages
RUN mkdir -p /var/lib/dbus && \
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > /var/lib/dbus/machine-id

# Install OpenTelemetry dependencies required by tracing.js
RUN mkdir -p /opt/opentelemetry
WORKDIR /opt/opentelemetry
COPY --from=prod-deps /app/node_modules node_modules
COPY tracing/tracing.js .
RUN chown node:node ./*.js

# Create a symlink to n8n-core in the OpenTelemetry node_modules directory
# tracing.js patches n8n-core to trace workflow executions
RUN mkdir -p /opt/opentelemetry/node_modules/n8n-core
RUN ln -sf /usr/local/lib/node_modules/n8n/node_modules/n8n-core/* /opt/opentelemetry/node_modules/n8n-core/

# Switch to n8n's installation directory
WORKDIR /usr/local/lib/node_modules/n8n

# Copy entrypoint script
COPY entrypoint.sh entrypoint.sh
RUN echo "Setting entrypoint permissions..." && \
    chmod +x entrypoint.sh && \
    chown node:node entrypoint.sh

USER node

ENTRYPOINT ["tini", "--", "./entrypoint.sh"]
