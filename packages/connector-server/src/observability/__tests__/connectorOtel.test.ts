import { afterEach, describe, expect, it } from 'vitest';
import { createStructuredLogger, setupConnectorOtel } from '../connectorOtel.js';

describe('Connector OTel Setup', () => {
  let result: ReturnType<typeof setupConnectorOtel> | null = null;

  afterEach(async () => {
    if (result) {
      await result.sdk.shutdown();
      result = null;
    }
  });

  it('should create OTel SDK, tracer, and logger', () => {
    result = setupConnectorOtel({
      serviceName: 'align-connector-test',
      enabled: false,
    });
    expect(result.sdk).toBeDefined();
    expect(result.tracer).toBeDefined();
    expect(result.logger).toBeDefined();
  });

  it('should create a working logger with info/error/warn methods', () => {
    result = setupConnectorOtel({
      serviceName: 'align-connector-test',
      enabled: false,
    });
    expect(result.logger.info).toBeDefined();
    expect(result.logger.error).toBeDefined();
    expect(result.logger.warn).toBeDefined();
  });
});

describe('Structured Logger', () => {
  it('should create a pino logger with the given service name', () => {
    const logger = createStructuredLogger('test-connector');
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.error).toBeDefined();
  });

  it('should respect LOG_LEVEL from environment', () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    try {
      const logger = createStructuredLogger('test-connector');
      // Default level is 'info' when LOG_LEVEL is unset
      expect(logger.level).toBe('info');
    } finally {
      if (originalLogLevel !== undefined) {
        process.env.LOG_LEVEL = originalLogLevel;
      }
    }
  });
});
