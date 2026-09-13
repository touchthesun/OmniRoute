// Minimal reference implementation of the Swarm pattern (CONTEXT.md's
// Pattern 2): a pool of stateless, ephemeral subagents, each calling the
// Swarm Lane combo. Demonstrates the one thing OmniRoute explicitly leaves to
// the caller (ADR-0001): when every target is exhausted (503
// ALL_TARGETS_SKIPPED), the harness pauses that unit of work and retries
// later, rather than treating it as a hard failure.
//
// Usage:
//   OMNIROUTE_URL=http://localhost:20128 OMNIROUTE_API_KEY=... \
//   node --import tsx/esm scripts/perf/swarmReferenceHarness/runSwarm.ts --tasks 12 --concurrency 3

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
  servedBy?: string;
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

async function callOnce(comboName: string, task: Task) {
  const started = performance.now();
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
  return { res, json, latencyMs };
}

async function runTask(
  comboName: string,
  task: Task,
  exhaustionBackoffMs: number,
  onResult: (r: TaskResult) => void
) {
  let exhaustionRetries = 0;
  for (;;) {
    const { res, json, latencyMs } = await callOnce(comboName, task);
    if (res.ok) {
      const content: string | undefined = json?.choices?.[0]?.message?.content;
      onResult({
        taskId: task.id,
        ts: Date.now(),
        ok: true,
        status: res.status,
        latencyMs,
        exhaustionRetries,
        servedBy: content,
      });
      return;
    }

    if (res.status === 503 && json?.error?.code === "ALL_TARGETS_SKIPPED") {
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
      status: res.status,
      latencyMs,
      exhaustionRetries,
      error: JSON.stringify(json).slice(0, 300),
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
  const summary = [
    `Tasks: ${results.length}  Succeeded: ${succeeded.length} (${(
      (100 * succeeded.length) /
      Math.max(1, results.length)
    ).toFixed(1)}%)`,
    `Total exhaustion pauses across all tasks: ${totalExhaustionRetries}`,
    `Results: ${path.join(runDir, "results.jsonl")}`,
  ].join("\n");
  console.log("\n" + summary);
}

await main();
