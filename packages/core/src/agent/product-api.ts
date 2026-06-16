import type { Product } from "../types.js";

/** find_product search parameters. */
export interface FindProductParams {
  q: string;
  page?: number;
  shop_id?: string;
  price?: string;
  sort?: "priceasc" | "pricedesc" | "order" | "default";
  service?: string;
}

export interface ProductApiConfig {
  baseUrl: string;
  apiKey?: string;
  /** Minimum delay between requests (ms). Default 700. */
  minIntervalMs?: number;
}

/** Product catalog search tools (`find_product`, `view_product_information`). */
export interface ProductApiPort {
  findProduct(params: FindProductParams): Promise<Product[]>;
  viewProductInformation(productIds: string): Promise<Product[]>;
}

function encodeQuery(q: string): string {
  return encodeURIComponent(q).replace(/%20/g, "+");
}

function normalizeService(service: string | undefined): string | undefined {
  if (!service) return undefined;
  const parts = service.split(",").map((p) => p.trim()).filter((p) => p && p !== "default");
  return parts.length ? parts.join(",") : undefined;
}

export function buildFindProductQueryParams(params: FindProductParams): Record<string, string | number> {
  const out: Record<string, string | number> = {
    q: encodeQuery(params.q),
    page: params.page ?? 1,
  };
  if (params.shop_id) out.shop_id = params.shop_id;
  if (params.price) out.price = params.price;
  if (params.sort && params.sort !== "default") out.sort = params.sort;
  const service = normalizeService(params.service);
  if (service) out.service = service;
  return out;
}

/** Direct HTTP client for product catalog API endpoints. Works in Node and browser. */
export class CatalogApiClient implements ProductApiPort {
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly minIntervalMs: number;

  constructor(config: ProductApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.minIntervalMs = config.minIntervalMs ?? 700;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.minIntervalMs - (now - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T | null> {
    await this.throttle();
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${this.baseUrl}${path}?${qs}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Product API ${path} failed (${res.status}): ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async findProduct(params: FindProductParams): Promise<Product[]> {
    const searchParams = buildFindProductQueryParams(params);
    let result = (await this.get<Product[]>("/search/find_product", searchParams)) ?? [];
    if (result.length || !searchParams.service) return result;

    const retry = { ...searchParams };
    delete retry.service;
    result = (await this.get<Product[]>("/search/find_product", retry)) ?? [];
    return result;
  }

  async viewProductInformation(productIds: string): Promise<Product[]> {
    if (!productIds) return [];
    return (await this.get<Product[]>("/search/view_product_information", { product_ids: productIds })) ?? [];
  }
}

export interface PendingToolRequest {
  id: string;
  name: "find_product" | "view_product_information";
  params: Record<string, unknown>;
}

/** Delegates product API calls to an external executor (browser widget). */
export class DelegatingProductApiPort implements ProductApiPort {
  private readonly pending = new Map<string, { resolve: (v: Product[]) => void; reject: (e: Error) => void }>();
  onToolRequest?: (request: PendingToolRequest) => void;

  private request(name: PendingToolRequest["name"], params: Record<string, unknown>): Promise<Product[]> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.onToolRequest?.({ id, name, params });
    });
  }

  fulfillToolResult(id: string, result: Product[] | unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (Array.isArray(result)) {
      entry.resolve(result as Product[]);
      return;
    }
    if (result && typeof result === "object" && "result" in result && Array.isArray((result as { result: unknown }).result)) {
      entry.resolve((result as { result: Product[] }).result);
      return;
    }
    entry.resolve([]);
  }

  rejectToolResult(id: string, message: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.reject(new Error(message));
  }

  async findProduct(params: FindProductParams): Promise<Product[]> {
    return this.request("find_product", { ...params });
  }

  async viewProductInformation(productIds: string): Promise<Product[]> {
    return this.request("view_product_information", { product_ids: productIds });
  }
}
