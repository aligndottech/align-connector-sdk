import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';

export interface ConnectorAppConfig {
  name: string;
  version: string;
  corsOrigin?: string[] | true;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  bodyLimit?: string;
  trustProxy?: boolean;
}

export function createConnectorApp(config: ConnectorAppConfig): Express {
  const app = express();

  if (config.trustProxy !== false) {
    app.set('trust proxy', true);
  }

  app.use(express.json({ limit: config.bodyLimit ?? '512kb' }));
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      origin: (config.corsOrigin ?? process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) ?? true) as cors.CorsOptions['origin'],
      exposedHeaders: ['Mcp-Session-Id'],
    })
  );
  app.use(
    rateLimit({
      windowMs: config.rateLimitWindowMs ?? 60_000,
      limit: config.rateLimitMax ?? 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      validate: {
        trustProxy: false,
        xForwardedForHeader: false,
      },
    })
  );

  // Standard health endpoint
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: config.name, version: config.version });
  });

  return app;
}
