"""
TikTok Shop search gateway for the commerce agent.

Exposes the standard product API contract:
  GET /search/find_product?q=&page=&price=&sort=
  GET /search/view_product_information?product_ids=

Providers (TIKTOK_PROVIDER env — auto-detected from credentials if unset):
  mock   — demo products (no API key, for development)  ← DEFAULT when no keys set
  keyapi — KeyAPI realtime TikTok Shop search (TIKTOK_API_KEY required)
  partner — TikTok Partner API seller catalog (TIKTOK_ACCESS_TOKEN + TIKTOK_SHOP_CIPHER)
  proxy  — Forward to subnet/ORO sandbox (SANDBOX_SEARCH_URL) — same as aagent.py catalog

Run:
  pip install -r services/tiktok-search/requirements.txt
  uvicorn services.tiktok-search.main:app --reload --port 8100

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

logger = logging.getLogger("tiktok-search")

# Load commerce-agent-js/.env when present (uvicorn cwd is usually commerce-agent-js)
try:
    from dotenv import load_dotenv

    _env_path = Path(__file__).resolve().parents[2] / ".env"
    if _env_path.is_file():
        load_dotenv(_env_path)
        logger.info("Loaded env from %s", _env_path)
except ImportError:
    pass


def _resolve_provider() -> str:
    explicit = os.environ.get("TIKTOK_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    if os.environ.get("TIKTOK_API_KEY", "").strip():
        return "keyapi"
    if os.environ.get("TIKTOK_ACCESS_TOKEN", "").strip() and os.environ.get("TIKTOK_SHOP_CIPHER", "").strip():
        return "partner"
    if os.environ.get("SANDBOX_SEARCH_URL", "").strip() or os.environ.get("PRODUCT_SEARCH_BASE_URL", "").strip():
        return "proxy"
    return "mock"


PROVIDER = _resolve_provider()
TIKTOK_API_KEY = os.environ.get("TIKTOK_API_KEY", "")
TIKTOK_REGION = os.environ.get("TIKTOK_REGION", "US")
TIKTOK_ACCESS_TOKEN = os.environ.get("TIKTOK_ACCESS_TOKEN", "")
TIKTOK_SHOP_CIPHER = os.environ.get("TIKTOK_SHOP_CIPHER", "")
TIKTOK_API_BASE = os.environ.get("TIKTOK_API_BASE", "https://api.keyapi.ai/v1").rstrip("/")
SANDBOX_SEARCH_URL = (
    os.environ.get("SANDBOX_SEARCH_URL", os.environ.get("PRODUCT_SEARCH_BASE_URL", "")).rstrip("/")
)

LLM_API_KEY = os.environ.get("LLM_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")

_last_request_at = 0.0
MIN_INTERVAL = 0.7

_DETAIL_CACHE: dict[str, dict[str, Any]] = {}


def _throttle() -> None:
    global _last_request_at
    now = time.time()
    wait = MIN_INTERVAL - (now - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.time()


def _http_get(url: str, headers: dict[str, str] | None = None) -> Any:
    _throttle()
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _http_post(url: str, body: dict, headers: dict[str, str]) -> Any:
    _throttle()
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


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


def _mock_search(q: str, page: int, price: str | None) -> list[dict[str, Any]]:
    q_lower = q.lower()
    catalog = [
        {
            "product_id": "tt_mock_earbuds_001",
            "title": "SoundPro X3 Wireless Earbuds — Active Noise Cancel",
            "price": 49.99,
            "shop_id": "tt_shop_audiohub",
            "image": "https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=400",
            "service": ["official", "freeShipping"],
            "brand": "SoundPro",
            "features": ["wireless", "ANC", "IPX5"],
        },
        {
            "product_id": "tt_mock_earbuds_002",
            "title": "FitRun Sport Buds — Ear-Hook Waterproof",
            "price": 42.99,
            "shop_id": "tt_shop_audiohub",
            "image": "https://images.unsplash.com/photo-1572569511254-d8f925fe2cbb?w=400",
            "service": ["freeShipping"],
            "brand": "FitRun",
            "features": ["sport", "IPX7", "24hr battery"],
        },
        {
            "product_id": "tt_mock_shoes_001",
            "title": "Nike Air Zoom Pegasus — Running Shoes",
            "price": 89.99,
            "shop_id": "tt_shop_sportzone",
            "image": "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400",
            "service": ["official"],
            "brand": "Nike",
            "features": ["running", "lightweight", "mesh"],
        },
        {
            "product_id": "tt_mock_socks_001",
            "title": "Cotton Crew Socks 3-Pack — Athletic",
            "price": 14.99,
            "shop_id": "tt_shop_sportzone",
            "image": "https://images.unsplash.com/photo-1586350977771-b3d0a754c2ce?w=400",
            "service": ["freeShipping"],
            "brand": "ComfortWear",
            "features": ["cotton", "athletic", "3-pack"],
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
    results = [s[1] for s in scored] or catalog

    lo, hi = _parse_price_range(price)
    if lo is not None or hi is not None:
        filtered = []
        for item in results:
            p = float(item["price"])
            if lo is not None and p < lo:
                continue
            if hi is not None and p > hi:
                continue
            filtered.append(item)
        results = filtered or results

    start = (page - 1) * 10
    page_items = results[start : start + 10]
    for item in page_items:
        _DETAIL_CACHE[item["product_id"]] = item
    return page_items


def _keyapi_search(q: str, page: int, price: str | None, sort: str | None) -> list[dict[str, Any]]:
    if not TIKTOK_API_KEY:
        raise RuntimeError("TIKTOK_API_KEY is required for keyapi provider")

    offset = (page - 1) * 10
    params: dict[str, str] = {
        "sk": q,
        "region": TIKTOK_REGION,
        "count": "10",
        "offset": str(offset),
    }

    lo, hi = _parse_price_range(price)
    if lo is not None and hi is not None:
        params["price_range"] = f"{int(lo)},{int(hi)}"
    elif hi is not None:
        params["price_range"] = f"0,{int(hi)}"

    sort_map = {"priceasc": "1", "pricedesc": "2", "order": "3", "default": "4"}
    if sort and sort in sort_map:
        params["sort_type"] = sort_map[sort]

    qs = urllib.parse.urlencode(params)
    url = f"{TIKTOK_API_BASE}/tiktok/realtime/product/search?{qs}"
    headers = {"Authorization": f"Bearer {TIKTOK_API_KEY}", "Accept": "application/json"}

    data = _http_get(url, headers)
    if data.get("code") not in (0, "0", None):
        raise RuntimeError(f"TikTok API error: {data.get('message', data)}")

    items = (
        data.get("data", {})
        .get("body", {})
        .get("sections", [{}])[0]
        .get("items", [])
    )

    products: list[dict[str, Any]] = []
    for item in items:
        raw = item.get("data", {}).get("raw_data")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                raw = {}
        if not isinstance(raw, dict):
            raw = item.get("data", {}) if isinstance(item.get("data"), dict) else {}

        pid = str(
            raw.get("product_id")
            or raw.get("id")
            or item.get("item_id", "")
        ).split(";")[-1]

        title = (
            raw.get("title")
            or raw.get("product_name")
            or raw.get("name")
            or "TikTok Product"
        )
        price_val = raw.get("price") or raw.get("sale_price") or raw.get("min_price") or 0
        if isinstance(price_val, dict):
            price_val = price_val.get("value") or price_val.get("amount") or 0
        try:
            price_num = float(price_val)
            if price_num > 1000:
                price_num = price_num / 100
        except (TypeError, ValueError):
            price_num = 0.0

        shop_id = str(raw.get("shop_id") or raw.get("seller_id") or "tiktok_shop")
        image = raw.get("image") or raw.get("cover") or raw.get("thumb_url")

        product = {
            "product_id": pid or f"tt_{hash(title) & 0xFFFFFFFF:08x}",
            "title": str(title),
            "price": round(price_num, 2),
            "shop_id": shop_id,
            "image": image,
            "service": [],
        }
        products.append(product)
        _DETAIL_CACHE[product["product_id"]] = {
            **product,
            "short_description": raw.get("desc") or raw.get("description") or title,
            "description": raw.get("description") or str(title),
        }

    return products


def _partner_search(q: str, page: int) -> list[dict[str, Any]]:
    if not TIKTOK_ACCESS_TOKEN or not TIKTOK_SHOP_CIPHER:
        raise RuntimeError("TIKTOK_ACCESS_TOKEN and TIKTOK_SHOP_CIPHER required for partner provider")

    url = os.environ.get(
        "TIKTOK_PARTNER_SEARCH_URL",
        "https://open-api.tiktokglobalshop.com/product/202502/products/search",
    )
    headers = {
        "Content-Type": "application/json",
        "x-tts-access-token": TIKTOK_ACCESS_TOKEN,
    }
    body = {
        "page_size": 10,
        "page_number": page,
        "search_keyword": q,
        "status": "ON_SALE",
        "shop_cipher": TIKTOK_SHOP_CIPHER,
    }
    data = _http_post(url, body, headers)
    raw_products = data.get("data", {}).get("products") or data.get("products") or []

    products: list[dict[str, Any]] = []
    for raw in raw_products:
        pid = str(raw.get("id") or raw.get("product_id") or "")
        title = raw.get("title") or raw.get("product_name") or "Product"
        price_num = 0.0
        skus = raw.get("skus") or []
        if skus and isinstance(skus[0], dict):
            price_info = skus[0].get("price") or {}
            price_num = float(price_info.get("sale_price") or price_info.get("amount") or 0)

        product = {
            "product_id": pid,
            "title": str(title),
            "price": round(price_num, 2),
            "shop_id": TIKTOK_SHOP_CIPHER,
            "service": ["official"],
        }
        products.append(product)
        _DETAIL_CACHE[pid] = {**product, "description": str(title)}

    return products


def _proxy_search(q: str, page: int, price: str | None, sort: str | None) -> list[dict[str, Any]]:
    """Forward to an external product search API (e.g. subnet sandbox / ORO catalog)."""
    if not SANDBOX_SEARCH_URL:
        raise RuntimeError(
            "SANDBOX_SEARCH_URL (or PRODUCT_SEARCH_BASE_URL) is required for proxy provider"
        )

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

    for item in data:
        if isinstance(item, dict) and item.get("product_id"):
            _DETAIL_CACHE[str(item["product_id"])] = item
    return data


def find_products(
    q: str,
    page: int = 1,
    price: str | None = None,
    sort: str | None = None,
    **_kwargs: Any,
) -> list[dict[str, Any]]:
    decoded_q = urllib.parse.unquote_plus(q)
    if PROVIDER == "keyapi":
        return _keyapi_search(decoded_q, page, price, sort)
    if PROVIDER == "partner":
        return _partner_search(decoded_q, page)
    if PROVIDER == "proxy":
        return _proxy_search(decoded_q, page, price, sort)
    if PROVIDER != "mock":
        logger.warning("Unknown TIKTOK_PROVIDER=%s — falling back to mock", PROVIDER)
    return _mock_search(decoded_q, page, price)


EXTRACT_SYSTEM = """You extract structured shopping intent from user queries for TikTok Shop search.
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


