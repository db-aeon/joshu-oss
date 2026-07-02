# Joshu App Agent SDK

Build **Copilot-style desktop apps** on Joshu: embedded chat, live GUI context, Hermes-backed agent turns, and optional voice fast paths.

**Package:** [`packages/app-agent/`](../packages/app-agent/) (`@joshu/app-agent`)

**Reference app:** [jMail](jmail-arozos-app.md) — first implementation of the [embedded app cookbook](#embedded-app-cookbook-any-domain--not-mail-specific).

---

## Developer guide — add an agent to your app

This is the end-to-end checklist for a **new Vite app** (or an existing one) that should open panes, fill drafts, and search its own UI from chat — without teaching Hermes about your React internals.

### What you are building

| You implement | Platform provides |
|---------------|-------------------|
| React UI + `guiRef` handlers (`openCompose`, `setPane`, …) | Hermes gateway + `app_gui_action` tool |
| `joshu.app.json` `agent.guiActions[]` | App-scoped AG-UI prompt (`src/agUiAppContext.ts`) |
| `@joshu/app-agent` bridge (provider, readables, actions, chat panel) | `POST /joshu/api/ag-ui/run` SSE adapter |
| Optional `skills/my-app-gui/SKILL.md` | Queue drain → `app_action` → browser handlers |
| Optional `voiceCommands` | Voice `app_action` fast path (no Hermes) |

**Product rule:** agents may **draft** or **navigate** the GUI but must **never auto-send** or confirm destructive actions — the user does that in your UI.

### Step 1 — Manifest

Add an `agent` block to `arozos/subservice/<your-app>/joshu.app.json`:

```json
{
  "id": "my-app",
  "agent": {
    "skill": "my-app-gui",
    "usesSkills": ["joshu-mail"],
    "headless": false,
    "guiActions": [
      {
        "name": "openCompose",
        "description": "Open compose pane with optional draft fields",
        "parameters": [
          { "name": "subject", "type": "string" },
          { "name": "body", "type": "string" }
        ],
        "voice": {
          "shortcut": "compose",
          "phrases": ["new email", "compose", "put in the draft"]
        }
      },
      { "name": "openSettings", "description": "Open settings pane" }
    ],
    "actions": [
      { "name": "syncMirror", "description": "Headless server action (optional)" }
    ]
  }
}
```

| Field | Purpose |
|-------|---------|
| `guiActions[]` | GUI action contract — **`parameters`**, optional **`voice`** shortcut; Hermes **`app_gui_action`** + voice fast tools derive from here |
| `usesSkills[]` | Shared platform skills (`joshu-mail`, `joshu-brain`, …) |
| `skill` | Your bundled GUI skill (procedure when the app window is open) |
| `voiceCommands[]` | **Deprecated** — use `guiActions[].voice` instead |
| `actions[]` | Headless only → `POST /joshu/api/apps/:id/invoke` |

Validate:

```bash
npm run build
node packages/app-sdk/dist/cli.js validate arozos/subservice/my-app/joshu.app.json
```

### Step 2 — Platform data (domain I/O)

Use [`@joshu/platform-data`](platform-data.md) for mail, files, connectors — not raw `/joshu/api/*` from UI code. See [jMail reference](jmail-arozos-app.md#platform-data-migration).

### Step 3 — Vite aliases

```typescript
// apps/my-app/vite.config.ts
resolve: {
  alias: {
    "@joshu/platform-data": path.resolve(appRoot, "../../packages/platform-data/src/index.ts"),
    "@joshu/app-agent": path.resolve(appRoot, "../../packages/app-agent/src/index.ts"),
  },
},
```

Import chat styles once inside your bridge or panel:

```typescript
import "@joshu/jchat-ui/jchatShell.css";
import "@joshu/jchat-ui/jchatThread.css";
import "@joshu/app-agent/agentChat.css"; // slide-out toggle + panel positioning
```

Use **`JChatShell`** from `@joshu/jchat-ui` for the shared status strip + history drawer + thread slot. Embedded apps use **`JChatBubbleDock`** (Messenger-style Chat Head) via **`JoshuEmbeddedAppAgent`** → **`JoshuAgentChatPanel`**:

- **Persistent avatar head** (companion portrait from `/joshu/api/instance/identity`) — click toggles the floating panel open/closed
- **Mic badge** on the head toggles Realtime S2S voice without opening chat (`voice` prop)
- **Message bubbles** show companion + user avatars

```typescript
import "@joshu/jchat-ui/jchatBubble.css";
import "@joshu/jchat-ui/jchatShell.css";
import "@joshu/jchat-ui/jchatThread.css";
```

### Step 4 — `guiRef` + embedded chat

Expose imperative GUI APIs from your app root (same handlers for voice, chat, and tests):

```typescript
// apps/my-app/src/main.tsx
import { useAppAgentChatSession } from "@joshu/app-agent";

export type MyGuiAgentApi = {
  getGuiSnapshot: () => Record<string, unknown>;
  openCompose: (opts?: { to?: string; subject?: string; body?: string }) => void;
  setPane: (pane: "inbox" | "compose" | "settings") => void;
};

const guiRef = useRef<MyGuiAgentApi | null>(null);
guiRef.current = { getGuiSnapshot, openCompose, setPane, /* … */ };

const { threadId: chatThreadId, startNewChat } = useAppAgentChatSession({
  appId: "my-app",
  scope: "default", // mailbox slug, project id, etc.
});
```

Define GUI action handlers once (names must match manifest `guiActions[]`):

```typescript
// apps/my-app/src/myGuiActions.ts
export function createMyGuiActions(guiRef: MutableRefObject<MyGuiAgentApi | null>) {
  return [
    {
      name: "openCompose",
      description: "Open compose pane with optional draft fields",
      handler: async (args) => {
        guiRef.current?.openCompose(args);
        return "Compose opened.";
      },
    },
  ];
}
```

Bridge component — **`JoshuEmbeddedAppAgent`** wires jChat UI + CopilotKit + GUI context:

```tsx
// apps/my-app/src/myAgentBridge.tsx
import { JoshuEmbeddedAppAgent } from "@joshu/app-agent";

export function MyAgentBridge({ guiRef, threadId, onNewChat }) {
  const guiActions = useMemo(() => createMyGuiActions(guiRef), [guiRef]);
  return (
    <JoshuEmbeddedAppAgent
      manifest={MY_MANIFEST}
      threadId={threadId}
      guiRef={guiRef}
      guiReadableDescription="Current my-app UI state (activeView, selection, …)"
      guiActions={guiActions}
      chatTitle="My app assistant"
      onNewChat={onNewChat}
    />
  );
}
```

Mount in your app root:

```tsx
<MyAgentBridge
  key={chatThreadId}
  guiRef={guiRef}
  threadId={chatThreadId}
  onNewChat={startNewChat}
/>
```

**What `JoshuEmbeddedAppAgent` does for you:**

1. `JoshuAppAgentProvider` + `createAppAgentConfig({ manifest, threadId, apiBase: "/joshu/api" })`
2. `useJoshuGuiReadable` — snapshot injected into Hermes system prompt each turn
3. `useJoshuGuiAction` — one registration per `guiActions[]` entry
4. `JoshuAgentChatPanel` — expandable rail using shared `@joshu/jchat-ui` thread UI (`JChatCopilotThread`)

`useJoshuGuiAction` does two jobs:

- Registers a CopilotKit **frontend tool** (for synthesized `TOOL_CALL` events from AG-UI)
- Registers an **`app_action` dispatch handler** (for `CUSTOM` SSE events)

Both call the same `handler` — you only write GUI logic once.

**Lower-level:** compose `JoshuAppAgentProvider` + `useJoshuGuiReadable` + `useJoshuGuiAction` + `JoshuAgentChatPanel` manually when you need a custom layout. Export `JChatCopilotThread` for fully custom chrome.

### Step 5 — Bundled GUI skill

Ship `arozos/subservice/my-app/skills/my-app-gui/SKILL.md` (template: [jmail-gui](../arozos/subservice/jmail/skills/jmail-gui/SKILL.md)):

- When the app window is open → **`app_gui_action(appId="my-app", action=…)`** for UI changes
- When headless / cron → invoke API + platform skills
- Never send / never destructive actions without user confirmation

Run [`scripts/install-joshu-app.sh`](../scripts/install-joshu-app.sh) or `dev:arozos` to sideload skills.

### Step 6 — Build and run

```bash
npm run build              # Joshu server + packages
npm run dev:my-app         # Vite dev (proxy /joshu → :8788)
npm run dev:arozos         # full stack
npm run build:my-app       # before shipping in subservice
```

Hard-reload your app window after changing the bridge or `@joshu/app-agent`.

### Step 7 — Verify (first compose/navigation test)

1. **Gateway** includes `app_gui_action`:

   ```bash
   curl -s -X POST http://127.0.0.1:8788/joshu/api/safety-settings/restart-gateway
   ```

2. **Langfuse** (compose turn): `toolCallNames` contains `app_gui_action` with `action=openCompose` in arguments.

3. **Browser Network** → `POST /joshu/api/ag-ui/run` → SSE contains:

   ```json
   {"type":"CUSTOM","name":"app_action","value":{"appId":"my-app","action":"openCompose","args":{...}}}
   ```

4. **UI** — pane opens / draft appears.

Use **New chat** in the panel when debugging stale history (see [Session IDs](#session-ids-chat-vs-voice)).

Full checklist: [How to confirm quickly](#how-to-confirm-quickly-without-code-changes).

### Step 8 — Voice (optional)

Wire manifest `voiceCommands` through `@joshu/voice-client` and handle `app_action` with the **same** functions as `useJoshuGuiAction` handlers. See [Voice fast path](#voice-fast-path).

---

## Embedded app cookbook (any domain — not mail-specific)

jMail is the **reference implementation**, not a special case. Every embedded agent app should follow these patterns so you do not re-debug snapshot leaks, Composio bypass, or stale chat sessions.

**Copy:** [GUI skill template](templates/my-app-gui-SKILL.md) · jMail live example: [`mailAgentBridge.tsx`](../apps/jmail/src/mailAgentBridge.tsx), [`jmail-gui`](../arozos/subservice/jmail/skills/jmail-gui/SKILL.md)

### Three layers (who owns what)

| Layer | Your app | Platform |
|-------|----------|----------|
| **UI + snapshot** | `getGuiSnapshot()`, `guiRef` handlers | Injects snapshot each chat turn (`src/agUiAppContext.ts`) |
| **In-app agent** | `<app>-gui` skill + `guiActions[]` | `app_gui_action` → queue → browser |
| **Headless / deep** | `agent.usesSkills[]`, `agent.actions[]` | MCP, gbrain, invoke API |

Platform embedded prompt + your **`<app>-gui` skill** together define GUI-first vs escalation. Mail-specific rules live in `jmail-gui`, not in generic platform code.

### Tiered routing (mandatory mental model)

```text
User message (app window open)
  │
  ├─ Can answer from GUI snapshot?     → YES: text reply from snapshot only (no MCP)
  │
  ├─ Need fresh list / filter in UI?   → app_gui_action refresh* / search* → tool result
  │
  ├─ Need navigate / draft in UI?    → app_gui_action (open*, setPane, …)
  │
  └─ Data not in loaded GUI / deep / headless? → skill_view(platform skill) → MCP / invoke
```

**Anti-pattern:** user asks “list the 5 items I see” → agent calls Composio/MCP while the list is already on screen.

**Fix:** put those rows in the snapshot; forbid platform tools for visible data in `<app>-gui` skill.

### GUI snapshot contract

Design `getGuiSnapshot()` so the model cannot confuse **visible** vs **background** state.

| Field | Purpose |
|-------|---------|
| **`activeView`** | What pane the user sees: `list`, `detail`, `editor`, `setup`, … |
| **`listPreview`** | Rows currently loaded in the sidebar/list (id + labels the user sees) |
| **`openDetail`** | Full record when a row is open (not background editor state) |
| **`editor` / `draft`** | Only when `activeView` is the editor/compose pane |

Rules:

1. **Never** include background draft/form state when `activeView` is list or detail.
2. Include **enough preview data** to answer read/list questions without MCP.
3. Refresh guiActions should **return** list summary text (not just “refreshed”) so one turn can refresh + answer.

Example shape (adapt names to your app):

```typescript
getGuiSnapshot: () => {
  if (activeView === "editor") {
    return { activeView: "editor", editor: { title, bodyPreview } };
  }
  if (activeView === "detail" && selection) {
    return {
      activeView: "detail",
      listPreview: buildListPreview(items),
      openDetail: { id, title, … },
    };
  }
  return {
    activeView: "list",
    listPreview: buildListPreview(items),
    itemCount: items.length,
  };
},
```

Snapshot is read **once per user chat message** at send time (`JoshuHttpAgent.requestInit` → `state.gui` → system prompt). It is not live between messages.

### Skill split (do this for every app)

| Skill | When loaded | Contents |
|-------|-------------|----------|
| **`<app>-gui`** | App window open / embedded chat | GUI-first table, guiAction names, never auto-destruct |
| **Platform skills** (`joshu-mail`, `joshu-brain`, …) | Headless, deep search, not in GUI | Existing platform mechanics |

In **`joshu-mail`** (and other platform skills): add one line — *when `<App>` GUI is open, load `<app>-gui` first*.

### Chat UI

Use **`@joshu/jchat-ui`** (`JChatThread`) via `JoshuAgentChatPanel` — same bubbles/composer as jChat. Alias in Vite:

```typescript
"@joshu/jchat-ui": path.resolve(appRoot, "../../packages/jchat-ui/src"),
```

Import `@joshu/jchat-ui/jchatThread.css` (pulled in by the chat panel).

### Session hygiene

| Surface | Thread id pattern | Reset |
|---------|-------------------|--------|
| Embedded chat | `{appId}:…:chat:{rev}` in `sessionStorage` | **New chat** → bump rev + `DELETE /joshu/api/ag-ui/session` |
| Voice | Stable id without `:chat:` | Separate from chat |

Do not reuse one stable chat thread forever — Hermes history accumulates and the model cites old GUI actions.

### New-app checklist (before you ship)

- [ ] `joshu.app.json`: `agent.skill`, `agent.guiActions[]`, `agent.usesSkills[]`
- [ ] `getGuiSnapshot()` with `activeView` + `listPreview` / `openDetail` (no background leak)
- [ ] One `useJoshuGuiAction` per `guiActions[]` name; handlers share `guiRef` with voice
- [ ] `<app>-gui/SKILL.md` with GUI-first vs escalation table ([template](templates/my-app-gui-SKILL.md))
- [ ] Platform skills updated: “when GUI open → `<app>-gui` first”
- [ ] Chat thread id with `:chat:{rev}` + New chat button
- [ ] `@joshu/jchat-ui` + design-system CSS loaded
- [ ] Langfuse smoke: read question → **no MCP**; navigate → `app_gui_action`; GUI updates

### jMail → your app (name mapping)

| jMail | Your app |
|-------|----------|
| `inboxPreview` | `listPreview` |
| `openThread` | `openDetail` |
| `openCompose` | `openEditor` / `openDraft` |
| `refreshInbox` | `refreshList` |
| `searchMail` | `searchList` |
| `joshu-mail` escalation | your `agent.usesSkills` platform skill |

---

## Architecture — how GUI actions reach the browser

Embedded chat does **not** rely on passing CopilotKit `tools` through Hermes chat/completions (Hermes uses its own tool catalog). Instead, use the same pattern as `desktop_open`:

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Vite app                                              │
│  @joshu/app-agent — useJoshuGuiAction handlers → guiRef     │
│  JoshuAgentChatPanel (CopilotKit headless)                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ POST /joshu/api/ag-ui/run
                            │ state: { appId, mode, gui }
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Joshu AG-UI adapter (src/agUiApi.ts)                       │
│  X-Hermes-Session-Key: joshu-app:{appId}:{threadId}         │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Hermes gateway                                             │
│  Model calls app_gui_action(appId, action, args)            │
│  Plugin post_tool_call → POST /app-gui-actions/enqueue      │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  AG-UI SSE (end of turn + on tool complete)                 │
│  CUSTOM app_action  +  TOOL_CALL openCompose (synthesized)  │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
                     guiRef handler runs in browser
```

| Path | Latency | Use for |
|------|---------|---------|
| Hermes **`app_gui_action`** | ~seconds | Embedded chat — compose, navigate, search UI |
| CopilotKit **`TOOL_CALL`** (synthesized) | same turn | Same handler as above; drives chat tool cards |
| Voice **`app_action`** | ~0ms | Manifest phrase → action (no Hermes) |
| **`POST /apps/:id/invoke`** | seconds | Headless / cron / MCP |
| Platform skills (`joshu-mail`, …) | seconds | Domain search, send (with guard), files |

Plugin reference: [hermes-integration — joshu-app-gui](hermes-integration.md#joshu-app-gui-plugin).

---

## Session IDs (chat vs voice)

| Surface | Example thread / session id | Hermes session key (AG-UI) |
|---------|----------------------------|----------------------------|
| Embedded **chat** | `jmail:owner@example.com:chat:1` | `joshu-app:jmail:jmail:owner@example.com:chat:1` |
| **Voice** | `jmail:owner@example.com` | (voice WebSocket — separate) |
| jChat | UUID session id | `joshu-hermes-chat:{sessionId}` |

Chat revision (`:chat:{rev}`) is managed by **`useAppAgentChatSession`** (`sessionStorage` key `${appId}-agent-chat-rev`). **New chat** in the panel:

1. `DELETE /joshu/api/ag-ui/session?threadId=…` (localhost only)
2. Bumps revision → remounts CopilotKit with a fresh thread
3. Langfuse groups under a new session id

Do not reuse a single stable thread id for chat unless you want unbounded Hermes history.

---

## Chat UI — two tool rows

After a compose turn you may see:

| Row | Meaning |
|-----|---------|
| **`openCompose` → Done** | Client handler ran; compose pane updated |
| **`app_gui_action` → Running** | Hermes server tool card — may stay “Running” even when compose succeeded (no client handler for the server tool; END event pairing quirk). **Safe to ignore** if the GUI updated. |

Langfuse shows **`app_gui_action`**; the actual pane change happens in the browser via **`app_action`** / **`openCompose`**.

---

## Quickstart (minimal bridge)

```tsx
import {
  JoshuAppAgentProvider,
  JoshuAgentChatPanel,
  createAppAgentConfig,
  useJoshuGuiReadable,
  useJoshuGuiAction,
} from "@joshu/app-agent";

const config = createAppAgentConfig({
  manifest: MY_MANIFEST,
  threadId: "my-app:session-1",
  apiBase: "/joshu/api",
});

function GuiTools({ guiRef }) {
  useJoshuGuiReadable({
    name: "myapp.gui",
    description: "Live UI snapshot",
    getSnapshot: () => guiRef.current?.getGuiSnapshot() ?? {},
  });
  useJoshuGuiAction({
    name: "openCompose",
    description: "Open compose (draft only — user sends)",
    parameters: [
      { name: "subject", type: "string" },
      { name: "body", type: "string" },
    ],
    handler: async (args) => {
      guiRef.current?.openCompose(args);
      return "Compose opened.";
    },
  });
  return null;
}

function MyAgentBridge({ guiRef, threadId, onNewChat }) {
  const config = useMemo(
    () => createAppAgentConfig({ manifest: MY_MANIFEST, threadId, apiBase: "/joshu/api" }),
    [threadId],
  );
  return (
    <JoshuAppAgentProvider config={config} getGuiState={() => guiRef.current?.getGuiSnapshot()} mode="embedded">
      <GuiTools guiRef={guiRef} />
      <JoshuAgentChatPanel title="Assistant" onNewChat={onNewChat} />
    </JoshuAppAgentProvider>
  );
}
```

---

## Voice fast path

Declare **`guiActions[].voice`** on the manifest. Voice-realtime loads tools from `GET /joshu/api/ag-ui/info?appId=` (`voiceTools` in the response). Pass only `appId` + GUI snapshot from the client:

```typescript
startJoshuVoiceSession({
  sessionId: "my-app:scope",
  chatSessionId: chatThreadId,
  surface: { appId: "my-app", threadId: chatThreadId, guiSnapshot: guiRef.current?.getGuiSnapshot() },
  onAppAction: ({ action, args }) => {
    // same handlers as useJoshuGuiAction
  },
});
```

Or use `resolveManifestVoiceTools(manifest.agent?.guiActions)` from `@joshu/app-agent` when wiring `useJoshuVoiceCommands`.

Wire event: `app_action` on the voice WebSocket (parallel to `desktop_action`).

---

## Server APIs

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/joshu/api/ag-ui/info?appId=` | Agent discovery + declared `guiActions` |
| `POST` | `/joshu/api/ag-ui/run` | AG-UI SSE stream (CopilotKit `HttpAgent`) |
| `DELETE` | `/joshu/api/ag-ui/session?threadId=` | Drop Hermes transcript for a chat thread (localhost) |
| `POST` | `/joshu/api/app-gui-actions/enqueue` | Plugin enqueue (localhost; keyed by session) |
| `GET` | `/joshu/api/app-gui-actions/drain?sessionKey=` | Debug drain |
| `POST` | `/joshu/api/apps/:id/invoke` | Headless `agent.actions[]` only |

AG-UI run body includes `state.appId`, `state.mode`, `state.gui` (snapshot). Session key sent to Hermes: `joshu-app:{appId}:{threadId}`.

Implementation: [`src/agUiApi.ts`](../src/agUiApi.ts), [`src/agUiAppContext.ts`](../src/agUiAppContext.ts), [`src/appGuiActionApi.ts`](../src/appGuiActionApi.ts).

---

## How to confirm quickly (without code changes)

After changing `src/agUiApi.ts`, `.hermes/plugins/joshu-app-gui/`, or `@joshu/app-agent`, **restart Joshu and the Hermes gateway**.

**Pass/fail:**

| Check | Pass | Fail → likely cause |
|-------|------|---------------------|
| Gateway toolset includes `app_gui_action` | Plugin enabled after restart | Stale gateway; check `joshu-app-gui` in config |
| Langfuse: `app_gui_action` + `openCompose` in args | Model + Hermes OK | Prompt / skill; load `my-app-gui` |
| SSE: `CUSTOM` `app_action` | AG-UI drain OK | Session key mismatch (see [Session IDs](#session-ids-chat-vs-voice)) |
| SSE: `TOOL_CALL` `openCompose` | Synthesized client tool OK | Missing `tools` in CopilotKit request |
| Compose pane opens | End-to-end OK | `guiRef` / handler not wired |

### Rebuild and restart

```bash
cd joshu
npm run build
# restart dev:arozos if needed
curl -s -X POST http://127.0.0.1:8788/joshu/api/safety-settings/restart-gateway
npm run build:my-app   # if you changed the app bundle
```

Hard-reload the app window. Use **New chat** before retesting compose after a failed spiral.

### curl smoke (server only — no browser GUI)

```bash
curl -sN -X POST 'http://127.0.0.1:8788/joshu/api/ag-ui/run' \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "my-app:test:chat:1",
    "runId": "smoke-1",
    "state": { "appId": "my-app", "mode": "embedded", "gui": { "pane": "home" } },
    "tools": [{ "name": "openCompose", "description": "Open compose", "parameters": { "type": "object", "properties": { "subject": { "type": "string" }, "body": { "type": "string" } } } }],
    "messages": [{ "role": "user", "content": "Draft a short test email. Use openCompose with subject and body." }]
  }' | rg 'app_action|app_gui_action|openCompose'
```

Expect: `app_gui_action` tool progress, then `CUSTOM` `app_action`, then `TOOL_CALL` `openCompose`.

---

## Licensing

- `@joshu/app-agent` depends on **CopilotKit** (MIT) and **AG-UI** (MIT).
- Copilot Cloud / Enterprise is **optional** — Joshu uses client-side `HttpAgent` → box AG-UI, no CopilotKit runtime on the box.
- See [THIRD_PARTY.md](THIRD_PARTY.md).

---

## Related

- [platform-architecture.md](platform-architecture.md) — platform layers + AG-UI summary
- [app-sdk.md](app-sdk.md) — manifest v2, build pipeline, validation
- [jmail-arozos-app.md](jmail-arozos-app.md) — reference implementation
- [hermes-integration.md](hermes-integration.md) — `joshu-app-gui` plugin
