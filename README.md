# commerce-agent-js

AI commerce agent as an npm monorepo: **SDK**, **Express server**, and **embeddable chat widget**.

## Packages

| Package | Description |
|---------|-------------|
| `@commerce-agent/core` | TypeScript SDK — `CommerceAgent` class, types, mock agent |
| `@commerce-agent/server` | Express router with REST + SSE streaming |
| `@commerce-agent/widget` | Embeddable chatbot (IIFE + ESM) |

## Quick start

```bash
cd commerce-agent-js
npm install
npm run build
npm run dev
```

Open **http://localhost:3000** — click the cart button to chat with the built-in agent.

## Amazon product search (LLM → search)

```bash
# Terminal 1 — Amazon search gateway
pip install -r services/amazon-search/requirements.txt
uvicorn services.amazon-search.main:app --reload --port 8100

# Terminal 2 — agent with LLM extraction + Amazon search
set PRODUCT_API_URL=http://localhost:8100
set LLM_API_KEY=sk-your-openai-key
npm run dev
```

For **live Amazon results**, set `RAINFOREST_API_KEY` in `.env` (see `.env.example`). Without it, the gateway returns demo products.

Ask: *"Find Sony wireless headphones under $200 with noise canceling"*


Use the FastAPI bridge to proxy requests to your own Python agent:

```bash
# Terminal 1 — Python bridge
pip install -r services/agent-bridge/requirements.txt
cd services/agent-bridge && uvicorn main:app --reload --port 8000

# Terminal 2 — Node demo with external agent
set AGENT_BACKEND_URL=http://localhost:8000
npm run dev
```

Set `AGENT_PATH` to point at your Python agent file (must export `agent_main`).

## Use in your project

### Backend (Express)

```typescript
import express from "express";
import { createCommerceAgentRouter } from "@commerce-agent/server";

const app = express();
app.use(express.json());

createCommerceAgentRouter({
  agentConfig: {
    agentBackendUrl: process.env.AGENT_BACKEND_URL,
    apiKey: process.env.AGENT_API_KEY,
  },
}).mount(app);

app.listen(3000);
```

### SDK (programmatic)

```typescript
import { CommerceAgent } from "@commerce-agent/core";

const agent = new CommerceAgent({
  agentBackendUrl: "http://localhost:8000",
});

const session = agent.createSession();
const result = await agent.query(
  session.id,
  "Find waterproof running shoes under $100",
);

console.log(result.productIds, result.products, result.steps);
```

### Website widget

```html
<script src="https://your-cdn.com/commerce-agent-widget.js"></script>
<script>
  CommerceAgentWidget.init({
    apiUrl: "https://your-api.com/api/agent",
    theme: { primaryColor: "#6366f1", position: "bottom-right" },
    greeting: "Hi! What product can I help you find?",
    onProductClick: (product) => {
      window.location.href = "/product/" + product.product_id;
    },
  });
</script>
```

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agent/sessions` | Create session → `{ sessionId }` |
| `GET` | `/api/agent/sessions/:id` | Get session history |
| `DELETE` | `/api/agent/sessions/:id` | Destroy session |
| `POST` | `/api/agent/sessions/:id/messages` | Send message → full `AgentResult` |
| `GET` | `/api/agent/sessions/:id/stream?message=` | SSE stream of dialogue steps |
| `GET` | `/api/agent/health` | Health check |

## Monorepo structure

```
commerce-agent-js/
├── packages/
│   ├── core/          # @commerce-agent/core
│   ├── server/        # @commerce-agent/server
│   └── widget/        # @commerce-agent/widget
├── examples/
│   └── express-server/
└── services/
    └── agent-bridge/  # FastAPI → Python agent
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `AGENT_BACKEND_URL` | Python agent bridge URL (e.g. `http://localhost:8000`) |
| `AGENT_API_KEY` | Optional bearer token for the backend |
| `PRODUCT_API_URL` | Product catalog API base URL (server-side search) |
| `PRODUCT_API_KEY` | Optional bearer token for the product catalog API |
| `PORT` | Demo server port (default `3000`) |

## License

MIT
