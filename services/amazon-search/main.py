"""
Amazon product search gateway for the commerce agent.

Flow: user message → LLM extracts keywords/brand/features → agent calls
      GET /search/find_product?q=... against this service.

Providers (AMAZON_PROVIDER env — auto-detected from credentials if unset):
  mock      — demo Amazon-style products (offline dev)
  rainforest — Rainforest API Amazon search (RAINFOREST_API_KEY required)
  proxy     — Forward to external catalog API (SANDBOX_SEARCH_URL)

Run:
  pip install -r services/amazon-search/requirements.txt
  uvicorn services.amazon-search.main:app --reload --port 8100

Point commerce-agent at it:
  PRODUCT_API_URL=http://localhost:8100
  LLM_API_KEY=sk-... LLM_BASE_URL=https://api.openai.com/v1
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger("amazon-search")

try:
    from dotenv import load_dotenv

    _env_path = Path(__file__).resolve().parents[2] / ".env"
    if _env_path.is_file():
        load_dotenv(_env_path)
        logger.info("Loaded env from %s", _env_path)
except ImportError:
    pass


def _resolve_provider() -> str:
    explicit = os.environ.get("AMAZON_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    if os.environ.get("RAINFOREST_API_KEY", os.environ.get("AMAZON_API_KEY", "")).strip():
        return "rainforest"
    if os.environ.get("SANDBOX_SEARCH_URL", os.environ.get("PRODUCT_SEARCH_BASE_URL", "")).strip():
        return "proxy"
    return "mock"


PROVIDER = _resolve_provider()
RAINFOREST_API_KEY = os.environ.get("RAINFOREST_API_KEY", os.environ.get("AMAZON_API_KEY", ""))
AMAZON_DOMAIN = os.environ.get("AMAZON_DOMAIN", "amazon.com")
SANDBOX_SEARCH_URL = (
    os.environ.get("SANDBOX_SEARCH_URL", os.environ.get("PRODUCT_SEARCH_BASE_URL", "")).rstrip("/")
)

LLM_API_KEY = os.environ.get("LLM_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

_last_request_at = 0.0
MIN_INTERVAL = 0.7
_DETAIL_CACHE: dict[str, dict[str, Any]] = {}
RAINFOREST_API_URL = "https://api.rainforestapi.com/request"


def _throttle() -> None:
    global _last_request_at
    now = time.time()
    wait = MIN_INTERVAL - (now - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.time()


def _http_get(url: str, headers: dict[str, str] | None = None) -> Any:
    _throttle()
    req = urllib.request.Request(url, headers=headers or {"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode())


def _http_post(url: str, body: dict, headers: dict[str, str]) -> Any:
    _throttle()
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode())


def _rainforest_request(params: dict[str, str]) -> dict[str, Any]:
    """GET https://api.rainforestapi.com/request — same pattern as Rainforest docs."""
    if not RAINFOREST_API_KEY:
        raise RuntimeError("RAINFOREST_API_KEY is required")

    query = {**params, "api_key": RAINFOREST_API_KEY}
    url = f"{RAINFOREST_API_URL}?{urllib.parse.urlencode(query)}"
    data = _http_get(url)

    if not isinstance(data, dict):
        raise RuntimeError(f"Rainforest API returned unexpected payload: {type(data).__name__}")

    info = data.get("request_info") or {}
    if info.get("success") is False:
        raise RuntimeError(
            f"Rainforest API error: {info.get('message') or info.get('error') or data}"
        )
    return data


def _parse_price_range(price: str | None) -> tuple[float | None, float | None]:
    if not price:
        return None, None
    m = re.match(r"^(\d+)-(\d+)$", price.strip())
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.match(r"^(\d+)-$", price.strip())
    if m:
        return float(m.group(1)), None
    m = re.match(r"^0-(\d+)$", price.strip())
    if m:
        return 0.0, float(m.group(1))
    return None, None


def _apply_price_filter(items: list[dict[str, Any]], price: str | None) -> list[dict[str, Any]]:
    lo, hi = _parse_price_range(price)
    if lo is None and hi is None:
        return items
    filtered: list[dict[str, Any]] = []
    for item in items:
        p = float(item.get("price") or 0)
        if lo is not None and p < lo:
            continue
        if hi is not None and p > hi:
            continue
        filtered.append(item)
    return filtered or items


