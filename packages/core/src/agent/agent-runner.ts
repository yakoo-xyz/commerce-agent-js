import { FALLBACK_PRODUCT_ID } from "./constants.js";
import { appendStep, createToolCall, finishSession } from "./dialogue.js";
import type { ProductSpec, ParsedQueryParams } from "./query-parser.js";
import { extractQueryParamsRegex, specToFindProductParams } from "./query-parser.js";
import type { FindProductParams, ProductApiPort } from "./product-api.js";
import {
  checkPickAgainstQuery,
  deduplicateProducts,
  scoreProduct,
  scoreProductForProductCase,
  selectBestProductHeuristic,
} from "./scoring.js";
import { calculateVoucher, voucherMaxTotalPrice } from "./voucher.js";
import type { DialogueStep, Product, ToolCall } from "../types.js";

export interface AgentRunOptions {
  onStep?: (step: DialogueStep, index: number) => void;
}

export interface AgentRunResult {
  steps: DialogueStep[];
  status: "success" | "failure";
  product_ids: string[];
}

class AgentContext {
  readonly detailCache = new Map<string, Record<string, unknown>>();

  constructor(readonly api: ProductApiPort) {}

  async findProduct(params: FindProductParams): Promise<ToolCall> {
    const result = await this.api.findProduct(params);
    return createToolCall("find_product", { ...params }, result);
  }

  async viewProductInformation(productIds: string[]): Promise<void> {
    const uncached = productIds.filter((id) => id && !this.detailCache.has(id));
    for (let i = 0; i < uncached.length; i += 10) {
      const batch = uncached.slice(i, i + 10);
      const rows = await this.api.viewProductInformation(batch.join(","));
      for (const row of rows) {
        this.detailCache.set(String(row.product_id ?? ""), row as Record<string, unknown>);
      }
    }
  }

  getDetail(productId: string): Record<string, unknown> | undefined {
    return this.detailCache.get(productId);
  }
}

function emitStep(
  steps: DialogueStep[],
  options: AgentRunOptions | undefined,
  think: string,
  toolResults: ToolCall[],
  response: string,
  query: string,
): void {
  appendStep(steps, think, toolResults, response, query);
  options?.onStep?.(steps[steps.length - 1], steps.length - 1);
}

async function runSingleProductSearch(
  ctx: AgentContext,
  params: ParsedQueryParams,
  query: string,
  steps: DialogueStep[],
  options?: AgentRunOptions,
): Promise<void> {
  const primarySpec = params.products[0] ?? { keywords: "product" };
  const searchParams = specToFindProductParams(primarySpec);
  const pool: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const toolBundle: ToolCall[] = [];

  const r1 = await ctx.findProduct({ ...searchParams, page: 1 } as FindProductParams);
  toolBundle.push(r1);
  for (const row of (r1.result as Product[]) ?? []) {
    const pid = String(row.product_id ?? "");
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      pool.push(row as Record<string, unknown>);
    }
  }

  const topCandidates = pool.slice(0, 5).map((r) => ({
    title: r.title,
    price: r.price,
    product_id: String(r.product_id ?? ""),
  }));

  emitStep(
    steps,
    options,
    `Searching for '${searchParams.q}' (price=${searchParams.price ?? "any"}, service=${searchParams.service ?? "any"}). Found ${pool.length} results. Top candidates: ${JSON.stringify(topCandidates)}.`,
    toolBundle,
    "",
    query,
  );

  const page1Pids = pool.slice(0, 10).map((p) => String(p.product_id ?? "")).filter(Boolean);
  await ctx.viewProductInformation(page1Pids);

  const page1Scores = pool.slice(0, 10).map((p) =>
    scoreProductForProductCase(
      p,
      query,
      ctx.getDetail(String(p.product_id ?? "")),
      primarySpec,
    ),
  );
  const maxP1Score = page1Scores.length ? Math.max(...page1Scores) : 0;

  if (!pool.length || maxP1Score < 10) {
    const fbCalls: ToolCall[] = [];
    const r2 = await ctx.findProduct({ ...searchParams, page: 2 } as FindProductParams);
    fbCalls.push(r2);
    for (const row of (r2.result as Product[]) ?? []) {
      const pid = String(row.product_id ?? "");
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        pool.push(row as Record<string, unknown>);
      }
    }
    emitStep(
      steps,
      options,
      `Weak page-1 score (max=${maxP1Score.toFixed(1)} < 10); broadened search to ${pool.length} total candidates.`,
      fbCalls,
      "",
      query,
    );
  }

  const details = new Map<string, Record<string, unknown>>();
  for (const p of pool) {
    const id = String(p.product_id ?? "");
    const d = ctx.getDetail(id);
    if (d) details.set(id, d);
  }

  const best = selectBestProductHeuristic(pool, query, primarySpec, details);
  if (!best) {
    finishSession(steps, [FALLBACK_PRODUCT_ID], "failure", query, "No suitable product found matching the query constraints.");
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
    return;
  }

  const pid = String(best.product_id ?? "");
  const constraintCheck = checkPickAgainstQuery(
    String(best.title ?? ""),
    best.price,
    primarySpec,
  );

  const thinkPick =
    `Selected product_id=${pid} title='${String(best.title ?? "").slice(0, 80)}' price=${best.price}. ` +
    `${constraintCheck.overall_note}`;

  finishSession(steps, [pid], "success", query, thinkPick);
  options?.onStep?.(steps[steps.length - 1], steps.length - 1);
}

