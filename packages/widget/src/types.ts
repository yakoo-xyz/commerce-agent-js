export interface WidgetTheme {
  /** Light or dark palette. `auto` follows `data-theme` or system preference. */
  mode?: "light" | "dark" | "auto";
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  mutedTextColor?: string;
  surfaceColor?: string;
  elevatedSurfaceColor?: string;
  inputBackgroundColor?: string;
  inputBorderColor?: string;
  mediaBackgroundColor?: string;
  settingsBackgroundColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  position?: "bottom-right" | "bottom-left";
  zIndex?: number;
}

export interface WidgetSizeConfig {
  /** Enable drag-to-resize handles. Default true. */
  resizable?: boolean;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Remember panel size in localStorage. Default true. */
  persistSize?: boolean;
}

/** Product catalog API settings — search runs in the browser when delegateProductApi is true. */
export interface WidgetProductApiConfig {
  /** Base URL for product endpoints (/search/find_product, /search/view_product_information). */
  baseUrl: string;
  apiKey?: string;
  minIntervalMs?: number;
}

export interface WidgetConfig {
  /** Base URL of the agent API, e.g. 'http://yakoo.xyz/api/agent' */
  apiUrl: string;
  theme?: WidgetTheme;
  size?: WidgetSizeConfig;
  greeting?: string;
  placeholder?: string;
  title?: string;
  /**
   * Product catalog API config. When set with delegateProductApi (default true),
   * the browser calls find_product / view_product_information directly.
   */
  productApi?: WidgetProductApiConfig;
  /** When true (default), server runs agent logic and client executes product API calls. */
  delegateProductApi?: boolean;
  /** Show inline settings form for product API URL (dev/demo). Default false. */
  showProductApiSettings?: boolean;
  /** Called when user clicks a product card. */
  onProductClick?: (product: WidgetProduct) => void;
  /** Subtitle under the header title (e.g. "Live demo"). */
  headerSubtitle?: string;
  /** Short label shown beside the launcher in promo mode. */
  launcherHint?: string;
  /** Clickable example queries shown after the greeting. */
  suggestedPrompts?: string[];
  /** Polished demo styling — pulse launcher, glow panel, prompt chips. */
  promo?: boolean;
  /** Live demo callout recommending the install module (promo sites). */
  installHint?: {
    title?: string;
    body?: string;
    command: string;
  };
}

export interface WidgetProduct {
  product_id: string;
  title?: string;
  price?: number;
  shop_id?: string;
  image?: string;
  shop_name?: string;
  brand?: string;
}

export interface WidgetProductLists {
  bestMatches: WidgetProduct[];
  recommendations: WidgetProduct[];
}

export interface WidgetMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** @deprecated Use productLists */
  products?: WidgetProduct[];
  productLists?: WidgetProductLists;
  thinking?: boolean;
}

export interface WidgetInstance {
  open: () => void;
  close: () => void;
  toggle: () => void;
  destroy: () => void;
}

export interface CommerceAgentWidgetGlobal {
  init: (config: WidgetConfig) => WidgetInstance;
}

declare global {
  interface Window {
    CommerceAgentWidget?: CommerceAgentWidgetGlobal;
  }
}
