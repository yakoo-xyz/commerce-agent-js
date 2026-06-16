"""
FastAPI bridge that wraps the Python commerce agent (aagent.py).

Run from the Subnet15 repo root:
  pip install -r commerce-agent-js/services/agent-bridge/requirements.txt
  uvicorn commerce-agent-js.services.agent-bridge.main:app --reload --port 8000

Then point the Node server at it:
  AGENT_BACKEND_URL=http://localhost:8000 npm run dev -w express-server-example
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Resolve aagent.py at repo root (Subnet15/aagent.py)
REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT_PATH = REPO_ROOT / "aagent.py"

_agent_main = None


def _load_agent():
    global _agent_main
    if _agent_main is not None:
        return _agent_main

    if not AGENT_PATH.is_file():
        raise RuntimeError(
            f"aagent.py not found at {AGENT_PATH}. "
            "Place the bridge inside the Subnet15 repo or set AGENT_PATH."
        )

    spec = importlib.util.spec_from_file_location("aagent", AGENT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load agent module from {AGENT_PATH}")

    module = importlib.util.module_from_spec(spec)
    sys.modules["aagent"] = module
    spec.loader.exec_module(module)

    fn = getattr(module, "agent_main", None)
    if fn is None:
        raise RuntimeError("aagent.py must export agent_main(problem_data)")

    _agent_main = fn
    return _agent_main


class QueryRequest(BaseModel):
    query: str = Field(..., min_length=1)
    session_id: str | None = None


class QueryResponse(BaseModel):
    steps: list[dict[str, Any]]
    status: str
    product_ids: list[str]


def _extract_product_ids(steps: list[dict]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for step in steps:
        for tc in step.get("tool_calls") or []:
            if tc.get("name") == "recommend_product":
                raw = (tc.get("params") or {}).get("product_ids", "")
                for pid in str(raw).split(","):
                    pid = pid.strip()
                    if pid and pid not in seen and pid != "0":
                        seen.add(pid)
                        ids.append(pid)
    return ids


def _infer_status(steps: list[dict], product_ids: list[str]) -> str:
    for step in steps:
        for tc in step.get("tool_calls") or []:
            if tc.get("name") == "terminate":
                if (tc.get("params") or {}).get("status") == "failure":
                    return "failure"
    return "success" if product_ids else "failure"


app = FastAPI(title="Commerce Agent Bridge", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "agent_path": str(AGENT_PATH), "agent_exists": AGENT_PATH.is_file()}


@app.post("/query", response_model=QueryResponse)
def query(body: QueryRequest):
    agent_main = _load_agent()
    steps = agent_main({"query": body.query})
    product_ids = _extract_product_ids(steps)
    status = _infer_status(steps, product_ids)
    return QueryResponse(steps=steps, status=status, product_ids=product_ids)