async function collectShopCandidates(
  ctx: AgentContext,
  specs: ProductSpec[],
): Promise<{ broad: Record<string, unknown>[][]; toolCalls: ToolCall[] }> {
  const broad: Record<string, unknown>[][] = [];
  const toolCalls: ToolCall[] = [];

  for (const spec of specs) {
    const sp = specToFindProductParams(spec, { includePrice: false });
    const gathered: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    for (const page of [1, 2, 3]) {
      const r = await ctx.findProduct({ ...sp, page } as FindProductParams);
      toolCalls.push(r);
      for (const row of (r.result as Product[]) ?? []) {
        const pid = String(row.product_id ?? "");
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          gathered.push(row as Record<string, unknown>);
        }
      }
    }

    if (!gathered.length && sp.service) {
      const noSvc = { ...sp };
      delete noSvc.service;
      const r = await ctx.findProduct({ ...noSvc, page: 1 } as FindProductParams);
      toolCalls.push(r);
      for (const row of (r.result as Product[]) ?? []) {
        gathered.push(row as Record<string, unknown>);
      }
    }

    broad.push(gathered);
  }

  return { broad, toolCalls };
}

function groupProductsByShop(
  broadResults: Record<string, unknown>[][],
): Map<string, Map<number, Record<string, unknown>[]>> {
  const coverage = new Map<string, Map<number, Record<string, unknown>[]>>();
  for (let specIdx = 0; specIdx < broadResults.length; specIdx++) {
    for (const product of broadResults[specIdx] ?? []) {
      const sid = String(product.shop_id ?? "");
      if (!sid) continue;
      if (!coverage.has(sid)) coverage.set(sid, new Map());
      const shopMap = coverage.get(sid)!;
      if (!shopMap.has(specIdx)) shopMap.set(specIdx, []);
      shopMap.get(specIdx)!.push(product);
    }
  }
  return coverage;
}

async function runSameShopSearch(
  ctx: AgentContext,
  params: ParsedQueryParams,
  query: string,
  steps: DialogueStep[],
  options?: AgentRunOptions,
): Promise<void> {
  const specs = params.products;
  const nSpecs = specs.length;
  if (!nSpecs) {
    finishSession(steps, [FALLBACK_PRODUCT_ID], "failure", query, "No product specs found in shop query.");
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
    return;
  }

  const kwList = specs.map((s) => s.keywords);
  emitStep(
    steps,
    options,
    `Searching for ${nSpecs} products from the same shop. Keywords: ${kwList.join("; ")}.`,
    [],
    "",
    query,
  );

  const { broad, toolCalls } = await collectShopCandidates(ctx, specs);
  emitStep(steps, options, `Collected candidate pools per product spec.`, toolCalls, "", query);

  const shopCoverage = groupProductsByShop(broad);
  const fullShops = [...shopCoverage.entries()]
    .filter(([, cov]) => cov.size === nSpecs)
    .map(([shopId]) => shopId);

  if (fullShops.length >= 1) {
    const shopId = fullShops[0];
    const cov = shopCoverage.get(shopId)!;
    const chosenIds: string[] = [];
    const used = new Set<string>();

    for (let specIdx = 0; specIdx < nSpecs; specIdx++) {
      const pool = cov.get(specIdx) ?? [];
      const spec = specs[specIdx];
      const sorted = [...pool].sort(
        (a, b) => scoreProduct(b, query, null, spec) - scoreProduct(a, query, null, spec),
      );
      for (const product of sorted) {
        const pid = String(product.product_id ?? "");
        if (pid && !used.has(pid)) {
          chosenIds.push(pid);
          used.add(pid);
          break;
        }
      }
    }

    if (chosenIds.length === nSpecs) {
      finishSession(
        steps,
        chosenIds,
        "success",
        query,
        `Found all ${nSpecs} products from shop ${shopId}: ${chosenIds.join(", ")}.`,
      );
      options?.onStep?.(steps[steps.length - 1], steps.length - 1);
      return;
    }
  }

  finishSession(
    steps,
    [FALLBACK_PRODUCT_ID],
    "failure",
    query,
    `Could not find a single shop covering all ${nSpecs} product specs (full-coverage shops: ${fullShops.length}).`,
  );
  options?.onStep?.(steps[steps.length - 1], steps.length - 1);
}

