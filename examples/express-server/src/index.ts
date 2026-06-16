import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createCommerceAgentRouter } from "@commerce-agent/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const agentBackendUrl = process.env.AGENT_BACKEND_URL;
const productApiUrl = process.env.PRODUCT_API_URL;
const productApiKey = process.env.PRODUCT_API_KEY;

const usePythonBridge = Boolean(agentBackendUrl);
const useLocalAgent = !usePythonBridge;
const useMock = !usePythonBridge && !productApiUrl;

const app = express();
app.use(cors());
app.use(express.json());

const router = createCommerceAgentRouter({
  agentConfig: {
    agentBackendUrl,
    useMock,
    useLocalAgent,
    apiKey: process.env.AGENT_API_KEY,
    productApi: productApiUrl
      ? { baseUrl: productApiUrl, apiKey: productApiKey }
      : undefined,
  },
  corsOrigins: "*",
});

router.mount(app);

const widgetDist = path.resolve(__dirname, "../../../packages/widget/dist");
app.use("/widget", express.static(widgetDist));

const modeLabel = usePythonBridge
  ? `Python bridge @ ${agentBackendUrl}`
  : productApiUrl
    ? `Built-in agent + server product API @ ${productApiUrl}`
    : "Built-in agent (client-side product API via widget settings)";

app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Commerce Agent Demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 24px; color: #1e293b; }
    h1 { color: #6366f1; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
    .badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 4px 10px; border-radius: 999px; font-size: 13px; margin-bottom: 16px; }
    ol { line-height: 1.7; }
  </style>
</head>
<body>
  <h1>Commerce Agent Demo</h1>
  <p class="badge">Mode: ${modeLabel}</p>
  <p>Click the cart button to chat with the shopping assistant.</p>
  <ol>
    <li>Open widget settings (⚙ Product API settings)</li>
    <li>Enter your product catalog API base URL (serves <code>/search/find_product</code> and <code>/search/view_product_information</code>)</li>
    <li>Ask: <code>Find wireless earbuds under 2000 pesos</code></li>
  </ol>
  <script src="/widget/commerce-agent-widget.js"></script>
  <script>
    CommerceAgentWidget.init({
      apiUrl: window.location.origin + '/api/agent',
      delegateProductApi: true,
      showProductApiSettings: true,
      theme: { primaryColor: '#6366f1', position: 'bottom-right' },
      greeting: 'Hi! I can help you find products. Set your product API URL in settings, then ask me anything.',
      onProductClick: function(p) { alert('Product clicked: ' + (p.title || p.product_id)); }
    });
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Commerce Agent demo running at http://localhost:${PORT}`);
  console.log(`  API:    http://localhost:${PORT}/api/agent`);
  console.log(`  Health: http://localhost:${PORT}/api/agent/health`);
  console.log(`  Agent:  ${modeLabel}`);
});
