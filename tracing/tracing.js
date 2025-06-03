'use strict'

const opentelemetry = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
const {
  getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  ATTR_SERVICE_NAME,
} = require('@opentelemetry/semantic-conventions')
const winston = require('winston')
const {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} = require('@opentelemetry/api')
const { flatten } = require('flat') // flattens objects into a single level
const { envDetector, hostDetector, processDetector } = require('@opentelemetry/resources')
const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston')

const LOGPREFIX = '[Tracing]'
const LOG_LEVEL = getEnv('OTEL_LOG_LEVEL', 'info')
// Process all OTEL_* environment variables to strip quotes.
// Fixes issues with quotes in Docker env vars breaking the OTLP exporter.
processOtelEnvironmentVariables()

console.log(`${LOGPREFIX}: Starting n8n OpenTelemetry instrumentation`)

// Configure OpenTelemetry
// Turn off auto-instrumentation for dns, net, tls, fs, pg
const autoInstrumentations = getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-dns': { enabled: false },
  '@opentelemetry/instrumentation-net': { enabled: false },
  '@opentelemetry/instrumentation-tls': { enabled: false },
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-pg': {
    enabled: false,
  },
  // Enable enhancedDatabaseReporting for pg
  // '@opentelemetry/instrumentation-pg': {
  //   enhancedDatabaseReporting: true,
  // },
})


registerInstrumentations({
  instrumentations: [autoInstrumentations, new WinstonInstrumentation()],
})

// Setup n8n telemetry
console.log(`${LOGPREFIX}: Setting up n8n telemetry`)
setupN8nOpenTelemetry()

// Configure Winston logger to log to console
console.log(`${LOGPREFIX}: Configuring Winston logger with level: ${LOG_LEVEL}`)
const logger = setupWinstonLogger(LOG_LEVEL)

// Configure and start the OpenTelemetry SDK
console.log(
  `${LOGPREFIX}: Configuring OpenTelemetry SDK with log level: ${LOG_LEVEL}`,
)
const sdk = setupOpenTelemetryNodeSDK()

sdk.start()

////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Get environment variable without surrounding quotes
 */
function getEnv(key, defaultValue = '', required = true) {
  const value = process.env[key] ?? defaultValue
  if (!value && required) {
    throw new Error(`Required environment variable ${key} is not set`)
  }
  return value ? value.replace(/^['"]|['"]$/g, '') : defaultValue
}

/**
 * Process all OTEL_* environment variables to strip quotes
 *
 * This ensures that all OpenTelemetry environment variables are properly
 * formatted without surrounding quotes that might cause configuration issues.
 */
function processOtelEnvironmentVariables() {
  console.log(`${LOGPREFIX}: Processing OTEL environment variables`)
  const envVars = process.env
  for (const key in envVars) {
    if (key.startsWith('OTEL_')) {
      try {
        // Get the value without quotes
        const cleanValue = getEnv(key, undefined, false)
        process.env[key] = cleanValue
      } catch (error) {
        console.warn(`${LOGPREFIX}: Error processing ${key}: ${error.message}`)
      }
    }
  }
}

function awaitAttributes(detector) {
  return {
    async detect(config) {
      const resource = detector.detect(config)
      await resource.waitForAsyncAttributes?.()
      return resource
    },
  }
}

/**
 * Configure and start the OpenTelemetry SDK
 */
function setupOpenTelemetryNodeSDK() {
  const sdk = new opentelemetry.NodeSDK({
    logRecordProcessors: [
      new opentelemetry.logs.SimpleLogRecordProcessor(
        new OTLPLogExporter(),
      ),
    ],
    // Fix for https://github.com/open-telemetry/opentelemetry-js/issues/4638
    // This may be deprecated in the future.
    resourceDetectors: [
      awaitAttributes(envDetector),
      awaitAttributes(processDetector),
      awaitAttributes(hostDetector),
    ],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: getEnv('OTEL_SERVICE_NAME', 'n8n'),
    }),
    traceExporter: new OTLPTraceExporter(),
  })
  return sdk
}

/**
 * Configure the Winston logger
 *
 * - Logs errors to the console
 */
function setupWinstonLogger(logLevel = 'info') {
  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  })

  return logger
}

/**
 * Patches n8n workflow and node execution to wrap the entire run in a workflow-level span.
 *
 * - Span name: "n8n.workflow.execute"
 * - Attributes prefixed with "n8n." to follow semantic conventions.
 */
