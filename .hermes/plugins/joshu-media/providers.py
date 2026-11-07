"""Image provider and video provider `joshu` for Hermes (change content-router, design decision D7).

Each provider posts the prompt, the options, and an optional provider endpoint to
`POST /api/router/media` of the Joshu API on localhost. The Joshu API calls the content router
with capability `image.generate` or `video.generate`, waits for the result, saves the file on the
Desktop of the owner, and returns its path. The box holds no fal.ai key for this.

The gateway sync of the Joshu API turns this plugin and the provider `joshu` on and off with the
toolset of the content router (`mcp-joshu-router`). This module writes nothing to stdout.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO as IMAGE_DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response as image_error,
    resolve_aspect_ratio,
    success_response as image_success,
)
from agent.video_gen_provider import (
    COMMON_ASPECT_RATIOS,
    COMMON_RESOLUTIONS,
    DEFAULT_ASPECT_RATIO as VIDEO_DEFAULT_ASPECT_RATIO,
    DEFAULT_RESOLUTION,
    VideoGenProvider,
    error_response as video_error,
    success_response as video_success,
)

logger = logging.getLogger(__name__)

PROVIDER_NAME = "joshu"
# The content router picks the provider endpoint when the request names none.
AUTO_MODEL = "auto"
# The Joshu API waits for the content router: an image takes seconds, a video can take minutes.
IMAGE_TIMEOUT_SECONDS = 4 * 60
VIDEO_TIMEOUT_SECONDS = 11 * 60


def _api_base() -> str:
    return os.environ.get("JOSHU_API_BASE_URL", "http://127.0.0.1:8788/joshu").rstrip("/")


def _post_media(body: Dict[str, Any], timeout: int) -> tuple[int, Dict[str, Any]]:
    """POST to the media route of the Joshu API. Returns the status and the JSON answer."""
    req = urllib.request.Request(
        f"{_api_base()}/api/router/media",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail) if detail else {}
        except json.JSONDecodeError:
            parsed = {"error": detail or f"HTTP {err.code}"}
        return err.code, parsed
    except (urllib.error.URLError, TimeoutError) as err:
        return 599, {"error": f"Joshu API not reachable: {err}"}


def _endpoint(model: Optional[str]) -> Optional[str]:
    """The provider endpoint that the request names, or None for `auto`."""
    value = (model or "").strip()
    return value if value and value != AUTO_MODEL else None


def _request(kind: str, prompt: str, model: Optional[str], options: Dict[str, Any]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"kind": kind, "prompt": prompt, "options": {k: v for k, v in options.items() if v is not None}}
    endpoint = _endpoint(model)
    if endpoint:
        body["endpoint"] = endpoint
    return body


def _error_text(status: int, data: Dict[str, Any]) -> tuple[str, str]:
    kind = str(data.get("kind") or "")
    if status == 402 or kind == "usage wallet empty":
        return (
            "The usage wallet of the owner is empty. The owner can add money on the usage billing page of their Joshu account.",
            "usage_wallet_empty",
        )
    return str(data.get("error") or f"HTTP {status}"), "provider_error"


class JoshuImageGenProvider(ImageGenProvider):
    """Images through the Joshu content router."""

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "Joshu content router"

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": AUTO_MODEL, "display": "Auto (the content router picks)", "price": "provider price plus the router markup"}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {"name": self.display_name, "badge": "usage wallet", "tag": "Images through the Joshu content router", "env_vars": []}

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text"], "max_reference_images": 0}

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = IMAGE_DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        aspect = resolve_aspect_ratio(aspect_ratio)
        model = kwargs.get("model")
        body = _request("image", prompt, model, {"aspect_ratio": aspect})
        status, data = _post_media(body, IMAGE_TIMEOUT_SECONDS)
        endpoint = body.get("endpoint", AUTO_MODEL)
        if status >= 400 or not data.get("ok"):
            error, error_type = _error_text(status, data)
            return image_error(error=error, error_type=error_type, provider=PROVIDER_NAME, model=endpoint, prompt=prompt, aspect_ratio=aspect)
        return image_success(
            image=str(data.get("path")),
            model=str(data.get("endpoint") or endpoint),
            prompt=prompt,
            aspect_ratio=aspect,
            provider=PROVIDER_NAME,
            extra={"desktop_path": data.get("desktopPath"), "cost_usd": data.get("costUsd")},
        )


class JoshuVideoGenProvider(VideoGenProvider):
    """Videos through the Joshu content router."""

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def display_name(self) -> str:
        return "Joshu content router"

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": AUTO_MODEL, "display": "Auto (the content router picks)", "modalities": ["text", "image"]}]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {"name": self.display_name, "badge": "usage wallet", "tag": "Videos through the Joshu content router", "env_vars": []}

    def capabilities(self) -> Dict[str, Any]:
        return {
            "modalities": ["text", "image"],
            "aspect_ratios": list(COMMON_ASPECT_RATIOS),
            "resolutions": list(COMMON_RESOLUTIONS),
            "max_duration": 15,
            "min_duration": 1,
            "supports_audio": True,
            "supports_negative_prompt": True,
            "max_reference_images": 0,
        }

    def generate(
        self,
        prompt: str,
        *,
        model: Optional[str] = None,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        duration: Optional[int] = None,
        aspect_ratio: str = VIDEO_DEFAULT_ASPECT_RATIO,
        resolution: str = DEFAULT_RESOLUTION,
        negative_prompt: Optional[str] = None,
        audio: Optional[bool] = None,
        seed: Optional[int] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        options = {
            "image_url": image_url,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "negative_prompt": negative_prompt,
            "audio": audio,
            "seed": seed,
        }
        body = _request("video", prompt, model, options)
        status, data = _post_media(body, VIDEO_TIMEOUT_SECONDS)
        endpoint = body.get("endpoint", AUTO_MODEL)
        modality = "image" if image_url else "text"
        if status >= 400 or not data.get("ok"):
            error, error_type = _error_text(status, data)
            return video_error(error=error, error_type=error_type, provider=PROVIDER_NAME, model=endpoint, prompt=prompt, aspect_ratio=aspect_ratio)
        return video_success(
            video=str(data.get("path")),
            model=str(data.get("endpoint") or endpoint),
            prompt=prompt,
            modality=modality,
            aspect_ratio=aspect_ratio,
            duration=duration or 0,
            provider=PROVIDER_NAME,
            extra={"desktop_path": data.get("desktopPath"), "cost_usd": data.get("costUsd")},
        )


def register(ctx) -> None:
    """Plugin entry point: register the image provider and the video provider `joshu`."""
    ctx.register_image_gen_provider(JoshuImageGenProvider())
    ctx.register_video_gen_provider(JoshuVideoGenProvider())
