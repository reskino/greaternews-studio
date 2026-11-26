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


# Fetched pages are the expensive part (each one is re-read on every later search step), so fetches
# are capped tighter than searches. The 2026-11-26 run with 30/20 used ~950k input tokens.
WEB_TOOLS = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 20},
             {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 8}]


def claude_research(system, user, *, max_tokens=64000, effort="high", timeout=1800, max_resumes=8):
    """A web-researching Claude call on the API key (Anthropic-hosted web search + fetch; no CLI, no
    login, no subscription limits). Streams (long output), resumes `pause_turn` server-tool loops,
    and returns (final_text, usage_summary). Raises ClaudeUnavailable on any failure."""
    c = client()
    if c is None:
        raise ClaudeUnavailable("no anthropic.api_key in secrets.json")
    messages = [{"role": "user", "content": user}]
    assistant_so_far = []
    searches = 0
    try:
        for _ in range(max_resumes + 1):
            with c.with_options(timeout=timeout).beta.messages.stream(
                model=MODEL, max_tokens=max_tokens,
                betas=["server-side-fallback-2026-07-01"],
                # auto prompt-caching: resumed/iterated rounds re-read the same prefix at ~10% of the price
                extra_body={"fallbacks": "default", "cache_control": {"type": "ephemeral"}},
                output_config={"effort": effort}, system=system, tools=WEB_TOOLS,
                messages=messages + ([{"role": "assistant", "content": assistant_so_far}] if assistant_so_far else []),
            ) as stream:
                resp = stream.get_final_message()
            searches += sum(1 for b in resp.content if b.type == "server_tool_use")
            if resp.stop_reason == "pause_turn":   # the server-side tool loop hit its step limit: resume it
                assistant_so_far = assistant_so_far + list(resp.content)
                continue
            break
    except anthropic.APIConnectionError as e:
        raise ClaudeUnavailable(f"network: {e}") from e
    except anthropic.RateLimitError as e:
        raise ClaudeUnavailable("rate limited") from e
    except anthropic.APIStatusError as e:
        raise ClaudeUnavailable(f"API {e.status_code}: {str(e.message)[:160]}") from e
    if resp.stop_reason == "refusal":
        raise ClaudeUnavailable("Claude declined this request")
    if resp.stop_reason == "max_tokens":
        raise ClaudeUnavailable("Claude's reply was cut off (max_tokens)")
    if resp.stop_reason == "pause_turn":
        raise ClaudeUnavailable("research did not finish (too many search rounds)")
    text = "".join(b.text for b in list(assistant_so_far) + list(resp.content) if getattr(b, "type", "") == "text")
    u = resp.usage
    return text, f"{searches} web tool calls, {getattr(u, 'input_tokens', 0)} in / {getattr(u, 'output_tokens', 0)} out tokens (last round)"


def last_json_block(text):
    """The last ```json fenced block in a reply (or the last {...} span), parsed."""
    import re
    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidate = blocks[-1] if blocks else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(candidate)


def run_claude_cli(prompt, *, check, allowed_tools="Read,Write,WebSearch,WebFetch,Glob,Grep",
                   bypass_permissions=True, timeout=900):
    """FALLBACK research path: the `claude` CLI on its own login (web search + file writing).
    Note: the CLI does NOT bill the GreaterNews API key — passing ANTHROPIC_API_KEY/AUTH_TOKEN still ran
    on the subscription login (and hit its session limit, 2026-11-26) — so the API path is
    claude_research() above; this only runs when that fails.
    `check()` must return True when the expected output files exist. Returns (ok, engine_label, log)."""
    import subprocess
    base_env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    attempts = [("Claude Code login (fallback)", base_env, [])]
    flags = ["--output-format", "text", "--allowedTools", allowed_tools]
    if bypass_permissions:
        flags = ["--permission-mode", "bypassPermissions"] + flags
    log = ""
    for label, env, extra in attempts:
        try:
            p = subprocess.run(["claude", "-p", prompt] + flags + extra, cwd=ROOT, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=timeout, env=env,
                               stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception as e:
            log += f"[{label}] failed to run: {e}\n"
            continue
        log += f"[{label}] exit {p.returncode}\n" + (p.stdout or "")[-1500:] + (p.stderr or "")[-500:] + "\n"
        try:
            ok = p.returncode == 0 and check()
        except Exception:
            ok = False
        if ok:
            return True, label, log
    return False, "", log


if __name__ == "__main__":   # quick health check: python scripts/claude_client.py
    print("key:", "set" if api_key() else "MISSING")
    print(claude_json("Answer briefly.", "Say hello to a Ghanaian newsroom in five words.",
                      {"type": "object", "properties": {"reply": {"type": "string"}}, "required": ["reply"]}))
