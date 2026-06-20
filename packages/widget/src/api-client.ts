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

export function baseWidgetStyles(): string {
  return `
    .ca-widget-root {
      font-family: var(--ca-font, system-ui, -apple-system, sans-serif);
      color-scheme: var(--ca-color-scheme, light);
    }
    .ca-launcher {
      position: fixed;
      left: var(--ca-pos-left, auto);
      right: var(--ca-pos-right, 24px);
      bottom: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--ca-primary, #6366f1);
      color: var(--ca-on-primary, #fff);
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px var(--ca-shadow, rgba(0,0,0,.2));
      z-index: var(--ca-z, 99999);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }
    .ca-launcher:hover { filter: brightness(1.08); }
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
    .ca-panel.hidden { display: none; }
    .ca-header {
      padding: 14px 16px;
      background: var(--ca-primary, #6366f1);
      color: var(--ca-on-primary, #fff);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
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
    .ca-msg.thinking { opacity: .7; font-style: italic; }
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
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      background: var(--ca-surface-elevated, #fff);
      transition: border-color .15s, box-shadow .15s;
    }
    .ca-product:hover {
      border-color: var(--ca-primary, #6366f1);
      box-shadow: 0 2px 8px var(--ca-primary-glow, rgba(99,102,241,.12));
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
  el.textContent = msg.content;
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
