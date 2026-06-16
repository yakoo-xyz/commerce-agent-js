import { SCORING_STOPWORDS } from "./constants.js";
import type { ProductSpec } from "./query-parser.js";

export function parsePriceRangeStr(priceRange: string | null | undefined): [number | null, number | null] {
  if (!priceRange) return [null, null];
  const rangeStr = String(priceRange).trim();
  if (!rangeStr.includes("-")) {
    const n = Number(rangeStr);
    return Number.isFinite(n) ? [null, n] : [null, null];
  }
  const dashIndex = rangeStr.indexOf("-");
  const minStr = rangeStr.slice(0, dashIndex).trim();
  const maxStr = rangeStr.slice(dashIndex + 1).trim();
  const minPrice = minStr ? Number(minStr) : null;
  const maxPrice = maxStr ? Number(maxStr) : null;
  return [
    minPrice != null && Number.isFinite(minPrice) ? minPrice : null,
    maxPrice != null && Number.isFinite(maxPrice) ? maxPrice : null,
  ];
}

export function productMatchesServices(
  product: Record<string, unknown>,
  serviceSpec: string | null | undefined,
): boolean {
  if (!serviceSpec) return true;
  const required = new Set(
    String(serviceSpec)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  if (!required.size) return true;
  const offered = product.service;
  const offeredSet = new Set(Array.isArray(offered) ? offered.map(String) : []);
  for (const svc of required) {
    if (!offeredSet.has(svc)) return false;
  }
  return true;
}

export function scoreProduct(
  product: Record<string, unknown>,
  queryText: string,
  detail?: Record<string, unknown> | null,
  parsedSpec?: ProductSpec | null,
): number {
  const title = String(product.title ?? "").toLowerCase();
  const titleWords = new Set([...title.matchAll(/\b\w+\b/g)].map((m) => m[0]));
  const queryWords = [
    ...new Set(
      [...queryText.toLowerCase().matchAll(/\b\w+/g)]
        .map((m) => m[0])
        .filter((w) => !SCORING_STOPWORDS.has(w) && w.length > 1),
    ),
  ];
  const spec = parsedSpec ?? ({} as ProductSpec);
  let score = 0;

  for (const queryWord of queryWords) {
    if (
      titleWords.has(queryWord) ||
      (queryWord.endsWith("s") && titleWords.has(queryWord.slice(0, -1))) ||
      (!queryWord.endsWith("s") && titleWords.has(`${queryWord}s`)) ||
      (queryWord.length >= 3 &&
        [...titleWords].some(
          (tw) => tw.startsWith(queryWord) && tw.length > queryWord.length,
        ))
    ) {
      score += 2;
    } else if (
      [...titleWords].some(
        (tw) =>
          tw.length > 2 &&
          (queryWord.startsWith(tw) || tw.startsWith(queryWord)),
      )
    ) {
      score += 1;
    }
    if (/[0-9]/.test(queryWord) && title.includes(queryWord)) score += 2;
  }

  const price = product.price;
  if (typeof price === "number" && spec.price_range) {
    const [minPrice, maxPrice] = parsePriceRangeStr(spec.price_range);
    if ((minPrice != null && price < minPrice) || (maxPrice != null && price > maxPrice)) {
      score -= 25;
    } else {
      score += 5;
    }
  }

  const productServices = new Set(
    Array.isArray(product.service) ? product.service.map(String) : [],
  );
  if (spec.service) {
    for (const svc of spec.service.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (productServices.has(svc)) score += 5;
      else score -= 15;
    }
  }

  if (detail) {
    const exactValues = new Set<string>();
    const attrWords = new Set<string>();

    const attrs = detail.attributes;
    if (attrs && typeof attrs === "object") {
      for (const [attrKey, values] of Object.entries(attrs as Record<string, unknown>)) {
        const keyLower = attrKey.toLowerCase();
        for (const w of keyLower.replace(/_/g, " ").match(/\b\w+\b/g) ?? []) attrWords.add(w);
        const list = Array.isArray(values) ? values : [values];
        for (const value of list) {
          const valueStr = String(value).trim().toLowerCase();
          exactValues.add(valueStr);
          for (const w of valueStr.match(/\b\w+\b/g) ?? []) attrWords.add(w);
        }
      }
    }

    const skuOptions = detail.sku_options;
    if (skuOptions && typeof skuOptions === "object") {
      for (const opts of Object.values(skuOptions as Record<string, unknown>)) {
        if (opts && typeof opts === "object") {
          for (const [attrKey, value] of Object.entries(opts as Record<string, unknown>)) {
            const valueStr = String(value).trim().toLowerCase();
            exactValues.add(valueStr);
            for (const w of valueStr.match(/\b\w+\b/g) ?? []) attrWords.add(w);
            for (const w of attrKey.toLowerCase().replace(/_/g, " ").match(/\b\w+\b/g) ?? []) {
              attrWords.add(w);
            }
          }
        }
      }
    }

    for (const queryWord of queryWords) {
      if (exactValues.has(queryWord)) score += 3;
      else if (exactValues.has(`${queryWord}#`)) score += 5;
      else if (attrWords.has(queryWord)) score += 2;
    }
  }

  return score;
}

export function scoreProductForProductCase(
  product: Record<string, unknown>,
  queryText: string,
  detail?: Record<string, unknown> | null,
  parsedSpec?: ProductSpec | null,
): number {
  return scoreProduct(product, queryText, detail, parsedSpec);
}

export function selectBestProductHeuristic(
  products: Record<string, unknown>[],
  queryText: string,
  parsedSpec?: ProductSpec | null,
  details: Map<string, Record<string, unknown>> = new Map(),
  topCount = 15,
): Record<string, unknown> | null {
  if (!products.length) return null;
  const top = [...products]
    .sort(
      (a, b) =>
        scoreProductForProductCase(
          b,
          queryText,
          details.get(String(b.product_id ?? "")),
          parsedSpec,
        ) -
        scoreProductForProductCase(
          a,
          queryText,
          details.get(String(a.product_id ?? "")),
          parsedSpec,
        ),
    )
    .slice(0, topCount);
  return top[0] ?? null;
}

export function deduplicateProducts<T extends Record<string, unknown>>(products: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of products) {
    const id = String(p.product_id ?? "");
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  return out;
}

export function formatProductIds(ids: string[], expectedOrder?: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const pid = String(raw).trim();
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      out.push(pid);
    }
  }
  if (expectedOrder?.length) {
    const rank = new Map(expectedOrder.map((id, i) => [id, i]));
    out.sort((a, b) => (rank.get(a) ?? expectedOrder.length) - (rank.get(b) ?? expectedOrder.length));
  }
  return out.length ? out.join(",") : "0";
}

