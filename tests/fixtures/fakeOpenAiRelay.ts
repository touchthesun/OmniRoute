import http from "node:http";
import net from "node:net";

export function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildCompletion(content: string) {
  return {
    status: 200,
    body: {
      id: `chatcmpl_${Math.random().toString(16).slice(2, 8)}`,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    },
  };
}

export function buildError(status: number, message: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers,
    body: { error: { message } },
  };
}

export type PlannedResponse = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  delayMs?: number;
};

export type TokenBehavior = {
  defaultResponse: PlannedResponse;
  queue: PlannedResponse[];
  hits: number;
  startedAt: number[];
  bodies: Array<Record<string, unknown>>;
};

/**
 * A minimal fake OpenAI-compatible upstream, keyed by bearer token so many
 * "virtual providers" can share one relay instance/port. Each token gets a
 * default response plus an optional one-shot queue (consumed in order before
 * falling back to the default) — enough to script transient failures,
 * rate-limit headers, latency, and recovery without a real upstream.
 */
export function createFakeOpenAiRelay() {
  const behaviors = new Map<string, TokenBehavior>();
  let server: http.Server | null = null;
  let baseUrl = "";

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const authHeader = String(req.headers.authorization || "");
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsedBody = rawBody ? JSON.parse(rawBody) : {};

      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }));
        return;
      }

      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unhandled path: ${req.method} ${req.url}` } }));
        return;
      }

      const behavior = behaviors.get(token);
      if (!behavior) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unknown token: ${token || "missing"}` } }));
        return;
      }

      behavior.hits += 1;
      behavior.startedAt.push(Date.now());
      behavior.bodies.push(parsedBody as Record<string, unknown>);

      const planned = behavior.queue.shift() || behavior.defaultResponse;
      if (planned.delayMs && planned.delayMs > 0) {
        await sleep(planned.delayMs);
      }

      const headers = { "Content-Type": "application/json", ...(planned.headers || {}) };
      res.writeHead(planned.status, headers);
      res.end(JSON.stringify(planned.body));
    });
  };

  return {
    async start() {
      const port = await getFreePort();
      await new Promise<void>((resolve, reject) => {
        server = http.createServer((req, res) => {
          void handleRequest(req, res);
        });
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      baseUrl = `http://127.0.0.1:${port}/v1`;
      return baseUrl;
    },
    getBaseUrl() {
      if (!baseUrl) throw new Error("Fake relay has not started yet");
      return baseUrl;
    },
    configureToken(
      token: string,
      config: { defaultResponse: PlannedResponse; queue?: PlannedResponse[] }
    ) {
      behaviors.set(token, {
        defaultResponse: config.defaultResponse,
        queue: [...(config.queue || [])],
        hits: 0,
        startedAt: [],
        bodies: [],
      });
    },
    getState(token: string) {
      const state = behaviors.get(token);
      if (!state) throw new Error(`Unknown token state for ${token}`);
      return state;
    },
    resetState(token: string, queue?: PlannedResponse[]) {
      const state = behaviors.get(token);
      if (!state) throw new Error(`Unknown token state for ${token}`);
      state.hits = 0;
      state.startedAt = [];
      state.bodies = [];
      state.queue = [...(queue || [])];
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    },
  };
}
