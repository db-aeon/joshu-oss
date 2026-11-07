#!/usr/bin/env python3
"""Slack group DM: the owner can address the companion by name.

In a Slack group DM (channel type `mpim`), the Hermes Slack adapter needs an
@mention before it takes a message, and a top-level @mention gets no earlier
messages of the group DM. On box clara (2026-10-21) the owner wrote "Clara,
please ..." in a group DM with a colleague and the companion. Hermes dropped
the message with a debug log only. Three hours later "@Clara please book this
meeting" reached the companion without the request above it (issue #170).

The patch changes three things in the Slack adapter:

1. A group DM message from the owner (a user in SLACK_ALLOWED_USERS) that
   addresses the companion by name counts as a mention. The name is the
   display name of the bot user or its Slack handle. "Addresses" means the
   message starts with the name ("Clara, ...", "Hi Clara: ...",
   "Clara please ..."), ends with it ("..., Clara?"), or has "@Clara" as plain
   text. A message that opens with an @mention of another person, a message
   from anyone else, and a channel message keep the mention rule.
2. A top-level mention in a group DM gets the last messages of the group DM
   (at most 10, from the last 6 hours) as channel context, the same way a
   thread reply gets the thread.
3. A group DM message from the owner that the mention rule drops is logged at
   INFO, so an audit can see it.

Idempotent. Target: $HERMES_DIR/plugins/platforms/slack/adapter.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARKER = "joshu-slack-group-dm-v1"
HERMES_DIR = Path(os.environ.get("HERMES_DIR", "/opt/hermes-agent")).resolve()
TARGET = HERMES_DIR / "plugins/platforms/slack/adapter.py"

# Module helpers, inserted before _slack_mention_detection_text.
HELPERS_ANCHOR = "def _slack_mention_detection_text(event: dict) -> str:\n"
HELPERS = '''# Joshu (joshu-slack-group-dm-v1): the owner can address the companion by
# name in a Slack group DM.
_JOSHU_GROUP_DM_HISTORY_LIMIT = 10
_JOSHU_GROUP_DM_HISTORY_SECONDS = 6 * 3600
_JOSHU_ADDRESS_LEAD = r"(?:(?:hi|hey|hello|ok|okay|so|and|also|dear|thanks|thank\\s+you)[\\s,!]+)?"
_JOSHU_ADDRESS_ASK = (
    r"(?:please|pls|plz|can\\s+you|could\\s+you|would\\s+you|will\\s+you|can\\s+we|"
    r"could\\s+we|do\\s+you|did\\s+you|is\\s+there|are\\s+there|what|when|where|who|how|why)\\b"
)


def _joshu_slack_owner_ids() -> set:
    """Slack user IDs of the owner: SLACK_ALLOWED_USERS of the box."""
    raw = os.getenv("SLACK_ALLOWED_USERS", "")
    return {part.strip() for part in raw.split(",") if part.strip()}


def _joshu_companion_name_variants(names) -> list:
    """Names the owner may use for the companion, longest first."""
    variants = set()
    for raw in names or ():
        name = re.sub(r"[\\s._-]+", " ", str(raw or "")).strip()
        if len(name) < 2 or re.fullmatch(r"U[A-Z0-9]+", name):
            continue
        variants.add(name)
        first = name.split(" ", 1)[0]
        if len(first) >= 3:
            variants.add(first)
    return sorted(variants, key=len, reverse=True)


def _joshu_text_addresses_companion(text: str, names) -> bool:
    """True when the message text speaks to the companion by name.

    A plain mention of the name in a sentence to someone else ("Mai, Clara
    will send it") does not count. A message that opens with an @mention of
    another person is addressed to that person.
    """
    raw = text or ""
    if re.match(r"\\s*<@", raw):
        return False
    # Drop Slack markup (links, other mentions) and keep plain words.
    plain = re.sub(r"<[^>]*>", " ", raw).strip()
    if not plain:
        return False
    for name in _joshu_companion_name_variants(names):
        pattern = r"\\s+".join(re.escape(part) for part in name.split(" "))
        start = (
            rf"^\\s*{_JOSHU_ADDRESS_LEAD}@?{pattern}"
            rf"(?:\\s*[,:;!?\\u2014\\u2013-]|\\s+{_JOSHU_ADDRESS_ASK}|\\s*$)"
        )
        end = rf",\\s*@?{pattern}\\s*[.!?]*\\s*$"
        anywhere = rf"(?<![\\w@])@{pattern}\\b"
        for rule in (start, end, anywhere):
            if re.search(rule, plain, re.IGNORECASE):
                return True
    return False


'''

# 1. Owner names the companion in a group DM.
WAKE_OLD = """        is_mentioned = bool(
            (bot_uid and f"<@{bot_uid}>" in routing_text)
            or self._slack_message_matches_mention_patterns(routing_text)
        )
"""
WAKE_NEW = WAKE_OLD + """        # Joshu (joshu-slack-group-dm-v1): in a group DM, an owner message
        # that addresses the companion by name counts as a mention.
        is_owner_group_dm = (
            channel_type == "mpim"
            and bool(user_id)
            and user_id in _joshu_slack_owner_ids()
        )
        if (
            not is_mentioned
            and is_owner_group_dm
            and bot_uid
            and _joshu_text_addresses_companion(
                original_text,
                await self._joshu_companion_names(bot_uid, channel_id, team_id),
            )
        ):
            is_mentioned = True
            logger.info(
                "[Slack] group DM: owner addressed the companion by name: channel=%s ts=%s",
                channel_id,
                ts,
            )
"""

# 3. Log a dropped owner message in a group DM.
DROP_OLD = """            elif not is_mentioned:
                if not await self._should_wake_on_unmentioned_message(
                    event_thread_ts=event_thread_ts,
                    channel_id=channel_id,
                    user_id=user_id,
                    team_id=team_id,
                    is_thread_reply=is_thread_reply,
                    chat_type="dm" if is_dm else "group",
                ):
                    return
"""
DROP_NEW = """            elif not is_mentioned:
                if not await self._should_wake_on_unmentioned_message(
                    event_thread_ts=event_thread_ts,
                    channel_id=channel_id,
                    user_id=user_id,
                    team_id=team_id,
                    is_thread_reply=is_thread_reply,
                    chat_type="dm" if is_dm else "group",
                ):
                    # Joshu (joshu-slack-group-dm-v1): an audit must see a
                    # dropped owner message in a group DM.
                    if is_owner_group_dm:
                        logger.info(
                            "[Slack] group DM: owner message not addressed to the companion, ignored: "
                            "channel=%s ts=%s",
                            channel_id,
                            ts,
                        )
                    return
"""

# 2. Recent group DM messages for a top-level mention.
HISTORY_OLD = """        # Determine message type
        msg_type = MessageType.TEXT
"""
HISTORY_NEW = """        # Joshu (joshu-slack-group-dm-v1): a top-level mention in a group DM
        # gets the recent messages of the group DM, like a thread reply gets
        # the thread.
        if (
            channel_context is None
            and channel_type == "mpim"
            and is_mentioned
            and not is_thread_reply
            and not is_command_text
        ):
            channel_context = (
                await self._joshu_group_dm_history(channel_id, ts, team_id) or None
            )

""" + HISTORY_OLD

# Adapter methods, inserted before the mention gating section.
METHODS_ANCHOR = "    # ── Channel mention gating ─────────────────────────────────────────────\n"
METHODS = '''    # Joshu (joshu-slack-group-dm-v1) ─────────────────────────────────────

    async def _joshu_companion_names(self, bot_uid: str, channel_id: str, team_id: str) -> list:
        """Display name and Slack handle of the bot user of this workspace."""
        names = [
            self._team_bot_names.get(team_id, "") if team_id else "",
            getattr(self, "_bot_display_name", "") or "",
        ]
        try:
            names.append(
                await self._resolve_user_name(bot_uid, chat_id=channel_id, team_id=team_id)
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("[Slack] group DM: bot name lookup failed: %s", exc)
        return [name for name in names if name and name != bot_uid]

    async def _joshu_group_dm_history(self, channel_id: str, ts: str, team_id: str) -> str:
        """Recent messages of a group DM before ``ts`` as a context block."""
        try:
            oldest = f"{max(0.0, float(ts) - _JOSHU_GROUP_DM_HISTORY_SECONDS):.6f}"
        except (TypeError, ValueError):
            return ""
        try:
            client = self._get_client(channel_id, team_id=team_id)
            result = await client.conversations_history(
                channel=channel_id,
                latest=ts,
                oldest=oldest,
                inclusive=False,
                limit=_JOSHU_GROUP_DM_HISTORY_LIMIT,
            )
        except Exception as exc:
            logger.warning(
                "[Slack] group DM: history fetch failed: channel=%s error=%s",
                channel_id,
                exc,
            )
            return ""
        messages = result.get("messages") if isinstance(result, dict) else None
        if not messages:
            return ""
        # conversations.history lists the newest message first.
        ordered = sorted(messages, key=lambda msg: float(msg.get("ts") or 0))
        content, _ = await self._format_thread_context(
            ordered,
            thread_ts="",
            current_ts=ts,
            team_id=team_id,
            channel_id=channel_id,
        )
        return content.replace(
            "[Thread context — prior messages in this thread",
            "[Group DM context — recent messages in this group DM",
            1,
        )

'''


def main() -> int:
    if not TARGET.is_file():
        print(f"[slack-group-dm] skip: missing {TARGET}", file=sys.stderr)
        return 0

    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print(f"[slack-group-dm] already applied ({TARGET})")
        return 0

    for label, old in (
        ("helpers anchor", HELPERS_ANCHOR),
        ("mention check", WAKE_OLD),
        ("unmentioned drop", DROP_OLD),
        ("message type", HISTORY_OLD),
        ("mention gating section", METHODS_ANCHOR),
    ):
        if text.count(old) != 1:
            print(f"[slack-group-dm] error: {label} not found once in {TARGET}", file=sys.stderr)
            return 1

    text = text.replace(HELPERS_ANCHOR, HELPERS + HELPERS_ANCHOR, 1)
    text = text.replace(WAKE_OLD, WAKE_NEW, 1)
    text = text.replace(DROP_OLD, DROP_NEW, 1)
    text = text.replace(HISTORY_OLD, HISTORY_NEW, 1)
    text = text.replace(METHODS_ANCHOR, METHODS + METHODS_ANCHOR, 1)
    TARGET.write_text(text, encoding="utf-8")
    print(f"[slack-group-dm] patched {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
