import type { AgentBackendResponse, DialogueStep } from "./types.js";

const DEMO_PRODUCTS = [
  {
    product_id: "10001",
    title: "Wireless Bluetooth Earbuds Pro",
    price: 1899,
    shop_id: "shop-42",
  },
  {
    product_id: "10002",
    title: "Running Shoes Lightweight Mesh",
    price: 2499,
    shop_id: "shop-17",
  },
  {
    product_id: "10003",
    title: "Cotton Crew Socks 3-Pack",
    price: 399,
    shop_id: "shop-17",
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferMockTask(query: string): "product" | "shop" | "voucher" {
  const q = query.toLowerCase();
  if (q.includes("voucher") || q.includes("budget") || q.includes("discount")) {
    return "voucher";
  }
  if (q.includes("same shop") || q.includes("same store")) {
    return "shop";
  }
  return "product";
}

function buildSteps(query: string, task: "product" | "shop" | "voucher"): DialogueStep[] {
  const keywords = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .join(" ");

  const step1: DialogueStep = {
    step: 1,
    think: `Analyzing your request. I'll search for "${keywords || "products"}" and apply any price or service filters you mentioned.`,
    tool_calls: [],
    response: "",
    query,
  };

  const searchResults =
    task === "shop"
      ? [DEMO_PRODUCTS[1], DEMO_PRODUCTS[2]]
      : task === "voucher"
        ? DEMO_PRODUCTS
        : [DEMO_PRODUCTS[0]];

  const step2: DialogueStep = {
    step: 2,
    think: `Found ${searchResults.length} candidate product(s). Scoring relevance against your query.`,
    tool_calls: [
      {
        name: "find_product",
        params: { q: keywords || "product", page: 1 },
        result: searchResults,
      },
    ],
    response: "",
    query,
  };

  const productIds = searchResults.map((p) => p.product_id);
  const step3: DialogueStep = {
    step: 3,
    think:
      task === "voucher"
        ? `Selected products fit within your budget after voucher discount. Total before discount: ₱${searchResults.reduce((s, p) => s + (p.price ?? 0), 0)}.`
        : task === "shop"
          ? `Both items are available from the same shop (shop-17). Recommending this combination.`
          : `Best match: "${searchResults[0]?.title}" at ₱${searchResults[0]?.price}.`,
    tool_calls: [
      { name: "recommend_product", params: { product_ids: productIds.join(",") }, result: `Recommended: ${productIds.join(",")}` },
      { name: "terminate", params: { status: "success" }, result: "The interaction has been completed with status: success" },
    ],
    response: "Done.",
    query,
  };

  return [step1, step2, step3];
}

/** Simulates the Python agent for local development and demos. */
export async function runMockAgent(
  query: string,
  onStep?: (step: DialogueStep, index: number) => void,
): Promise<AgentBackendResponse> {
  const task = inferMockTask(query);
  const steps = buildSteps(query, task);

  for (let i = 0; i < steps.length; i++) {
    await delay(400 + i * 300);
    onStep?.(steps[i], i);
  }

  const productIds = steps
    .flatMap((s) => s.tool_calls)
    .filter((tc) => tc.name === "find_product")
    .flatMap((tc) => {
      const result = tc.result;
      if (Array.isArray(result)) {
        return result.map((p: { product_id?: string }) => String(p.product_id ?? ""));
      }
      return [];
    })
    .filter(Boolean);

  const uniqueIds = [...new Set(productIds)];

  return {
    steps,
    status: "success",
    product_ids: uniqueIds.length ? uniqueIds : ["10001"],
  };
}
