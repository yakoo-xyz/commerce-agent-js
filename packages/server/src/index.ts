import type { Application, Request, Response } from "express";
import {
  CommerceAgent,
  DelegatingProductApiPort,
  runCommerceAgent,
  CatalogApiClient,
} from "@commerce-agent/core";
import type { AgentResult, DialogueStep, PendingToolRequest, ProductApiConfig } from "@commerce-agent/core";

export interface ServerConfig {
  /** Shared CommerceAgent instance. Created automatically if omitted. */
  agent?: CommerceAgent;
  /** Passed to CommerceAgent when `agent` is omitted. */
  agentConfig?: ConstructorParameters<typeof CommerceAgent>[0];
  /** Allowed CORS origins. Use '*' for all (dev only). */
  corsOrigins?: string[] | "*";
  /** Base path prefix, e.g. '/api/agent'. Default '/api/agent'. */
  basePath?: string;
}

interface ActiveDelegatedRun {
  port: DelegatingProductApiPort;
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function sessionIdParam(req: Request): string {
  const id = req.params.id;
  const raw = Array.isArray(id) ? id[0] : id;
  return typeof raw === "string" ? raw : "";
}

function parseProductApiConfig(body: unknown): ProductApiConfig | undefined {
  if (!body || typeof body !== "object") return undefined;
  const cfg = body as Record<string, unknown>;
  if (typeof cfg.baseUrl !== "string" || !cfg.baseUrl.trim()) return undefined;
  return {
    baseUrl: cfg.baseUrl.trim(),
    apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : undefined,
    minIntervalMs: typeof cfg.minIntervalMs === "number" ? cfg.minIntervalMs : undefined,
  };
}

/**
 * Creates Express middleware/router for the commerce agent API.
 *
 * Routes:
 * - POST   {basePath}/sessions
 * - GET    {basePath}/sessions/:id
 * - DELETE {basePath}/sessions/:id
 * - POST   {basePath}/sessions/:id/messages
 * - POST   {basePath}/sessions/:id/tool-results
 * - GET    {basePath}/sessions/:id/stream?message=...  (SSE)
 */
export function createCommerceAgentRouter(config: ServerConfig = {}) {
  const agent = config.agent ?? new CommerceAgent(config.agentConfig);
  const basePath = config.basePath ?? "/api/agent";
  const corsOrigins = config.corsOrigins ?? "*";
  const serverProductApi = config.agentConfig?.productApi;
  const useLocalAgent = Boolean(config.agentConfig?.useLocalAgent || serverProductApi);

  const delegatedRuns = new Map<string, ActiveDelegatedRun>();

  function corsMiddleware(req: Request, res: Response, next: () => void): void {
    const origin = req.headers.origin;
    if (corsOrigins === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  }

  async function handleQuery(
    sessionId: string,
    message: string,
    options: {
      onStep?: (step: DialogueStep, index: number) => void;
      onToolRequest?: (request: PendingToolRequest) => void;
      delegateProductApi?: boolean;
      productApi?: ProductApiConfig;
    } = {},
  ): Promise<AgentResult> {
    const delegate = options.delegateProductApi ?? false;

    if (delegate) {
      const port = new DelegatingProductApiPort();
      port.onToolRequest = options.onToolRequest;
      delegatedRuns.set(sessionId, { port });

      try {
        const result = await runCommerceAgent(message, port, { onStep: options.onStep });
        return {
          status: result.status,
          productIds: result.product_ids,
          products: extractProductsFromSteps(result.steps),
          steps: result.steps,
          sessionId,
        };
      } finally {
        delegatedRuns.delete(sessionId);
      }
    }

    if (options.productApi) {
      const api = new CatalogApiClient(options.productApi);
      const result = await runCommerceAgent(message, api, { onStep: options.onStep });
      return {
        status: result.status,
        productIds: result.product_ids,
        products: extractProductsFromSteps(result.steps),
        steps: result.steps,
        sessionId,
      };
    }

    return agent.query(sessionId, message, { onStep: options.onStep });
  }

  function extractProductsFromSteps(steps: DialogueStep[]) {
    const byId = new Map<string, AgentResult["products"][0]>();
    for (const step of steps) {
      for (const tc of step.tool_calls) {
        if (tc.name !== "find_product" || !Array.isArray(tc.result)) continue;
        for (const row of tc.result) {
          if (row && typeof row === "object" && "product_id" in row) {
            const p = row as AgentResult["products"][0];
            byId.set(String(p.product_id), p);
          }
        }
      }
    }
    return [...byId.values()];
  }

  return {
    basePath,
    agent,
    corsMiddleware,

    /** Mount all routes on an Express app. */
    mount(app: Application): void {
      app.use(basePath, corsMiddleware);

      app.post(`${basePath}/sessions`, (_req: Request, res: Response) => {
        const session = agent.createSession();
        res.status(201).json({ sessionId: session.id, createdAt: session.createdAt });
      });

      app.get(`${basePath}/sessions/:id`, (req: Request, res: Response) => {
        const session = agent.getSession(sessionIdParam(req));
        if (!session) {
          jsonError(res, 404, "Session not found");
          return;
        }
        res.json(session);
      });

      app.delete(`${basePath}/sessions/:id`, (req: Request, res: Response) => {
        const removed = agent.destroySession(sessionIdParam(req));
        delegatedRuns.delete(sessionIdParam(req));
        if (!removed) {
          jsonError(res, 404, "Session not found");
          return;
        }
        res.status(204).send();
      });

      app.post(`${basePath}/sessions/:id/tool-results`, (req: Request, res: Response) => {
        const sessionId = sessionIdParam(req);
        const run = delegatedRuns.get(sessionId);
        if (!run) {
          jsonError(res, 404, "No active delegated run for this session");
          return;
        }

        const requestId = req.body?.requestId;
        const result = req.body?.result;
        const error = req.body?.error;

        if (!requestId || typeof requestId !== "string") {
          jsonError(res, 400, "Body must include { requestId: string, result?: unknown }");
          return;
        }

        if (typeof error === "string" && error) {
          run.port.rejectToolResult(requestId, error);
        } else {
          run.port.fulfillToolResult(requestId, result);
        }

        res.json({ ok: true });
      });

      app.post(`${basePath}/sessions/:id/messages`, async (req: Request, res: Response) => {
        const message = req.body?.message;
        if (!message || typeof message !== "string") {
          jsonError(res, 400, "Body must include { message: string }");
          return;
        }

        const delegateProductApi = Boolean(req.body?.delegateProductApi);
        const productApi = parseProductApiConfig(req.body?.productApi);

        try {
          const result = await handleQuery(sessionIdParam(req), message.trim(), {
            delegateProductApi,
            productApi: productApi ?? serverProductApi,
          });
          res.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Agent query failed";
          jsonError(res, 500, msg);
        }
      });

      app.get(`${basePath}/sessions/:id/stream`, async (req: Request, res: Response) => {
        const message = req.query.message;
        if (!message || typeof message !== "string") {
          jsonError(res, 400, "Query param ?message= is required");
          return;
        }

        const delegateProductApi = req.query.delegateProductApi === "true" || req.query.delegateProductApi === "1";
        const productApiFromQuery = parseProductApiConfig({
          baseUrl: req.query.productApiUrl,
          apiKey: req.query.productApiKey,
        });

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const sessionId = sessionIdParam(req);
        writeSse(res, "started", { sessionId });

        try {
          const result = await handleQuery(sessionId, message.trim(), {
            delegateProductApi,
            productApi: productApiFromQuery ?? serverProductApi,
            onStep: (step, index) => {
              writeSse(res, "step", { index, step });
            },
            onToolRequest: (request) => {
              writeSse(res, "tool_request", request);
            },
          });
          writeSse(res, "done", result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Agent query failed";
          writeSse(res, "error", { message: msg });
        } finally {
          res.end();
        }
      });

      app.get(`${basePath}/health`, (_req: Request, res: Response) => {
        res.json({
          ok: true,
          mock: agent.isMock,
          localAgent: useLocalAgent,
          hasServerProductApi: Boolean(serverProductApi),
        });
      });
    },
  };
}

export { CommerceAgent };
