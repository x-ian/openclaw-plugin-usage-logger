import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs/promises";
import path from "node:path";

// --- Config -----------------------------------------------------------------

const configSchema = buildJsonPluginConfigSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    logPath: {
      type: "string",
      default: "logs/usage.md",
      description: "Log file path, relative to the workspace directory.",
    },
    timeZone: {
      type: "string",
      default: "Europe/Berlin",
      description: "IANA time zone for timestamps.",
    },
    maxPromptLen: {
      type: "integer",
      default: 300,
      minimum: 0,
      description: "Truncate logged prompts to this many characters (0 = no limit).",
    },
    maxTrackedRuns: {
      type: "integer",
      default: 200,
      minimum: 1,
      description: "Maximum in-flight turns held in memory.",
    },
    maxPendingCalls: {
      type: "integer",
      default: 500,
      minimum: 1,
      description: "Maximum staged tool calls held in memory.",
    },
    flushDelayMs: {
      type: "integer",
      default: 750,
      minimum: 0,
      description:
        "Delay between agent_end and writing the row, so late llm_output events are included.",
    },
    inboundClaimWindowMs: {
      type: "integer",
      default: 120000,
      minimum: 0,
      description:
        "How long a group-chat inbound message stays claimable by a later agent run.",
    },
  },
});

type PluginConfig = {
  logPath: string;
  timeZone: string;
  maxPromptLen: number;
  maxTrackedRuns: number;
  maxPendingCalls: number;
  flushDelayMs: number;
  inboundClaimWindowMs: number;
};

const DEFAULTS: PluginConfig = {
  logPath: "logs/usage.md",
  timeZone: "Europe/Berlin",
  maxPromptLen: 300,
  maxTrackedRuns: 200,
  maxPendingCalls: 500,
  flushDelayMs: 750,
  inboundClaimWindowMs: 120_000,
};

/** Narrow the untyped `api.pluginConfig` bag into a fully populated config. */
function readConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const r = raw ?? {};
  const str = (k: keyof PluginConfig, d: string): string => {
    const v = r[k];
    return typeof v === "string" && v.length > 0 ? v : d;
  };
  const int = (k: keyof PluginConfig, d: number): number => {
    const v = r[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d;
  };
  return {
    logPath: str("logPath", DEFAULTS.logPath),
    timeZone: str("timeZone", DEFAULTS.timeZone),
    maxPromptLen: int("maxPromptLen", DEFAULTS.maxPromptLen),
    maxTrackedRuns: int("maxTrackedRuns", DEFAULTS.maxTrackedRuns),
    maxPendingCalls: int("maxPendingCalls", DEFAULTS.maxPendingCalls),
    flushDelayMs: int("flushDelayMs", DEFAULTS.flushDelayMs),
    inboundClaimWindowMs: int("inboundClaimWindowMs", DEFAULTS.inboundClaimWindowMs),
  };
}

const HEADER =
  "| Time | Model | Tokens | Dur | OK | Prompt | Files |\n" +
  "|---|---|---|---|---|---|---|\n";

// --- Helpers ----------------------------------------------------------------

/**
 * Fallback for tools where the host provides no `derivedPaths`.
 * Key names are tool-dependent, hence the several variants.
 */
