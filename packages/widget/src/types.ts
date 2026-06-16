export interface WidgetTheme {
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  position?: "bottom-right" | "bottom-left";
  zIndex?: number;
}

export interface WidgetConfig {
  /** Base URL of the agent API, e.g. 'http://localhost:3000/api/agent' */
  apiUrl: string;
  theme?: WidgetTheme;
  greeting?: string;
  placeholder?: string;
  title?: string;
  /** Called when user clicks a product card. */
  onProductClick?: (product: WidgetProduct) => void;
}

export interface WidgetProduct {
  product_id: string;
  title?: string;
  price?: number;
  shop_id?: string;
}

export interface WidgetMessage {
  role: "user" | "assistant" | "system";
  content: string;
  products?: WidgetProduct[];
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
