"""Joshu realtime-goal admission hook, agent fallback tool, and cron delivery guard."""

from . import cron_guard
from .tools import register as _register_tools


def register(ctx) -> None:
    _register_tools(ctx)
    cron_guard.register(ctx)


__all__ = ["register"]