async function runVoucherSearch(
  ctx: AgentContext,
  params: ParsedQueryParams,
  query: string,
  steps: DialogueStep[],
  options?: AgentRunOptions,
): Promise<void> {
  const products = params.products;
  const voucher = params.voucher ?? {
    discount_type: "percentage" as const,
    discount_value: 10,
    threshold: 0,
    cap: 0,
    budget: 5000,
  };

  const allowedTotal = voucherMaxTotalPrice(voucher);
  if (!allowedTotal || allowedTotal <= 0) {
    finishSession(steps, [FALLBACK_PRODUCT_ID], "failure", query, "Could not calculate allowed total from voucher parameters.");
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
    return;
  }

  emitStep(
    steps,
    options,
    `Voucher task: ${products.length} product(s). Budget=${voucher.budget}, allowed_total=${allowedTotal.toFixed(2)}.`,
    [],
    "",
    query,
  );

  const picked: Record<string, unknown>[] = [];
  const toolCalls: ToolCall[] = [];

  for (const spec of products) {
    const sp = specToFindProductParams(spec, { includePrice: false });
    sp.price = `0-${Math.floor(allowedTotal)}`;
    sp.sort = "priceasc";

    let found: Record<string, unknown>[] = [];
    for (const page of [1, 2]) {
      const r = await ctx.findProduct({ ...sp, page } as FindProductParams);
      toolCalls.push(r);
      found = found.concat((r.result as Product[]) ?? []);
    }
    found = deduplicateProducts(found);

    const best = selectBestProductHeuristic(found, query, spec);
    if (best) picked.push(best);
  }

  if (picked.length !== products.length) {
    emitStep(steps, options, `Could only find ${picked.length}/${products.length} products within budget.`, toolCalls, "", query);
    finishSession(steps, [FALLBACK_PRODUCT_ID], "failure", query);
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
    return;
  }

  const prices = picked.map((p) => Number(p.price ?? 0));
  const calc = calculateVoucher(
    prices.join(","),
    voucher.discount_type,
    voucher.discount_value,
    voucher.threshold,
    voucher.budget,
    voucher.cap,
  );

  emitStep(
    steps,
    options,
    `Selected products with prices ${prices.join(", ")}. Voucher calculation: ${JSON.stringify(calc)}.`,
    toolCalls,
    "",
    query,
  );

  if ("error" in calc || !calc.within_budget) {
    finishSession(steps, [FALLBACK_PRODUCT_ID], "failure", query, "Selected combination exceeds budget after voucher.");
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
    return;
  }

  const ids = picked.map((p) => String(p.product_id ?? ""));
  finishSession(
    steps,
    ids,
    "success",
    query,
    `Voucher search complete. Total after discount: ${"total_after" in calc ? calc.total_after : "?"}. Product IDs: ${ids.join(", ")}.`,
  );
  options?.onStep?.(steps[steps.length - 1], steps.length - 1);
}

/** Built-in commerce agent — uses heuristic scoring (no LLM). */
export async function runCommerceAgent(
  query: string,
  api: ProductApiPort,
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const steps: DialogueStep[] = [];
  const ctx = new AgentContext(api);

  try {
    const params = extractQueryParamsRegex(query);
    const kwList = params.products.map((p) => p.keywords);
    const priceList = params.products.map((p) => p.price_range);
    const serviceList = params.products.map((p) => p.service);

    emitStep(
      steps,
      options,
      `Analyzing query. Keywords: ${kwList.join("; ")}. Price constraints: ${priceList.join("; ")}. Service filters: ${serviceList.join("; ")}.`,
      [],
      "",
      query,
    );

    if (params.task_type === "shop") {
      await runSameShopSearch(ctx, params, query, steps, options);
    } else if (params.task_type === "voucher") {
      await runVoucherSearch(ctx, params, query, steps, options);
    } else {
      await runSingleProductSearch(ctx, params, query, steps, options);
    }
  } catch (err) {
    finishSession(
      steps,
      [FALLBACK_PRODUCT_ID],
      "failure",
      query,
      err instanceof Error ? err.message : "Agent error",
    );
    options?.onStep?.(steps[steps.length - 1], steps.length - 1);
  }

  if (!steps.length) {
    appendStep(steps, "Done.", [], "Done.", query);
  }

  const productIds: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name === "recommend_product") {
        const raw = String((tc.params?.product_ids as string) ?? "");
        for (const pid of raw.split(",")) {
          const id = pid.trim();
          if (id && id !== "0" && !seen.has(id)) {
            seen.add(id);
            productIds.push(id);
          }
        }
      }
    }
  }

  let status: "success" | "failure" = productIds.length ? "success" : "failure";
  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name === "terminate" && tc.params?.status === "failure") {
        status = "failure";
      }
    }
  }

  return { steps, status, product_ids: productIds.length ? productIds : [FALLBACK_PRODUCT_ID] };
}

export { DelegatingProductApiPort, CatalogApiClient } from "./product-api.js";
export type { ProductApiConfig, ProductApiPort, PendingToolRequest } from "./product-api.js";
export { extractQueryParamsRegex, inferTaskType } from "./query-parser.js";
