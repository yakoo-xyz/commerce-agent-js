import type { WidgetConfig, WidgetMessage, WidgetProduct, WidgetProductLists } from "./types.js";

export interface ProductApiSettings {
  /** Product catalog API base URL, e.g. https://your-api.example.com */
  baseUrl: string;
  apiKey?: string;
  minIntervalMs?: number;
}

export class CatalogApiClient {
  private lastRequestAt = 0;
  constructor(private readonly config: ProductApiSettings) {}

  private async throttle(): Promise<void> {
    const minInterval = this.config.minIntervalMs ?? 700;
    const now = Date.now();
    const wait = minInterval - (now - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
    await this.throttle();
    const base = this.config.baseUrl.replace(/\/$/, "");
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await fetch(`${base}${path}?${qs}`, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Product API failed (${res.status}): ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async executeTool(
    name: "find_product" | "view_product_information",
    params: Record<string, unknown>,
  ): Promise<WidgetProduct[]> {
    if (name === "find_product") {
      const q = String(params.q ?? "");
      const searchParams: Record<string, string | number> = {
        q: encodeURIComponent(q).replace(/%20/g, "+"),
        page: Number(params.page ?? 1),
      };
      if (params.shop_id) searchParams.shop_id = String(params.shop_id);
      if (params.price) searchParams.price = String(params.price);
      if (params.sort && params.sort !== "default") searchParams.sort = String(params.sort);
      if (params.service) searchParams.service = String(params.service);

      let result = (await this.get<WidgetProduct[]>("/search/find_product", searchParams)) ?? [];
      if (!result.length && searchParams.service) {
        const retry = { ...searchParams };
        delete retry.service;
        result = (await this.get<WidgetProduct[]>("/search/find_product", retry)) ?? [];
      }
      return result;
    }

    const ids = String(params.product_ids ?? "");
    if (!ids) return [];
    return (await this.get<WidgetProduct[]>("/search/view_product_information", { product_ids: ids })) ?? [];
  }
}

export class WidgetApiClient {
  private sessionId: string | null = null;

  constructor(
    private readonly apiUrl: string,
    private options: {
      productApi?: ProductApiSettings;
      delegateProductApi?: boolean;
    } = {},
  ) {}

  updateProductApi(productApi: ProductApiSettings): void {
    this.options.productApi = productApi;
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const res = await fetch(`${this.apiUrl}/sessions`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to create session (${res.status})`);
    const data = (await res.json()) as { sessionId: string };
    this.sessionId = data.sessionId;
    return this.sessionId;
  }

  private async submitToolResult(requestId: string, result: unknown, error?: string): Promise<void> {
    const sessionId = await this.ensureSession();
    const res = await fetch(`${this.apiUrl}/sessions/${sessionId}/tool-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, result, error }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Tool result failed (${res.status})`);
    }
  }

  async sendMessage(message: string): Promise<{
    steps: Array<{ think: string; tool_calls: Array<{ name: string; result?: unknown }> }>;
    products: WidgetProduct[];
    bestMatches?: WidgetProduct[];
    recommendations?: WidgetProduct[];
    status: string;
  }> {
    const sessionId = await this.ensureSession();
    const body: Record<string, unknown> = { message };
    if (this.options.delegateProductApi) body.delegateProductApi = true;
    if (this.options.productApi && !this.options.delegateProductApi) {
      body.productApi = this.options.productApi;
    }

    const res = await fetch(`${this.apiUrl}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
      onDone?: (result: {
        products: WidgetProduct[];
        bestMatches?: WidgetProduct[];
        recommendations?: WidgetProduct[];
        status: string;
        steps: unknown[];
      }) => void;
      onError?: (err: Error) => void;
    },
  ): void {
    void this.ensureSession().then(async (sessionId) => {
      const productApiClient = this.options.productApi
        ? new CatalogApiClient(this.options.productApi)
        : null;

      const params = new URLSearchParams({ message });
      if (this.options.delegateProductApi) params.set("delegateProductApi", "true");

      const url = `${this.apiUrl}/sessions/${sessionId}/stream?${params.toString()}`;
      const es = new EventSource(url);

      es.addEventListener("tool_request", (ev) => {
        void (async () => {
          try {
            const request = JSON.parse((ev as MessageEvent).data) as {
              id: string;
              name: "find_product" | "view_product_information";
              params: Record<string, unknown>;
            };
            if (!productApiClient) {
              await this.submitToolResult(request.id, null, "productApi is not configured on the widget");
              return;
            }
            const result = await productApiClient.executeTool(request.name, request.params);
            await this.submitToolResult(request.id, result);
          } catch (e) {
            const request = JSON.parse((ev as MessageEvent).data) as { id: string };
            await this.submitToolResult(
              request.id,
              null,
              e instanceof Error ? e.message : String(e),
            ).catch(() => undefined);
          }
        })();
      });

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
            bestMatches?: WidgetProduct[];
            recommendations?: WidgetProduct[];
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

export function extractProductListsFromSteps(
  steps: Array<{ tool_calls?: Array<{ name: string; params?: Record<string, unknown>; result?: unknown }> }>,
): WidgetProductLists {
  const byId = new Map<string, WidgetProduct>();
  const recommendedIds: string[] = [];

  for (const step of steps) {
    for (const tc of step.tool_calls ?? []) {
      if (tc.name === "recommend_product") {
        const raw = String(tc.params?.product_ids ?? "");
        for (const id of raw.split(",")) {
          const pid = id.trim();
          if (pid && pid !== "0") recommendedIds.push(pid);
        }
      }
      if (tc.name === "find_product" && Array.isArray(tc.result)) {
        for (const row of tc.result) {
          if (row && typeof row === "object" && "product_id" in row) {
            const p = row as WidgetProduct;
            byId.set(String(p.product_id), p);
          }
        }
      }
    }
  }

  const recommendedSet = new Set(recommendedIds);
  let bestMatches = recommendedIds
    .map((id) => byId.get(id))
    .filter((p): p is WidgetProduct => Boolean(p));

  let recommendations = [...byId.values()].filter(
    (p) => !recommendedSet.has(String(p.product_id)),
  );

  if (!bestMatches.length && byId.size) {
    const ordered = [...byId.values()];
    bestMatches = [ordered[0]];
    recommendations = ordered.slice(1);
  }

  return {
    bestMatches,
    recommendations: recommendations.slice(0, 6),
  };
}

/** @deprecated Use extractProductListsFromSteps */
export function extractProductsFromSteps(
  steps: Array<{ tool_calls?: Array<{ name: string; result?: unknown }> }>,
): WidgetProduct[] {
  const { bestMatches, recommendations } = extractProductListsFromSteps(steps);
  return [...bestMatches, ...recommendations];
}

function formatPriceUsd(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

function productImageUrl(product: WidgetProduct): string | null {
  const image = product.image;
  return typeof image === "string" && image.trim() ? image.trim() : null;
}

export function setThinkingContent(el: HTMLElement, text: string): void {
  el.textContent = "";
  const label = document.createElement("span");
  label.className = "ca-thinking-text";
  label.textContent = text.replace(/\.+$/, "");
  const dots = document.createElement("span");
  dots.className = "ca-thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  el.append(label, dots);
}

export function baseWidgetStyles(): string {
  return `
    .ca-widget-root {
      font-family: var(--ca-font, system-ui, -apple-system, sans-serif);
      color-scheme: var(--ca-color-scheme, light);
    }
    .ca-launcher-wrap {
      position: fixed;
      left: var(--ca-pos-left, auto);
      right: var(--ca-pos-right, 24px);
      bottom: 24px;
      z-index: var(--ca-z, 99999);
    }
    .ca-launcher {
      position: relative;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--ca-primary, #6366f1);
      color: var(--ca-on-primary, #fff);
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px var(--ca-shadow, rgba(0,0,0,.2));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      transition: transform 0.2s ease, filter 0.2s ease, box-shadow 0.2s ease;
    }
    .ca-launcher:hover { filter: brightness(1.08); transform: scale(1.04); }
    .ca-launcher:active { transform: scale(0.98); }
    .ca-launcher-icon { font-size: 24px; line-height: 1; }
    .ca-launcher-hint {
      display: none;
      position: absolute;
      right: calc(100% + 12px);
      bottom: 50%;
      transform: translateY(50%);
      white-space: nowrap;
      padding: 8px 14px;
      border-radius: 999px;
      background: var(--ca-bg, #0a0f0c);
      color: var(--ca-text, #f0f4f1);
      border: 1px solid var(--ca-border, rgba(255,255,255,.1));
      box-shadow: 0 8px 24px var(--ca-shadow, rgba(0,0,0,.35));
      font-size: 13px;
      font-weight: 600;
      pointer-events: none;
      opacity: 0;
      animation: ca-hint-in 0.5s ease 1.2s forwards;
    }
    .ca-launcher-hint::after {
      content: "";
      position: absolute;
      right: -5px;
      top: 50%;
      width: 10px;
      height: 10px;
      background: var(--ca-bg, #0a0f0c);
      border-right: 1px solid var(--ca-border, rgba(255,255,255,.1));
      border-top: 1px solid var(--ca-border, rgba(255,255,255,.1));
      transform: translateY(-50%) rotate(45deg);
    }
    .ca-panel {
      position: fixed;
      left: var(--ca-pos-left, auto);
      right: var(--ca-pos-right, 24px);
      bottom: 92px;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 520px;
      max-height: calc(100vh - 120px);
      background: var(--ca-bg, #ffffff);
      border-radius: var(--ca-radius, 12px);
      box-shadow: 0 8px 40px var(--ca-shadow, rgba(0,0,0,.15));
      z-index: var(--ca-z, 99999);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--ca-border, #e2e8f0);
      opacity: 0;
      transform: translateY(16px) scale(0.98);
      pointer-events: none;
      transition: opacity 0.28s ease, transform 0.28s ease;
    }
    .ca-panel.ca-panel-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .ca-panel.ca-panel-resizing {
      transition: none;
      user-select: none;
    }
    .ca-resize-handle {
      position: absolute;
      z-index: 2;
      touch-action: none;
    }
    .ca-resize-nw {
      top: 0;
      left: 0;
      width: 18px;
      height: 18px;
      cursor: nwse-resize;
    }
    .ca-resize-ne {
      top: 0;
      right: 0;
      width: 18px;
      height: 18px;
      cursor: nesw-resize;
    }
    .ca-resize-n {
      top: 0;
      left: 18px;
      right: 18px;
      height: 8px;
      cursor: ns-resize;
    }
    .ca-resize-w {
      top: 18px;
      left: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
    }
    .ca-resize-e {
      top: 18px;
      right: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
    }
    .ca-resize-nw::after,
    .ca-resize-ne::after {
      content: "";
      position: absolute;
      inset: 4px;
      border-top: 2px solid var(--ca-on-primary, #fff);
      border-left: 2px solid var(--ca-on-primary, #fff);
      opacity: 0.45;
      border-radius: 2px 0 0 0;
      pointer-events: none;
    }
    .ca-resize-ne::after {
      border-left: none;
      border-right: 2px solid var(--ca-on-primary, #fff);
      border-radius: 0 2px 0 0;
    }
    .ca-panel.hidden {
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      transform: translateY(16px) scale(0.98);
    }
    .ca-header {
      padding: 14px 16px;
      background: linear-gradient(135deg, var(--ca-primary, #6366f1) 0%, color-mix(in srgb, var(--ca-primary, #6366f1) 78%, #000) 100%);
      color: var(--ca-on-primary, #fff);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .ca-header-main { flex: 1; min-width: 0; }
    .ca-header-title { display: block; font-size: 15px; line-height: 1.3; }
    .ca-header-subtitle {
      display: block;
      margin-top: 2px;
      font-size: 11px;
      font-weight: 500;
      opacity: 0.88;
      letter-spacing: 0.02em;
    }
    .ca-header-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .ca-header-badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #7eb8e8;
      box-shadow: 0 0 8px #7eb8e8;
      animation: ca-pulse-dot 1.8s ease-in-out infinite;
    }
    .ca-close {
      background: none;
      border: none;
      color: var(--ca-on-primary, #fff);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      opacity: .85;
    }
    .ca-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--ca-bg, #ffffff);
    }
    .ca-msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--ca-text, #1e293b);
    }
    .ca-msg.user {
      align-self: flex-end;
      background: var(--ca-primary, #6366f1);
      color: var(--ca-on-primary, #fff);
      border-bottom-right-radius: 4px;
    }
    .ca-msg.assistant {
      align-self: flex-start;
      background: var(--ca-surface, #f1f5f9);
      border-bottom-left-radius: 4px;
    }
    .ca-msg.system {
      align-self: center;
      background: transparent;
      color: var(--ca-text-muted, #64748b);
      font-size: 13px;
      text-align: center;
    }
    .ca-msg.thinking {
      opacity: 1;
      font-style: normal;
      display: inline-flex;
      align-items: baseline;
      gap: 2px;
    }
    .ca-thinking-dots::after {
      content: "...";
      display: inline-block;
      width: 1.2em;
      text-align: left;
      animation: ca-thinking-dots 1.2s steps(4, end) infinite;
    }
    .ca-suggested-prompts {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 4px;
      align-self: stretch;
      max-width: 100%;
    }
    .ca-prompt-chip {
      text-align: left;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--ca-border, #e2e8f0);
      background: var(--ca-surface-elevated, #fff);
      color: var(--ca-text, #1e293b);
      font-size: 13px;
      line-height: 1.4;
      cursor: pointer;
      font-family: inherit;
      transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
    }
    .ca-prompt-chip:hover {
      border-color: var(--ca-primary, #6366f1);
      box-shadow: 0 4px 14px var(--ca-primary-glow, rgba(99,102,241,.12));
      transform: translateY(-1px);
    }
    .ca-prompt-chip-label {
      display: block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ca-text-muted, #64748b);
      margin-bottom: 8px;
    }
    .ca-products { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
    .ca-product-section { display: flex; flex-direction: column; gap: 8px; }
    .ca-product-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--ca-text-muted, #64748b);
    }
    .ca-product {
      display: flex;
      gap: 10px;
      border: 1px solid var(--ca-border, #e2e8f0);
      border-radius: 10px;
      padding: 10px;
      cursor: pointer;
      background: var(--ca-surface-elevated, #fff);
      transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
    }
    .ca-product:hover {
      border-color: var(--ca-primary, #6366f1);
      box-shadow: 0 4px 16px var(--ca-primary-glow, rgba(99,102,241,.12));
      transform: translateY(-1px);
    }
    .ca-product-media {
      flex-shrink: 0;
      width: 72px;
      height: 72px;
      border-radius: 8px;
      overflow: hidden;
      background: var(--ca-media-bg, #f1f5f9);
    }
    .ca-product-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ca-product-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      color: var(--ca-text-muted, #64748b);
    }
    .ca-product-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ca-product-title {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: var(--ca-text, #1e293b);
    }
    .ca-product-meta { font-size: 11px; color: var(--ca-text-muted, #64748b); }
    .ca-product-price {
      color: var(--ca-primary, #6366f1);
      font-weight: 700;
      font-size: 14px;
      margin-top: auto;
    }
    .ca-input-row {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--ca-border, #e2e8f0);
      background: var(--ca-bg, #ffffff);
    }
    .ca-input {
      flex: 1;
      border: 1px solid var(--ca-input-border, #cbd5e1);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      background: var(--ca-input-bg, #ffffff);
      color: var(--ca-text, #1e293b);
    }
    .ca-input::placeholder { color: var(--ca-text-muted, #64748b); }
    .ca-input:focus { border-color: var(--ca-primary, #6366f1); }
    .ca-send {
      background: var(--ca-primary, #6366f1);
      color: var(--ca-on-primary, #fff);
      border: none;
      border-radius: 8px;
      padding: 0 16px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .ca-send:disabled { opacity: .5; cursor: not-allowed; }
    .ca-settings {
      padding: 10px 12px;
      border-top: 1px solid var(--ca-border, #e2e8f0);
      background: var(--ca-settings-bg, #f8fafc);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ca-settings label {
      font-size: 11px;
      font-weight: 600;
      color: var(--ca-text-muted, #64748b);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .ca-settings input {
      border: 1px solid var(--ca-input-border, #cbd5e1);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
      background: var(--ca-input-bg, #ffffff);
      color: var(--ca-text, #1e293b);
    }
    .ca-settings-toggle {
      background: none;
      border: none;
      color: var(--ca-primary, #6366f1);
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      padding: 0;
    }
    .ca-widget-promo .ca-launcher {
      width: 60px;
      height: 60px;
      background: linear-gradient(145deg, var(--ca-primary, #ff9138) 0%, color-mix(in srgb, var(--ca-primary, #ff9138) 70%, #edd03a) 100%);
      box-shadow: 0 8px 28px var(--ca-primary-glow, rgba(255,145,56,.35)), 0 0 0 0 color-mix(in srgb, var(--ca-primary, #ff9138) 40%, transparent);
      animation: ca-launcher-glow 2.8s ease-in-out infinite;
    }
    .ca-widget-promo .ca-launcher-hint { display: block; }
    .ca-widget-promo .ca-panel {
      box-shadow:
        0 24px 64px var(--ca-shadow, rgba(0,0,0,.45)),
        0 0 0 1px var(--ca-border, rgba(255,255,255,.08)),
        0 0 40px var(--ca-primary-glow, rgba(255,145,56,.12));
    }
    .ca-widget-promo .ca-msg.system {
      padding: 0 4px;
      line-height: 1.55;
    }
    @keyframes ca-hint-in {
      from { opacity: 0; transform: translateY(50%) translateX(8px); }
      to { opacity: 1; transform: translateY(50%) translateX(0); }
    }
    @keyframes ca-launcher-glow {
      0%, 100% { box-shadow: 0 8px 28px var(--ca-primary-glow), 0 0 0 0 color-mix(in srgb, var(--ca-primary) 35%, transparent); }
      50% { box-shadow: 0 10px 36px var(--ca-primary-glow), 0 0 0 10px transparent; }
    }
    @keyframes ca-pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.85); }
    }
    @keyframes ca-thinking-dots {
      0% { content: ""; }
      25% { content: "."; }
      50% { content: ".."; }
      75%, 100% { content: "..."; }
    }
  `;
}

/** @deprecated Use baseWidgetStyles() — theme vars are applied per instance on .ca-widget-root */
export function defaultStyles(_config: WidgetConfig): string {
  return baseWidgetStyles();
}

export function renderProductCard(
  product: WidgetProduct,
  onClick?: (p: WidgetProduct) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "ca-product";

  const media = document.createElement("div");
  media.className = "ca-product-media";
  const imageUrl = productImageUrl(product);
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = product.title ?? "Product";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(createImagePlaceholder());
    });
    media.appendChild(img);
  } else {
    media.appendChild(createImagePlaceholder());
  }

  const body = document.createElement("div");
  body.className = "ca-product-body";
  body.innerHTML = `
    <div class="ca-product-title">${escapeHtml(product.title ?? `Product ${product.product_id}`)}</div>
    ${product.brand || product.shop_name ? `<div class="ca-product-meta">${escapeHtml([product.brand, product.shop_name].filter(Boolean).join(" · "))}</div>` : ""}
    ${product.price != null ? `<div class="ca-product-price">${formatPriceUsd(product.price)}</div>` : ""}
  `;

  card.append(media, body);
  card.addEventListener("click", () => onClick?.(product));
  return card;
}

function createImagePlaceholder(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ca-product-placeholder";
  el.textContent = "🛍";
  return el;
}

export function renderProductLists(
  lists: WidgetProductLists,
  onClick?: (p: WidgetProduct) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ca-products";

  if (lists.bestMatches.length) {
    wrap.appendChild(renderProductSection("Best matches", lists.bestMatches, onClick));
  }
  if (lists.recommendations.length) {
    wrap.appendChild(renderProductSection("Recommendations", lists.recommendations, onClick));
  }

  return wrap;
}

function renderProductSection(
  title: string,
  products: WidgetProduct[],
  onClick?: (p: WidgetProduct) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "ca-product-section";

  const heading = document.createElement("div");
  heading.className = "ca-product-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  for (const product of products) {
    section.appendChild(renderProductCard(product, onClick));
  }

  return section;
}

/** @deprecated Use renderProductLists */
export function renderProductCards(
  products: WidgetProduct[],
  onClick?: (p: WidgetProduct) => void,
): HTMLElement {
  return renderProductLists({ bestMatches: products, recommendations: [] }, onClick);
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
  if (msg.thinking) {
    setThinkingContent(el, msg.content);
  } else {
    el.textContent = msg.content;
  }
  const lists =
    msg.productLists ??
    (msg.products?.length
      ? { bestMatches: msg.products, recommendations: [] as WidgetProduct[] }
      : null);
  if (lists && (lists.bestMatches.length || lists.recommendations.length)) {
    el.appendChild(renderProductLists(lists, onProductClick));
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}