function setupN8nOpenTelemetry() {
  // Setup n8n workflow execution tracing
  const tracer = trace.getTracer('n8n-instrumentation', '1.0.0')

  try {
    // Import n8n core modules
    const { WorkflowExecute } = require('n8n-core')

    /**
     * Patch the workflow execution
     *
     * Wrap the entire run in a workflow-level span and capture workflow details as attributes.
     *
     * - Span name: "n8n.workflow.execute"
     * - Attributes prefixed with "n8n." to follow semantic conventions.
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData
    /** @param {import('n8n-workflow').Workflow} workflow */
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {}
      const workflowId = wfData?.id ?? ''
      const workflowName = wfData?.name ?? ''

      const workflowAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        ...flatten(wfData?.settings ?? {}, {
          delimiter: '.',
          transformKey: (key) => `n8n.workflow.settings.${key}`,
        }),
      }
      const span = tracer.startSpan('n8n.workflow.execute', {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL,
      })
      logger.info(`Workflow started`, {workflowAttributes, spanContext: span.spanContext()})

      // Set the span as active
      const activeContext = trace.setSpan(context.active(), span)
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments)
        cancelable
          .then(
            (result) => {
              if (result?.data?.resultData?.error) {
                const err = result.data.resultData.error
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(err.message || err),
                })
                logger.error(`Workflow failed`, {workflowAttributes, spanContext: span.spanContext()})
              }
              span.setStatus({
                code: SpanStatusCode.OK,
              })
              logger.info(`Workflow finished`, {workflowAttributes, spanContext: span.spanContext()})
            },
            (error) => {
              span.recordException(error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error.message || error),
              })
              logger.error(`Workflow failed`, {workflowAttributes, spanContext: span.spanContext()})
            },
          )
          .finally(() => {
            span.end()
          })
        return cancelable
      })
    }

    /**
     * Patch the n8n node execution
     *
     * Wrap each node's run in a child span and capture node details as attributes.
     * - Span name: "n8n.node.execute"
     */
    const originalRunNode = WorkflowExecute.prototype.runNode
    /**
     * @param {import('n8n-workflow').Workflow} workflow
     * @param {import('n8n-workflow').IExecuteData} executionData
     * @param {import('n8n-workflow').IRunExecutionData} runExecutionData
     * @param {number} runIndex
     * @param {import('n8n-workflow').IWorkflowExecuteAdditionalData} additionalData
     * @param {import('n8n-workflow').WorkflowExecuteMode} mode
     * @param {AbortSignal} [abortSignal]
     * @returns {Promise<import('n8n-workflow').IRunNodeResponse>}
     */
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal,
    ) {
      // Safeguard against undefined this context
      if (!this) {
        console.warn('WorkflowExecute context is undefined')
        return originalRunNode.apply(this, arguments)
      }

      const node = executionData?.node ?? 'unknown'

      const executionId = additionalData?.executionId ?? 'unknown'
      const userId = additionalData?.userId ?? 'unknown'
      const nodeAttributes = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
        'n8n.user.id': userId,
      }

      // Flatten the n8n node object into a single level of attributes
      const flattenedNode = flatten(node ?? {}, { delimiter: '.' })
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          nodeAttributes[`n8n.node.${key}`] = value
        } else {
          nodeAttributes[`n8n.node.${key}`] = JSON.stringify(value)
        }
      }

      return tracer.startActiveSpan(
        `n8n.node.execute`,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          logger.info('Starting node execution', { nodeAttributes, spanContext: nodeSpan.spanContext() })
          try {
            const result = await originalRunNode.apply(this, [
              workflow,
              executionData,
              runExecutionData,
              runIndex,
              additionalData,
              mode,
              abortSignal,
            ])
            try {
              const outputData = result?.data?.[runIndex]
              const finalJson = outputData?.map((item) => item.json)
              nodeSpan.setAttribute(
                'n8n.node.output_json',
                JSON.stringify(finalJson),
              )
            } catch (error) {
              console.warn('Failed to set node output attributes: ', error)
            } finally {
              logger.info('Node executed successfully',{ spanContext: nodeSpan.spanContext() })
              nodeSpan.setStatus({
                code: SpanStatusCode.OK,
                message: 'Node executed successfully',
              })
            }
            return result
          } catch (error) {
            nodeSpan.recordException(error)
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            })
            nodeSpan.setAttribute('n8n.node.status', 'error')
            throw error
          } finally {
            nodeSpan.end()
          }
        },
      )
    }
  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry instrumentation:', e)
  }
}