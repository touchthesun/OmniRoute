import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createFakeOpenAiRelay,
  buildCompletion,
  getFreePort,
  type PlannedResponse,
} from "../../../tests/fixtures/fakeOpenAiRelay.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "_artifacts/swarm-lane-test-env/data");
const SWARM_LANE_COMBO_NAME = "swarm-lane-mock";

/**
 * Fixed, deterministic mock connections — same prefixes/tokens every run so a
 * re-used DATA_DIR (skip-reseed path) and a fresh one behave identically, and
 * scenario scripts can address a target by name without querying the DB first.
 */
export const MOCK_TARGETS = Array.from({ length: 8 }, (_, i) => {
  const prefix = `swarm-mock-p${i + 1}`;
  return { prefix, token: `sk-${prefix}`, model: `${prefix}/test-model` };
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerId(prefix: string) {
  return `openai-compatible-chat-${prefix}`;
}

async function seedSwarmLane(dataDir: string, relayBaseUrl: string) {
  process.env.DATA_DIR = dataDir;
  process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
  process.env.REQUIRE_API_KEY = "false";

  const core = await import("../../../src/lib/db/core.ts");
  const providersDb = await import("../../../src/lib/db/providers.ts");
  const combosDb = await import("../../../src/lib/db/combos.ts");
  const settingsDb = await import("../../../src/lib/db/settings.ts");

  const existing = await combosDb.getComboByName(SWARM_LANE_COMBO_NAME);
  if (existing) {
    core.closeDbInstance();
    return;
  }

  for (const { prefix, token } of MOCK_TARGETS) {
    const id = providerId(prefix);
    await providersDb.createProviderNode({
      id,
      type: "openai-compatible",
      name: `Swarm mock ${prefix}`,
      prefix,
      apiType: "chat",
      baseUrl: relayBaseUrl,
    });
    await providersDb.createProviderConnection({
      provider: id,
      authType: "apikey",
      name: `conn-${prefix}`,
      apiKey: token,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl: relayBaseUrl, apiType: "chat" },
    });
  }

  await combosDb.createCombo({
    name: SWARM_LANE_COMBO_NAME,
    strategy: "random",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: MOCK_TARGETS.map((t) => t.model),
  });

  await settingsDb.updateSettings({
    requireLogin: false,
    setupComplete: true,
  });

  core.closeDbInstance();
}

function createServerProcess(dataDir: string, port: number, apiKeySecret: string) {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const child = spawn(process.execPath, ["scripts/dev/run-next-playwright.mjs", "dev"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      DASHBOARD_PORT: String(port),
      API_PORT: String(port),
      HOST: "127.0.0.1",
      REQUIRE_API_KEY: "false",
      API_KEY_SECRET: apiKeySecret,
      DISABLE_SQLITE_AUTO_BACKUP: "true",
      INITIAL_PASSWORD: "",
      NEXT_TELEMETRY_DISABLED: "1",
      OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
      OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK: "true",
      OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK: "true",
      OMNIROUTE_HIDE_HEALTHCHECK_LOGS: "true",
      OMNIROUTE_E2E_BOOTSTRAP_MODE: "open",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });
  child.stdout.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    stdoutLines.push(...lines);
    if (stdoutLines.length > 200) stdoutLines.splice(0, stdoutLines.length - 200);
  });
  child.stderr.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    stderrLines.push(...lines);
    if (stderrLines.length > 200) stderrLines.splice(0, stderrLines.length - 200);
  });

  return {
    child,
    stdoutLines,
    stderrLines,
    baseUrl: `http://127.0.0.1:${port}`,
    get exitInfo() {
      return exitInfo;
    },
  };
}

