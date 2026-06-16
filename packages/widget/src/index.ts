import { WidgetApiClient, appendMessage, defaultStyles, extractProductsFromSteps } from "./api-client.js";
import type {
  CommerceAgentWidgetGlobal,
  WidgetConfig,
  WidgetInstance,
  WidgetProduct,
} from "./types.js";

const STYLE_ID = "commerce-agent-widget-styles";

function injectStyles(config: WidgetConfig): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = defaultStyles(config);
  document.head.appendChild(style);
}

function createWidget(config: WidgetConfig): WidgetInstance {
  injectStyles(config);

  const api = new WidgetApiClient(config.apiUrl.replace(/\/$/, ""));
  const title = config.title ?? "Shopping Assistant";
  const greeting = config.greeting ?? "Hi! Tell me what you're looking for and I'll find the best products.";
  const placeholder = config.placeholder ?? "e.g. wireless earbuds under 2000 pesos";

  const root = document.createElement("div");
  root.className = "ca-widget-root";

  const launcher = document.createElement("button");
  launcher.className = "ca-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open shopping assistant");
  launcher.textContent = "🛒";

  const panel = document.createElement("div");
  panel.className = "ca-panel hidden";

  const header = document.createElement("div");
  header.className = "ca-header";
  header.innerHTML = `<span>${title}</span>`;

  const closeBtn = document.createElement("button");
  closeBtn.className = "ca-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  const messages = document.createElement("div");
  messages.className = "ca-messages";

  const inputRow = document.createElement("div");
  inputRow.className = "ca-input-row";

  const input = document.createElement("input");
  input.className = "ca-input";
  input.type = "text";
  input.placeholder = placeholder;

  const sendBtn = document.createElement("button");
  sendBtn.className = "ca-send";
  sendBtn.type = "button";
  sendBtn.textContent = "Send";

  inputRow.append(input, sendBtn);
  panel.append(header, messages, inputRow);
  root.append(launcher, panel);
  document.body.appendChild(root);

  appendMessage(messages, { role: "system", content: greeting });

  let open = false;
  let busy = false;
  let thinkingEl: HTMLElement | null = null;

  function setOpen(value: boolean): void {
    open = value;
    panel.classList.toggle("hidden", !open);
  }

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text || busy) return;

    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    appendMessage(messages, { role: "user", content: text });

    thinkingEl = appendMessage(messages, {
      role: "assistant",
      content: "Searching and comparing products…",
      thinking: true,
    });

    const useStream = typeof EventSource !== "undefined";

    if (useStream) {
      api.streamMessage(text, {
        onStep: (step) => {
          if (thinkingEl) {
            thinkingEl.textContent = step.think || "Working…";
          }
        },
        onDone: (result) => {
          if (thinkingEl) thinkingEl.remove();
          thinkingEl = null;
          const products = result.products?.length
            ? result.products
            : extractProductsFromSteps(result.steps as Parameters<typeof extractProductsFromSteps>[0]);
          const lastThink =
            (result.steps as Array<{ think?: string }>)?.at(-1)?.think ??
            "Here are my recommendations.";
          appendMessage(
            messages,
            { role: "assistant", content: lastThink, products },
            config.onProductClick,
          );
          busy = false;
          sendBtn.disabled = false;
          input.focus();
        },
        onError: () => {
          void fallbackFetch(text);
        },
      });
    } else {
      await fallbackFetch(text);
    }
  }

  async function fallbackFetch(text: string): Promise<void> {
    try {
      const result = await api.sendMessage(text);
      if (thinkingEl) thinkingEl.remove();
      thinkingEl = null;
      const products = result.products?.length
        ? result.products
        : extractProductsFromSteps(result.steps);
      const lastThink = result.steps.at(-1)?.think ?? "Here are my recommendations.";
      appendMessage(
        messages,
        { role: "assistant", content: lastThink, products },
        config.onProductClick,
      );
    } catch (err) {
      if (thinkingEl) thinkingEl.remove();
      thinkingEl = null;
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      appendMessage(messages, { role: "assistant", content: `Sorry — ${msg}` });
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(!open));
  closeBtn.addEventListener("click", () => setOpen(false));
  sendBtn.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    destroy: () => root.remove(),
  };
}

export function init(config: WidgetConfig): WidgetInstance {
  if (!config.apiUrl) {
    throw new Error("CommerceAgentWidget.init requires apiUrl");
  }
  return createWidget(config);
}

const globalApi: CommerceAgentWidgetGlobal = { init };

if (typeof window !== "undefined") {
  window.CommerceAgentWidget = globalApi;
}

export type { WidgetConfig, WidgetInstance, WidgetProduct, CommerceAgentWidgetGlobal };
