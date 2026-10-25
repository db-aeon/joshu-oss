"""Fire-and-forget Langfuse relay to Joshu control plane.

Mirrors stock observability/langfuse fidelity (full request messages, system
prompt, usage/cost, per-API generations, tool spans) but posts to the control
plane so Langfuse secrets never live on the box.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import threading
import time
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional


# Do not print() to stdout. A blocked write to stdout stops every turn in the
# Hermes gateway. Spec: openspec hermes-gateway (change gateway-stdout-drain).
_LOG = logging.getLogger("joshu_langfuse_relay")


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _max_chars() -> int:
    raw = _env("HERMES_LANGFUSE_MAX_CHARS", "12000")
    try:
        return max(500, int(raw))
    except ValueError:
        return 12000


def _relay_url() -> str:
    explicit = _env("JOSHU_LANGFUSE_RELAY_URL")
    if explicit:
        return explicit.rstrip("/")
    base = _env("CONTROL_PLANE_URL").rstrip("/")
    if not base:
        return ""
    return f"{base}/api/instances/langfuse/ingest"


def _bearer_token() -> str:
    instance_id = _env("JOSHU_INSTANCE_ID")
    raw = _env("INSTANCE_AGENT_TOKEN")
    if not instance_id or not raw:
        return ""
    if raw.startswith(f"{instance_id}."):
        return raw
    return f"{instance_id}.{raw}"


def _user_id() -> str:
    return _env("HERMES_LANGFUSE_USER_ID") or (_env("CUSTOMER_DOMAIN").split(".")[0] if _env("CUSTOMER_DOMAIN") else "")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _safe_value(value: Any, *, parse_json_strings: bool = False, max_chars: Optional[int] = None) -> Any:
    limit = _max_chars() if max_chars is None else max_chars
    if value is None:
        return None
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        text = value
        if parse_json_strings:
            stripped = text.strip()
            if stripped[:1] in "{[" and stripped[-1:] in "}]":
                try:
                    parsed, idx = json.JSONDecoder().raw_decode(stripped)
                    if isinstance(parsed, (dict, list)) and not stripped[idx:].strip():
                        return _safe_value(parsed, max_chars=limit)
                except Exception:
                    pass
        if len(text) > limit:
            return text[:limit] + f"… [truncated {len(text) - limit} chars]"
        return text
    if isinstance(value, list):
        return [_safe_value(v, parse_json_strings=parse_json_strings, max_chars=limit) for v in value[:40]]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 40:
                out["_truncated_keys"] = len(value) - 40
                break
            out[str(k)] = _safe_value(v, parse_json_strings=parse_json_strings, max_chars=limit)
        return out
    try:
        text = json.dumps(value, default=str)
    except Exception:
        text = str(value)
    if len(text) > limit:
        return text[:limit] + f"… [truncated {len(text) - limit} chars]"
    return text


def _coerce_request_messages(
    *,
    request_messages: Any = None,
    messages: Any = None,
    conversation_history: Any = None,
    user_message: Any = None,
) -> list[dict[str, Any]]:
    for candidate in (request_messages, messages, conversation_history):
        if isinstance(candidate, list):
            return [m for m in candidate if isinstance(m, dict)]
    if user_message is None:
        return []
    return [{"role": "user", "content": user_message}]


def _serialize_system_prompt(system_prompt: Any) -> Optional[dict[str, Any]]:
    if system_prompt is None:
        return None
    if isinstance(system_prompt, str):
        text = system_prompt.strip()
        if not text:
            return None
        return {"role": "system", "content": _safe_value(text)}
    if isinstance(system_prompt, list):
        parts: list[str] = []
        for block in system_prompt:
            if isinstance(block, dict) and block.get("type") == "text":
                piece = block.get("text", "")
                if isinstance(piece, str) and piece:
                    parts.append(piece)
            elif isinstance(block, str) and block:
                parts.append(block)
        if not parts:
            return None
        return {"role": "system", "content": _safe_value("\n\n".join(parts))}
    return None


def _serialize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for message in messages[-12:]:
        role = message.get("role")
        item: dict[str, Any] = {
            "role": role,
            "content": _safe_value(message.get("content"), parse_json_strings=(role == "tool")),
        }
        if role == "tool":
            if message.get("tool_call_id"):
                item["tool_call_id"] = message.get("tool_call_id")
            if message.get("name"):
                item["name"] = _safe_value(message.get("name"))
        if message.get("tool_calls"):
            item["tool_calls"] = _safe_value(message.get("tool_calls"), parse_json_strings=True)
        serialized.append(item)
    return serialized


def _messages_for_langfuse_input(
    *,
    request_messages: Any = None,
    messages: Any = None,
    conversation_history: Any = None,
    user_message: Any = None,
    system_prompt: Any = None,
) -> list[dict[str, Any]]:
    raw = _coerce_request_messages(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
    )
    if raw and raw[0].get("role") == "system":
        return _serialize_messages(raw)
    system_msg = _serialize_system_prompt(system_prompt)
    serialized = _serialize_messages(raw)
    if system_msg is None:
        return serialized
    return [system_msg, *serialized]


def _extract_last_user_message(messages: Any) -> Any:
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return {"role": "user", "content": _safe_value(message.get("content"))}
    return None


def _serialize_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    if not tool_calls:
        return []
    serialized: list[dict[str, Any]] = []
    for tool_call in tool_calls:
        if isinstance(tool_call, dict):
            fn = tool_call.get("function") if isinstance(tool_call.get("function"), dict) else {}
            name = fn.get("name") or tool_call.get("name")
            arguments = fn.get("arguments") or tool_call.get("arguments")
            serialized.append(
                {
                    "id": tool_call.get("id"),
                    "type": tool_call.get("type") or "function",
                    "name": name,
                    "arguments": _safe_value(arguments, parse_json_strings=False),
                    "function": {"name": name, "arguments": _safe_value(arguments, parse_json_strings=False)},
                }
            )
            continue
        fn = getattr(tool_call, "function", None)
        name = getattr(fn, "name", None) if fn else None
        arguments = getattr(fn, "arguments", None) if fn else None
        serialized.append(
            {
                "id": getattr(tool_call, "id", None),
                "type": getattr(tool_call, "type", None) or "function",
                "name": name,
                "arguments": _safe_value(arguments, parse_json_strings=False),
                "function": {"name": name, "arguments": _safe_value(arguments, parse_json_strings=False)},
            }
        )
    return serialized


def _serialize_assistant_message(message: Any) -> dict[str, Any]:
    if isinstance(message, dict):
        return {
            "content": _safe_value(message.get("content")),
            "reasoning": _safe_value(message.get("reasoning")),
            "tool_calls": _serialize_tool_calls(message.get("tool_calls")),
        }
    return {
        "content": _safe_value(getattr(message, "content", None)),
        "reasoning": _safe_value(getattr(message, "reasoning", None)),
        "tool_calls": _serialize_tool_calls(getattr(message, "tool_calls", None)),
    }


def _usage_from_kwargs(usage: Any) -> dict[str, int]:
    if not isinstance(usage, dict):
        return {}
    details: dict[str, int] = {}
    inp = usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0) or usage.get("input", 0)
    out = usage.get("output_tokens", 0) or usage.get("completion_tokens", 0) or usage.get("output", 0)
    if inp:
        details["input"] = int(inp)
    if out:
        details["output"] = int(out)
    cache_read = usage.get("cache_read_tokens", 0) or usage.get("cache_read_input_tokens", 0)
    cache_write = usage.get("cache_write_tokens", 0) or usage.get("cache_creation_input_tokens", 0)
    reasoning = usage.get("reasoning_tokens", 0)
    if cache_read:
        details["cache_read_input_tokens"] = int(cache_read)
    if cache_write:
        details["cache_creation_input_tokens"] = int(cache_write)
    if reasoning:
        details["reasoning_tokens"] = int(reasoning)
    if details:
        details["total"] = int(details.get("input", 0)) + int(details.get("output", 0))
    return details


def _cost_from_kwargs(usage: Any) -> dict[str, float]:
    if not isinstance(usage, dict):
        return {}
    cost = usage.get("cost")
    if isinstance(cost, (int, float)) and cost:
        return {"total": float(cost)}
    cost_details = usage.get("cost_details")
    if isinstance(cost_details, dict):
        out: dict[str, float] = {}
        for k, v in cost_details.items():
            if isinstance(v, (int, float)):
                out[str(k)] = float(v)
        return out
    return {}


def _compact_event(event: dict[str, Any]) -> dict[str, Any]:
    """Drop top-level nulls — CP zod `.optional()` rejects JSON null."""
    out: dict[str, Any] = {}
    for key, value in event.items():
        if value is None:
            continue
        if isinstance(value, dict):
            # Also drop null metadata values for cleaner Langfuse payloads.
            out[key] = {k: v for k, v in value.items() if v is not None}
        else:
            out[key] = value
    return out


def _post_max_attempts() -> int:
    raw = _env("JOSHU_LANGFUSE_RELAY_POST_RETRIES", "3")
    try:
        return max(1, min(8, int(raw)))
    except ValueError:
        return 3


def _post_events(events: list[dict[str, Any]]) -> None:
    url = _relay_url()
    token = _bearer_token()
    if not url or not token or not events:
        return
    compact = [_compact_event(e) for e in events]
    payload = json.dumps({"events": compact}, default=str).encode("utf-8")
    attempts = _post_max_attempts()
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "joshu-langfuse-relay/1.1.5",
            },
            method="POST",
        )
        try:
            # Larger traces (system + history) need more than the old 2.5s budget.
            with urllib.request.urlopen(req, timeout=12.0) as resp:
                resp.read()
            return
        except urllib.error.HTTPError as err:
            body = ""
            try:
                body = err.read().decode("utf-8", errors="replace")[:400]
            except Exception:
                pass
            retryable = err.code in (401, 408, 429, 500, 502, 503, 504)
            _LOG.warning(
                f"post failed attempt={attempt}/{attempts}: {err} "
                f"body={body} types={[e.get('type') for e in compact]}",
            )
            if not retryable or attempt >= attempts:
                return
            time.sleep(min(8.0, 0.4 * (2 ** (attempt - 1))))
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            _LOG.warning(
                f"post failed attempt={attempt}/{attempts}: {err}",
            )
            if attempt >= attempts:
                return
            time.sleep(min(8.0, 0.4 * (2 ** (attempt - 1))))


_EMIT_THREADS: list[threading.Thread] = []
_EMIT_THREADS_LOCK = threading.Lock()


def _emit_async(events: list[dict[str, Any]]) -> None:
    thread = threading.Thread(target=_post_events, args=(events,), daemon=True)
    with _EMIT_THREADS_LOCK:
        # Drop finished workers so the list cannot grow without bound.
        alive = [t for t in _EMIT_THREADS if t.is_alive()]
        alive.append(thread)
        _EMIT_THREADS[:] = alive[-64:]
    thread.start()


def _flush_emit_threads(timeout_s: float = 8.0) -> None:
    """Best-effort wait for in-flight relay POSTs (gateway restart / process exit)."""
    with _EMIT_THREADS_LOCK:
        threads = list(_EMIT_THREADS)
    deadline = time.time() + max(0.5, timeout_s)
    for thread in threads:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        thread.join(timeout=remaining)


def _session_key(kwargs: dict) -> str:
    for key in ("gateway_session_key", "session_id", "session_key", "task_id"):
        value = kwargs.get(key)
        if value:
            return str(value)
    return ""


def _trace_key(task_id: str, session_id: str) -> str:
    """Stable turn key across pre_api / post_api / post_llm / tool hooks.

    Important: do not prefix session ids — jChat often passes the same hermes-chat-*
    value as task_id on API hooks and as session_id on post_llm_call. A prefix
    mismatch creates orphan traces with no generations.
    """
    tid = str(task_id or "").strip()
    sid = str(session_id or "").strip()
    if tid:
        return tid
    if sid:
        return sid
    return f"thread:{threading.get_ident()}"


@dataclass
class TurnState:
    trace_id: str
    root_span_id: str
    session_id: str = ""
    llm_call_count: int = 0
    generations_emitted: int = 0
    pending_gens: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending_tools: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    turn_tool_calls: list[dict[str, Any]] = field(default_factory=list)
    started_at: str = field(default_factory=_now_iso)
    # Monotonic activity stamp for hung-turn sweeper (gateway_timeout / missing finalize).
    last_activity_mono: float = field(default_factory=time.monotonic)
    last_assistant_output: Any = None
    user_message: Any = None
    platform: str = ""
    model: str = ""
    finalized: bool = False


def _touch_turn(state: TurnState) -> None:
    with _STATE_LOCK:
        state.last_activity_mono = time.monotonic()


def _hung_turn_ttl_s() -> float:
    """Finalize open turns after this many seconds without hook activity.

    Default 2100s sits just above typical gateway_timeout (1800) so a killed
    Slack/jChat turn still gets a Langfuse endTime even when post_llm_call /
    on_session_end never fires (seen as a hung session on a box).
    """
    raw = _env("JOSHU_LANGFUSE_HUNG_TURN_TTL_S", "2100")
    try:
        return max(120.0, float(raw))
    except ValueError:
        return 2100.0


def _turn_alias_keys(*, task_id: str = "", session_id: str = "") -> list[str]:
    keys: list[str] = []
    for candidate in (task_id, session_id):
        value = str(candidate or "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def _register_turn_aliases(state: TurnState, *, task_id: str = "", session_id: str = "") -> None:
    aliases = _turn_alias_keys(task_id=task_id, session_id=session_id)
    if not aliases:
        aliases = [_trace_key(task_id, session_id)]
    with _STATE_LOCK:
        for alias in aliases:
            _TURNS[alias] = state


def _unregister_turn(state: TurnState) -> None:
    with _STATE_LOCK:
        for key, value in list(_TURNS.items()):
            if value is state:
                _TURNS.pop(key, None)


def _remember_assistant_output(state: TurnState, output: Any) -> None:
    if output is None:
        return
    if isinstance(output, dict):
        content = output.get("content")
        if content:
            with _STATE_LOCK:
                state.last_assistant_output = content
            return
        if output.get("tool_calls"):
            with _STATE_LOCK:
                state.last_assistant_output = output
            return
    with _STATE_LOCK:
        state.last_assistant_output = output


_STATE_LOCK = threading.Lock()
_TURNS: dict[str, TurnState] = {}
_SWEEPER_STARTED = False
_SWEEPER_LOCK = threading.Lock()


def _sweep_hung_turns_once() -> int:
    """Finalize turns with no hook activity past TTL. Returns count finalized."""
    ttl = _hung_turn_ttl_s()
    now = time.monotonic()
    with _STATE_LOCK:
        candidates = []
        seen: set[int] = set()
        for state in _TURNS.values():
            sid = id(state)
            if sid in seen or state.finalized:
                continue
            seen.add(sid)
            if (now - state.last_activity_mono) >= ttl:
                candidates.append(state)
    for state in candidates:
        age = int(now - state.last_activity_mono)
        _LOG.info(
            f"hung-turn sweeper finalizing trace={state.trace_id[:12]}… "
            f"idle={age}s ttl={int(ttl)}s session={state.session_id!r}",
        )
        fallback = state.last_assistant_output or "[hung turn — finalize timeout]"
        _finalize_turn(
            state,
            assistant_response=fallback,
            model=state.model,
            platform=state.platform,
            hook="hung_turn_sweeper",
        )
    return len(candidates)


def _hung_turn_sweeper_loop() -> None:
    # Poll often enough to catch gateway kills without busy-waiting.
    while True:
        try:
            _sweep_hung_turns_once()
        except Exception as err:
            _LOG.warning(f"hung-turn sweeper error: {err}")
        time.sleep(60.0)


def _ensure_hung_turn_sweeper() -> None:
    global _SWEEPER_STARTED
    with _SWEEPER_LOCK:
        if _SWEEPER_STARTED:
            return
        thread = threading.Thread(
            target=_hung_turn_sweeper_loop,
            name="joshu-langfuse-hung-turn-sweeper",
            daemon=True,
        )
        thread.start()
        _SWEEPER_STARTED = True


def _get_or_create_turn(
    *,
    task_id: str = "",
    session_id: str = "",
    user_message: Any = None,
    messages: Any = None,
    platform: str = "",
    model: str = "",
    provider: str = "",
) -> TurnState:
    aliases = _turn_alias_keys(task_id=task_id, session_id=session_id)
    with _STATE_LOCK:
        for alias in aliases:
            existing = _TURNS.get(alias)
            if existing:
                existing.last_activity_mono = time.monotonic()
                return existing
    trace_id = uuid.uuid4().hex
    root_span_id = f"t-{trace_id}"
    state = TurnState(
        trace_id=trace_id,
        root_span_id=root_span_id,
        session_id=str(session_id or ""),
        user_message=user_message,
        platform=str(platform or ""),
        model=str(model or ""),
    )
    _register_turn_aliases(state, task_id=str(task_id or ""), session_id=str(session_id or ""))

    trace_input = None
    if user_message is not None:
        trace_input = {"role": "user", "content": _safe_value(user_message)}
    else:
        trace_input = _extract_last_user_message(messages)

    _emit_async(
        [
            {
                "id": trace_id,
                "type": "trace",
                "name": "Hermes turn",
                "traceId": trace_id,
                "sessionId": session_id or None,
                "userId": _user_id() or None,
                "input": trace_input,
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "startTime": state.started_at,
                "metadata": {
                    "platform": platform or None,
                    "provider": provider or None,
                    "model": model or None,
                    "joshuRelay": True,
                },
            },
            {
                "id": root_span_id,
                "type": "span",
                "name": "Hermes turn",
                "traceId": trace_id,
                "sessionId": session_id or None,
                "input": trace_input,
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "startTime": state.started_at,
                "metadata": {"asType": "chain", "joshuRelay": True},
            },
        ]
    )
    return state


def on_pre_api_request(
    *,
    task_id: str = "",
    session_id: str = "",
    platform: str = "",
    model: str = "",
    provider: str = "",
    base_url: str = "",
    api_mode: str = "",
    api_call_count: Any = 0,
    request_messages: Any = None,
    messages: Any = None,
    conversation_history: Any = None,
    user_message: Any = None,
    system_prompt: Any = None,
    **kwargs: Any,
) -> None:
    _LOG.debug(
        f"pre_api_request task={task_id!r} session={session_id!r} model={model!r}",
    )
    sid = str(session_id or _session_key(kwargs) or "").strip()
    state = _get_or_create_turn(
        task_id=str(task_id or ""),
        session_id=sid,
        user_message=user_message,
        messages=request_messages or messages or conversation_history,
        platform=platform,
        model=model,
        provider=provider,
    )
    req_key = str(api_call_count or len(state.pending_gens) + 1)
    gen_input = _messages_for_langfuse_input(
        request_messages=request_messages,
        messages=messages,
        conversation_history=conversation_history,
        user_message=user_message,
        system_prompt=system_prompt,
    )
    system_chars = 0
    if gen_input and gen_input[0].get("role") == "system":
        system_chars = len(str(gen_input[0].get("content") or ""))
    with _STATE_LOCK:
        state.llm_call_count += 1
        call_no = state.llm_call_count
        gen_id = uuid.uuid4().hex
        state.pending_gens[req_key] = {
            "id": gen_id,
            "name": f"LLM call {call_no}",
            "input": gen_input,
            "model": model,
            "started_at": _now_iso(),
            "metadata": {
                "provider": provider or None,
                "platform": platform or None,
                "api_mode": api_mode or None,
                "base_url": base_url or None,
                "message_count": len(gen_input),
                "system_prompt_chars": system_chars or None,
                "joshuRelay": True,
            },
        }


def _resolve_turn(task_id: str = "", session_id: str = "") -> tuple[str, Optional[TurnState]]:
    """Find in-flight turn; jChat often swaps which id is task vs session."""
    tid = str(task_id or "").strip()
    sid = str(session_id or "").strip()
    keys = []
    for candidate in (tid, sid):
        if candidate and candidate not in keys:
            keys.append(candidate)
    if tid and sid and tid != sid:
        keys.append(_trace_key(tid, sid))
        keys.append(_trace_key(sid, tid))
    with _STATE_LOCK:
        for key in keys:
            state = _TURNS.get(key)
            if state:
                return key, state
        # Last resort: unique active turn whose key contains either id.
        if tid or sid:
            matches = [
                k
                for k in _TURNS.keys()
                if (tid and tid in k) or (sid and sid in k)
            ]
            if len(matches) == 1:
                key = matches[0]
                return key, _TURNS.get(key)
    return (keys[0] if keys else ""), None


def _generation_output_from_hooks(
    *,
    assistant_message: Any = None,
    assistant_response: Any = None,
    response: Any = None,
    assistant_content_chars: Any = None,
    assistant_tool_call_count: Any = None,
) -> Any:
    # Mirror stock observability/langfuse: post_api and post_llm shapes differ.
    if assistant_message is not None:
        return _serialize_assistant_message(assistant_message)
    if assistant_response is not None:
        return {"content": _safe_value(assistant_response)}
    if isinstance(response, dict):
        choices = response.get("choices") if isinstance(response.get("choices"), list) else []
        msg = choices[0].get("message") if choices and isinstance(choices[0], dict) else response.get("message")
        if msg is not None:
            return _serialize_assistant_message(msg)
        return _safe_value(response)
    if response is not None:
        content = getattr(response, "choices", None)
        if content:
            return _serialize_assistant_message(getattr(content[0].message, "content", None))
        return _safe_value(response)
    if assistant_content_chars or assistant_tool_call_count:
        return {
            "content": f"[{assistant_content_chars} chars]" if assistant_content_chars else None,
            "tool_calls": (
                [{"id": f"tc_{i}"} for i in range(int(assistant_tool_call_count))]
                if assistant_tool_call_count
                else []
            ),
        }
    return None


def _emit_generation_from_pending(
    state: TurnState,
    pending: dict[str, Any],
    *,
    model: str = "",
    usage: Any = None,
    finish_reason: Any = None,
    api_duration_s: Any = None,
    output: Any = None,
    hook: str = "post_api_request",
) -> None:
    usage_details = _usage_from_kwargs(usage)
    cost_details = _cost_from_kwargs(usage)
    metadata = dict(pending.get("metadata") or {})
    metadata["hook"] = hook
    if finish_reason is not None:
        metadata["finish_reason"] = finish_reason
    if api_duration_s is not None:
        metadata["api_duration_s"] = api_duration_s
    if isinstance(usage, dict) and usage.get("generation_id"):
        metadata["openrouter_generation_id"] = usage.get("generation_id")

    with _STATE_LOCK:
        state.generations_emitted += 1

    _emit_async(
        [
            {
                "id": pending["id"],
                "type": "generation",
                "name": pending["name"],
                "traceId": state.trace_id,
                "parentObservationId": state.root_span_id,
                "sessionId": state.session_id or None,
                "input": pending.get("input"),
                "output": output,
                "model": pending.get("model") or model or None,
                "usageDetails": usage_details or None,
                "costDetails": cost_details or None,
                "startTime": pending.get("started_at") or _now_iso(),
                "endTime": _now_iso(),
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "metadata": metadata,
            }
        ]
    )


def on_post_api_request(
    *,
    task_id: str = "",
    session_id: str = "",
    platform: str = "",
    model: str = "",
    provider: str = "",
    base_url: str = "",
    api_mode: str = "",
    api_call_count: Any = 0,
    response: Any = None,
    usage: Any = None,
    assistant_message: Any = None,
    assistant_response: Any = None,
    assistant_content_chars: Any = None,
    assistant_tool_call_count: Any = None,
    finish_reason: Any = None,
    api_duration_s: Any = None,
    api_duration: Any = None,
    **kwargs: Any,
) -> None:
    """Close one pending generation — stock also wires this hook to the post-LLM closer."""
    sid = str(session_id or _session_key(kwargs) or "").strip()
    key, state = _resolve_turn(str(task_id or ""), sid)
    if state:
        _touch_turn(state)
    req_key = str(api_call_count or 0)
    _LOG.debug(
        f"post_api_request task={task_id!r} session={sid!r} "
        f"key={key!r} req_key={req_key!r} has_state={state is not None}",
    )
    pending = None
    if state:
        with _STATE_LOCK:
            pending = state.pending_gens.pop(req_key, None)
            # Fallback: most recent pending generation if call count missing/mismatched.
            if pending is None and state.pending_gens:
                _, pending = state.pending_gens.popitem()
    if not state or not pending:
        return

    output = _generation_output_from_hooks(
        assistant_message=assistant_message,
        assistant_response=assistant_response,
        response=response,
        assistant_content_chars=assistant_content_chars,
        assistant_tool_call_count=assistant_tool_call_count,
    )
    _emit_generation_from_pending(
        state,
        pending,
        model=model,
        usage=usage,
        finish_reason=finish_reason,
        api_duration_s=api_duration_s if api_duration_s is not None else api_duration,
        output=output,
        hook="post_api_request",
    )
    _remember_assistant_output(state, output)


def _finalize_turn(
    state: TurnState,
    *,
    assistant_response: Any = "",
    user_message: Any = None,
    conversation_history: Any = None,
    model: str = "",
    platform: str = "",
    api_call_count: Any = 0,
    usage: Any = None,
    assistant_message: Any = None,
    response: Any = None,
    finish_reason: Any = None,
    api_duration_s: Any = None,
    api_duration: Any = None,
    hook: str = "post_llm_call",
) -> None:
    if state.finalized:
        return

    resolved_response = assistant_response or state.last_assistant_output or ""
    req_key = str(api_call_count or 0)
    with _STATE_LOCK:
        pending = state.pending_gens.pop(req_key, None)
        if pending is None and state.pending_gens:
            first_key = next(iter(state.pending_gens))
            pending = state.pending_gens.pop(first_key)
    if pending:
        output = _generation_output_from_hooks(
            assistant_message=assistant_message,
            assistant_response=resolved_response,
            response=response,
        )
        _emit_generation_from_pending(
            state,
            pending,
            model=model or state.model,
            usage=usage,
            finish_reason=finish_reason,
            api_duration_s=api_duration_s if api_duration_s is not None else api_duration,
            output=output,
            hook=hook,
        )

    leftovers: list[dict[str, Any]] = []
    with _STATE_LOCK:
        leftovers = list(state.pending_gens.values())
        state.pending_gens.clear()
    if leftovers:
        output = _generation_output_from_hooks(
            assistant_message=assistant_message,
            assistant_response=resolved_response,
            response=response,
        )
        for pending in leftovers:
            _emit_generation_from_pending(
                state,
                pending,
                model=model or state.model,
                usage=usage,
                finish_reason=finish_reason,
                api_duration_s=api_duration_s if api_duration_s is not None else api_duration,
                output=output,
                hook=f"{hook}_flush",
            )

    trace_user_message = user_message if user_message is not None else state.user_message
    resolved_model = model or state.model
    resolved_platform = platform or state.platform

    events: list[dict[str, Any]] = []
    if state.generations_emitted == 0:
        gen_input = _messages_for_langfuse_input(
            conversation_history=conversation_history,
            user_message=trace_user_message,
        )
        with _STATE_LOCK:
            state.generations_emitted += 1
        events.append(
            {
                "id": uuid.uuid4().hex,
                "type": "generation",
                "name": "LLM call 1",
                "traceId": state.trace_id,
                "parentObservationId": state.root_span_id,
                "sessionId": state.session_id or None,
                "input": gen_input,
                "output": {"content": _safe_value(resolved_response)},
                "model": resolved_model or None,
                "startTime": state.started_at,
                "endTime": _now_iso(),
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "metadata": {"hook": f"{hook}_fallback", "joshuRelay": True},
            }
        )

    output: Any = {"content": _safe_value(resolved_response)}
    if state.turn_tool_calls:
        output["tool_calls"] = state.turn_tool_calls[-20:]

    events.extend(
        [
            {
                "id": state.trace_id,
                "type": "trace",
                "name": "Hermes turn",
                "traceId": state.trace_id,
                "sessionId": state.session_id or None,
                "userId": _user_id() or None,
                "input": {"role": "user", "content": _safe_value(trace_user_message)} if trace_user_message else None,
                "output": output,
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "startTime": state.started_at,
                "endTime": _now_iso(),
                "metadata": {
                    "model": resolved_model or None,
                    "platform": resolved_platform or None,
                    "joshuRelay": True,
                    "hook": hook,
                },
            },
            {
                "id": state.root_span_id,
                "type": "span",
                "name": "Hermes turn",
                "traceId": state.trace_id,
                "sessionId": state.session_id or None,
                "input": {"role": "user", "content": _safe_value(trace_user_message)} if trace_user_message else None,
                "output": output,
                "startTime": state.started_at,
                "endTime": _now_iso(),
                "tags": ["hermes", "langfuse", "joshu-relay"],
                "metadata": {"asType": "chain", "joshuRelay": True, "hook": hook},
            },
        ]
    )
    _emit_async(events)
    with _STATE_LOCK:
        state.finalized = True
    _unregister_turn(state)


def on_pre_tool_call(*, tool_name: str = "", args: Any = None, task_id: str = "", session_id: str = "", **kwargs: Any) -> None:
    sid = str(session_id or _session_key(kwargs) or "").strip()
    state = _get_or_create_turn(task_id=str(task_id or ""), session_id=sid)
    _touch_turn(state)
    tool_id = uuid.uuid4().hex
    with _STATE_LOCK:
        queue = state.pending_tools.setdefault(str(tool_name or "tool"), [])
        queue.append(
            {
                "id": tool_id,
                "name": f"tool:{tool_name}" if tool_name else "tool",
                "tool": tool_name,
                "input": _safe_value(args, parse_json_strings=True),
                "started_at": _now_iso(),
            }
        )


def on_post_tool_call(
    *,
    tool_name: str = "",
    args: Any = None,
    result: Any = None,
    task_id: str = "",
    session_id: str = "",
    **kwargs: Any,
) -> None:
    sid = str(session_id or _session_key(kwargs) or "").strip()
    _key, state = _resolve_turn(str(task_id or ""), sid)
    if state:
        _touch_turn(state)
    with _STATE_LOCK:
        pending = None
        if state:
            queue = state.pending_tools.get(str(tool_name or "tool"))
            if isinstance(queue, list) and queue:
                pending = queue.pop(0)
            state.turn_tool_calls.append(
                {
                    "name": tool_name,
                    "arguments": _safe_value(args, parse_json_strings=True),
                    "result": _safe_value(result, parse_json_strings=True),
                }
            )
    if not state:
        return
    span_id = (pending or {}).get("id") or uuid.uuid4().hex
    started = (pending or {}).get("started_at") or _now_iso()
    tool_input = (pending or {}).get("input")
    if tool_input is None:
        tool_input = _safe_value(args, parse_json_strings=True)
    _emit_async(
        [
            {
                "id": span_id,
                "type": "span",
                "name": f"tool:{tool_name}" if tool_name else "tool",
                "traceId": state.trace_id,
                "parentObservationId": state.root_span_id,
                "sessionId": state.session_id or None,
                "input": tool_input,
                "output": _safe_value(result, parse_json_strings=True),
                "startTime": started,
                "endTime": _now_iso(),
                "tags": ["hermes", "langfuse", "joshu-relay", "tool"],
                "metadata": {"tool": tool_name, "joshuRelay": True},
            }
        ]
    )


def on_post_llm_call(
    *,
    session_id: str = "",
    task_id: str = "",
    user_message: str = "",
    assistant_response: str = "",
    conversation_history: Any = None,
    model: str = "",
    platform: str = "",
    api_call_count: Any = 0,
    usage: Any = None,
    assistant_message: Any = None,
    response: Any = None,
    finish_reason: Any = None,
    api_duration_s: Any = None,
    api_duration: Any = None,
    **kwargs: Any,
) -> None:
    """Turn-level completion — finalize root trace/span and flush open generations."""
    sid = str(session_id or _session_key(kwargs) or "").strip()
    tid = str(task_id or kwargs.get("task_id") or "").strip()
    _key, state = _resolve_turn(tid, sid)
    _LOG.debug(
        f"post_llm_call task={tid!r} session={sid!r} "
        f"has_state={state is not None} "
        f"llm_calls={state.llm_call_count if state else 0} "
        f"pending={len(state.pending_gens) if state else 0} "
        f"emitted={state.generations_emitted if state else 0}",
    )
    if not state:
        return
    _finalize_turn(
        state,
        assistant_response=assistant_response,
        user_message=user_message,
        conversation_history=conversation_history,
        model=model,
        platform=platform,
        api_call_count=api_call_count,
        usage=usage,
        assistant_message=assistant_message,
        response=response,
        finish_reason=finish_reason,
        api_duration_s=api_duration_s,
        api_duration=api_duration,
        hook="post_llm_call",
    )


def on_session_end(
    *,
    session_id: str = "",
    completed: bool = True,
    interrupted: bool = False,
    model: str = "",
    platform: str = "",
    **kwargs: Any,
) -> None:
    """Hermes skips post_llm_call when final_response is empty — finalize here instead."""
    sid = str(session_id or _session_key(kwargs) or "").strip()
    _key, state = _resolve_turn("", sid)
    if not state or state.finalized:
        return
    fallback = state.last_assistant_output or ""
    if not fallback and interrupted:
        fallback = "[interrupted]"
    elif not fallback and not completed:
        fallback = "[turn ended without assistant text]"
    _LOG.debug(
        f"on_session_end session={sid!r} completed={completed} "
        f"interrupted={interrupted} has_output={bool(fallback)}",
    )
    _finalize_turn(
        state,
        assistant_response=fallback,
        model=model,
        platform=platform,
        hook="on_session_end",
    )


def register(ctx) -> None:
    # Match stock observability/langfuse hook set for parity.
    ctx.register_hook("pre_api_request", on_pre_api_request)
    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("post_llm_call", on_post_llm_call)
    ctx.register_hook("on_session_end", on_session_end)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    _ensure_hung_turn_sweeper()
    atexit.register(_flush_emit_threads)
    url = _relay_url()
    has_auth = bool(_bearer_token())
    _LOG.info(
        f"registered v1.1.5 "
        f"(url={'set' if url else 'missing'}, auth={'set' if has_auth else 'missing'}, "
        f"hung_ttl_s={int(_hung_turn_ttl_s())})",
    )
