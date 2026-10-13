"""프로젝트 API 키로 Langfuse의 읽기 전용 실행 단계만 조회한다."""

import base64
import json
import math
import re
from http.client import HTTPException
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from django.conf import settings
from django.utils.dateparse import parse_datetime
from django.utils.timezone import is_aware

PAGE_SIZE = 50
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
ID_PATTERN = r"[A-Za-z0-9_-]{1,128}"
CURSOR_PATTERN = r"[A-Za-z0-9+/=_-]{1,2048}"


class LangfuseUnavailable(Exception):
    pass


class NoTraceRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 다른 호스트로 프로젝트 키를 전달하거나 로그인 HTML을 결과로 읽지 않는다.
        return None


def read_page(params):
    base = settings.LANGFUSE_BASE_URL
    public, secret = settings.LANGFUSE_PUBLIC_KEY, settings.LANGFUSE_SECRET_KEY
    try:
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(char.isspace() for char in base)
            or any(
                not value
                or len(value) > 4096
                or any(char.isspace() or ord(char) < 32 or char == ":" for char in value)
                for value in (public, secret)
            )
        ):
            raise ValueError("Invalid trace configuration")
        _ = parsed.port  # 잘못된 포트도 요청 전에 거절한다.
        authorization = base64.b64encode(f"{public}:{secret}".encode()).decode()
        request = Request(
            base.rstrip("/") + "/api/public/v2/observations?" + urlencode(params),
            headers={"Authorization": "Basic " + authorization, "Accept": "application/json"},
            method="GET",
        )
        with build_opener(ProxyHandler({}), NoTraceRedirect()).open(request, timeout=5) as response:
            if response.status != 200:
                raise ValueError("Unexpected trace response")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Trace response too large")
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("meta"), dict):
            raise ValueError("Invalid trace response")
        rows, cursor = data.get("data"), data["meta"].get("cursor")
        if (
            not isinstance(rows, list)
            or len(rows) > PAGE_SIZE
            or (cursor is not None and not valid_id(cursor, CURSOR_PATTERN))
        ):
            raise ValueError("Invalid trace page")
        return rows, cursor
    except (URLError, OSError, HTTPException, ValueError, TypeError, RecursionError):
        # 원격 오류 본문·주소·자격 증명은 공개 응답이나 예외에 포함하지 않는다.
        raise LangfuseUnavailable from None


def valid_id(value, pattern=ID_PATTERN):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def timestamp(value, *, optional=False):
    if value is None and optional:
        return None
    parsed = parse_datetime(value) if isinstance(value, str) else None
    if parsed is None or not is_aware(parsed):
        raise ValueError("Invalid trace timestamp")
    return parsed.isoformat()


def text(value, *, optional=False, limit=1024):
    if value is None and optional:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid trace text")
    return value


def number(value):
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid trace metric")
    return value


def observation(row, *, detail=False):
    if not isinstance(row, dict) or not valid_id(row.get("id")) or not valid_id(row.get("traceId")):
        raise ValueError("Invalid trace identity")
    result = {
        "id": row["id"],
        "trace_id": row["traceId"],
        "name": text(row.get("name") or ""),
        "type": text(row["type"], limit=64),
        "started_at": timestamp(row.get("startTime")),
        "ended_at": timestamp(row.get("endTime"), optional=True),
        "level": text(row.get("level") or "DEFAULT", limit=64),
        "status_message": text(row.get("statusMessage"), optional=True, limit=16384),
        "model": text(row.get("model"), optional=True),
        "latency_seconds": number(row.get("latency")),
        "total_cost": number(row.get("totalCost")),
        "environment": text(row.get("environment"), optional=True),
    }
    if detail:
        parent = row.get("parentObservationId")
        usage = row.get("usageDetails")
        if parent is not None and not valid_id(parent):
            raise ValueError("Invalid parent observation")
        if usage is not None and (
            not isinstance(usage, dict)
            or len(usage) > 100
            or any(
                not isinstance(key, str) or len(key) > 128 or type(value) is not int or value < 0
                for key, value in usage.items()
            )
        ):
            raise ValueError("Invalid trace usage")
        metadata = row.get("metadata")
        # 메타데이터의 NaN/Infinity를 공개 JSON의 정상 값으로 내보내지 않는다.
        json.dumps(metadata, allow_nan=False)
        result.update(
            parent_observation_id=parent,
            input=text(row.get("input"), optional=True, limit=MAX_RESPONSE_BYTES),
            output=text(row.get("output"), optional=True, limit=MAX_RESPONSE_BYTES),
            metadata=metadata,
            usage_details=usage,
        )
    return result


def read_roots(*, from_time, to_time, name="", cursor=""):
    params = {
        "isRootObservation": "true",
        "fromStartTime": from_time.isoformat(),
        "toStartTime": to_time.isoformat(),
        "fields": "basic,model,usage,metrics",
        "limit": PAGE_SIZE,
    }
    if name:
        params["name"] = name
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = read_page(params)
    try:
        if any(row.get("isRootObservation") is not True for row in rows):
            raise ValueError("Unexpected non-root observation")
        results = [observation(row) for row in rows]
        if len({row["id"] for row in results}) != len(results):
            raise ValueError("Duplicate observation")
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        raise LangfuseUnavailable from None
    return {"results": results, "next_cursor": next_cursor}


def read_trace(trace_id, *, cursor=""):
    if not valid_id(trace_id):
        raise ValueError("Invalid trace ID")
    params = {
        "traceId": trace_id,
        "fields": "basic,model,usage,metrics,io,metadata",
        "limit": PAGE_SIZE,
    }
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = read_page(params)
    try:
        results = [observation(row, detail=True) for row in rows]
        if any(row["trace_id"] != trace_id for row in results) or len(
            {row["id"] for row in results}
        ) != len(results):
            raise ValueError("Unexpected trace observation")
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
        raise LangfuseUnavailable from None
    return {"trace_id": trace_id, "observations": results, "next_cursor": next_cursor}
