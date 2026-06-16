import type { WidgetConfig, WidgetMessage, WidgetProduct } from "./types.js";

export class WidgetApiClient {
  private sessionId: string | null = null;

  constructor(private readonly apiUrl: string) {}

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const res = await fetch(`${this.apiUrl}/sessions`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to create session (${res.status})`);
    const data = (await res.json()) as { sessionId: string };
    this.sessionId = data.sessionId;
    return this.sessionId;
  }

  async sendMessage(message: string): Promise<{
    steps: Array<{ think: string; tool_calls: Array<{ name: string; result?: unknown }> }>;
    products: WidgetProduct[];
    status: string;
  }> {
    const sessionId = await this.ensureSession();
    const res = await fetch(`${this.apiUrl}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed (${res.status})`);
    }
    return res.json();
  }

  streamMessage(
    message: string,
    handlers: {
      onStep?: (step: { think: string; tool_calls: unknown[] }, index: number) => void;
      onDone?: (result: { products: WidgetProduct[]; status: string; steps: unknown[] }) => void;
      onError?: (err: Error) => void;
    },
  ): void {
    void this.ensureSession().then((sessionId) => {
      const url = `${this.apiUrl}/sessions/${sessionId}/stream?message=${encodeURIComponent(message)}`;
      const es = new EventSource(url);

      es.addEventListener("step", (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as {
            index: number;
            step: { think: string; tool_calls: unknown[] };
          };
          handlers.onStep?.(payload.step, payload.index);
        } catch {
          /* ignore malformed events */
        }
      });

      es.addEventListener("done", (ev) => {
        try {
          const result = JSON.parse((ev as MessageEvent).data) as {
            products: WidgetProduct[];
            status: string;
            steps: unknown[];
          };
          handlers.onDone?.(result);
        } catch (e) {
          handlers.onError?.(e instanceof Error ? e : new Error("Invalid done event"));
        }
        es.close();
      });

      es.addEventListener("error", () => {
        handlers.onError?.(new Error("Stream connection failed"));
        es.close();
      });
    }).catch((e) => {
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
  }
}

export function extractProductsFromSteps(
  steps: Array<{ tool_calls?: Array<{ name: string; result?: unknown }> }>,
): WidgetProduct[] {
  const byId = new Map<string, WidgetProduct>();
  for (const step of steps) {
    for (const tc of step.tool_calls ?? []) {
      if (tc.name !== "find_product" || !Array.isArray(tc.result)) continue;
      for (const row of tc.result) {
        if (row && typeof row === "object" && "product_id" in row) {
          const p = row as WidgetProduct;
          byId.set(String(p.product_id), p);
        }
      }
    }
  }
  return [...byId.values()];
}

export function defaultStyles(config: WidgetConfig): string {
  const t = config.theme ?? {};
  const primary = t.primaryColor ?? "#6366f1";
  const bg = t.backgroundColor ?? "#ffffff";
  const text = t.textColor ?? "#1e293b";
  const radius = t.borderRadius ?? "12px";
  const font = t.fontFamily ?? "system-ui, -apple-system, sans-serif";
  const z = t.zIndex ?? 99999;
  const pos = t.position ?? "bottom-right";

  return `
    .ca-widget-root { --ca-primary: ${primary}; --ca-bg: ${bg}; --ca-text: ${text}; --ca-radius: ${radius}; --ca-font: ${font}; --ca-z: ${z}; font-family: var(--ca-font); }
    .ca-launcher { position: fixed; ${pos === "bottom-right" ? "right: 24px" : "left: 24px"}; bottom: 24px; width: 56px; height: 56px; border-radius: 50%; background: var(--ca-primary); color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,.2); z-index: var(--ca-z); display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .ca-launcher:hover { filter: brightness(1.08); }
    .ca-panel { position: fixed; ${pos === "bottom-right" ? "right: 24px" : "left: 24px"}; bottom: 92px; width: 380px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 120px); background: var(--ca-bg); border-radius: var(--ca-radius); box-shadow: 0 8px 40px rgba(0,0,0,.15); z-index: var(--ca-z); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #e2e8f0; }
    .ca-panel.hidden { display: none; }
    .ca-header { padding: 14px 16px; background: var(--ca-primary); color: #fff; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    .ca-close { background: none; border: none; color: #fff; cursor: pointer; font-size: 20px; line-height: 1; opacity: .85; }
    .ca-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .ca-msg { max-width: 88%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; color: var(--ca-text); }
    .ca-msg.user { align-self: flex-end; background: var(--ca-primary); color: #fff; border-bottom-right-radius: 4px; }
    .ca-msg.assistant { align-self: flex-start; background: #f1f5f9; border-bottom-left-radius: 4px; }
    .ca-msg.system { align-self: center; background: transparent; color: #64748b; font-size: 13px; text-align: center; }
    .ca-msg.thinking { opacity: .7; font-style: italic; }
    .ca-products { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .ca-product { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; cursor: pointer; background: #fff; transition: border-color .15s; }
    .ca-product:hover { border-color: var(--ca-primary); }
    .ca-product-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
    .ca-product-price { color: var(--ca-primary); font-weight: 700; font-size: 14px; }
    .ca-input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2e8f0; }
    .ca-input { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; font-size: 14px; font-family: inherit; outline: none; }
    .ca-input:focus { border-color: var(--ca-primary); }
    .ca-send { background: var(--ca-primary); color: #fff; border: none; border-radius: 8px; padding: 0 16px; cursor: pointer; font-weight: 600; font-size: 14px; }
    .ca-send:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

export function renderProductCards(
  products: WidgetProduct[],
  onClick?: (p: WidgetProduct) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ca-products";
  for (const p of products) {
    const card = document.createElement("div");
    card.className = "ca-product";
    card.innerHTML = `
      <div class="ca-product-title">${escapeHtml(p.title ?? `Product ${p.product_id}`)}</div>
      ${p.price != null ? `<div class="ca-product-price">₱${p.price.toLocaleString()}</div>` : ""}
    `;
    card.addEventListener("click", () => onClick?.(p));
    wrap.appendChild(card);
  }
  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function appendMessage(
  container: HTMLElement,
  msg: WidgetMessage,
  onProductClick?: (p: WidgetProduct) => void,
): HTMLElement {
  const el = document.createElement("div");
  el.className = `ca-msg ${msg.role}${msg.thinking ? " thinking" : ""}`;
  el.textContent = msg.content;
  if (msg.products?.length) {
    el.appendChild(renderProductCards(msg.products, onProductClick));
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}
