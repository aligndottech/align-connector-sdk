/**
 * Shared RequestContext utility for all connectors
 *
 * Provides AsyncLocalStorage-based request context management.
 * This is the SINGLE SOURCE OF TRUTH - do not duplicate in connector packages.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Base request context interface
 * Connectors can extend this for platform-specific fields
 */
export interface BaseRequestContext {
  tenantId: string;
  bearerToken?: string;
}

/**
 * AsyncLocalStorage instance for request-scoped context
 */
const als = new AsyncLocalStorage<BaseRequestContext>();

/**
 * Get the current request context
 * @throws Error if called outside of request scope
 */
export function getContext<T extends BaseRequestContext = BaseRequestContext>(): T {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error('missing_request_context');
  }
  return ctx as T;
}

/**
 * Try to get the current request context, returns undefined if not in request scope
 */
export function tryGetContext<T extends BaseRequestContext = BaseRequestContext>(): T | undefined {
  return als.getStore() as T | undefined;
}

/**
 * Run a function within a request context
 */
export function runWithContext<T, C extends BaseRequestContext = BaseRequestContext>(
  context: C,
  fn: () => T
): T {
  return als.run(context, fn);
}

/**
 * Run an async function within a request context
 */
export async function runWithContextAsync<T, C extends BaseRequestContext = BaseRequestContext>(
  context: C,
  fn: () => Promise<T>
): Promise<T> {
  return als.run(context, fn);
}

/**
 * Extract bearer token from Authorization header
 * @param authHeader - The Authorization header value (e.g., "Bearer xyz123")
 * @returns The token without "Bearer " prefix, or undefined if invalid
 */
export function extractBearer(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) {
    return undefined;
  }
  return authHeader.slice(7);
}

/**
 * Alias for extractBearer for backwards compatibility
 */
export const getBearer = extractBearer;
