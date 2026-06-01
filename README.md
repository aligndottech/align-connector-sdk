# align-connector-sdk

Open-source (MIT) SDK for building [Align](https://align.tech) connectors. Two packages:

| Package | What it is | Depends on |
|---|---|---|
| [`@aligndottech/connector-core`](packages/connector-core) | The **read** foundation: the `ConnectorFetcher` contract, normalized item types, read-only fetchers, the gateway client, and tier definitions. **Lightweight** (only `undici`) - the Align CLI depends on this. | - |
| [`@aligndottech/connector-server`](packages/connector-server) | **Server plumbing** for full connectors: Express app factory, MCP handler, webhook signature guard, OpenTelemetry setup, test harness. | `connector-core` |

## Adding a connector

A connector is, at minimum, one **`ConnectorFetcher`** - a read-only function that, given a token, returns normalized `FetcherItem`s:

```ts
import type { ConnectorFetcher, FetcherItem } from '@aligndottech/connector-core';

export class MyToolFetcher implements ConnectorFetcher {
  async fetch({ token, limit }): Promise<FetcherItem[]> {
    // call your tool's read API, map results to FetcherItem[]
    return [];
  }
}
```

That single implementation serves **both**:

- the **free Align CLI**, which calls `fetch()` directly for personal read-only imports, and
- the **paid discover scan**, which calls your connector's `fetch_historical` tool (backed by the same fetcher) from inside Align's hosted orchestration.

You implement the *read*. Align's hosted platform owns the orchestration (queues, fan-out, dedup, the decision graph) - none of which lives here.

## Develop

```bash
pnpm install
pnpm -r build      # tsc -> dist/ for each package
pnpm -r test       # vitest
pnpm -r typecheck
pnpm -r lint
```

## Release

Publishing is gated on a git tag. Push a `v*` tag and `.github/workflows/publish.yml` runs `pnpm -r publish --access public --provenance`. Both packages version in lockstep.

## License

MIT - see [LICENSE](LICENSE).
