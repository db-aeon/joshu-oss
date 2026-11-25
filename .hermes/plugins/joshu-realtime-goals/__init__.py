"""Joshu realtime-goal admission hook, agent fallback tool, cron delivery guard, and step-limit hooks."""

from . import cron_guard, step_limit
from .tools import register as _register_tools


def register(ctx) -> None:
    _register_tools(ctx)
    cron_guard.register(ctx)
    step_limit.register(ctx)


__all__ = ["register"]