def _cache_products(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for item in items:
        _DETAIL_CACHE[str(item["product_id"])] = item
    return items


def _mock_search(q: str, page: int, price: str | None) -> list[dict[str, Any]]:
    q_lower = q.lower()
    catalog = [
        {
            "product_id": "B08MOCK001",
            "title": "Sony WH-1000XM5 Wireless Headphones — Noise Canceling",
            "price": 328.00,
            "shop_id": "amazon",
            "shop_name": "Amazon",
            "image": "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400",
            "service": ["prime", "freeShipping"],
            "brand": "Sony",
            "features": ["wireless", "ANC", "bluetooth"],
            "url": "https://www.amazon.com/dp/B08MOCK001",
        },
        {
            "product_id": "B08MOCK002",
            "title": "Apple AirPods Pro (2nd Gen) with USB-C",
            "price": 189.99,
            "shop_id": "amazon",
            "shop_name": "Amazon",
            "image": "https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=400",
            "service": ["prime"],
            "brand": "Apple",
            "features": ["wireless", "ANC", "USB-C"],
            "url": "https://www.amazon.com/dp/B08MOCK002",
        },
        {
            "product_id": "B08MOCK003",
            "title": "Nike Air Zoom Pegasus 41 Running Shoes",
            "price": 119.99,
            "shop_id": "amazon",
            "shop_name": "Amazon",
            "image": "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400",
            "service": ["prime", "freeShipping"],
            "brand": "Nike",
            "features": ["running", "lightweight", "cushioning"],
            "url": "https://www.amazon.com/dp/B08MOCK003",
        },
        {
            "product_id": "B08MOCK004",
            "title": "JBL Flip 6 Portable Bluetooth Speaker — Waterproof",
            "price": 99.95,
            "shop_id": "amazon",
            "shop_name": "Amazon",
            "image": "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400",
            "service": ["prime"],
            "brand": "JBL",
            "features": ["bluetooth", "waterproof", "portable"],
            "url": "https://www.amazon.com/dp/B08MOCK004",
        },
        {
            "product_id": "B08MOCK005",
            "title": "Kindle Paperwhite (16 GB) — 7\" Display",
            "price": 149.99,
            "shop_id": "amazon",
            "shop_name": "Amazon",
            "image": "https://images.unsplash.com/photo-1592496431127-0e0d4a0b0a0a?w=400",
            "service": ["prime", "freeShipping"],
            "brand": "Amazon",
            "features": ["e-reader", "waterproof", "16GB"],
            "url": "https://www.amazon.com/dp/B08MOCK005",
        },
    ]

    tokens = set(q_lower.split())
    scored: list[tuple[float, dict]] = []
    for item in catalog:
        hay = f"{item['title']} {item.get('brand', '')} {' '.join(item.get('features', []))}".lower()
        score = sum(1 for t in tokens if t in hay and len(t) > 2)
        if score > 0 or not tokens:
            scored.append((score, item))

    scored.sort(key=lambda x: -x[0])
    results = _apply_price_filter([s[1] for s in scored] or catalog, price)
    start = (page - 1) * 10
    return _cache_products(results[start : start + 10])


def _parse_amazon_price(raw: Any) -> float:
    if isinstance(raw, dict):
        raw = raw.get("value") or raw.get("raw") or raw.get("amount") or 0
    if isinstance(raw, str):
        raw = re.sub(r"[^\d.]", "", raw) or "0"
    try:
        return round(float(raw), 2)
    except (TypeError, ValueError):
        return 0.0


def _parse_amazon_image(raw: Any) -> str | None:
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    if isinstance(raw, dict):
        return raw.get("link") or raw.get("url")
    return None


def _normalize_amazon_item(raw: dict[str, Any]) -> dict[str, Any]:
    asin = str(raw.get("asin") or raw.get("product_id") or "").strip()
    title = str(raw.get("title") or raw.get("product_name") or "Amazon Product")
    buybox = raw.get("buybox_winner")
    price_src = raw.get("price")
    if not price_src and isinstance(buybox, dict):
        price_src = buybox.get("price")
    price = _parse_amazon_price(price_src)
    image = _parse_amazon_image(
        raw.get("image") or raw.get("main_image") or raw.get("thumbnail")
    )
    brand = raw.get("brand") or raw.get("brand_name")
    if isinstance(brand, dict):
        brand = brand.get("name") or brand.get("value")
    is_prime = bool(raw.get("is_prime") or raw.get("prime"))
    link = raw.get("link") or raw.get("url") or (f"https://www.{AMAZON_DOMAIN}/dp/{asin}" if asin else None)
    features = raw.get("feature_bullets") or raw.get("features") or []
    if isinstance(features, str):
        features = [features]

    product = {
        "product_id": asin or f"amz_{hash(title) & 0xFFFFFFFF:08x}",
        "title": title,
        "price": price,
        "shop_id": "amazon",
        "shop_name": "Amazon",
        "image": image,
        "brand": brand,
        "service": ["prime", "freeShipping"] if is_prime else [],
        "url": link,
        "features": features[:6] if isinstance(features, list) else [],
    }
    bullets = raw.get("feature_bullets_flat") or raw.get("description")
    _DETAIL_CACHE[product["product_id"]] = {
        **product,
        "short_description": raw.get("snippet") or (features[0] if features else title),
        "description": bullets or title,
    }
    return product


def _rainforest_search(q: str, page: int, price: str | None, sort: str | None) -> list[dict[str, Any]]:
    params: dict[str, str] = {
        "type": "search",
        "amazon_domain": AMAZON_DOMAIN,
        "search_term": q,
        "page": str(page),
    }
    if sort == "priceasc":
        params["sort_by"] = "price_low_to_high"
    elif sort == "pricedesc":
        params["sort_by"] = "price_high_to_low"
    elif sort == "order":
        params["sort_by"] = "featured"

    data = _rainforest_request(params)
    items = data.get("search_results") or []
    products = [_normalize_amazon_item(item) for item in items if isinstance(item, dict)]
    return _cache_products(_apply_price_filter(products, price))


def _rainforest_product(asin: str) -> dict[str, Any] | None:
    """Fetch a single product by ASIN — type=product (Rainforest docs)."""
    data = _rainforest_request({
        "type": "product",
        "amazon_domain": AMAZON_DOMAIN,
        "asin": asin,
    })
    raw = data.get("product")
    if isinstance(raw, dict):
        return _normalize_amazon_item(raw)
    return None


def _proxy_search(q: str, page: int, price: str | None, sort: str | None) -> list[dict[str, Any]]:
    if not SANDBOX_SEARCH_URL:
        raise RuntimeError("SANDBOX_SEARCH_URL is required for proxy provider")

    params: dict[str, str | int] = {"q": q, "page": page}
    if price:
        params["price"] = price
    if sort:
        params["sort"] = sort

    qs = urllib.parse.urlencode(params)
    url = f"{SANDBOX_SEARCH_URL}/search/find_product?{qs}"
    headers: dict[str, str] = {"Accept": "application/json"}
    api_key = os.environ.get("SANDBOX_API_KEY", os.environ.get("PRODUCT_API_KEY", ""))
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data = _http_get(url, headers)
    if not isinstance(data, list):
        raise RuntimeError(f"Proxy search returned unexpected payload: {type(data).__name__}")
    return _cache_products(data)


def find_products(
    q: str,
    page: int = 1,
    price: str | None = None,
    sort: str | None = None,
    **_kwargs: Any,
) -> list[dict[str, Any]]:
    decoded_q = urllib.parse.unquote_plus(q)
    if PROVIDER == "rainforest":
        return _rainforest_search(decoded_q, page, price, sort)
    if PROVIDER == "proxy":
        return _proxy_search(decoded_q, page, price, sort)
    if PROVIDER != "mock":
        logger.warning("Unknown AMAZON_PROVIDER=%s — falling back to mock", PROVIDER)
    return _mock_search(decoded_q, page, price)


EXTRACT_SYSTEM = """You extract structured shopping intent from user queries for an Amazon product search agent.
Return ONLY valid JSON:
{
  "products": [
    {
      "keywords": "search phrase",
      "brand": "brand or null",
      "features": ["feature1"],
      "price_range": "0-50 or null"
    }
  ]
}"""


class ExtractRequest(BaseModel):
    query: str = Field(..., min_length=1)


class ExtractResponse(BaseModel):
    products: list[dict[str, Any]]
    search_query: str
    source: str


def llm_extract(query: str) -> ExtractResponse:
    if not LLM_API_KEY:
        words = [w for w in re.findall(r"[a-zA-Z0-9]+", query.lower()) if len(w) > 2][:6]
        kw = " ".join(words) or query
        return ExtractResponse(
            products=[{"keywords": kw, "brand": None, "features": [], "price_range": None}],
            search_query=kw,
            source="regex",
        )

    payload = {
        "model": LLM_MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": EXTRACT_SYSTEM},
            {"role": "user", "content": query},
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LLM_API_KEY}",
    }
    data = _http_post(f"{LLM_BASE_URL}/chat/completions", payload, headers)
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    products = parsed.get("products") or [{"keywords": query}]

    parts: list[str] = []
    for p in products:
        kw = p.get("keywords", "")
        if p.get("brand"):
            kw = f"{kw} {p['brand']}"
        for f in (p.get("features") or [])[:3]:
            kw = f"{kw} {f}"
        parts.append(kw.strip())

    return ExtractResponse(
        products=products,
        search_query=" ".join(parts) or query,
        source="llm",
    )