async function waitForServer(
  baseUrl: string,
  logs: { stdoutLines: string[]; stderrLines: string[]; exitInfo?: unknown }
) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 120_000) {
    if (logs.exitInfo) {
      throw new Error(
        [
          `OmniRoute exited before it became ready: ${JSON.stringify(logs.exitInfo)}`,
          "--- stdout ---",
          ...logs.stdoutLines.slice(-40),
          "--- stderr ---",
          ...logs.stderrLines.slice(-40),
        ].join("\n")
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/monitoring/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(
    [
      `Timed out waiting for OmniRoute to start: ${lastError}`,
      "--- stdout ---",
      ...logs.stdoutLines.slice(-40),
      "--- stderr ---",
      ...logs.stderrLines.slice(-40),
    ].join("\n")
  );
}

async function stopProcess(child: ChildProcess) {
  if (child.killed) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!exited && !child.killed) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

export interface SwarmLaneTestEnvOptions {
  /** Reuse an existing DATA_DIR / seeded connections instead of always starting fresh. */
  dataDir?: string;
  port?: number;
  apiKeySecret?: string;
}

export interface SwarmLaneTestEnv {
  baseUrl: string;
  comboModel: string;
  targets: typeof MOCK_TARGETS;
  relay: ReturnType<typeof createFakeOpenAiRelay>;
  dataDir: string;
  stop(): Promise<void>;
}

/**
 * Starts one fake-upstream relay (in this process) + one dedicated OmniRoute
 * instance (spawned child process, isolated DATA_DIR) pre-seeded with the
 * Swarm Lane's mock connections and combo. Idempotent: re-running against the
 * same `dataDir` skips reseeding and just reconfigures the relay's default
 * (healthy) behavior for every target.
 */
export async function startSwarmLaneTestEnv(
  options: SwarmLaneTestEnvOptions = {}
): Promise<SwarmLaneTestEnv> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  await fsp.mkdir(dataDir, { recursive: true });

  const relay = createFakeOpenAiRelay();
  const relayBaseUrl = await relay.start();
  for (const { prefix, token } of MOCK_TARGETS) {
    relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
  }

  await seedSwarmLane(dataDir, relayBaseUrl);

  const port = options.port ?? (await getFreePort());
  const apiKeySecret = options.apiKeySecret ?? "swarm-lane-load-test-secret-123456";

  const app = createServerProcess(dataDir, port, apiKeySecret);
  await waitForServer(app.baseUrl, app);

  // Warm the chat-completions route up with one sequential request before any
  // concurrent load starts. Next.js dev compiles routes on-demand; several
  // concurrent first-hits to an uncompiled route were observed to leave every
  // subsequent request in the run failing (an HTML error page instead of
  // JSON), not just the first one. One warmup request avoids the race.
  const warmup = await fetch(`${app.baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SWARM_LANE_COMBO_NAME,
      stream: false,
      messages: [{ role: "user", content: "warm up chat route" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!warmup.ok) {
    throw new Error(`Warmup request failed: HTTP ${warmup.status} ${await warmup.text()}`);
  }
  for (const { token } of MOCK_TARGETS) {
    relay.resetState(token, []);
  }

  return {
    baseUrl: app.baseUrl,
    comboModel: SWARM_LANE_COMBO_NAME,
    targets: MOCK_TARGETS,
    relay,
    dataDir,
    async stop() {
      await stopProcess(app.child);
      await relay.stop();
    },
  };
}

export function planFor(status: number, message: string, headers?: Record<string, string>) {
  return { status, headers, body: { error: { message } } } satisfies PlannedResponse;
}

export function resetToHealthy(env: SwarmLaneTestEnv, prefix: string) {
  const target = env.targets.find((t) => t.prefix === prefix);
  if (!target) throw new Error(`Unknown mock target: ${prefix}`);
  env.relay.resetState(target.token, []);
}

if (fs.realpathSync(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const env = await startSwarmLaneTestEnv();
  console.log(`Swarm Lane test env ready: ${env.baseUrl}`);
  console.log(`Combo model: ${env.comboModel}`);
  console.log(`DATA_DIR: ${env.dataDir}`);
  console.log("Press Ctrl+C to stop.");
  process.on("SIGINT", async () => {
    await env.stop();
    process.exit(0);
  });
}
