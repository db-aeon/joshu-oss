# `@joshu/platform-data`

TypeScript client for the Joshu **platform data plane**. Wraps existing Joshu REST routes — no new business logic on the box.

| | |
|-|-|
| Package | [`packages/platform-data/`](../packages/platform-data/) |
| Architecture | [`platform-architecture.md`](platform-architecture.md) |
| Manifest validation | [`@joshu/app-sdk`](app-sdk.md#joshuapp-sdk) |

## Install / build

Monorepo workspace — built with root `npm run build`:

```bash
npm run build -w @joshu/platform-data
```

Vite apps alias `@joshu/platform-data` to `packages/platform-data/src` (see `apps/jmail/vite.config.ts`).

## Usage

```typescript
import { createJoshuPlatformData } from "@joshu/platform-data";

const platform = createJoshuPlatformData({
  apiBase: "/joshu/api", // browser default
  // apiBase: process.env.JOSHU_API_BASE_URL, // Node/cron
});

const status = await platform.connections.status();
const hits = await platform.mail.search({ provider: "gmail", q: "invoice", tier: "cache" });
const pages = await platform.files.query({ q: "quarterly report", since: "90d" });
const memories = await platform.memory.recall({ q: "budget discussion", limit: 10 });
```

Reference implementation: [`apps/jmail/src/joshuData.ts`](../apps/jmail/src/joshuData.ts).

## Tier policy (mail)

The SDK enforces **cache before live** at the URL layer ([`packages/platform-data/src/tierRouter.ts`](../packages/platform-data/src/tierRouter.ts)):

| Tier | Use when | Behavior |
|------|----------|----------|
| `cache` (default) | Inbox UI, agent recall, search | `GET …/connectors/mail/{provider}/search` |
| `sync` | Refresh mirrors | `POST …/connectors/mail/{provider}/sync` — not valid for `search()` |
| `live` | Cache miss, pre-mirror mail | Gmail search adds `live=true` |

Skills (`joshu-mail`) describe *when* to escalate; this SDK describes *how*.

## API surface

### `connections`

| Method | Route | Notes |
|--------|-------|-------|
| `status()` | `GET /connectors/status` | Nylas + Gmail accounts, mirror counts |

### `mail`

| Method | Tier | Route |
|--------|------|-------|
| `search({ provider, q, tier })` | `cache` (default) | `GET /connectors/mail/{provider}/search` |
| `search(..., tier: 'live')` | live Gmail | same + `live=true` |
| `sync({ provider, ... })` | sync | `POST /connectors/mail/{provider}/sync` |
| `mirror({ provider })` | cache probe | `GET /connectors/mail/{provider}/mirror` |
| `getGmailMessage`, `sendGmail`, `replyGmail` | live | Gmail connector routes |

### `nylas`

Agent inbox (Nylas grant): `status`, `listMessages`, `getMessage`, `patchMessage`, `sendMessage`, `provisionAgent`, `getProfile`, `saveProfile`, `testSend`.

Base: `{apiBase}/nylas` (default `/joshu/api/nylas`).

### `calendar`

| Method | Route |
|--------|-------|
| `freeSlots({ date, timezone, ... })` | `GET /connectors/calendar/google/free-slots` |

### `files`

| Method | Route |
|--------|-------|
| `query({ q, since, sourceId })` | `GET /brain/query` — default `sourceId: "__all__"` |
| `getPage(slug)` | `GET /brain/get` |

### `memory`

| Method | Route |
|--------|-------|
| `status()` | `GET /hindsight/status` |
| `graph(kind)` | `GET /hindsight/graph/:kind` |
| `recall({ q, limit })` | `GET /hindsight/recall` |

### `identity`

| Method | Route |
|--------|-------|
| `get()` | `GET /instance/identity` |

## Configuration

| Env / option | Default | Used by |
|--------------|---------|---------|
| `apiBase` option | `/joshu/api` | All modules |
| `VITE_JOSHU_API_BASE` | — | Browser (via `resolveApiBase`) |
| `JOSHU_API_BASE_URL` | — | Node scripts |
| `fetch` option | `globalThis.fetch` | Tests / SSR |

## Errors

Failed requests throw `PlatformDataError` with `status` and parsed body when available.

## What not to put in platform-data

- App-specific UI state
- Voice session wiring (use `@joshu/voice-client`)
- Hermes chat streaming (use jChat API or AG-UI adapter — [`platform-architecture.md`](platform-architecture.md#ag-ui-interop))

## Tests

```bash
npm run test:platform-architecture
```

Covers tier URL construction, manifest validation, app registry load, and optional live `GET /api/apps` when the dev server is running.