app = FastAPI(title="Amazon Search Gateway", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    using_real = PROVIDER in ("rainforest", "proxy")
    return {
        "ok": True,
        "provider": PROVIDER,
        "using_real_amazon": using_real,
        "amazon_domain": AMAZON_DOMAIN,
        "llm_configured": bool(LLM_API_KEY),
        "rainforest_configured": bool(RAINFOREST_API_KEY),
        "proxy_configured": bool(SANDBOX_SEARCH_URL),
        "note": (
            "Live Amazon search is active."
            if using_real
            else "MOCK MODE — set RAINFOREST_API_KEY for real Amazon products."
        ),
    }


@app.on_event("startup")
def _log_provider() -> None:
    if PROVIDER == "mock":
        logger.warning(
            "AMAZON_PROVIDER=mock — returning demo products (B08MOCK*). "
            "Set RAINFOREST_API_KEY for live Amazon search."
        )
    else:
        logger.info("Amazon search provider: %s (domain=%s)", PROVIDER, AMAZON_DOMAIN)


@app.post("/extract", response_model=ExtractResponse)
def extract(body: ExtractRequest):
    return llm_extract(body.query)


@app.get("/search/find_product")
def search_find_product(
    q: str = Query(...),
    page: int = Query(1, ge=1),
    shop_id: str | None = None,
    price: str | None = None,
    sort: str | None = None,
    service: str | None = None,
):
    del shop_id  # Amazon search is marketplace-wide
    results = find_products(q=q, page=page, price=price, sort=sort)
    if service:
        wanted = {s.strip().lower() for s in service.split(",") if s.strip()}
        if wanted:
            filtered = [
                p for p in results
                if wanted.intersection({s.lower() for s in (p.get("service") or [])})
            ]
            if filtered:
                results = filtered
    return results


@app.get("/search/view_product_information")
def view_product_information(product_ids: str = Query(...)):
    ids = [p.strip() for p in product_ids.split(",") if p.strip()]
    out: list[dict[str, Any]] = []
    for pid in ids:
        cached = _DETAIL_CACHE.get(pid)
        if not cached and PROVIDER == "rainforest" and re.match(r"^[A-Z0-9]{10}$", pid):
            try:
                fetched = _rainforest_product(pid)
                if fetched:
                    cached = _DETAIL_CACHE.get(pid)
            except Exception as exc:
                logger.warning("Rainforest product fetch failed for %s: %s", pid, exc)

        if cached:
            out.append({
                "product_id": pid,
                "short_description": cached.get("short_description") or cached.get("title", ""),
                "description": cached.get("description") or cached.get("title", ""),
                "attributes": json.dumps({
                    "brand": cached.get("brand"),
                    "features": cached.get("features", []),
                    "image": cached.get("image"),
                    "url": cached.get("url"),
                    "shop_name": cached.get("shop_name", "Amazon"),
                }),
            })
        else:
            out.append({
                "product_id": pid,
                "short_description": "",
                "description": "",
            })
    return out
