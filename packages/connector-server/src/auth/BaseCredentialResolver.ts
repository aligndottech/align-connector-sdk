import { fetch as undiciFetch } from 'undici';

export interface CredentialResolverConfig {
  /** Platform name (e.g., 'jira', 'github') — used in error messages */
  platform: string;
  /** Map of credential key to env var name. E.g., { token: 'JIRA_API_TOKEN' } */
  envVars?: Record<string, string>;
  /** Header name for direct token pass-through. E.g., 'x-github-token' */
  directTokenHeader?: string;
  /** Gateway endpoint for credential exchange. E.g., '/integrations/jira/credentials' */
  gatewayEndpoint: string;
  /** Gateway base URL. Defaults to GATEWAY_URL env var */
  gatewayUrl?: string;
  /** Service-to-service bearer token. Defaults to GATEWAY_BEARER_TOKEN env var */
  gatewayBearerToken?: string;
  /** Override fetch for testing */
  fetchFn?: typeof undiciFetch;
  /** Validate that response contains these keys */
  requiredFields?: string[];
}

export type CredentialResult = Record<string, string>;

export interface ResolveContext {
  bearer?: string;
  tenantId?: string;
  headers?: Record<string, string>;
}

export class BaseCredentialResolver {
  constructor(private config: CredentialResolverConfig) {}

  async resolve(ctx: ResolveContext): Promise<CredentialResult> {
    // Tier 1a: Direct header token
    if (this.config.directTokenHeader && ctx.headers?.[this.config.directTokenHeader]) {
      return { token: ctx.headers[this.config.directTokenHeader] };
    }

    // Tier 1b: Environment variables
    if (this.config.envVars) {
      const result: CredentialResult = {};
      let allPresent = true;
      for (const [key, envVar] of Object.entries(this.config.envVars)) {
        const val = process.env[envVar];
        if (val) result[key] = val;
        else allPresent = false;
      }
      if (allPresent && Object.keys(result).length > 0) return result;
    }

    // Tier 2: Gateway exchange
    const { bearer, tenantId } = ctx;
    if (!bearer && !tenantId) throw new Error('unauthorized');

    const gatewayUrl = this.config.gatewayUrl ?? process.env.GATEWAY_URL ?? 'http://gateway:8080';
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    if (tenantId) headers['x-tenant-id'] = tenantId;

    const gatewayBearer = this.config.gatewayBearerToken ?? process.env.GATEWAY_BEARER_TOKEN;
    if (gatewayBearer && !bearer) headers['authorization'] = `Bearer ${gatewayBearer}`;

    const fetchFn = this.config.fetchFn ?? undiciFetch;
    const response = await fetchFn(`${gatewayUrl}${this.config.gatewayEndpoint}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`${this.config.platform}_cred_exchange_failed:${response.status}`);
    }

    const data = (await response.json()) as CredentialResult;
    if (this.config.requiredFields) {
      for (const field of this.config.requiredFields) {
        if (!data[field]) throw new Error(`${this.config.platform}_creds_missing:${field}`);
      }
    }
    return data;
  }
}
