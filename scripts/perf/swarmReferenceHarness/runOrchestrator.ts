// Master Orchestrator traffic generator (CONTEXT.md's Pattern 1): calls the
// "master-orchestrator-lane" combo repeatedly over a duration, deliberately
// at LOW concurrency (default 1) — CONTEXT.md describes real Master
// Orchestrator traffic as "low volume, sequential", which is also the
// realistic shape for the Lane-isolation-under-contention question: a light,
// latency-sensitive caller sharing a free-tier pool with a heavy one (the
// Swarm Lane).
//
// Model default is "master-orchestrator-lane" — a plain `priority`-strategy
// combo (Claude first, free-tier connections as ordered fallback), NOT
// auto/thrifty. Confirmed empirically 2026-09-13: auto/thrifty and even
// auto/subscription route to free-tier Groq by default even with the real
// Anthropic subscription fully healthy — tierPriority/tierAffinity are minor
// weighted factors (checked every profile in
// open-sse/services/autoCombo/modePacks.ts, max 0.0476), not a hard
// "prefer subscription" override, so cost/health/latency easily win instead.
// This dedicated combo (created via a real POST /api/combos call, id
// 5ea8eba6-75e2-4171-8a54-3f2472c2a246) is purely additive — auto/thrifty and
// every other auto/* id are completely untouched, still available and
// unchanged for anything that wants that scoring behavior.
//
// Run this ALONE first for a clean baseline, then concurrently with
// `npm run swarm-lane:run-real` (heavy load) to see whether Swarm Lane
// traffic degrades the orchestrator's Rung 2 fallback latency/success when
// Rung 0 (the real Anthropic subscription) is forced unavailable — see
// forceRungZeroCooldown.ts and the plan at
// /Users/nathan/.claude/plans/steady-dazzling-backus.md.
//
// Usage (put OMNIROUTE_URL / OMNIROUTE_API_KEY in this worktree's .env if needed):
//   npm run swarm-lane:run-orchestrator -- --duration 30s --concurrency 1
// A plain `node` invocation does not read .env on its own — pass
// --env-file=.env yourself if you invoke this file directly instead.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASE_URL = process.env.OMNIROUTE_URL || "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY || "";

function parseArgs(argv: string[]) {
  const args = {
    durationMs: 30_000,
    concurrency: 1,
    model: "master-orchestrator-lane",
    exhaustionBackoffMs: 5_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--duration") args.durationMs = parseDuration(argv[++i]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--exhaustion-backoff-ms") args.exhaustionBackoffMs = Number(argv[++i]);
  }
  return args;
}

function parseDuration(raw: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw ?? "");
  if (!match) throw new Error(`Invalid --duration "${raw}" (expected e.g. "30s", "2m", "500ms")`);
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "m") return value * 60_000;
  if (unit === "s") return value * 1_000;
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CallRecord {
  ts: number;
  elapsedMs: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  exhaustionRetries: number;
  servedByProvider?: string;
  servedByModel?: string;
  error?: string;
}

type CallResult =
  | { ok: true; status: number; headers: Headers; json: Record<string, unknown>; latencyMs: number }
  | { ok: false; status: 0; error: string; latencyMs: number };

// Never throws — see runSwarm.ts's identical rationale (real providers can be
// genuinely slow; a timeout must be a recorded result, not a crashed process).
async function callOnce(model: string): Promise<CallResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 200,
        messages: [{ role: "user", content: "Reply with only the word ok." }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    return { ok: res.ok, status: res.status, headers: res.headers, json, latencyMs };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

async function callWithExhaustionRetry(
  model: string,
  exhaustionBackoffMs: number,
  startedAt: number,
  onResult: (r: CallRecord) => void
) {
  let exhaustionRetries = 0;
  for (;;) {
    const result = await callOnce(model);
    const ts = Date.now();
    if (result.ok) {
      onResult({
        ts,
        elapsedMs: ts - startedAt,
        ok: true,
        status: result.status,
        latencyMs: result.latencyMs,
        exhaustionRetries,
        servedByProvider: result.headers.get("x-omniroute-provider") ?? undefined,
        servedByModel: result.headers.get("x-omniroute-model") ?? undefined,
      });
      return;
    }
    if (result.status === 503 && result.json?.error?.code === "ALL_TARGETS_SKIPPED") {
      exhaustionRetries += 1;
      console.log(
        `Orchestrator call: all targets exhausted, pausing ${exhaustionBackoffMs}ms (retry #${exhaustionRetries})`
      );
      await sleep(exhaustionBackoffMs);
      continue;
    }
    onResult({
      ts,
      elapsedMs: ts - startedAt,
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      exhaustionRetries,
      error: result.status === 0 ? result.error : JSON.stringify(result.json).slice(0, 300),
    });
    return;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results: CallRecord[] = [];

  const runDir = path.join(REPO_ROOT, "_artifacts/swarm-reference-harness");
  await fsp.mkdir(runDir, { recursive: true });
  const resultsStream = fs.createWriteStream(path.join(runDir, "orchestrator-results.jsonl"));

  console.log(
    `Running Master Orchestrator traffic against "${args.model}" @ ${BASE_URL} for ${args.durationMs}ms (concurrency ${args.concurrency})`
  );

  const startedAt = Date.now();
  const workers = Array.from({ length: args.concurrency }, async () => {
    while (Date.now() - startedAt < args.durationMs) {
      await callWithExhaustionRetry(args.model, args.exhaustionBackoffMs, startedAt, (r) => {
        results.push(r);
        resultsStream.write(JSON.stringify(r) + "\n");
      });
    }
  });
  await Promise.all(workers);
  resultsStream.end();

  const succeeded = results.filter((r) => r.ok);
  const latencies = succeeded.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length ? latencies[Math.floor((latencies.length - 1) * p)] : 0;
  const providerCounts = new Map<string, number>();
  for (const r of succeeded) {
    const key = r.servedByProvider ?? "unknown";
    providerCounts.set(key, (providerCounts.get(key) ?? 0) + 1);
  }
  // Confirmed 2026-09-13: OmniRoute's x-omniroute-provider header reports the
  // real Claude connection as "cc" (an internal canonical alias), not "claude".
  const fellOverToRung2 = succeeded.some((r) => r.servedByProvider && r.servedByProvider !== "cc");

  const summary = [
    `Calls: ${results.length}  Succeeded: ${succeeded.length} (${(
      (100 * succeeded.length) /
      Math.max(1, results.length)
    ).toFixed(1)}%)`,
    `Latency (ms) — p50: ${pct(0.5)}  p90: ${pct(0.9)}  max: ${latencies.at(-1) ?? 0}`,
    `Served-by provider: ${JSON.stringify(Object.fromEntries(providerCounts))}`,
    `Fell over to Rung 2 (non-claude) at least once: ${fellOverToRung2}`,
    `Results: ${path.join(runDir, "orchestrator-results.jsonl")}`,
  ].join("\n");
  console.log("\n" + summary);
}

await main();
