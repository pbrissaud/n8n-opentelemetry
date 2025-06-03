ARG N8N_VERSION="latest"

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY tracing /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM docker.n8n.io/n8nio/n8n:$N8N_VERSION

USER root

# Create machine-id
# This fixes OTEL log error messages
RUN echo "Creating machine-id..." && \
    apk add dbus --no-cache && \
    dbus-uuidgen > /var/lib/dbus/machine-id


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