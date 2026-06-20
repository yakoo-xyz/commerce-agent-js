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
  /** Top pick(s) from recommend_product. */
  bestMatches?: Product[];
  /** Additional products from search results. */
  recommendations?: Product[];
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

/** Product catalog API configuration for search tools. */
export interface ProductApiConfig {
  baseUrl: string;
  apiKey?: string;
  minIntervalMs?: number;
}

import type { LlmConfig } from "./agent/llm-query-parser.js";

export type { LlmConfig };
export interface CommerceAgentConfig {
  /** Base URL of the agent backend (Python bridge or hosted API). */
  agentBackendUrl?: string;
  /** API key sent as Authorization: Bearer header. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default 120_000. */
  timeoutMs?: number;
  /** Use built-in mock agent when no backend URL is set. Default true. */
  useMock?: boolean;
  /**
   * Run the built-in commerce agent instead of mock/Python bridge.
   * Requires `productApi` when not delegating to the client.
   */
  useLocalAgent?: boolean;
  /** Server-side product catalog API base URL for find_product / view_product_information. */
  productApi?: ProductApiConfig;
  /** LLM for intent extraction (product names, brands, features). */
  llm?: LlmConfig;
}

/** Injectable product API for delegated (client-side) tool execution. */
export interface ProductApiPort {
  findProduct(params: import("./agent/product-api.js").FindProductParams): Promise<Product[]>;
  viewProductInformation(productIds: string): Promise<Product[]>;
}

/** Options passed to query(). */
export interface QueryOptions {
  sessionId?: string;
  /** Stream step events via callback instead of waiting for full result. */
  onStep?: (step: DialogueStep, index: number) => void;
  /** Override product API (e.g. browser-delegated catalog API client). */
  productApiPort?: ProductApiPort;
  /** Called when the agent needs the client to execute a product API tool. */
  onToolRequest?: (request: import("./agent/product-api.js").PendingToolRequest) => void;
  /** Override LLM config for this query (defaults to CommerceAgentConfig.llm). */
  llm?: LlmConfig;
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
