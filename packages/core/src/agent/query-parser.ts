import {
  BUDGET_SPLIT_RE,
  MULTI_PRODUCT_SPLIT_RE,
  REGEX_STOPWORDS,
} from "./constants.js";

export type TaskType = "product" | "shop" | "voucher";

export interface ProductSpec {
  keywords: string;
  query?: string;
  price_range?: string | null;
  service?: string | null;
  brand?: string | null;
  only_product_type?: boolean;
}

export interface VoucherSpec {
  discount_type: "fixed" | "percentage";
  discount_value: number;
  threshold: number;
  cap: number;
  budget: number;
  voucher_type?: string;
}

export interface ParsedQueryParams {
  task_type: TaskType;
  products: ProductSpec[];
  is_shop_voucher?: boolean;
  voucher?: VoucherSpec;
}

export function inferTaskType(query: string): TaskType {
  const q = query.toLowerCase();
  if (q.includes("voucher") || q.includes("budget") || q.includes("discount")) {
    return "voucher";
  }
  if (
    q.includes("shop") &&
    (/\b(both|these|offering|offers|sells|same|together|along\s+with)\b/i.test(q) ||
      MULTI_PRODUCT_SPLIT_RE.test(query))
  ) {
    return "shop";
  }
  return "product";
}

function extractProductSpec(text: string): ProductSpec {
  const alphaWords = [...text.toLowerCase().matchAll(/\b[a-zA-Z]{2,}\b/g)]
    .map((m) => m[0])
    .filter((w) => !REGEX_STOPWORDS.has(w));

  const alnumTokens = [
    ...(text.toLowerCase().matchAll(/\b\d+[a-zA-Z]+\b|\b[a-zA-Z]+\d+[a-zA-Z]*\b/g) ?? []),
  ].map((m) => m[0]);

  const words = [...alphaWords.slice(0, 6)];
  for (const t of alnumTokens.slice(0, 2)) {
    if (!words.includes(t)) words.push(t);
  }
  for (const s of [...text.matchAll(/(\d+)#/g)].slice(0, 2).map((m) => m[1])) {
    if (!words.includes(s)) words.push(s);
  }
  const keywords = words.join(" ") || "product";

  let price_range: string | null = null;
  let m = text.match(/(?:greater|more|over|above|>|cost[s]?\s+more)\s*(?:than\s*)?(\d+)/i);
  if (m) {
    price_range = `${m[1]}-`;
  } else {
    m = text.match(/(\d{1,6})\s*(?:to|and|-)\s*(\d{1,6})\s*(?:pesos|php)/i);
    if (m) {
      price_range = `${m[1]}-${m[2]}`;
    } else if (/(?:price|pesos|php|cost)/i.test(text)) {
      m = text.match(/(\d{1,6})\s+(?:to|and)\s+(\d{1,6})/);
      if (m) price_range = `${m[1]}-${m[2]}`;
      else {
        m = text.match(/(?:under|below|less than|max|up to)\s*(\d{1,6})/i);
        if (m) price_range = `0-${m[1]}`;
        else {
          m = text.match(/(\d{1,6})\s*(?:pesos|php)/i);
          if (m) price_range = `0-${m[1]}`;
        }
      }
    }
  }

  let service: string | null = null;
  const tl = text.toLowerCase();
  if (tl.includes("lazmall") || tl.includes("official")) service = "official";
  if (tl.includes("free shipping") || tl.includes("free delivery")) {
    service = service ? `${service},freeShipping` : "freeShipping";
  }
  if (tl.includes("lazflash") || tl.includes("flash sale") || tl.includes("flashsale")) {
    service = service ? `${service},flashsale` : "flashsale";
  }
  if (tl.includes("cash on delivery") || /\bcod\b/.test(tl)) {
    service = service ? `${service},COD` : "COD";
  }

  return { keywords, price_range, service };
}

function extractVoucherFromQuery(query: string): VoucherSpec | undefined {
  const q = query.toLowerCase();
  const budgetMatch = query.match(/(?:budget|maximum|max|up to)\s*(?:of\s*)?(\d{1,7})/i);
  const budget = budgetMatch ? Number(budgetMatch[1]) : 0;

  const thresholdMatch = query.match(/(?:minimum|min|spend|purchase|total)\s*(?:of\s*)?(\d{1,7})/i);
  const threshold = thresholdMatch ? Number(thresholdMatch[1]) : 0;

  let discount_type: "fixed" | "percentage" = "percentage";
  let discount_value = 0;
  let cap = 0;

  const pctMatch = query.match(/(\d{1,3})\s*%\s*(?:off|discount)?/i);
  const fixedMatch = query.match(/(?:discount|off|save)\s*(?:of\s*)?(\d{1,7})\s*(?:pesos|php)?/i);

  if (pctMatch) {
    discount_type = "percentage";
    discount_value = Number(pctMatch[1]);
    const capMatch = query.match(/(?:cap|maximum|max)\s*(?:discount\s*)?(?:of\s*)?(\d{1,7})/i);
    if (capMatch) cap = Number(capMatch[1]);
  } else if (fixedMatch) {
    discount_type = "fixed";
    discount_value = Number(fixedMatch[1]);
  } else if (budget > 0) {
    discount_type = "percentage";
    discount_value = 10;
  }

  if (!budget && !threshold && !discount_value) return undefined;

  return {
    discount_type,
    discount_value,
    threshold,
    cap,
    budget: budget || threshold * 2 || 5000,
  };
}

/** Regex-based query parsing (fallback when no LLM is available). */
export function extractQueryParamsRegex(query: string): ParsedQueryParams {
  const task_type = inferTaskType(query);

  let productText = query.split(BUDGET_SPLIT_RE)[0]?.trim() ?? query;
  if (!productText || productText.length < 15) productText = query;

  let parts = productText
    .split(MULTI_PRODUCT_SPLIT_RE)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 10);
  if (!parts.length) parts = [query];

  let products = parts.map(extractProductSpec);
  products = products.filter((s: ProductSpec) => s.keywords.split(/\s+/).length >= 2);
  if (!products.length) products = [extractProductSpec(query)];

  const is_shop_voucher =
    task_type === "shop" || (task_type === "voucher" && query.toLowerCase().includes("same shop"));

  const result: ParsedQueryParams = { task_type, products, is_shop_voucher };

  if (task_type === "voucher") {
    result.voucher = extractVoucherFromQuery(query);
  }

  return result;
}

export function specToFindProductParams(
  product: ProductSpec,
  options: { includePrice?: boolean } = {},
): Record<string, string | number> {
  const includePrice = options.includePrice !== false;
  let searchQuery = product.keywords;
  if (!product.service && product.only_product_type) {
    searchQuery = `${product.keywords} only`;
  }

  const params: Record<string, string | number> = { q: searchQuery };
  if (includePrice && product.price_range) params.price = product.price_range;
  if (product.service) params.service = product.service;
  return params;
}
