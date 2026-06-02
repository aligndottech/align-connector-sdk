# align-connector-sdk

Open-source (MIT) SDK for building [Align](https://align.tech) connectors. Two packages:

| Package | What it is | Depends on |
|---|---|---|
| [`@aligndottech/connector-core`](packages/connector-core) | The **read** foundation: the `ConnectorFetcher` contract, normalized item types, read-only fetchers, the gateway client, and tier definitions. **Lightweight** (only `undici`) - the Align CLI depends on this. | - |
| [`@aligndottech/connector-server`](packages/connector-server) | **Server plumbing** for full connectors: Express app factory, MCP handler, webhook signature guard, OpenTelemetry setup, test harness. | `connector-core` |

## Adding a connector

A connector is a **tool adapter**: the bits that are specific to *your* tool (Slack, Jira, Miro, ...). You write all of it against the interfaces in this SDK. There is **no per-tool orchestration to write** - Align's decision engine is generic and the *same* for every connector, so your one adapter powers both the free CLI and the commercial real-time product.

An adapter has two layers - implement what your tool supports:

**1. Read (required)** - a `ConnectorFetcher` that pulls items from your tool's read API:

```ts
import type { ConnectorFetcher, FetcherItem } from '@aligndottech/connector-core';

export class MiroFetcher implements ConnectorFetcher {
  async fetch({ token, limit }): Promise<FetcherItem[]> {
    // call your tool's read API, map results to FetcherItem[]
    return [];
  }
}
```

This single implementation serves both the **free CLI** (calls `fetch()` for personal imports) and the **paid discover scan** (calls your `fetch_historical` tool, backed by the same fetcher).

**2. Real-time (optional)** - to capture decisions live (a Slack/Teams-style bot), implement the platform interfaces and stand up a webhook server with the SDK's scaffolding:

```ts
import type { DecisionAlertFormatter, MessagePoster } from '@aligndottech/connector-core';
import { createConnectorApp, WebhookGuard, createMcpHandler } from '@aligndottech/connector-server';

export class MiroAlertFormatter implements DecisionAlertFormatter { /* render a decision card in Miro */ }
export class MiroMessagePoster   implements MessagePoster        { /* post/update in Miro */ }
```

## What's yours vs. ours

| You write (open, this SDK) | Align provides (closed, written once) |
|---|---|
| `ConnectorFetcher` (read) | The **generic decision engine** that drives every connector identically: |
| `DecisionAlertFormatter` (render) | relationship classification, conflict/supersession handling, |
| `MessagePoster` (post) | the decision graph, and the queue/fan-out/dedup of the discover scan. |
| webhook handler + MCP tools | |

The engine is **tool-agnostic** - it calls *your* formatter/poster through the interfaces above. So when you contribute, say, a Miro adapter, Align writes **zero** Miro-specific code; the existing engine + your adapter *is* the Miro bot. The interface contract is the only thing that has to stay in sync - there's no per-tool coordination.

Develop and test entirely against the SDK's mocks (`MockGatewayClient`, `TestHarness`, `NoOpDecisionFlowStateRepository`) - you never need the engine source. You write the **adapter** (tool knowledge); Align provides the **brain** (decision intelligence). One contribution, both tiers.

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
