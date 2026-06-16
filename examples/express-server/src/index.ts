import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createCommerceAgentRouter } from "@commerce-agent/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const agentBackendUrl = process.env.AGENT_BACKEND_URL;
const useMock = !agentBackendUrl;

const app = express();
app.use(cors());
app.use(express.json());

const router = createCommerceAgentRouter({
  agentConfig: {
    agentBackendUrl,
    useMock,
    apiKey: process.env.AGENT_API_KEY,
  },
  corsOrigins: "*",
});

router.mount(app);

// Serve widget bundle and demo page
const widgetDist = path.resolve(__dirname, "../../../packages/widget/dist");
app.use("/widget", express.static(widgetDist));

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
    .badge { display: inline-block; background: ${useMock ? "#fef3c7" : "#dcfce7"}; color: ${useMock ? "#92400e" : "#166534"}; padding: 4px 10px; border-radius: 999px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Commerce Agent Demo</h1>
  <p class="badge">Mode: ${useMock ? "Mock agent (set AGENT_BACKEND_URL for Python bridge)" : `Python bridge @ ${agentBackendUrl}`}</p>
  <p>Click the cart button in the bottom-right corner to open the shopping assistant.</p>
  <p>Try: <code>Find wireless earbuds under 2000 pesos</code> or <code>I need shoes and socks from the same shop with a 5000 budget voucher</code></p>
  <script src="/widget/commerce-agent-widget.js"></script>
  <script>
    CommerceAgentWidget.init({
      apiUrl: window.location.origin + '/api/agent',
      theme: { primaryColor: '#6366f1', position: 'bottom-right' },
      greeting: 'Hi! I can help you find products. What are you looking for?',
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
  console.log(`  Agent:  ${useMock ? "mock (built-in)" : agentBackendUrl}`);
});
