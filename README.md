# n8n + OpenTelemetry

Custom Dockerfile to run n8n with OpenTelemetry tracing.

It's inspired by the work of [Stuart Johnson in the n8n community](https://community.n8n.io/t/n8n-successfully-instrumented-with-opentelemetry/78468) and @simple10 for the [LLemonStack stack](https://github.com/LLemonStack/llemonstack).

## Features 

- Tracing of n8n workflows and nodes executions
> [!WARNING]
> Subnode executions are not traced yet. Open to PRs if you want to add this feature.

- Logging of n8n workflows and nodes executions in console (not sent in otlp) with Winston

## Usage

To activate tracing, you need to set the following environment variables when running the container:

```bash
docker run -it --rm \
    -e OTEL_SERVICE_NAME="n8n" \
    -e OTEL_SDK_DISABLED="false" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" \
    -e OTEL_LOG_LEVEL="info"
    ghcr.io/pbrissaud/n8n-opentelemetry:latest
```

## Full stack

You can use the [compose.yaml](compose.yaml) file to run a full stack with n8n, alloy, loki, tempo and grafana.

```bash
docker compose -f compose.yaml up
```
    
    
