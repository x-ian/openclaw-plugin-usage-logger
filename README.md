# openclaw-plugin-usage-logger

An OpenClaw plugin that appends one markdown table row per agent turn to a file in your
Obsidian vault. Captures timestamp, model, token usage, duration, success, the user's
prompt, and any files touched by tools.

```
| Time | Model | Tokens | Dur | OK | Prompt | Files |
|---|---|---|---|---|---|---|
| 2026-08-15 17:20 | huggingface/moonshotai/Kimi-K3 | 23138 | 12.7s | ✅ | NADA | None |
```

## Requirements

- OpenClaw >= 2026.5.17
- Node 22.22.3+, 24.15+, or 25.9+

## Install (development)

```bash
git clone <this repo> ~/openclaw-plugin-usage-logger
cd ~/openclaw-plugin-usage-logger
npm install
npm run build
openclaw plugins install --link ~/openclaw-plugin-usage-logger
```

`--link` registers the directory in `plugins.load.paths` without copying it, so
`npm run build` + a gateway restart is the whole edit loop. Do not move or rename the
directory afterwards — the recorded path is absolute.

**Never install this into `~/.openclaw/extensions/`.** That directory is a plugin
discovery root; a `node_modules` tree inside it gets scanned as if it contained plugins
and breaks config validation for the entire gateway.

## Enable

In `~/.openclaw/openclaw.json`:

```json
"plugins": {
  "entries": {
    "usage-logger": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true },
      "config": {
        "logPath": "projects/my-vault/_obsidian/openclaw/logs/agent.md"
      }
    }
  }
}
```

`allowConversationAccess` is required. The `llm_input`, `llm_output`, and `agent_end`
hooks are gated behind it because they expose prompt and conversation content; without
it they are silently blocked and only tool hooks register. Restart the gateway after
editing — `plugins.entries` changes do not hot-reload reliably.

## Configuration

| Key | Default | Description |
|---|---|---|
| `logPath` | `logs/usage.md` | Log file, relative to the workspace directory |
| `timeZone` | `Europe/Berlin` | IANA time zone for timestamps |
| `maxPromptLen` | `300` | Truncate logged prompts (0 = no limit) |
| `maxTrackedRuns` | `200` | Max in-flight turns held in memory |
| `maxPendingCalls` | `500` | Max staged tool calls held in memory |
| `flushDelayMs` | `750` | Delay between `agent_end` and writing the row |

`logPath` must resolve inside the workspace directory; anything escaping it is refused
and logged as an error. Directories and the file itself are created on first write.

Config keys live in **two** places and must be kept in sync by hand: `configSchema` in
`src/index.ts` and `configSchema` in `openclaw.plugin.json`. The manifest is what
validates config before the runtime loads, so a key present only in the code will be
rejected as an unknown property.

## Hooks used

| Hook | Purpose |
|---|---|
| `message_received` | Raw user prompt (preferred source) |
| `llm_input` | Prompt fallback, model fallback |
| `llm_output` | Resolved model ref, token usage |
| `before_tool_call` | Stage file paths from `derivedPaths` |
| `after_tool_call` | Commit paths, only on success |
| `agent_end` | Duration, success; schedules the row write |
| `gateway_stop` | Drain outstanding writes |

## Implementation notes

Three non-obvious host behaviours shape this plugin. All were found empirically against
OpenClaw 2026.6.11 and may change in future releases.

**`agent_end` can fire before `llm_output`.** Despite the declared hook order, `agent_end`
was observed arriving ~16ms *before* `llm_output` for the same `runId`. Writing the row
directly from `agent_end` therefore produced empty model and token columns on every row.
The fix is `scheduleFlush`: `agent_end` starts a `flushDelayMs` timer, and the row is
written when it fires, by which point late events have landed. Raise `flushDelayMs` if
columns come back empty.

**`llm_output.prompt` is empty on the default harness.** The field is documented as the
original user prompt, but on `harnessId: "openclaw"` it arrives undefined while `usage`
and `resolvedRef` from the same event are populated. Do not rely on it.

**`llm_input.prompt` carries the full inbound envelope.** It is non-optional and always
present, but contains fenced JSON metadata blocks, a sender block, and a chronological
transcript of prior turns — the user's actual message is at the very end, well past any
reasonable truncation. `message_received.content` is the raw text with none of that, and
its `runId` (optional in the type, present in practice for Telegram) allows correlation.
`stripEnvelope` handles the fallback case and is deliberately imperfect.

Other details worth knowing:

- Token counts sum across all LLM calls in a turn (tool loops, retries, compaction).
  `cacheRead` and `cacheWrite` are excluded since they bill differently.
- Tool paths are staged on `before_tool_call` (where `derivedPaths` exists) and committed
  on `after_tool_call` only when there was no error, so failed calls do not appear.
- Appends are serialized through a promise chain so concurrent runs cannot interleave rows.
- `turns`, `pendingCalls`, and `pendingWrites` are all size-capped; a turn that never
  reaches `agent_end` is evicted rather than leaked.

## Development

```bash
npm run build     # tsc -> dist/
npm test          # vitest
```

`openclaw plugins build` and `openclaw plugins validate` do **not** work here. Those
commands belong to the `defineToolPlugin` scaffold's generated-metadata path; this is a
`definePluginEntry` hook-only plugin, so `openclaw.plugin.json` is written by hand and
those commands fail with "plugin entry does not expose defineToolPlugin metadata".

Verify a build against the running gateway instead:

```bash
openclaw plugins inspect usage-logger --runtime --json
```

Check `"status": "loaded"`, `"hookCount": 7`, an empty `diagnostics` array, and
`"dependencyStatus": { "hasDependencies": false }`. A non-empty `diagnostics` usually
means a hook was blocked by a missing permission.

`openclaw` is a **peerDependency**, not a dependency. Declaring it as a regular
dependency causes npm to install an entire second copy of OpenClaw into the plugin's
`node_modules`, which is how the discovery-root failure above happens.

## Troubleshooting

**No rows appear.** Check the gateway log for `[usage-logger]` lines:

```bash
journalctl --user -u openclaw-gateway.service -f | grep usage-logger
```

The plugin warns explicitly when `workspaceDir` is missing from the hook context and
when a write fails.

**Rows appear with empty columns.** Increase `flushDelayMs`. See the ordering note above.

**Rows land in the wrong file.** `logPath` is relative to the workspace directory
(`~/.openclaw/workspace` by default), not to the vault or the plugin. With no `config`
block at all the default `logs/usage.md` is used, which is easy to miss.

## License

MIT

