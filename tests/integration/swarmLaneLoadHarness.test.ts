import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSwarmLaneTestEnv, type SwarmLaneTestEnv } from "../../scripts/perf/swarmLaneLoadTest/testEnv.ts";
import { getScenario } from "../../scripts/perf/swarmLaneLoadTest/scenarios.ts";
import { getFreePort } from "../fixtures/fakeOpenAiRelay.ts";

/**
 * Regression guard for the Swarm Lane load-test harness itself (not a
 * production-code test) — proves the harness actually exercises fallover and
 * observability correctly, rather than just "ran locally without a test".
 * Exploratory load-testing sessions are manual, via `npm run loadtest:swarm-lane`.
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-swarm-lane-harness-"));
let env: SwarmLaneTestEnv | undefined;

test.after(async () => {
  if (env) await env.stop();
  await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.equal(fs.existsSync(TEST_DATA_DIR), false, "teardown must remove the isolated DATA_DIR");
});

test("hard-outage scenario: combo falls over and the downed target's failures surface via monitoring", async () => {
  const port = await getFreePort();
  env = await startSwarmLaneTestEnv({ dataDir: TEST_DATA_DIR, port });

  const scenario = getScenario("hard-outage");
  scenario.setup(env);
  const downedPrefix = env.targets[0].prefix;
  const downedProviderId = `openai-compatible-chat-${downedPrefix}`;

  const results = await Promise.all(
    Array.from({ length: 80 }, () =>
      fetch(`${env!.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env!.comboModel,
          stream: false,
          messages: [{ role: "user", content: "harness regression probe" }],
        }),
        signal: AbortSignal.timeout(20_000),
      }).then((r) => r.status)
    )
  );

  assert.ok(
    results.every((status) => status === 200),
    `expected every request to succeed via fallover, got statuses: ${JSON.stringify(results)}`
  );

  // /api/monitoring/health always requires real management auth by design
  // (GHSA-mvf8-qc78-5mxm), so it only ever returns {status} for an
  // unauthenticated caller — /api/providers/health-matrix has no such
  // hardening (gated by the ordinary requireLogin=false setting) and already
  // nests per-provider circuit-breaker state with per-connection cooldown.
  const matrix = await fetch(`${env.baseUrl}/api/providers/health-matrix`).then((r) => r.json());
  const downedEntry = matrix.providers.find(
    (p: { provider?: string }) => p.provider === downedProviderId
  );
  assert.ok(downedEntry, `expected a health-matrix entry for ${downedProviderId}`);
  assert.ok(
    downedEntry.issueCount >= 1,
    `expected the downed target to show at least one issue, got ${JSON.stringify(downedEntry)}`
  );
  assert.equal(
    downedEntry.accounts[0].lastErrorType,
    "server_error",
    "the downed connection's last error should be classified as a server error (503)"
  );

  const healthyEntry = matrix.providers.find(
    (p: { provider?: string }) => p.provider === `openai-compatible-chat-${env!.targets[1].prefix}`
  );
  if (healthyEntry) {
    assert.equal(healthyEntry.circuitBreaker.state, "CLOSED", "a healthy target's breaker should stay CLOSED");
  }
});
