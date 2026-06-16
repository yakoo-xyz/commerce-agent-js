import type { Application, Request, Response } from "express";
import { CommerceAgent } from "@commerce-agent/core";
import type { AgentResult, DialogueStep } from "@commerce-agent/core";

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

/**
 * Creates Express middleware/router for the commerce agent API.
 *
 * Routes:
 * - POST   {basePath}/sessions
 * - GET    {basePath}/sessions/:id
 * - DELETE {basePath}/sessions/:id
 * - POST   {basePath}/sessions/:id/messages
 * - GET    {basePath}/sessions/:id/stream?message=...  (SSE)
 */
export function createCommerceAgentRouter(config: ServerConfig = {}) {
  const agent = config.agent ?? new CommerceAgent(config.agentConfig);
  const basePath = config.basePath ?? "/api/agent";

  const corsOrigins = config.corsOrigins ?? "*";

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
    onStep?: (step: DialogueStep, index: number) => void,
  ): Promise<AgentResult> {
    return agent.query(sessionId, message, { onStep });
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
        if (!removed) {
          jsonError(res, 404, "Session not found");
          return;
        }
        res.status(204).send();
      });

      app.post(`${basePath}/sessions/:id/messages`, async (req: Request, res: Response) => {
        const message = req.body?.message;
        if (!message || typeof message !== "string") {
          jsonError(res, 400, "Body must include { message: string }");
          return;
        }

        try {
          const result = await handleQuery(sessionIdParam(req), message.trim());
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

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        writeSse(res, "started", { sessionId: sessionIdParam(req) });

        try {
          const result = await handleQuery(sessionIdParam(req), message.trim(), (step, index) => {
            writeSse(res, "step", { index, step });
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
        res.json({ ok: true, mock: agent.isMock });
      });
    },
  };
}

export { CommerceAgent };
