/**
 * Thrown by a fetcher when the provider returns 401 (token expired/revoked) -
 * i.e. re-authenticating would help. Callers (e.g. the CLI) can catch this to
 * trigger a reconnect flow, vs. a generic Error (403 / lacking scopes) where
 * re-auth won't help.
 */
export class FetcherAuthError extends Error {
  constructor(public readonly connector: string) {
    super(`${connector} authentication expired or revoked`);
    this.name = 'FetcherAuthError';
  }
}
