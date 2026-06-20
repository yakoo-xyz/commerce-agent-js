export interface WidgetTheme {
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  position?: "bottom-right" | "bottom-left";
  zIndex?: number;
}

/** Product catalog API settings — search runs in the browser when delegateProductApi is true. */
export interface WidgetProductApiConfig {
  /** Base URL for product endpoints (/search/find_product, /search/view_product_information). */
  baseUrl: string;
  apiKey?: string;
  minIntervalMs?: number;
}

export interface WidgetConfig {
  /** Base URL of the agent API, e.g. 'http://localhost:3000/api/agent' */
  apiUrl: string;
  theme?: WidgetTheme;
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
