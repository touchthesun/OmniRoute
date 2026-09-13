// Minimal reference implementation of the Swarm pattern (CONTEXT.md's
// Pattern 2): a pool of stateless, ephemeral subagents, each calling the
// Swarm Lane combo. Demonstrates the one thing OmniRoute explicitly leaves to
// the caller (ADR-0001): when every target is exhausted (503
// ALL_TARGETS_SKIPPED), the harness pauses that unit of work and retries
// later, rather than treating it as a hard failure.
//
// Usage (put OMNIROUTE_URL / OMNIROUTE_API_KEY in this worktree's .env if needed):
//   npm run swarm-lane:run-real -- --tasks 12 --concurrency 3
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
  const args = { tasks: 12, concurrency: 3, combo: "swarm-lane-real", exhaustionBackoffMs: 5_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tasks") args.tasks = Number(argv[++i]);
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--combo") args.combo = argv[++i];
    else if (arg === "--exhaustion-backoff-ms") args.exhaustionBackoffMs = Number(argv[++i]);
  }
  return args;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Task {
  id: number;
  prompt: string;
}

interface TaskResult {
  taskId: number;
  ts: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  exhaustionRetries: number;
  servedByProvider?: string;
  servedByModel?: string;
  error?: string;
}

function buildTasks(count: number): Task[] {
  // Deliberately tiny/cheap prompts — this is a reference smoke test against
  // real free-tier providers, not a real workload. Keep token cost minimal.
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    prompt: `Reply with only the word "ack" and the number ${i}.`,
  }));
}

type CallResult =
  | { ok: true; status: number; headers: Headers; json: Record<string, unknown>; latencyMs: number }
  | { ok: false; status: 0; error: string; latencyMs: number };

// Never throws — a timeout or network failure (a real possibility against
// real free-tier providers, some documented as taking minutes) is reported
// as a normal failed result, the same as an HTTP error status, rather than
// crashing the whole run via an unhandled rejection.
async function callOnce(comboName: string, task: Task): Promise<CallResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: comboName,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: task.prompt }],
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

async function runTask(
  comboName: string,
  task: Task,
  exhaustionBackoffMs: number,
  onResult: (r: TaskResult) => void
) {
  let exhaustionRetries = 0;
  for (;;) {
    const result = await callOnce(comboName, task);

    if (result.ok) {
      // Authoritative routing info from OmniRoute's own response headers —
      // not the response content, which real providers don't echo back
      // identifiably (that trick only worked against the mock relay, which
      // we fully controlled).
      onResult({
        taskId: task.id,
        ts: Date.now(),
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
        `Task ${task.id}: all Swarm Lane targets exhausted, pausing ${exhaustionBackoffMs}ms (retry #${exhaustionRetries})`
      );
      await sleep(exhaustionBackoffMs);
      continue; // same task, try again
    }

    onResult({
      taskId: task.id,
      ts: Date.now(),
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      exhaustionRetries,
      error: result.status === 0 ? result.error : JSON.stringify(result.json).slice(0, 300),
    });
    return; // a real (non-exhaustion) failure — don't retry forever
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = buildTasks(args.tasks);
  const results: TaskResult[] = [];

  const runDir = path.join(REPO_ROOT, "_artifacts/swarm-reference-harness");
  await fsp.mkdir(runDir, { recursive: true });
  const resultsStream = fs.createWriteStream(path.join(runDir, "results.jsonl"));

  console.log(`Running ${tasks.length} task(s) against combo "${args.combo}" @ ${BASE_URL} (concurrency ${args.concurrency})`);

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(args.concurrency, tasks.length) }, async () => {
    for (;;) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      await runTask(args.combo, tasks[i], args.exhaustionBackoffMs, (r) => {
        results.push(r);
        resultsStream.write(JSON.stringify(r) + "\n");
      });
    }
  });
  await Promise.all(workers);
  resultsStream.end();

  const succeeded = results.filter((r) => r.ok);
  const totalExhaustionRetries = results.reduce((sum, r) => sum + r.exhaustionRetries, 0);
  const providerCounts = new Map<string, number>();
  for (const r of succeeded) {
    const key = r.servedByProvider ?? "unknown";
    providerCounts.set(key, (providerCounts.get(key) ?? 0) + 1);
  }
  const summary = [
    `Tasks: ${results.length}  Succeeded: ${succeeded.length} (${(
      (100 * succeeded.length) /
      Math.max(1, results.length)
    ).toFixed(1)}%)`,
    `Total exhaustion pauses across all tasks: ${totalExhaustionRetries}`,
    `Served-by provider: ${JSON.stringify(Object.fromEntries(providerCounts))}`,
    `Results: ${path.join(runDir, "results.jsonl")}`,
  ].join("\n");
  console.log("\n" + summary);
}

await main();
