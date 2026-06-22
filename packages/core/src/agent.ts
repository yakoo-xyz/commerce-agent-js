import { AgentClient } from "./client.js";
import type {
  AgentResult,
  CommerceAgentConfig,
  QueryOptions,
  Session,
  SessionMessage,
} from "./types.js";

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * High-level SDK for the AI commerce agent.
 *
 * @example
 * ```ts
 * const agent = new CommerceAgent({ agentBackendUrl: 'http://yakoo.xyz:8000' });
 * const session = agent.createSession();
 * const result = await agent.query(session.id, 'Find wireless earbuds under 2000 pesos');
 * console.log(result.productIds, result.products);
 * ```
 */
export class CommerceAgent {
  private readonly client: AgentClient;
  private readonly sessions = new Map<string, Session>();

  constructor(config: CommerceAgentConfig = {}) {
    this.client = new AgentClient(config);
  }

  /** Whether the SDK is using the built-in mock agent. */
  get isMock(): boolean {
    return this.client.usesMock;
  }

  /** Create a new chat session. */
  createSession(userId?: string): Session {
    const session: Session = {
      id: userId ? `sess-${userId}-${randomId()}` : `sess-${randomId()}`,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Get an existing session by ID. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove a session from memory. */
  destroySession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Send a user message and run the commerce agent.
   * Returns the full result including dialogue steps and recommended products.
   */
  async query(
    sessionId: string,
    message: string,
    options: Omit<QueryOptions, "sessionId"> = {},
  ): Promise<AgentResult> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, createdAt: new Date().toISOString(), messages: [] };
      this.sessions.set(sessionId, session);
    }

    const userMsg: SessionMessage = {
      id: randomId(),
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    const result = await this.client.query(message, { ...options, sessionId });

    const assistantMsg: SessionMessage = {
      id: randomId(),
      role: "assistant",
      content: result.steps.at(-1)?.think ?? "Done.",
      timestamp: new Date().toISOString(),
      result,
    };
    session.messages.push(assistantMsg);

    return result;
  }
}
