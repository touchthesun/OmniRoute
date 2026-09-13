// Simulates the real Anthropic subscription connection ("Rung 0" in the Rung
// Ladder / auto/thrifty) becoming unavailable, WITHOUT burning real
// subscription quota or waiting for real exhaustion.
//
// This forces CONNECTION-LEVEL cooldown (rateLimitedUntil in the future),
// which removes the connection from the auto-pool candidate list before the
// Rung Ladder ever evaluates it (open-sse/services/autoCombo/virtualFactory.ts
// — filterResilienceBlockedCandidates). It does NOT exercise the ladder's own
// live-quota signal (resolveFreeAccessState, backed by a real call to
// https://api.anthropic.com/api/oauth/usage) — there is no safe way to fake
// that signal without either real usage or waiting for it. Functionally
// equivalent for testing fallover (Rung 0 unavailable -> Rung 2), but worth
// being precise that this is connection cooldown, not the ladder's own
// quota-based signal specifically.
//
// Recovery is manual (this script's --clear mode) because
// clampCooldownToReset() — the reset-aware fast re-entry path — is confirmed
// still unwired in this codebase (docs/routing/SUBSCRIPTION_LADDER.md).
//
// Usage (put OMNIROUTE_URL / OMNIROUTE_API_KEY in this worktree's .env if needed):
//   npm run swarm-lane:force-rung-zero -- --force --minutes 30
//   npm run swarm-lane:force-rung-zero -- --clear

const BASE_URL = process.env.OMNIROUTE_URL || "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY || "";

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

function parseArgs(argv: string[]) {
  const args = { force: false, clear: false, minutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--clear") args.clear = true;
    else if (argv[i] === "--minutes") args.minutes = Number(argv[++i]);
  }
  if (args.force === args.clear) {
    throw new Error("Pass exactly one of --force or --clear");
  }
  return args;
}

async function findClaudeConnectionId(): Promise<string> {
  const { connections } = await getJson("/api/providers?provider=claude");
  if (!Array.isArray(connections) || connections.length === 0) {
    throw new Error(
      'No "claude" connection found. Connect the real Anthropic subscription via the dashboard first.'
    );
  }
  return connections[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = await findClaudeConnectionId();

  if (args.force) {
    const until = new Date(Date.now() + args.minutes * 60_000).toISOString();
    await putJson(`/api/providers/${id}`, { rateLimitedUntil: until, testStatus: "unavailable" });
    console.log(
      `Forced Rung 0 (claude connection ${id}) into cooldown until ${until} (${args.minutes}min).`
    );
    console.log("Remember to run --clear when the test is done.");
  } else {
    await putJson(`/api/providers/${id}`, { rateLimitedUntil: null, testStatus: "active" });
    console.log(`Cleared simulated cooldown on Rung 0 (claude connection ${id}).`);
  }
}

await main();