export function checkPickAgainstQuery(
  title: string,
  price: unknown,
  parsedSpec: ProductSpec,
): Record<string, unknown> {
  const titleLower = title.toLowerCase();
  const queryKeywords = (parsedSpec.keywords ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matched = queryKeywords.filter((w) => titleLower.includes(w));
  const missing = queryKeywords.filter((w) => !titleLower.includes(w));

  let priceOk: boolean | null = null;
  let priceNote = "no price range was parsed from the query";
  if (parsedSpec.price_range) {
    const [lo, hi] = parsePriceRangeStr(parsedSpec.price_range);
    if (price != null) {
      const pv = Number(price);
      if (Number.isFinite(pv)) {
        if (lo != null && pv < lo) {
          priceOk = false;
          priceNote = `price ${pv} is BELOW lower bound ${lo}`;
        } else if (hi != null && pv > hi) {
          priceOk = false;
          priceNote = `price ${pv} is ABOVE upper bound ${hi}`;
        } else {
          priceOk = true;
          priceNote = `price ${pv} fits inside range ${parsedSpec.price_range}`;
        }
      }
    }
  }

  let overallNote: string;
  if (!missing.length && priceOk !== false) {
    overallNote = "The selected product looks like a genuine match for the parsed query.";
  } else if (missing.length && priceOk === false) {
    overallNote = `Title missing terms ${missing.join(", ")} and price is outside the requested range.`;
  } else if (missing.length) {
    overallNote = `Title is missing query terms ${missing.join(", ")}; best available candidate.`;
  } else {
    overallNote = "Title matches keywords but price does not fit the requested range.";
  }

  return {
    query_keywords: queryKeywords,
    keywords_matched: matched,
    keywords_missing: missing,
    title_contains_all_keywords: !missing.length,
    price_ok: priceOk,
    price_note: priceNote,
    overall_note: overallNote,
  };
}
