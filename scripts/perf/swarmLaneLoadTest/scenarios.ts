import { buildCompletion, buildError } from "../../../tests/fixtures/fakeOpenAiRelay.ts";
import type { SwarmLaneTestEnv } from "./testEnv.ts";

export interface Scenario {
  name: string;
  description: string;
  /** One-time behavior setup, applied before load generation starts. */
  setup(env: SwarmLaneTestEnv): void;
  /** Optional: called on every health-poll tick during the run, to evolve behavior over time. */
  tick?(env: SwarmLaneTestEnv, elapsedMs: number): void;
}

function tokenFor(env: SwarmLaneTestEnv, prefix: string) {
  const target = env.targets.find((t) => t.prefix === prefix);
  if (!target) throw new Error(`Unknown mock target: ${prefix}`);
  return target;
}

const RAMP_WINDOW_MS = 20_000;
const RECOVERY_AFTER_MS = 10_000;

export const SCENARIOS: Record<string, Scenario> = {
  "concurrency-ramp": {
    name: "concurrency-ramp",
    description: "No fault injection — all targets healthy. Ramp concurrency to find the ceiling.",
    setup(env) {
      for (const { token, prefix } of env.targets) {
        env.relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
      }
    },
  },

  "hard-outage": {
    name: "hard-outage",
    description: "One target returns 100% 5xx immediately — confirm the combo falls through.",
    setup(env) {
      const down = tokenFor(env, env.targets[0].prefix);
      env.relay.configureToken(down.token, {
        defaultResponse: buildError(503, "mock hard outage"),
      });
      for (const { token, prefix } of env.targets.slice(1)) {
        env.relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
      }
    },
  },

  "rate-limited": {
    name: "rate-limited",
    description: "One target returns 429 w/ Retry-After — confirm connection cooldown honors it.",
    setup(env) {
      const limited = tokenFor(env, env.targets[0].prefix);
      env.relay.configureToken(limited.token, {
        defaultResponse: buildError(429, "mock rate limit", { "Retry-After": "3" }),
      });
      for (const { token, prefix } of env.targets.slice(1)) {
        env.relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
      }
    },
  },

  "total-blackout": {
    name: "total-blackout",
    description: "Every target down — confirm the request fails with 503 ALL_TARGETS_SKIPPED.",
    setup(env) {
      for (const { token, prefix } of env.targets) {
        env.relay.configureToken(token, {
          defaultResponse: buildError(503, `mock blackout (${prefix})`),
        });
      }
    },
  },

  recovery: {
    name: "recovery",
    description:
      "One target is down, then recovers after " +
      `${RECOVERY_AFTER_MS}ms — measure real HALF_OPEN→CLOSED recovery latency.`,
    setup(env) {
      const flaky = tokenFor(env, env.targets[0].prefix);
      env.relay.configureToken(flaky.token, {
        defaultResponse: buildError(503, "mock outage before recovery"),
      });
      for (const { token, prefix } of env.targets.slice(1)) {
        env.relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
      }
    },
    tick(env, elapsedMs) {
      if (elapsedMs < RECOVERY_AFTER_MS) return;
      const flaky = tokenFor(env, env.targets[0].prefix);
      env.relay.configureToken(flaky.token, {
        defaultResponse: buildCompletion(`${flaky.prefix} recovered`),
      });
    },
  },

  "gradual-degradation": {
    name: "gradual-degradation",
    description: `One target's error rate ramps 0%→100% over ${RAMP_WINDOW_MS}ms.`,
    setup(env) {
      for (const { token, prefix } of env.targets) {
        env.relay.configureToken(token, { defaultResponse: buildCompletion(`${prefix} ok`) });
      }
    },
    tick(env, elapsedMs) {
      const degrading = tokenFor(env, env.targets[0].prefix);
      const failureFraction = Math.min(1, elapsedMs / RAMP_WINDOW_MS);
      const shouldFail = Math.random() < failureFraction;
      env.relay.configureToken(degrading.token, {
        defaultResponse: shouldFail
          ? buildError(503, "mock gradual degradation")
          : buildCompletion(`${degrading.prefix} ok`),
      });
    },
  },
};

export function getScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    const known = Object.keys(SCENARIOS).join(", ");
    throw new Error(`Unknown scenario "${name}". Known scenarios: ${known}`);
  }
  return scenario;
}
