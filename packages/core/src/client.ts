import { runMockAgent } from "./mock-agent.js";
import type {
  AgentBackendRequest,
  AgentBackendResponse,
  AgentResult,
  CommerceAgentConfig,
  DialogueStep,
  Product,
  QueryOptions,
} from "./types.js";

function extractProductIds(steps: DialogueStep[]): string[] {
  const ids = new Set<string>();

  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name === "recommend_product") {
        const raw = tc.params?.product_ids;
        if (typeof raw === "string") {
          raw.split(",").forEach((id) => ids.add(id.trim()));
        }
      }
      if (tc.name === "find_product" && Array.isArray(tc.result)) {
        for (const row of tc.result) {
          if (row && typeof row === "object" && "product_id" in row) {
            ids.add(String((row as Product).product_id));
          }
        }
      }
    }
  }

  return [...ids].filter((id) => id && id !== "0");
}

function extractProducts(steps: DialogueStep[]): Product[] {
  const byId = new Map<string, Product>();

  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name !== "find_product") continue;
      const rows = tc.result;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row && typeof row === "object" && "product_id" in row) {
          const p = row as Product;
          byId.set(String(p.product_id), p);
        }
      }
    }
  }

  return [...byId.values()];
}

function inferStatus(steps: DialogueStep[], backendStatus?: string): "success" | "failure" {
  if (backendStatus === "failure") return "failure";
  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name === "terminate") {
        const status = tc.params?.status;
        if (status === "failure") return "failure";
      }
    }
  }
  const ids = extractProductIds(steps);
  return ids.length > 0 ? "success" : "failure";
}

async function callBackend(
  config: CommerceAgentConfig,
  body: AgentBackendRequest,
  onStep?: (step: DialogueStep, index: number) => void,
): Promise<AgentBackendResponse> {
  const url = `${config.agentBackendUrl!.replace(/\/$/, "")}/query`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Agent backend error ${res.status}: ${text || res.statusText}`);
    }

    const data = (await res.json()) as AgentBackendResponse;

    if (data.steps && onStep) {
      data.steps.forEach((step, i) => onStep(step, i));
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeResponse(
  data: AgentBackendResponse,
  sessionId?: string,
): AgentResult {
  const steps = data.steps ?? [];
  const productIds = data.product_ids?.length
    ? data.product_ids.map(String)
    : extractProductIds(steps);

  return {
    status: inferStatus(steps, data.status),
    productIds,
    products: extractProducts(steps),
    steps,
    sessionId,
  };
}

/** HTTP + mock client used internally by CommerceAgent. */
export class AgentClient {
  private readonly config: CommerceAgentConfig;

  constructor(config: CommerceAgentConfig = {}) {
    this.config = {
      timeoutMs: 120_000,
      useMock: config.agentBackendUrl ? false : config.useMock !== false,
      ...config,
    };
  }

  get usesMock(): boolean {
    return Boolean(this.config.useMock || !this.config.agentBackendUrl);
  }

  async query(message: string, options: QueryOptions = {}): Promise<AgentResult> {
    const { sessionId, onStep } = options;

    let backend: AgentBackendResponse;

    if (this.usesMock) {
      backend = await runMockAgent(message, onStep);
    } else {
      backend = await callBackend(
        this.config,
        { query: message, session_id: sessionId },
        onStep,
      );
    }

    return normalizeResponse(backend, sessionId);
  }
}
