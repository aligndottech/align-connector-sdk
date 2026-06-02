/**
 * OTel setup for connectors.
 *
 * Provides auto-instrumentation for Express, HTTP, and structured logging.
 * Connectors call setupConnectorOtel() once at startup before creating
 * the Express app.
 *
 * Usage:
 * ```typescript
 * import { setupConnectorOtel } from '@align/connector-sdk';
 * const { logger, sdk } = setupConnectorOtel({ serviceName: 'align-connector-slack' });
 * ```
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace } from '@opentelemetry/api';
import pino from 'pino';

export interface ConnectorOtelConfig {
  /** Service name (e.g., 'align-connector-slack') */
  serviceName: string;
  /** Service version (default: '1.0.0') */
  serviceVersion?: string;
  /** Enable OTel (default: OTEL_ENABLED env, disabled if unset) */
  enabled?: boolean;
}

export interface ConnectorOtelResult {
  /** The OTel SDK instance (call shutdown() on SIGTERM) */
  sdk: NodeSDK;
  /** A configured tracer for creating custom spans */
  tracer: ReturnType<typeof trace.getTracer>;
  /** Structured pino logger (replaces console.log) */
  logger: pino.Logger;
}

/**
 * Initialize OTel instrumentation for a connector.
 *
 * ESM note: In `type: "module"` packages, static imports are hoisted and
 * evaluated before top-level code. For strict early-patching guarantees,
 * use `node --import=./otelPreload.js` to load OTel before the app entry.
 * Our connectors call this at the top of server.ts which works for the
 * libraries we instrument, but `--import` is the most reliable approach.
 *
 * Call `import 'dotenv/config'` before this function so OTEL_ENABLED and
 * other env vars are available.
 */
export function setupConnectorOtel(config: ConnectorOtelConfig): ConnectorOtelResult {
  const enabled = config.enabled ?? (process.env.OTEL_ENABLED === 'true');
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '1.0.0',
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: enabled
      ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })
      : undefined,
    instrumentations: enabled
      ? [getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
        })]
      : [],
  });

  sdk.start();

  const tracer = trace.getTracer(config.serviceName);
  const logger = createStructuredLogger(config.serviceName);

  return { sdk, tracer, logger };
}

/**
 * Create a structured pino logger for a connector.
 * Replaces console.log/console.error with JSON-formatted,
 * level-aware logging.
 */
export function createStructuredLogger(serviceName: string): pino.Logger {
  return pino({
    name: serviceName,
    level: process.env.LOG_LEVEL ?? 'info',
  });
}
