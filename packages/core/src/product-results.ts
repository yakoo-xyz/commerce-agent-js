import type { DialogueStep, Product } from "./types.js";

export interface ProductLists {
  bestMatches: Product[];
  recommendations: Product[];
}

const MAX_RECOMMENDATIONS = 6;

function collectProductsFromSteps(steps: DialogueStep[]): Map<string, Product> {
  const byId = new Map<string, Product>();
  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name !== "find_product" || !Array.isArray(tc.result)) continue;
      for (const row of tc.result) {
        if (row && typeof row === "object" && "product_id" in row) {
          const p = row as Product;
          byId.set(String(p.product_id), p);
        }
      }
    }
  }
  return byId;
}

function collectRecommendedIds(steps: DialogueStep[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    for (const tc of step.tool_calls) {
      if (tc.name !== "recommend_product") continue;
      const raw = String(tc.params?.product_ids ?? "");
      for (const id of raw.split(",")) {
        const pid = id.trim();
        if (pid && pid !== "0") ids.push(pid);
      }
    }
  }
  return ids;
}

/** Split search results into agent picks (best matches) and additional recommendations. */
export function partitionProductsFromSteps(steps: DialogueStep[]): ProductLists {
  const byId = collectProductsFromSteps(steps);
  const recommendedIds = collectRecommendedIds(steps);
  const recommendedSet = new Set(recommendedIds);

  let bestMatches = recommendedIds
    .map((id) => byId.get(id))
    .filter((p): p is Product => Boolean(p));

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
    recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS),
  };
}