function extractPaths(input: unknown, depth = 0): string[] {
  if (depth > 4 || !input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const keys = ["path", "file_path", "filePath", "file", "target", "notebook_path"];
  const out: string[] = [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  for (const nested of [rec.edits, rec.files, rec.changes]) {
    if (Array.isArray(nested)) {
      for (const e of nested) out.push(...extractPaths(e, depth + 1));
    }
  }
  return out;
}

/**
 * Last-resort cleanup of the inbound envelope core prepends to channel prompts.
 * Only reached when neither a runId-bearing nor a sessionKey-staged inbound
 * message was available. Deliberately imperfect.
 */
function stripEnvelope(prompt: string): string {
  return prompt
    .replace(/```json[\s\S]*?```/g, " ") // fenced metadata blocks
    .replace(/^\s*\[[^\]]{8,60}\]\s*/, "") // leading timestamp
    .replace(/^[A-Z][^\n:]{0,60}\(untrusted[^)]*\):\s*$/gm, " ") // section labels
    .replace(/^#(?:\d+|session:[0-9a-f]+)\s.*$/gm, " ") // history transcript lines
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse whitespace and trim. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Escape and clamp a markdown table cell. */
function cell(value: string, maxLen: number): string {
  const flat = value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();
  return maxLen > 0 && flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

/** True when `target` resolves inside `root`. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

type TurnState = {
  prompt?: string;
  model?: string;
  tokens: number;
  files: Set<string>;
  seenAt: number;
};

/** Everything agent_end knows; held until the deferred flush fires. */
type TurnOutcome = {
  durationMs?: number;
  success: boolean;
  workspaceDir: string;
  fallbackModelId?: string;
  fallbackProviderId?: string;
};

// --- Plugin -----------------------------------------------------------------

const plugin = definePluginEntry({
  id: "usage-logger",
  name: "Usage Logger",
  description: "Logs agent telemetry to an Obsidian vault as a markdown table",
  configSchema,

  register(api) {
    const cfg = readConfig(api.pluginConfig);

    // Per-turn state, correlated by runId (stable across llm_input,
    // llm_output, after_tool_call and agent_end).
    const turns = new Map<string, TurnState>();

    // derivedPaths only exists on before_tool_call, but is committed only
    // after a successful after_tool_call -> staging area.
    const pendingCalls = new Map<string, { runId?: string; paths: string[] }>();

    // agent_end can fire BEFORE llm_output for the same runId, so the row is
    // written on a short timer instead of immediately.
    const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

    // Group-chat inbound arrives with no runId (the run does not exist yet),
    // so content is staged per sessionKey and claimed by llm_input, which sees
    // both ids. Heuristic: with several messages between trigger and run start,
    // the wrong one can be claimed.
    const recentInbound = new Map<string, { content: string; at: number }>();

    // Serializes appends so concurrent runs cannot interleave rows.
    let writeQueue: Promise<void> = Promise.resolve();

    function getTurn(runId: string): TurnState {
      let t = turns.get(runId);
      if (!t) {
        t = { tokens: 0, files: new Set(), seenAt: Date.now() };
        turns.set(runId, t);
      }
      t.seenAt = Date.now();
      return t;
    }

    // Guard against leaks: turns/calls/inbound that never reach their end
    // (crash, abort, message that never triggers a run) would otherwise stay
    // in memory forever.
    function evictStale(): void {
      if (turns.size > cfg.maxTrackedRuns) {
        const sorted = [...turns.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
        for (const [k] of sorted.slice(0, turns.size - cfg.maxTrackedRuns)) {
          const timer = pendingWrites.get(k);
          if (timer) {
            clearTimeout(timer);
            pendingWrites.delete(k);
          }
          turns.delete(k);
        }
      }

      if (pendingCalls.size > cfg.maxPendingCalls) {
        let excess = pendingCalls.size - cfg.maxPendingCalls;
        for (const k of pendingCalls.keys()) {
          if (excess-- <= 0) break;
          pendingCalls.delete(k);
        }
      }

      const cutoff = Date.now() - cfg.inboundClaimWindowMs;
      for (const [k, v] of recentInbound) {
        if (v.at < cutoff) recentInbound.delete(k);
      }
    }

    /** Resolve the log file, refusing to escape the workspace. */
    function resolveLogFile(workspaceDir: string): string | undefined {
      const root = path.resolve(workspaceDir);
      const target = path.resolve(root, cfg.logPath);
      if (!isInside(root, target)) {
        api.logger.error(
          `[usage-logger] logPath escapes the workspace, refusing to write: ${cfg.logPath}`,
        );
        return undefined;
      }
      return target;
    }

    async function appendRow(filePath: string, row: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let needsHeader = false;
      try {
        const stat = await fs.stat(filePath);
        needsHeader = stat.size === 0;
      } catch {
        needsHeader = true;
      }
      await fs.appendFile(filePath, needsHeader ? HEADER + row : row, "utf8");
    }

    /** Build one markdown row and queue it for append. */
    function writeRow(state: TurnState | undefined, outcome: TurnOutcome): void {
      const filePath = resolveLogFile(outcome.workspaceDir);
      if (!filePath) return;

      const timestamp = new Date()
        .toLocaleString("sv-SE", { timeZone: cfg.timeZone })
        .substring(0, 16);

      const model =
        state?.model ??
        (outcome.fallbackModelId
          ? outcome.fallbackProviderId
            ? `${outcome.fallbackProviderId}/${outcome.fallbackModelId}`
            : outcome.fallbackModelId
          : "unknown");

      const duration =
        typeof outcome.durationMs === "number"
          ? `${(outcome.durationMs / 1000).toFixed(1)}s`
          : "-";

      const files =
        [...(state?.files ?? [])]
          .map((f) => {
            const rel = path.isAbsolute(f)
              ? path.relative(outcome.workspaceDir, f).split(path.sep).join("/")
              : f;
            return `\`${cell(rel, 0)}\``;
          })
          .join(", ") || "None";

      const row =
        `| ${timestamp} | ${cell(model, 0)} | ${state?.tokens ?? 0} | ${duration} | ` +
        `${outcome.success ? "✅" : "❌"} | ` +
        `${cell(state?.prompt ?? "No prompt available", cfg.maxPromptLen)} | ${files} |\n`;

      writeQueue = writeQueue
        .then(() => appendRow(filePath, row))
        .catch((err) => {
          api.logger.error(`[usage-logger] failed to write row: ${String(err)}`);
        });
    }

    /**
     * Wait briefly after agent_end so a late llm_output for the same run is
     * still counted, then emit the row. A second agent_end for the same run
     * simply restarts the timer.
     */
    function scheduleFlush(runId: string, outcome: TurnOutcome): void {
      const existing = pendingWrites.get(runId);
      if (existing) clearTimeout(existing);

      if (cfg.flushDelayMs === 0) {
        const state = turns.get(runId);
        turns.delete(runId);
        writeRow(state, outcome);
        return;
      }

      const timer = setTimeout(() => {
        pendingWrites.delete(runId);
        const state = turns.get(runId);
        turns.delete(runId);
        writeRow(state, outcome);
      }, cfg.flushDelayMs);

      // Do not hold the event loop open on shutdown.
      (timer as { unref?: () => void }).unref?.();
      pendingWrites.set(runId, timer);
    }

    // Preferred prompt source: the raw inbound message, before core wraps it in
    // the metadata envelope. Direct chats carry a runId; group chats do not, so
    // those are staged by sessionKey for llm_input to claim.
    api.on("message_received", async (event) => {
      const content = event.content ? flatten(event.content) : "";
      if (!content) return;

      if (event.runId) {
        const t = getTurn(event.runId);
        t.prompt ??= content;
      } else if (event.sessionKey) {
        recentInbound.set(event.sessionKey, { content, at: Date.now() });
      }

      evictStale();
    });

    // Claim a staged inbound message, or fall back to the envelope. Also the
    // model fallback for turns where llm_output never lands.
    api.on("llm_input", async (event, ctx) => {
      const t = getTurn(event.runId);

      if (!t.prompt && ctx.sessionKey) {
        const staged = recentInbound.get(ctx.sessionKey);
        if (staged && Date.now() - staged.at < cfg.inboundClaimWindowMs) {
          recentInbound.delete(ctx.sessionKey);
          t.prompt = staged.content;
        }
      }

      t.prompt ??= stripEnvelope(event.prompt);
      t.model ??= `${event.provider}/${event.model}`;
      evictStale();
    });

    // Model and tokens. One turn can contain several LLM calls (tool loops,
    // retries, compaction) -> tokens are summed. resolvedRef wins over the
    // llm_input fallback because it keeps the provider prefix.
    api.on("llm_output", async (event) => {
      const t = getTurn(event.runId);

      t.prompt ??= event.prompt;
      t.model = event.resolvedRef ?? t.model ?? `${event.provider}/${event.model}`;

      const u = event.usage;
      if (u) {
        // `total` is optional; otherwise input+output. cacheRead/cacheWrite
        // are deliberately excluded (billed differently).
        t.tokens += u.total ?? (u.input ?? 0) + (u.output ?? 0);
      }

      evictStale();
    });

    // Stage paths. derivedPaths is the host's own derivation (e.g. for
    // apply_patch), extractPaths the fallback for unknown tools.
    api.on("before_tool_call", async (event, ctx) => {
      const key = event.toolCallId ?? ctx.toolCallId;
      if (!key) return;
      const derived = event.derivedPaths ? [...event.derivedPaths] : [];
      const paths = derived.length > 0 ? derived : extractPaths(event.params);
      if (paths.length === 0) return;
      pendingCalls.set(key, { runId: ctx.runId ?? event.runId, paths });
      evictStale();
    });

    // Commit only after a successful call.
    api.on("after_tool_call", async (event, ctx) => {
      const key = event.toolCallId ?? ctx.toolCallId;
      const pending = key ? pendingCalls.get(key) : undefined;
      if (key) pendingCalls.delete(key);
      if (event.error) return; // do not count failed tool calls

      const runId = ctx.runId ?? event.runId ?? pending?.runId;
      if (!runId) return;

      const paths = pending?.paths ?? extractPaths(event.params);
      if (paths.length === 0) return;

      const t = getTurn(runId);
      for (const p of paths) t.files.add(p);
      evictStale();
    });

    // One row per turn, written after a short delay.
    api.on("agent_end", async (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) {
        api.logger.warn("[usage-logger] agent_end without runId, skipping row");
        return;
      }

      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) {
        api.logger.warn("[usage-logger] no workspaceDir in context, skipping row");
        turns.delete(runId);
        return;
      }

      scheduleFlush(runId, {
        durationMs: event.durationMs,
        success: event.success,
        workspaceDir,
        fallbackModelId: ctx.modelId,
        fallbackProviderId: ctx.modelProviderId,
      });
    });

    // Drain outstanding writes so shutdown does not truncate a row mid-append.
    api.on("gateway_stop", async () => {
      for (const [runId, timer] of pendingWrites) {
        clearTimeout(timer);
        pendingWrites.delete(runId);
      }
      recentInbound.clear();
      await writeQueue;
    });
  },
});

export default plugin;

