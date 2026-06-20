import { WidgetApiClient, appendMessage, baseWidgetStyles, extractProductListsFromSteps } from "./api-client.js";
import { applyThemeToElement, resolveWidgetTheme, watchThemeChanges } from "./theme.js";
import { setupPanelResize } from "./resize.js";
import type {
  CommerceAgentWidgetGlobal,
  WidgetConfig,
  WidgetInstance,
  WidgetProduct,
  WidgetProductApiConfig,
  WidgetProductLists,
} from "./types.js";

const STYLE_ID = "commerce-agent-widget-styles";
const STORAGE_KEY = "commerce-agent-product-api";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = baseWidgetStyles();
  document.head.appendChild(style);
}

function applyTheme(root: HTMLElement, config: WidgetConfig): void {
  applyThemeToElement(root, resolveWidgetTheme(config.theme));
}

function loadStoredProductApi(): WidgetProductApiConfig | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WidgetProductApiConfig;
    return parsed.baseUrl ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveProductApi(config: WidgetProductApiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function createWidget(config: WidgetConfig): WidgetInstance {
  injectStyles();

  let productApi = config.productApi ?? loadStoredProductApi();
  const delegateProductApi = config.delegateProductApi !== false;

  const api = new WidgetApiClient(config.apiUrl.replace(/\/$/, ""), {
    productApi,
    delegateProductApi,
  });

  const title = config.title ?? "Shopping Assistant";
  const greeting = config.greeting ?? "Hi! Tell me what you're looking for and I'll find the best products.";
  const placeholder = config.placeholder ?? "e.g. wireless earbuds under $50";

  const root = document.createElement("div");
  root.className = "ca-widget-root";
  applyTheme(root, config);

  const stopThemeWatch =
    config.theme?.mode === "auto" || config.theme?.mode === undefined
      ? watchThemeChanges(() => applyTheme(root, config))
      : null;

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

  let settingsEl: HTMLElement | null = null;
  if (config.showProductApiSettings) {
    settingsEl = document.createElement("div");
    settingsEl.className = "ca-settings";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ca-settings-toggle";
    toggle.textContent = "⚙ Product API settings";

    const form = document.createElement("div");
    form.hidden = true;

    const baseLabel = document.createElement("label");
    baseLabel.textContent = "OpenAPI base URL";
    const baseInput = document.createElement("input");
    baseInput.type = "url";
    baseInput.placeholder = "https://your-api.example.com";
    baseInput.value = productApi?.baseUrl ?? "";

    const keyLabel = document.createElement("label");
    keyLabel.textContent = "API key (optional)";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "Bearer token";
    keyInput.value = productApi?.apiKey ?? "";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ca-send";
    saveBtn.textContent = "Save";
    saveBtn.style.marginTop = "4px";

    toggle.addEventListener("click", () => {
      form.hidden = !form.hidden;
    });

    saveBtn.addEventListener("click", () => {
      const next: WidgetProductApiConfig = {
        baseUrl: baseInput.value.trim(),
        apiKey: keyInput.value.trim() || undefined,
      };
      if (!next.baseUrl) return;
      productApi = next;
      saveProductApi(next);
      api.updateProductApi(next);
      appendMessage(messages, { role: "system", content: "Product API saved." });
    });

    form.append(baseLabel, baseInput, keyLabel, keyInput, saveBtn);
    settingsEl.append(toggle, form);
  }

  panel.append(header, messages, inputRow);
  if (settingsEl) panel.append(settingsEl);

  const stopResize = setupPanelResize(panel, {
    position: config.theme?.position ?? "bottom-right",
    resizable: config.size?.resizable,
    defaultWidth: config.size?.width,
    defaultHeight: config.size?.height,
    minWidth: config.size?.minWidth,
    minHeight: config.size?.minHeight,
    maxWidth: config.size?.maxWidth,
    maxHeight: config.size?.maxHeight,
    persistSize: config.size?.persistSize,
  });

  root.append(launcher, panel);
  document.body.appendChild(root);

  appendMessage(messages, {
    role: "system",
    content: delegateProductApi
      ? productApi
        ? greeting
        : `${greeting} Configure your product catalog API URL in settings to search real products.`
      : greeting,
  });

  function resolveProductLists(result: {
    bestMatches?: WidgetProduct[];
    recommendations?: WidgetProduct[];
    products?: WidgetProduct[];
    steps: Array<{ tool_calls?: Array<{ name: string; params?: Record<string, unknown>; result?: unknown }> }>;
  }): WidgetProductLists {
    if (result.bestMatches?.length || result.recommendations?.length) {
      return {
        bestMatches: result.bestMatches ?? [],
        recommendations: result.recommendations ?? [],
      };
    }
    if (result.products?.length) {
      return { bestMatches: result.products, recommendations: [] };
    }
    return extractProductListsFromSteps(result.steps);
  }

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

    if (delegateProductApi && !productApi?.baseUrl) {
      appendMessage(messages, {
        role: "assistant",
        content: "Please set your product catalog API base URL in settings first.",
      });
      return;
    }

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
          const productLists = resolveProductLists({
            ...result,
            steps: result.steps as Parameters<typeof extractProductListsFromSteps>[0],
          });
          const lastThink =
            (result.steps as Array<{ think?: string }>)?.at(-1)?.think ??
            "Here are my recommendations.";
          appendMessage(
            messages,
            { role: "assistant", content: lastThink, productLists },
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
      const productLists = resolveProductLists(result);
      const lastThink = result.steps.at(-1)?.think ?? "Here are my recommendations.";
      appendMessage(
        messages,
        { role: "assistant", content: lastThink, productLists },
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
    destroy: () => {
      stopThemeWatch?.();
      stopResize();
      root.remove();
    },
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

export type { WidgetConfig, WidgetInstance, WidgetProduct, WidgetProductLists, CommerceAgentWidgetGlobal, WidgetProductApiConfig };
