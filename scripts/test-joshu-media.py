#!/usr/bin/env python3
"""Tests of the Hermes plugin joshu-media (change content-router, task 5.1).

The image provider and the video provider `joshu` post to a fake Joshu API. The test checks the
request for an image and a video, with and without a provider endpoint, the answer shape of
Hermes, and the error of an empty usage wallet.

With HERMES_AGENT_DIR set to a Hermes checkout, the test uses the real provider base classes of
Hermes (agent/image_gen_provider.py and agent/video_gen_provider.py). Without it (CI), the test
uses small stand-ins with the same names and signatures.
"""

from __future__ import annotations

import abc
import importlib
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def install_stand_ins() -> None:
    """Small stand-ins for agent.image_gen_provider and agent.video_gen_provider of Hermes."""
    agent = types.ModuleType("agent")
    agent.__path__ = []  # a package

    def success(kind):
        def fn(*, model, prompt, provider, extra=None, **fields):
            payload = {"success": True, "model": model, "prompt": prompt, "provider": provider, **fields}
            for k, v in (extra or {}).items():
                payload.setdefault(k, v)
            return payload

        return fn

    def error(kind):
        def fn(*, error, error_type="provider_error", provider="", model="", prompt="", aspect_ratio=""):
            return {"success": False, kind: None, "error": error, "error_type": error_type, "model": model, "prompt": prompt, "aspect_ratio": aspect_ratio, "provider": provider}

        return fn

    image = types.ModuleType("agent.image_gen_provider")

    class ImageGenProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self): ...

        @abc.abstractmethod
        def generate(self, prompt, aspect_ratio="landscape", **kwargs): ...

    image.ImageGenProvider = ImageGenProvider
    image.DEFAULT_ASPECT_RATIO = "landscape"
    image.resolve_aspect_ratio = lambda v: v if v in ("landscape", "square", "portrait") else "landscape"
    image.success_response = success("image")
    image.error_response = error("image")

    video = types.ModuleType("agent.video_gen_provider")

    class VideoGenProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self): ...

        @abc.abstractmethod
        def generate(self, prompt, **kwargs): ...

    video.VideoGenProvider = VideoGenProvider
    video.COMMON_ASPECT_RATIOS = ("16:9", "9:16", "1:1")
    video.COMMON_RESOLUTIONS = ("480p", "720p", "1080p")
    video.DEFAULT_ASPECT_RATIO = "16:9"
    video.DEFAULT_RESOLUTION = "720p"
    video.success_response = success("video")
    video.error_response = error("video")
    sys.modules.update({"agent": agent, "agent.image_gen_provider": image, "agent.video_gen_provider": video})


hermes_dir = os.environ.get("HERMES_AGENT_DIR", "").strip()
if hermes_dir:
    sys.path.insert(0, hermes_dir)
    source = "the real Hermes base classes"
else:
    install_stand_ins()
    source = "stand-ins of the Hermes base classes"

SEEN: list[dict] = []


class FakeJoshuApi(BaseHTTPRequestHandler):
    def log_message(self, *args):  # no output
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        SEEN.append({"path": self.path, "body": body})
        if body.get("prompt") == "empty wallet":
            status, answer = 402, {"ok": False, "error": "router call auto: the usage wallet is empty", "kind": "usage wallet empty"}
        else:
            kind = body["kind"]
            name = "image-20261101-120000-abc123.png" if kind == "image" else "video-20261101-120000-abc123.mp4"
            status, answer = 200, {
                "ok": True,
                "path": f"/home/owner/Desktop/{name}",
                "desktopPath": name,
                "url": "https://fal.media/files/x",
                "endpoint": body.get("endpoint") or f"fal.{kind}.default",
                "channel": "fal",
                "costUsd": 0.04,
            }
        raw = json.dumps(answer).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    server = HTTPServer(("127.0.0.1", 0), FakeJoshuApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ["JOSHU_API_BASE_URL"] = f"http://127.0.0.1:{server.server_address[1]}/joshu"
    sys.path.insert(0, str(REPO / ".hermes" / "plugins"))
    try:
        plugin = importlib.import_module("joshu-media")
        from agent.image_gen_provider import ImageGenProvider
        from agent.video_gen_provider import VideoGenProvider

        registered = {}

        class Ctx:
            def register_image_gen_provider(self, provider):
                registered["image"] = provider

            def register_video_gen_provider(self, provider):
                registered["video"] = provider

        plugin.register(Ctx())
        image, video = registered["image"], registered["video"]
        assert isinstance(image, ImageGenProvider) and isinstance(video, VideoGenProvider)
        assert image.name == video.name == "joshu"
        if hermes_dir:
            assert image.default_model() == video.default_model() == "auto"
        print("ok register: image provider and video provider joshu")

        # Image without a provider endpoint: the content router picks with auto.
        out = image.generate("a red bicycle", "square")
        assert SEEN[-1] == {"path": "/joshu/api/router/media", "body": {"kind": "image", "prompt": "a red bicycle", "options": {"aspect_ratio": "square"}}}, SEEN[-1]
        assert out["success"] is True and out["image"] == "/home/owner/Desktop/image-20261101-120000-abc123.png", out
        assert out["provider"] == "joshu" and out["model"] == "fal.image.default" and out["cost_usd"] == 0.04
        # Image with a provider endpoint (image_gen.model in the Hermes configuration).
        image.generate("a red bicycle", "portrait", model="fal.image.nano-banana-pro")
        assert SEEN[-1]["body"] == {"kind": "image", "prompt": "a red bicycle", "endpoint": "fal.image.nano-banana-pro", "options": {"aspect_ratio": "portrait"}}
        image.generate("a red bicycle", model="auto")
        assert "endpoint" not in SEEN[-1]["body"]
        print("ok image request with and without a provider endpoint")

        # Video without and with a provider endpoint (argument model of video_generate).
        out = video.generate("a red bicycle in the rain", model="auto", duration=5, aspect_ratio="9:16", resolution="720p", _model_override_explicit=False)
        assert SEEN[-1]["body"] == {"kind": "video", "prompt": "a red bicycle in the rain", "options": {"duration": 5, "aspect_ratio": "9:16", "resolution": "720p"}}, SEEN[-1]
        assert out["success"] is True and out["video"].endswith(".mp4") and out["duration"] == 5
        video.generate("a red bicycle in the rain", model="fal.video.seedance-2-pro", image_url="https://x/first.png", _model_override_explicit=True)
        body = SEEN[-1]["body"]
        assert body["endpoint"] == "fal.video.seedance-2-pro" and body["options"]["image_url"] == "https://x/first.png"
        print("ok video request with and without a provider endpoint")

        # An empty usage wallet.
        out = video.generate("empty wallet")
        assert out["success"] is False and out["error_type"] == "usage_wallet_empty" and "usage billing" in out["error"], out
        out = image.generate("empty wallet")
        assert out["success"] is False and out["error_type"] == "usage_wallet_empty"
        print("ok empty usage wallet gives a clear error")
        print(f"joshu-media: all tests passed ({source})")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
