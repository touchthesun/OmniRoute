// Registers real free-tier connections + the real "swarm-lane-real" combo
// against an already-running OmniRoute instance. Idempotent: safe to re-run
// any time a new provider key becomes available.
//
// Usage: put GROQ_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY / CEREBRAS_API_KEY /
// OPENROUTER_API_KEY (whichever you have) and optionally OMNIROUTE_URL /
// OMNIROUTE_API_KEY into this worktree's .env, then:
//   npm run swarm-lane:register-real-providers
//
// A plain `node` invocation does NOT read .env on its own (that's Next.js's
// own loading behavior for the dev server, not something a standalone script
// gets for free) — the npm script above passes `--env-file=.env` for you. If
// you invoke this file directly instead, pass that flag yourself:
//   node --env-file=.env --import tsx/esm scripts/perf/swarmReferenceHarness/registerRealProviders.ts

const BASE_URL = process.env.OMNIROUTE_URL || "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY || "";
const COMBO_NAME = "swarm-lane-real";

function authHeaders(): Record<string, string> {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

async function getJson(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { ...authHeaders() } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function putJson(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PUT ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

interface ProviderSpec {
  provider: string;
  model: string;
  /** If set, this provider needs a real key from this env var before it can be registered. */
  envVar?: string;
}

// Verified against each provider's own registry entry
// (open-sse/config/providers/registry/<id>/index.ts) — not guessed.
//
// aihorde/opencode still support an optional managed connection (POST
// /api/providers succeeds with no apiKey, falling back to the registry's
// anonymousApiKey). duckduckgo-web is deliberately excluded — confirmed
// (2026-09-13 real smoke test) that it actively anti-bot-blocks automated
// requests (HTTP 418 "anti-abuse challenge failed"), not a transient limit —
// its own design intent, not a fit for swarm traffic. See
// `_tasks/freellmapi-integration/2026-09-12-load-test-findings.md`.
//
// aihorde's model roster changes as volunteer workers come/go — the id below
// was confirmed to have an active worker via `GET
// https://oai.aihorde.net/v1/models` (`worker_threads: 1`) at registration
// time, not copied from the registry's static comment (that fallback list
// 404'd with "Not Acceptable" — no worker currently backing it).
const NO_AUTH_PROVIDERS: ProviderSpec[] = [
  { provider: "aihorde", model: "aihorde/koboldcpp/Llama-3.1-8B-Stheno-v3.4" },
  { provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
];

const CONNECTIONLESS_PROVIDERS: ProviderSpec[] = [];

// groq's model id was fixed 2026-09-13: the registry's static
// llama-3.3-70b-versatile 404'd against a real key (POST
// /api/providers/[id]/sync-models confirmed it's gone from Groq's live
// catalog — same "static registry entry can outlive what the provider
// actually still serves" lesson as aihorde above). openai/gpt-oss-120b was
// confirmed live and working with a real call.
const KEYED_PROVIDERS: ProviderSpec[] = [
  { provider: "groq", model: "groq/openai/gpt-oss-120b", envVar: "GROQ_API_KEY" },
  { provider: "gemini", model: "gemini/gemini-2.5-flash", envVar: "GEMINI_API_KEY" },
  { provider: "mistral", model: "mistral/mistral-small-latest", envVar: "MISTRAL_API_KEY" },
  { provider: "cerebras", model: "cerebras/gpt-oss-120b", envVar: "CEREBRAS_API_KEY" },
  { provider: "openrouter", model: "openrouter/auto", envVar: "OPENROUTER_API_KEY" },
];

async function ensureConnection(spec: ProviderSpec, apiKey?: string): Promise<boolean> {
  const existing = await getJson(`/api/providers?provider=${encodeURIComponent(spec.provider)}`);
  if (Array.isArray(existing.connections) && existing.connections.length > 0) {
    return false; // already registered, nothing to do
  }
  await postJson("/api/providers", {
    provider: spec.provider,
    name: `${spec.provider} (swarm lane)`,
    ...(apiKey ? { apiKey } : {}),
  });
  return true;
}

// The server normalizes plain-string model entries into objects on create
// (POST /api/combos), so a re-fetched combo's `models[]` are objects with a
// `.model` field, not bare strings — confirmed via GET /api/combos, not
// assumed. Extract accordingly or every re-run looks like a false "update".
function extractModelStrings(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m === "string" ? m : (m as { model?: unknown })?.model))
    .filter((m): m is string => typeof m === "string");
}

// Declarative, not additive: the combo's models are set to exactly the
// currently-available spec set every run, so removing a provider from the
// spec lists above (e.g. duckduckgo-web, dropped for anti-bot blocking) or
// losing an env var actually takes effect on the next run, not just growth.
async function ensureCombo(desiredModels: string[]) {
  const { combos } = await getJson("/api/combos?limit=200");
  const existing = (combos as Array<{ id: string; name: string; models?: unknown[] }>).find(
    (c) => c.name === COMBO_NAME
  );
  if (!existing) {
    await postJson("/api/combos", { name: COMBO_NAME, strategy: "random", models: desiredModels });
    return { created: true, models: desiredModels };
  }
  const currentModels = extractModelStrings(existing.models);
  const same =
    currentModels.length === desiredModels.length &&
    new Set(currentModels).size === new Set([...currentModels, ...desiredModels]).size;
  if (same) {
    return { created: false, updated: false, models: currentModels };
  }
  await putJson(`/api/combos/${existing.id}`, { models: desiredModels });
  return { created: false, updated: true, models: desiredModels };
}

async function main() {
  const registeredModels: string[] = [];
  const missing: string[] = [];

  for (const spec of NO_AUTH_PROVIDERS) {
    const created = await ensureConnection(spec);
    console.log(`${created ? "Registered" : "Already registered"}: ${spec.provider} (no auth)`);
    registeredModels.push(spec.model);
  }

  for (const spec of CONNECTIONLESS_PROVIDERS) {
    console.log(`No connection needed: ${spec.provider} (connectionless free provider)`);
    registeredModels.push(spec.model);
  }

  for (const spec of KEYED_PROVIDERS) {
    const key = spec.envVar ? process.env[spec.envVar] : undefined;
    if (!key) {
      missing.push(spec.envVar!);
      continue;
    }
    const created = await ensureConnection(spec, key);
    console.log(`${created ? "Registered" : "Already registered"}: ${spec.provider}`);
    registeredModels.push(spec.model);
  }

  const comboResult = await ensureCombo(registeredModels);
  console.log(
    `\nCombo "${COMBO_NAME}": ${
      comboResult.created ? "created" : comboResult.updated ? "updated" : "already up to date"
    } — ${comboResult.models.length} target(s): ${comboResult.models.join(", ")}`
  );

  if (missing.length > 0) {
    console.log(`\nStill missing (set these env vars and re-run to add them): ${missing.join(", ")}`);
  } else {
    console.log("\nAll keyed providers are registered.");
  }
}

await main();
