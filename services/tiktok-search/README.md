# Deprecated — use Amazon Search Gateway

This service has been replaced by **[amazon-search](../amazon-search/)**.

TikTok is a video platform; product search now uses **Amazon** after LLM intent extraction.

```bash
cd commerce-agent-js
uvicorn services.amazon-search.main:app --reload --port 8100
```

See [amazon-search/README.md](../amazon-search/README.md).
