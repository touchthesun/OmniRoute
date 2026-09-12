import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSwarmLaneTestEnv, type SwarmLaneTestEnv } from "./testEnv.ts";
import { getScenario } from "./scenarios.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA_DIR = path.join(REPO_ROOT, "_artifacts/swarm-lane-test-env/data");
const RUNS_DIR = path.join(REPO_ROOT, "_artifacts/swarm-lane-test-env/runs");

function parseArgs(argv: string[]) {
  const args = {
    scenario: "concurrency-ramp",
    concurrency: 5,
    durationMs: 20_000,
    pollMs: 1_000,
    fresh: true,
    keepAlive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario") args.scenario = argv[++i];
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--duration") args.durationMs = parseDuration(argv[++i]);
    else if (arg === "--poll-ms") args.pollMs = Number(argv[++i]);
    else if (arg === "--reuse-env") args.fresh = false;
    else if (arg === "--keep-alive") args.keepAlive = true;
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

interface RequestLogEntry {
  ts: number;
  elapsedMs: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  servedBy?: string;
  error?: string;
}

async function sendOneRequest(env: SwarmLaneTestEnv, startedAt: number): Promise<RequestLogEntry> {
  const requestStart = performance.now();
  const ts = Date.now();
  try {
    const response = await fetch(`${env.baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.comboModel,
        stream: false,
        messages: [{ role: "user", content: "swarm lane load test probe" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Math.round(performance.now() - requestStart);
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    const content: string | undefined = json?.choices?.[0]?.message?.content;
    const servedBy = content?.split(" ")[0];
    return {
      ts,
      elapsedMs: ts - startedAt,
      ok: response.ok,
      status: response.status,
      latencyMs,
      servedBy,
      error: response.ok ? undefined : JSON.stringify(json).slice(0, 300),
    };
  } catch (error) {
    return {
      ts,
      elapsedMs: ts - startedAt,
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - requestStart),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchHealthSnapshot(env: SwarmLaneTestEnv) {
  // /api/monitoring/health always requires real management auth by design
  // (GHSA-mvf8-qc78-5mxm — it fingerprints the host) regardless of the
  // requireLogin=false test setting, so it only ever returns {status} here.
  // /api/providers/health-matrix has no such hardening and already nests
  // per-provider circuit-breaker state with per-connection cooldown/lockout
  // detail — everything this harness needs from one call.
  const matrix = await fetch(`${env.baseUrl}/api/providers/health-matrix`, {
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));

  const mockPrefix = "openai-compatible-chat-swarm-mock-";
  const providers = Array.isArray(matrix?.providers)
    ? matrix.providers.filter((p: { provider?: string }) =>
        String(p?.provider ?? "").startsWith(mockPrefix)
      )
    : matrix;

  return { providers };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = getScenario(args.scenario);

  if (args.fresh) {
    await fsp.rm(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`Starting Swarm Lane test env (scenario: ${scenario.name})...`);
  console.log(scenario.description);
  const env = await startSwarmLaneTestEnv({ dataDir: DATA_DIR });
  console.log(`Ready: ${env.baseUrl} (combo: ${env.comboModel})`);

  scenario.setup(env);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_DIR, runId);
  await fsp.mkdir(runDir, { recursive: true });
  const requestsStream = fs.createWriteStream(path.join(runDir, "requests.jsonl"));
  const healthStream = fs.createWriteStream(path.join(runDir, "health-snapshots.jsonl"));

  const startedAt = Date.now();
  let stopPolling = false;
  const pollLoop = (async () => {
    while (!stopPolling) {
      const elapsedMs = Date.now() - startedAt;
      scenario.tick?.(env, elapsedMs);
      const snapshot = await fetchHealthSnapshot(env);
      healthStream.write(JSON.stringify({ ts: Date.now(), elapsedMs, ...snapshot }) + "\n");
      await sleep(args.pollMs);
    }
  })();

  const results: RequestLogEntry[] = [];
  const workers = Array.from({ length: args.concurrency }, async () => {
    while (Date.now() - startedAt < args.durationMs) {
      const entry = await sendOneRequest(env, startedAt);
      results.push(entry);
      requestsStream.write(JSON.stringify(entry) + "\n");
    }
  });
  await Promise.all(workers);

  stopPolling = true;
  await pollLoop;
  requestsStream.end();
  healthStream.end();

  const succeeded = results.filter((r) => r.ok);
  const latencies = succeeded.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length ? latencies[Math.floor((latencies.length - 1) * p)] : 0);
  const servedByCounts = new Map<string, number>();
  for (const r of succeeded) {
    if (r.servedBy) servedByCounts.set(r.servedBy, (servedByCounts.get(r.servedBy) ?? 0) + 1);
  }

  const summaryLines = [
    `Scenario: ${scenario.name}`,
    `Concurrency: ${args.concurrency}  Duration: ${args.durationMs}ms`,
    `Requests: ${results.length}  Succeeded: ${succeeded.length} (${(
      (100 * succeeded.length) /
      Math.max(1, results.length)
    ).toFixed(1)}%)`,
    `Latency (ms) — p50: ${pct(0.5)}  p90: ${pct(0.9)}  p99: ${pct(0.99)}  max: ${latencies.at(-1) ?? 0}`,
    `Served-by distribution: ${JSON.stringify(Object.fromEntries(servedByCounts))}`,
    `Artifacts: ${runDir}`,
  ];
  const summary = summaryLines.join("\n");
  await fsp.writeFile(path.join(runDir, "summary.txt"), summary + "\n");
  console.log("\n" + summary);

  if (!args.keepAlive) {
    await env.stop();
  } else {
    console.log(`\n--keep-alive set: leaving ${env.baseUrl} running. Stop it manually when done.`);
  }
}

await main();
