import type { DialogueStep, ToolCall } from "../types.js";

export function createToolCall(
  name: string,
  params: Record<string, unknown>,
  result: unknown,
): ToolCall {
  return { name, params, result };
}

export function createDialogueStep(
  think: string,
  toolCalls: ToolCall[],
  response: string,
  query: string,
  step: number,
): DialogueStep {
  return { step, think, tool_calls: toolCalls, response, query };
}

export function appendStep(
  steps: DialogueStep[],
  think: string,
  toolResults: ToolCall[],
  response: string,
  query: string,
): void {
  steps.push(createDialogueStep(think, toolResults, response, query, steps.length + 1));
}

export function makeRecommendCall(productIds: string): ToolCall {
  return createToolCall(
    "recommend_product",
    { product_ids: productIds },
    `Having recommended the products to the user: ${productIds}.`,
  );
}

export function makeTerminateCall(status: "success" | "failure"): ToolCall {
  return createToolCall(
    "terminate",
    { status },
    `The interaction has been completed with status: ${status}`,
  );
}

export function finishSession(
  steps: DialogueStep[],
  productIds: string[],
  status: "success" | "failure",
  query: string,
  think?: string,
): void {
  const ids = productIds.filter(Boolean).join(",") || "0";
  const thinkText =
    think ??
    `Recommending product(s) ${ids}. Status: ${status}.`;
  appendStep(
    steps,
    thinkText,
    [makeRecommendCall(ids), makeTerminateCall(status)],
    "Done.",
    query,
  );
}
