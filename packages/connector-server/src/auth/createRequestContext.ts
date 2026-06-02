import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface BaseRequestCtx {
  reqId: string;
  bearer?: string;
  [key: string]: unknown;
}

export interface RequestContextConfig<T extends BaseRequestCtx = BaseRequestCtx> {
  /** Custom factory to build context from the incoming request */
  createContext?: (req: Request) => T;
}

export interface RequestContextResult<T extends BaseRequestCtx = BaseRequestCtx> {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getCtx: () => T;
  tryGetCtx: () => T | undefined;
  runInContext: <R>(ctx: T, fn: () => R) => R;
  als: AsyncLocalStorage<T>;
}

function extractBearerToken(auth: string | undefined): string | undefined {
  if (!auth?.startsWith('Bearer ')) return undefined;
  return auth.slice(7);
}

export function createRequestContext<T extends BaseRequestCtx = BaseRequestCtx>(
  config?: RequestContextConfig<T>
): RequestContextResult<T> {
  const als = new AsyncLocalStorage<T>();

  function getCtx(): T {
    const store = als.getStore();
    if (!store) throw new Error('missing_request_context');
    return store;
  }

  function tryGetCtx(): T | undefined {
    return als.getStore();
  }

  function middleware(req: Request, _res: Response, next: NextFunction) {
    const ctx = config?.createContext
      ? config.createContext(req)
      : ({
          reqId: randomUUID(),
          bearer: extractBearerToken(req.get('Authorization')),
        } as T);
    als.run(ctx, next);
  }

  function runInContext<R>(ctx: T, fn: () => R): R {
    return als.run(ctx, fn);
  }

  return { middleware, getCtx, tryGetCtx, runInContext, als };
}