app = FastAPI(title="TikTok Search Gateway", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    using_real = PROVIDER in ("keyapi", "partner", "proxy")
    return {
        "ok": True,
        "provider": PROVIDER,
        "using_real_tiktok": using_real,
        "region": TIKTOK_REGION,
        "llm_configured": bool(LLM_API_KEY),
        "keyapi_configured": bool(TIKTOK_API_KEY),
        "partner_configured": bool(TIKTOK_ACCESS_TOKEN and TIKTOK_SHOP_CIPHER),
        "proxy_configured": bool(SANDBOX_SEARCH_URL),
        "note": (
            "Live TikTok search is active."
            if using_real
            else "MOCK MODE — set TIKTOK_PROVIDER=keyapi + TIKTOK_API_KEY, or SANDBOX_SEARCH_URL for real products."
        ),
    }


@app.on_event("startup")
def _log_provider() -> None:
    if PROVIDER == "mock":
        logger.warning(
            "TIKTOK_PROVIDER=mock — returning demo products (tt_mock_*). "
            "Set TIKTOK_API_KEY for KeyAPI or SANDBOX_SEARCH_URL for subnet catalog."
        )
    else:
        logger.info("TikTok search provider: %s", PROVIDER)


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
    del shop_id, service  # TikTok public search does not use these yet
    return find_products(q=q, page=page, price=price, sort=sort)


@app.get("/search/view_product_information")
def view_product_information(product_ids: str = Query(...)):
    ids = [p.strip() for p in product_ids.split(",") if p.strip()]
    out: list[dict[str, Any]] = []
    for pid in ids:
        cached = _DETAIL_CACHE.get(pid)
        if cached:
            out.append({
                "product_id": pid,
                "short_description": cached.get("short_description") or cached.get("title", ""),
                "description": cached.get("description") or cached.get("title", ""),
                "attributes": json.dumps({
                    "brand": cached.get("brand"),
                    "features": cached.get("features", []),
                    "image": cached.get("image"),
                }),
            })
        else:
            out.append({
                "product_id": pid,
                "short_description": "",
                "description": "",
            })
    return out
