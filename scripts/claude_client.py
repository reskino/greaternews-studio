"""Claude (Anthropic API) for the local GreaterNews tools — tried FIRST; callers fall back to Groq.

Key: secrets.json -> "anthropic": {"api_key": "..."} (or the ANTHROPIC_API_KEY env var).
Model: Claude Opus 5.5. Used by the Deep Dive Studio (hot-story picks; research runs the claude CLI
on this key) and scripts/resolver.py (photo-search planning + video-script drafting).

    from claude_client import claude_json, ClaudeUnavailable
    data = claude_json(system, user, schema)          # raises -> caller uses Groq instead
"""

import json
import os

import anthropic

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_PATH = os.path.join(ROOT, "secrets.json")
MODEL = "claude-opus-5-5"


class ClaudeUnavailable(Exception):
    """No key, a refusal, a truncated reply, or an API error — the caller should fall back."""


def api_key():
    try:
        with open(SECRETS_PATH, encoding="utf-8") as handle:
            key = ((json.load(handle).get("anthropic") or {}).get("api_key") or "").strip()
        if key:
            return key
    except (OSError, ValueError):
        pass
    return (os.environ.get("ANTHROPIC_API_KEY") or "").strip() or None


_client = None


def client():
    global _client
    key = api_key()
    if not key:
        return None
    if _client is None:
        _client = anthropic.Anthropic(api_key=key, max_retries=2)
    return _client


def _closed(schema):
    """Structured outputs want every object closed (additionalProperties: false)."""
    if isinstance(schema, dict):
        out = {k: _closed(v) for k, v in schema.items()}
        if out.get("type") == "object":
            out.setdefault("additionalProperties", False)
        return out
    if isinstance(schema, list):
        return [_closed(v) for v in schema]
    return schema


def claude_json(system, user, schema, *, max_tokens=8000, effort="low", timeout=90):
    """One Claude call that must return JSON matching `schema`. Raises ClaudeUnavailable on any
    failure so the caller can use its Groq fallback. A safety decline is first retried server-side
    on Anthropic's fallback model (the `fallbacks: "default"` option)."""
    c = client()
    if c is None:
        raise ClaudeUnavailable("no anthropic.api_key in secrets.json")
    try:
        resp = c.with_options(timeout=timeout).beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},   # SDK 0.96 has no named arg for it yet
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": _closed(schema)}},
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIConnectionError as e:
        raise ClaudeUnavailable(f"network: {e}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeUnavailable("rate limited") from e
    except anthropic.APIStatusError as e:
        raise ClaudeUnavailable(f"API {e.status_code}: {str(e.message)[:120]}") from e
    if resp.stop_reason == "refusal":
        raise ClaudeUnavailable("Claude declined this request")
    if resp.stop_reason == "max_tokens":
        raise ClaudeUnavailable("Claude's reply was cut off (max_tokens)")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise ClaudeUnavailable("no text in Claude's reply")
    try:
        return json.loads(text)
    except ValueError as e:
        raise ClaudeUnavailable("Claude's reply was not valid JSON") from e


if __name__ == "__main__":   # quick health check: python scripts/claude_client.py
    print("key:", "set" if api_key() else "MISSING")
    print(claude_json("Answer briefly.", "Say hello to a Ghanaian newsroom in five words.",
                      {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}))
