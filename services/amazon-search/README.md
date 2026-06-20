# Amazon Search Gateway

Product search backend for `@commerce-agent/core`. After the LLM parses the user's message (keywords, brand, features, price), the agent calls this service to search Amazon.

## Quick start (mock mode — no API keys)

```bash
cd commerce-agent-js
pip install -r services/amazon-search/requirements.txt
uvicorn services.amazon-search.main:app --reload --port 8100
```

In another terminal:

```bash
cd commerce-agent-js
export PRODUCT_API_URL=http://localhost:8100
export LLM_API_KEY=sk-your-openai-key
npm run build
npm run dev -w express-server-example
```

Ask the widget: *"I need Sony wireless headphones under $200 with noise canceling"*

The agent will:
1. **LLM extract** product name, brand (Sony), features (wireless, ANC), price ($0–200)
2. **Amazon search** via `GET /search/find_product?q=Sony wireless headphones noise canceling`
3. Score and recommend the best match

## Providers

| `AMAZON_PROVIDER` | Description |
|-------------------|-------------|
| `mock` (default) | Demo Amazon-style products, works offline |
| `rainforest` | [Rainforest API](https://www.rainforestapi.com/docs/product-data-api/overview) live Amazon search |
| `proxy` | Forward to external catalog (`SANDBOX_SEARCH_URL`) |

### Rainforest API (live Amazon search)

Uses the same `GET https://api.rainforestapi.com/request` pattern as the [Rainforest docs](https://docs.trajectdata.com/rainforestapi/product-data-api/parameters/search):

- **Search** (after LLM extracts keywords): `type=search`, `search_term=...`
- **Product details** (by ASIN): `type=product`, `asin=B073JYC4XM`

```bash
export AMAZON_PROVIDER=rainforest
export RAINFOREST_API_KEY=your_rainforest_api_key
export AMAZON_DOMAIN=amazon.com
uvicorn services.amazon-search.main:app --port 8100
```

Or copy `.env.example` → `.env` — the gateway loads it on startup.

```python
# Rainforest request pattern (search)
params = {
    "api_key": "YOUR_KEY",
    "type": "search",
    "amazon_domain": "amazon.com",
    "search_term": "wireless earbuds",
}
# GET https://api.rainforestapi.com/request
```


## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Provider status |
| POST | `/extract` | Standalone LLM intent extraction |
| GET | `/search/find_product` | Product search (agent tool) |
| GET | `/search/view_product_information` | Product details (agent tool) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AMAZON_PROVIDER` | auto | `mock`, `rainforest`, or `proxy` |
| `RAINFOREST_API_KEY` | — | Rainforest API key (alias: `AMAZON_API_KEY`) |
| `AMAZON_DOMAIN` | `amazon.com` | Amazon marketplace domain |
| `SANDBOX_SEARCH_URL` | — | Base URL for `proxy` provider |
| `LLM_API_KEY` | — | OpenAI-compatible key (for `/extract`) |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API base |
| `LLM_MODEL` | `gpt-4o-mini` | Extraction model |
