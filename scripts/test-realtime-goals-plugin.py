#!/usr/bin/env python3
"""Contract tests for the Hermes Slack/Telegram admission hook."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / ".hermes/plugins/joshu-realtime-goals/tools.py"
SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_tools", TOOLS)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

GUARD_PATH = ROOT / ".hermes/plugins/joshu-realtime-goals/cron_guard.py"
GUARD_SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_cron_guard", GUARD_PATH)
assert GUARD_SPEC and GUARD_SPEC.loader
GUARD = importlib.util.module_from_spec(GUARD_SPEC)
GUARD_SPEC.loader.exec_module(GUARD)

STEP_PATH = ROOT / ".hermes/plugins/joshu-realtime-goals/step_limit.py"
STEP_SPEC = importlib.util.spec_from_file_location("joshu_realtime_goals_step_limit", STEP_PATH)
assert STEP_SPEC and STEP_SPEC.loader
STEP = importlib.util.module_from_spec(STEP_SPEC)
STEP_SPEC.loader.exec_module(STEP)


def check_step_limit() -> None:
    """Spec realtime-goal-worker-runs: step-limit warning and step-limit note."""
    import sys
    import types

    # Stand-ins for Hermes modules, so the test runs without Hermes installed.
    config = types.ModuleType("hermes_cli.config")
    config.load_config = lambda: {"agent": {"max_turns": 90}}
    runs: dict[int, SimpleNamespace] = {}
    comments: list[tuple[str, str, str]] = []

    class Conn:
        def close(self) -> None:
            pass

    kanban_db = types.ModuleType("hermes_cli.kanban_db")
    kanban_db.connect = lambda *a, **k: Conn()
    kanban_db.get_run = lambda _conn, run_id: runs.get(run_id)
    kanban_db.add_comment = lambda _conn, task_id, author, body: comments.append((task_id, author, body)) or 1
    package = types.ModuleType("hermes_cli")
    package.config = config
    package.kanban_db = kanban_db
    saved = {name: sys.modules.get(name) for name in ("hermes_cli", "hermes_cli.config", "hermes_cli.kanban_db", "hermes_cli.kanban_db_connect")}
    sys.modules.update({"hermes_cli": package, "hermes_cli.config": config, "hermes_cli.kanban_db": kanban_db})
    saved_env = {k: os.environ.get(k) for k in ("HERMES_KANBAN_TASK", "HERMES_KANBAN_BOARD", "HERMES_KANBAN_RUN_ID")}

    def worker(board: str | None, run_id: str = "7") -> None:
        STEP._state["steps"] = 0
        for key in saved_env:
            os.environ.pop(key, None)
        if board:
            os.environ.update({"HERMES_KANBAN_TASK": "t_4bab6c61", "HERMES_KANBAN_BOARD": board, "HERMES_KANBAN_RUN_ID": run_id})

    try:
        # Warning at step 75 of 90 says 15 steps are left; the tool result text before it stays.
        worker("realtime-goals")
        STEP.pre_api_request(api_call_count=20)
        assert STEP.transform_tool_result(result="page text") is None
        STEP.pre_api_request(api_call_count=75)
        warned = STEP.transform_tool_result(result="page text")
        assert warned.startswith("page text\n\n[Joshu step-limit warning] 15 steps are left")
        assert "kanban_block" in warned and "kanban_complete" in warned
        STEP.pre_api_request(api_call_count=89)
        assert "1 step is left" in STEP.transform_tool_result(result="x")
        # A lower count (a retried request) never moves the counter back.
        STEP.pre_api_request(api_call_count=3)
        assert STEP.transform_tool_result(result="x") is not None
        # A smaller step limit from agent.max_turns.
        config.load_config = lambda: {"agent": {"max_turns": 30}}
        worker("realtime-goals")
        STEP.pre_api_request(api_call_count=15)
        assert "15 steps are left" in STEP.transform_tool_result(result="x")
        config.load_config = lambda: {}
        assert STEP.step_limit() == 90
        config.load_config = lambda: {"agent": {"max_turns": 90}}

        # Other boards and sessions that are not workers get no warning.
        worker("ea-mail-ingress")
        STEP.pre_api_request(api_call_count=85)
        assert STEP.transform_tool_result(result="x") is None
        worker(None)
        STEP.pre_api_request(api_call_count=85)
        assert STEP.transform_tool_result(result="x") is None

        # Step-limit note for a run that Hermes ended at the step limit.
        error = "Iteration budget exhausted (90/90) — task could not complete within the allowed iterations"
        runs[7] = SimpleNamespace(outcome="timed_out", error=error)
        worker("realtime-goals")
        STEP.post_llm_call(assistant_response="Enterprise is sold out for a Saturday pickup at XNA.")
        assert comments == [("t_4bab6c61", "joshu-step-limit", "## Step-limit note\n\nEnterprise is sold out for a Saturday pickup at XNA.")]
        # A long summary is cut to 4000 characters.
        comments.clear()
        STEP.post_llm_call(assistant_response="a" * 9000)
        assert comments[0][2] == "## Step-limit note\n\n" + "a" * 4000
        # No note: empty summary, run still running, a crash, another board, no run id.
        comments.clear()
        STEP.post_llm_call(assistant_response="   ")
        runs[8] = SimpleNamespace(outcome=None, error=None)
        worker("realtime-goals", "8")
        STEP.post_llm_call(assistant_response="Blocked with a question.")
        runs[9] = SimpleNamespace(outcome="crashed", error="worker exited with code 1")
        worker("realtime-goals", "9")
        STEP.post_llm_call(assistant_response="summary")
        worker("ea-mail-ingress")
        STEP.post_llm_call(assistant_response="summary")
        worker("realtime-goals", "")
        STEP.post_llm_call(assistant_response="summary")
        assert comments == []
        # Hermes v0.23 opens the database with hermes_cli.kanban_db_connect.connect.
        worker("realtime-goals")
        newer = types.ModuleType("hermes_cli.kanban_db_connect")
        opened: list[str] = []
        newer.connect = lambda *a, **k: opened.append("kanban_db_connect") or Conn()
        sys.modules["hermes_cli.kanban_db_connect"] = newer
        package.kanban_db_connect = newer
        STEP.post_llm_call(assistant_response="summary")
        assert opened == ["kanban_db_connect"] and len(comments) == 1
        del sys.modules["hermes_cli.kanban_db_connect"]
        del package.kanban_db_connect
        comments.clear()
        # A failing Kanban database never raises into Hermes.
        worker("realtime-goals")
        kanban_db.connect = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("database is locked"))
        assert STEP.post_llm_call(assistant_response="summary") is None

        class Ctx:
            hooks: list[str] = []

            def register_hook(self, name, _callback):
                self.hooks.append(name)

        ctx = Ctx()
        STEP.register(ctx)
        assert ctx.hooks == ["pre_api_request", "transform_tool_result", "post_llm_call"]
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def check_cron_guard() -> None:
    """Spec owner-reminders: Hermes cronjob calls with an undeliverable target are blocked."""

    def call(platform: str, args: dict):
        os.environ["HERMES_SESSION_PLATFORM"] = platform
        try:
            return GUARD.pre_tool_call(tool_name="cronjob", args=args)
        finally:
            del os.environ["HERMES_SESSION_PLATFORM"]

    # Reminder from an SMS turn without deliver (box joe, 2026-09-11).
    blocked = call("api_server", {"action": "create", "schedule": "0 9 * * *", "prompt": "Remind the owner"})
    assert blocked["action"] == "block"
    assert "owner_reminder_create" in blocked["message"]
    assert call("api_server", {"action": "create", "deliver": "origin"})["action"] == "block"
    # Platforms that the Hermes gateway does not run on a box.
    assert call("telegram", {"action": "create", "deliver": "sms:+15551234567"})["action"] == "block"
    assert call("", {"action": "create", "deliver": "email:owner@example.com"})["action"] == "block"
    assert call("api_server", {"action": "create", "deliver": "origin,telegram"})["action"] == "block"
    # Not blocked: Telegram/Slack sessions, local, all, explicit telegram, other actions.
    assert call("telegram", {"action": "create"}) is None
    assert call("slack", {"action": "create", "deliver": "origin"}) is None
    assert call("api_server", {"action": "create", "deliver": "local"}) is None
    assert call("api_server", {"action": "create", "deliver": "all"}) is None
    assert call("api_server", {"action": "create", "deliver": "telegram:-1001:17"}) is None
    assert call("", {"action": "create"}) is None  # unknown session: Hermes home-channel fallback
    assert call("api_server", {"action": "update", "job_id": "j1", "prompt": "x"}) is None
    assert call("api_server", {"action": "update", "job_id": "j1", "deliver": "origin"})["action"] == "block"
    assert call("api_server", {"action": "list"}) is None
    assert GUARD.pre_tool_call(tool_name="terminal", args={"action": "create"}) is None
    # Same examples as scanCronFailures in scripts/test-instance-failures.mjs.
    assert GUARD.undeliverable_reason("origin", "api_server")
    assert GUARD.undeliverable_reason("sms:+15551234567", "")
    assert GUARD.undeliverable_reason("local", "api_server") is None
    assert GUARD.undeliverable_reason("telegram", "telegram") is None

    class Ctx:
        hooks: list[str] = []

        def register_hook(self, name, _callback):
            self.hooks.append(name)

    ctx = Ctx()
    GUARD.register(ctx)
    assert ctx.hooks == ["pre_tool_call"]


class Adapter:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, dict | None]] = []

    async def send(self, chat_id: str, text: str, metadata=None) -> None:
        self.sent.append((chat_id, text, metadata))


class Platform:
    value = "slack"


async def main() -> None:
    check_cron_guard()
    assert MODULE._origin_from_session("agent:main:email:dm:owner") is None
    assert MODULE._origin_from_session("share-chat:public") is None
    assert MODULE._origin_from_session("agent:main:slack:dm:D1")["channel"] == "slack"
    os.environ["HERMES_KANBAN_TASK"] = "t_worker"
    rejected = json.loads(
        MODULE.realtime_goal_defer(
            {"objective": "recursively queue me"},
            gateway_session_key="joshu-hermes-chat:test",
        )
    )
    assert rejected["ok"] is False
    del os.environ["HERMES_KANBAN_TASK"]

    platform = Platform()
    source = SimpleNamespace(
        platform=platform,
        user_id="U1",
        chat_id="C1",
        thread_id="123.456",
    )
    event = SimpleNamespace(source=source, text="Research this deeply", message_id="M1")
    adapter = Adapter()
    gateway = SimpleNamespace(
        adapters={platform: adapter},
        _is_user_authorized=lambda _source: True,
        _session_key_for_source=lambda _source: "agent:main:slack:channel:C1:123.456",
    )

    MODULE._post = lambda *_args, **_kwargs: {
        "action": "reply",
        "text": "Queued. Anything else?",
    }
    result = MODULE.pre_gateway_dispatch(event, gateway)
    assert result["action"] == "skip"
    await asyncio.sleep(0)
    assert adapter.sent == [
        ("C1", "Queued. Anything else?", {"thread_id": "123.456"})
    ]

    # Issue #171: files and chat context go to the broker with the text.
    posted: list[tuple[str, dict]] = []

    def record_post(path, payload, timeout=10.0):
        posted.append((path, payload))
        return {"action": "reply", "text": "Queued. Anything else?"}

    MODULE._post = record_post
    media_event = SimpleNamespace(
        source=source,
        text="please book this meeting",
        message_id="M2",
        media_urls=["/home/joshu/.hermes/cache/img_invite.png", "relative/skip.png"],
        media_types=["image/png", "image/png"],
        channel_context="[Group DM context — recent messages in this group DM]\nJT: Mina, book Tuesday 3 PM",
        reply_to_text="Can you find a slot with Sam?",
    )
    assert MODULE.pre_gateway_dispatch(media_event, gateway)["action"] == "skip"
    _path, payload = posted[-1]
    assert payload["text"] == "please book this meeting"
    assert payload["attachments"] == [
        {"path": "/home/joshu/.hermes/cache/img_invite.png", "mediaType": "image/png"}
    ]
    assert payload["context"].startswith('[The owner replied to: "Can you find a slot with Sam?"]')
    assert "JT: Mina, book Tuesday 3 PM" in payload["context"]
    # A plain text message sends neither field.
    MODULE.pre_gateway_dispatch(event, gateway)
    assert "attachments" not in posted[-1][1] and "context" not in posted[-1][1]
    # A photo without a caption or a voice note before transcription takes the normal Hermes turn.
    count = len(posted)
    empty = SimpleNamespace(source=source, text="", message_id="M3", media_urls=["/tmp/voice.ogg"], media_types=["audio/ogg"])
    assert MODULE.pre_gateway_dispatch(empty, gateway)["action"] == "allow"
    assert len(posted) == count
    await asyncio.sleep(0)

    gateway._is_user_authorized = lambda _source: False
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    event.text = "/status"
    gateway._is_user_authorized = lambda _source: True
    assert MODULE.pre_gateway_dispatch(event, gateway)["action"] == "allow"

    # Slack/Telegram turns get the owner's background-work snapshot (SMS and voice do).
    calls: list[tuple[str, dict]] = []

    def fake_post(path, payload, timeout=10.0):
        calls.append((path, payload))
        return {"context": "Background work context: Cancun flights (done; owner heard it by phone)"}

    MODULE._post = fake_post
    injected = MODULE.pre_llm_call(session_id="agent:main:slack:dm:D1", platform="slack")
    assert injected == {"context": "Background work context: Cancun flights (done; owner heard it by phone)"}
    assert calls[-1][0] == "/api/realtime-goals/context"
    assert calls[-1][1]["origin"]["channel"] == "slack"
    assert MODULE.pre_llm_call(session_id="sess-1", platform="api_server") is None
    assert MODULE.pre_llm_call(session_id="sess-2", platform="telegram")["context"].startswith("Background")

    def failing_post(*_args, **_kwargs):
        raise RuntimeError("broker warming")

    MODULE._post = failing_post
    assert MODULE.pre_llm_call(session_id="agent:main:slack:dm:D1", platform="slack") is None

    print("test-realtime-goals-plugin: ok")


check_step_limit()
asyncio.run(main())
