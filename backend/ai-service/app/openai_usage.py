"""요청마다 OpenAI 호출의 모델·처리 등급·토큰을 모아 Core에 응답 헤더로 돌려준다.

공유 OpenAI HTTP 클라이언트의 응답 훅이 Responses·Chat Completions·Embeddings 응답 본문의 ``usage``를 읽어 지금 요청의 목록에
더하고, ASGI 미들웨어가 응답을 보내기 직전에 (모델, 처리 등급)별 합계를 ``X-GovBiz-OpenAI-Usage`` 헤더(JSON)로 붙인다.
스트리밍 호출은 없어 본문을 미리 읽어도 SDK가 같은 본문을 그대로 쓴다. 비용 계산과 저장은 Core가 맡는다.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, MutableMapping
from contextvars import ContextVar
from typing import Any

import httpx
from openai import DefaultAsyncHttpxClient

USAGE_HEADER = "x-govbiz-openai-usage"
_USAGE_PATHS = ("/responses", "/chat/completions", "/embeddings")
_calls: ContextVar[list[dict[str, Any]] | None] = ContextVar("openai_usage_calls", default=None)
logger = logging.getLogger(__name__)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


def usage_http_client() -> httpx.AsyncClient:
    """OpenAI SDK 기본 설정에 사용량 수집 훅만 더한 HTTP 클라이언트."""
    return DefaultAsyncHttpxClient(event_hooks={"response": [record_openai_usage]})


async def record_openai_usage(response: httpx.Response) -> None:
    """성공한 OpenAI 응답의 사용량을 지금 요청 목록에 더한다. 요청 밖의 호출과 사용량이 없는 응답은 건너뛴다."""
    calls = _calls.get()
    if calls is None or response.status_code != 200 or not response.request.url.path.endswith(_USAGE_PATHS):
        return
    if not response.headers.get("content-type", "").startswith("application/json"):
        return
    await response.aread()
    try:
        call = usage_of(response.json())
    except ValueError:
        call = None
    if call is None:
        logger.warning("openai_usage_missing path=%s", response.request.url.path)
        return
    calls.append(call)


def usage_of(body: Any) -> dict[str, Any] | None:
    """입력에 포함된 캐시 읽기·쓰기를 구분한다. 쓰기 미보고는 0이 아닌 미확정으로 보낸다."""
    if not isinstance(body, dict) or not isinstance(body.get("usage"), dict) or not isinstance(body.get("model"), str):
        return None
    usage = body["usage"]
    if "input_tokens" in usage:  # Responses
        input_tokens, output_tokens = usage.get("input_tokens"), usage.get("output_tokens", 0)
        details = usage.get("input_tokens_details") or {}
    else:  # Chat Completions, Embeddings
        input_tokens, output_tokens = usage.get("prompt_tokens"), usage.get("completion_tokens", 0)
        details = usage.get("prompt_tokens_details") or {}
    if not isinstance(details, dict):
        return None
    reported_cached = details.get("cached_tokens")
    cached = 0 if reported_cached is None else reported_cached
    values = (input_tokens, cached, output_tokens or 0)
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in values):
        return None
    if cached > input_tokens:
        return None
    embedding = body.get("object") == "list" and body["model"].startswith("text-embedding-")
    cache_write = details.get("cache_write_tokens")
    cache_write_12h = None
    if cache_write is not None:
        if not isinstance(cache_write, int) or isinstance(cache_write, bool) or not 0 <= cache_write <= input_tokens - cached:
            return None
        # Responses/Chat은 현재 30m TTL만 지원하며 이 값은 일반 입력과 중복 과금하지 않는다.
        # 응답에 알 수 없는 TTL이 추가되면 임의로 30m 가격을 적용하지 않는다.
        options = body.get("prompt_cache_options") or {}
        if isinstance(options, dict) and options.get("ttl") in (None, "30m"):
            cache_write_12h = 0
        else:
            cache_write = None
    elif embedding:
        # Embeddings는 프롬프트 캐시를 사용하지 않는다.
        cache_write, cache_write_12h = 0, 0
    if not embedding and reported_cached is None:
        # 기존 읽기 합계 계약은 유지하되, 읽기 미보고를 완전한 토큰 분할로 가격 계산하지 않게 한다.
        cache_write, cache_write_12h = None, None
    tier = body.get("service_tier")
    return {
        "model": body["model"],
        "serviceTier": tier if isinstance(tier, str) and tier else "default",
        "inputTokens": values[0],
        "cachedInputTokens": cached,
        "cacheWriteInputTokens": cache_write,
        "cacheWrite12hInputTokens": cache_write_12h,
        "outputTokens": values[2],
    }


def usage_header(calls: list[dict[str, Any]]) -> str:
    """(모델, 처리 등급)별 호출 수와 토큰 합계를 짧은 JSON 배열로 만든다."""
    totals: dict[tuple[str, str], dict[str, Any]] = {}
    for call in calls:
        key = (call["model"], call["serviceTier"])
        total = totals.setdefault(key, {
            "model": key[0], "serviceTier": key[1], "calls": 0, "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0,
            "cacheWriteInputTokens": 0, "cacheWrite12hInputTokens": 0,
        })
        total["calls"] += 1
        for name in ("inputTokens", "cachedInputTokens", "outputTokens"):
            total[name] += call[name]
        for name in ("cacheWriteInputTokens", "cacheWrite12hInputTokens"):
            value = call.get(name)
            total[name] = total[name] + value if total[name] is not None and value is not None else None
    return json.dumps(list(totals.values()), separators=(",", ":"), ensure_ascii=True)


class OpenAIUsageMiddleware:
    """HTTP 요청마다 사용량 목록을 열고, 응답 머리에 그 요청이 쓴 OpenAI 사용량 헤더를 붙인다."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        calls: list[dict[str, Any]] = []
        token = _calls.set(calls)

        async def send_with_usage(message: Message) -> None:
            if message["type"] == "http.response.start" and calls:
                headers = list(message.get("headers", []))
                headers.append((USAGE_HEADER.encode("ascii"), usage_header(calls).encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_usage)
        finally:
            _calls.reset(token)
