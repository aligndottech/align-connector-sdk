# align-connector-sdk

[![CI](https://github.com/aligndottech/align-connector-sdk/actions/workflows/ci.yaml/badge.svg)](https://github.com/aligndottech/align-connector-sdk/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm: connector-core](https://img.shields.io/npm/v/@aligndottech/connector-core.svg?label=%40aligndottech%2Fconnector-core)](https://www.npmjs.com/package/@aligndottech/connector-core)
[![npm: connector-server](https://img.shields.io/npm/v/@aligndottech/connector-server.svg?label=%40aligndottech%2Fconnector-server)](https://www.npmjs.com/package/@aligndottech/connector-server)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

The open-source (MIT) SDK for building [Align](https://align.tech) connectors.

A connector is the part that knows one tool, say Jira or Miro: how to read from it, and
optionally how to post back into it. Align's decision engine does everything else, and it works
the same way for every connector. So a new connector is only the tool-specific code.

| Package | What it's for |
|---|---|
| [`@aligndottech/connector-core`](packages/connector-core) | Reading. The `ConnectorFetcher` contract, item types, read-only fetchers and the gateway client. Its only dependency is `undici`, and the Align CLI depends on it. |
| [`@aligndottech/connector-server`](packages/connector-server) | Running a full connector: an Express app factory, an MCP handler, webhook signature checks, OpenTelemetry setup and a test harness. Depends on `connector-core`. |

```bash
npm install @aligndottech/connector-core
npm install @aligndottech/connector-server   # only for a real-time connector
```

Node 20 or later.

## Write a fetcher (required)

A fetcher reads items from your tool's API. The free
[Align CLI](https://github.com/aligndottech/align-cli) calls `fetch()` for personal imports.
Align's hosted scan of a team's history calls the optional `fetchPage()`, through your
connector's `fetch_historical` MCP tool.

```ts
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult } from '@aligndottech/connector-core';

export class MiroFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  // Optional, but every built-in fetcher has it. Put the read here and have fetch() call it,
  // so the two can't drift apart.
  async fetchWithReport({ token, limit = 50 }: ConnectorFetcherOptions): Promise<FetchResult> {
    const items: FetcherItem[] = []; // call your tool's API and map the results
    return {
      items,
      report: { platform: 'miro', scanned: 0, requested: limit, skips: [], complete: true, scope: 'team' },
    };
  }
}
```

The report tells the user what the read could not reach: a page cap, a time limit, an item type
you don't read, or an error the provider returned. Set `complete` when you read everything that
was asked for, and `scope` to `'yours'` or `'team'`. `buildFetchReport()` from `connector-core`
fills these in for you.

Worth knowing:

- **A `FetcherItem`** has `source_url`, `platform`, `raw_text`, and optionally `title`, `author`
  and `created_at`.
- **`created_at` must be the tool's own timestamp** (ISO-8601, UTC). If the tool doesn't give
  one, leave it out. Never use the time you fetched it, because a plausible wrong date looks
  exactly like a real one later on.
- **When the provider refuses a request, throw what it said.** Use
  `throw await providerError(connector, res, { forbidden })` (it's async). A 401 becomes a
  `FetcherAuthError`, and the CLI then offers to reconnect. Anything else becomes
  `<Connector> API failed (<status>): <provider text>`, with your `forbidden` hint added only on a 403.
  Don't tell the user to check their token unless the token was what got refused. A 400 means the
  request was wrong, not the key.

## Add real-time capture (optional)

To capture decisions as they happen, the way a Slack or Teams bot does, implement two interfaces
and stand up a webhook server with `connector-server`:

```ts
import type { DecisionAlertFormatter, MessagePoster } from '@aligndottech/connector-core';
import { createConnectorApp, WebhookGuard, createMcpHandler } from '@aligndottech/connector-server';

export class MiroAlertFormatter implements DecisionAlertFormatter { /* render a decision card in Miro */ }
export class MiroMessagePoster implements MessagePoster { /* post or update a message in Miro */ }
```

`WebhookGuard` skips signature checks when no secret is set. That's the default for backward
compatibility. In production, pass `failClosed: true` so a missing secret rejects requests instead.

## What you write, and what Align runs

You write the tool-specific code, here in the open: the fetcher, the formatter, the poster, the
webhook handler and any MCP tools.

Align runs the decision engine: classifying how decisions relate, handling conflicts and
replacements, the decision graph itself, and the queueing and deduplication behind a scan. It's
closed source and it doesn't know about any one tool. It calls your formatter and poster through
the interfaces above, so a Miro connector needs no Miro-specific code on Align's side.

You don't need the engine to build or test a connector. Use `MockGatewayClient` and
`NoOpDecisionFlowStateRepository` from `connector-core`, and `TestHarness` from
`@aligndottech/connector-server/testing`.

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm -r lint
```

## Releasing

release-please opens a release PR from the conventional commits on `main`. Merging it tags the
release and publishes both packages to npm with provenance. The two packages share one version.

One trap: a PR squash-merges with every commit message on the branch in the body, and
release-please parses all of it. A line it can't parse drops the whole commit from the release
without anything going red (#26 shipped that way and needed #27). CI's `squash-message` job
catches this before merge. Plain prose is fine. A line that starts with a backtick or a
parenthesis isn't.

## License

MIT, see [LICENSE](LICENSE).
