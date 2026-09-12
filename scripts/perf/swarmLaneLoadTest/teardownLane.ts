import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATA_DIR = path.join(REPO_ROOT, "_artifacts/swarm-lane-test-env/data");

/**
 * Wipes the Swarm Lane test environment's DATA_DIR (mock connections, combo,
 * and any persisted circuit-breaker/cooldown state). Run this after a testing
 * session to fully reset, or when carried-over breaker state would corrupt
 * the next run's measurements. `run.ts` already does this by default before
 * each run (`--reuse-env` opts out) — this script is for a standalone reset
 * without also starting a new run.
 */
async function main() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  console.log(`Removed ${DATA_DIR}`);
}

await main();
