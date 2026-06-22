import type { ParsedQueryParams, ProductSpec, TaskType } from "./query-parser.js";
import { enrichProductSpecs, extractPriceRange, extractQueryParamsRegex } from "./query-parser.js";
import { splitMultiProductQuery } from "./constants.js";

export interface LlmConfig {
  /** OpenAI-compatible API base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Model name. Default gpt-4o-mini */
  model?: string;
  /** Request timeout ms. Default 30_000 */
  timeoutMs?: number;
}

const EXTRACT_SYSTEM = `You extract structured shopping intent from user queries for an Amazon shopping agent.
Return ONLY valid JSON (no markdown) matching this schema:
{
  "task_type": "product" | "shop" | "voucher",
  "products": [
    {
      "keywords": "main product search phrase (2-6 words)",
      "brand": "brand name or null",
      "features": ["feature1", "feature2"],
      "price_range": "min-max in USD without currency symbol, e.g. 0-50, or null",
      "service": "prime,freeShipping comma-separated or null"
    }
  ],
  "is_shop_voucher": false
}

Rules:
- keywords: core product type + key attributes for Amazon search (not full sentence)
- brand: only if user mentions a brand (Apple, Nike, Sony, etc.)
- features: specs like waterproof, wireless, 256GB, running, ANC
- price_range: USD min-max without currency symbol. ALWAYS extract when user mentions price, budget, cost, or dollar amounts.
  Examples: "under $50" -> "0-50", "$100-$200" -> "100-200", "over $100" -> "100-", "around $80" -> "0-80", "budget $500" -> "0-500"
- If multiple products each have their own price, set price_range on each product entry separately
- service: use "prime" for Prime-eligible, "freeShipping" for free delivery
- Multiple products -> separate entries in products array
- voucher/budget/discount queries -> task_type "voucher"`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function normalizeProduct(raw: Record<string, unknown>, fallbackText?: string): ProductSpec {
  const keywords = String(raw.keywords ?? raw.product_name ?? "product").trim() || "product";
  const brand = raw.brand ? String(raw.brand).trim() : null;
  const features = Array.isArray(raw.features)
    ? raw.features.map((f) => String(f).trim()).filter(Boolean)
    : [];
  let price_range = raw.price_range ? String(raw.price_range).trim() : null;
  if (!price_range && fallbackText) {
    price_range = extractPriceRange(fallbackText);
  }
  const service = raw.service ? String(raw.service).trim() : null;

  const parts = [keywords];
  if (brand) parts.push(brand);
  for (const f of features.slice(0, 4)) parts.push(f);

  return {
    keywords: parts.join(" ").trim(),
    brand,
    features,
    price_range: price_range || null,
    service: service || null,
    query: keywords,
  };
}

function normalizeParsed(raw: Record<string, unknown>, fallbackQuery: string): ParsedQueryParams {
  const task_type = (["product", "shop", "voucher"].includes(String(raw.task_type))
    ? raw.task_type
    : "product") as TaskType;

  const segments = splitMultiProductQuery(fallbackQuery);

  let products: ProductSpec[] = [];
  if (Array.isArray(raw.products)) {
    products = raw.products
      .filter((p) => p && typeof p === "object")
      .map((p, i) =>
        normalizeProduct(p as Record<string, unknown>, segments[i] ?? fallbackQuery),
      );
  }
  if (!products.length) {
    return extractQueryParamsRegex(fallbackQuery);
  }

  products = enrichProductSpecs(products, fallbackQuery);

  return {
    task_type,
    products,
    is_shop_voucher: Boolean(raw.is_shop_voucher),
    voucher: task_type === "voucher" ? extractQueryParamsRegex(fallbackQuery).voucher : undefined,
  };
}

/** Extract product names, brands, and features using an OpenAI-compatible LLM. */
export async function extractQueryParamsLlm(
  query: string,
  config: LlmConfig,
): Promise<ParsedQueryParams> {
  const base = config.baseUrl.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model ?? "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: query },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM extract failed (${res.status}): ${text || res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty content");

    const parsed = JSON.parse(stripJsonFence(content)) as Record<string, unknown>;
    return normalizeParsed(parsed, query);
  } finally {
    clearTimeout(timeout);
  }
}

/** LLM extraction with regex fallback on error. */
export async function parseQueryParams(
  query: string,
  llm?: LlmConfig,
): Promise<{ params: ParsedQueryParams; source: "llm" | "regex" }> {
  if (llm?.apiKey && llm.baseUrl) {
    try {
      const params = await extractQueryParamsLlm(query, llm);
      return { params, source: "llm" };
    } catch {
      /* fall through to regex */
    }
  }
  return { params: extractQueryParamsRegex(query), source: "regex" };
}

export function formatExtractSummary(params: ParsedQueryParams, source: "llm" | "regex"): string {
  const lines = params.products.map((p, i) => {
    const feats = p.features?.length ? ` features=[${p.features.join(", ")}]` : "";
    const brand = p.brand ? ` brand=${p.brand}` : "";
    return `  ${i + 1}. "${p.keywords}"${brand}${feats} price=${p.price_range ?? "any"}`;
  });
  return `Query parsed via ${source.toUpperCase()}:\n${lines.join("\n")}`;
}
