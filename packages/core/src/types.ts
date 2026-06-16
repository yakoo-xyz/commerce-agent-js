/** A product returned from search or recommendation. */
export interface Product {
  product_id: string;
  title?: string;
  price?: number;
  shop_id?: string;
  image?: string;
  service?: string[];
  [key: string]: unknown;
}

/** A tool call recorded in a dialogue step. */
export interface ToolCall {
  name: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** One reasoning step produced by the agent. */
export interface DialogueStep {
  step: number;
  think: string;
  tool_calls: ToolCall[];
  response: string;
  query: string;
}

export type AgentStatus = "success" | "failure";

/** Result of a single agent query. */
export interface AgentResult {
  status: AgentStatus;
  productIds: string[];
  products: Product[];
  steps: DialogueStep[];
  sessionId?: string;
}

/** A chat session with message history. */
export interface Session {
  id: string;
  createdAt: string;
  messages: SessionMessage[];
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  result?: AgentResult;
}

/** Configuration for CommerceAgent. */
export interface CommerceAgentConfig {
  /** Base URL of the agent backend (Python bridge or hosted API). */
  agentBackendUrl?: string;
  /** API key sent as Authorization: Bearer header. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default 120_000. */
  timeoutMs?: number;
  /** Use built-in mock agent when no backend URL is set. Default true. */
  useMock?: boolean;
}

/** Options passed to query(). */
export interface QueryOptions {
  sessionId?: string;
  /** Stream step events via callback instead of waiting for full result. */
  onStep?: (step: DialogueStep, index: number) => void;
}

/** Backend request body sent to the Python agent bridge. */
export interface AgentBackendRequest {
  query: string;
  session_id?: string;
}

/** Backend response from the Python agent bridge. */
export interface AgentBackendResponse {
  steps: DialogueStep[];
  status?: AgentStatus;
  product_ids?: string[];
}
