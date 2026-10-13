"""현재 GovBiz 관리자에게만 Langfuse 실행 추적을 읽기 전용으로 제공한다."""

from datetime import timedelta

from django.utils import timezone
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .trace_client import CURSOR_PATTERN, LangfuseUnavailable, read_roots, read_trace, valid_id


class TraceCursorSerializer(serializers.Serializer):
    cursor = serializers.RegexField(
        r"\A" + CURSOR_PATTERN + r"\Z",
        max_length=2048,
        required=False,
        default="",
        allow_blank=True,
        trim_whitespace=False,
    )


class TraceListSerializer(TraceCursorSerializer):
    name = serializers.CharField(max_length=200, required=False, default="", allow_blank=True)
    from_time = serializers.DateTimeField(required=False)
    to_time = serializers.DateTimeField(required=False)

    def validate(self, attrs):
        if ("from_time" in attrs) != ("to_time" in attrs):
            raise serializers.ValidationError("조회 시작과 종료 시각을 함께 지정하세요.")
        if "from_time" not in attrs:
            if attrs["cursor"]:
                raise serializers.ValidationError("다음 페이지는 기존 조회 기간이 필요합니다.")
            attrs["to_time"] = timezone.now()
            attrs["from_time"] = attrs["to_time"] - timedelta(days=7)
        if not timedelta(0) < attrs["to_time"] - attrs["from_time"] <= timedelta(days=30):
            raise serializers.ValidationError("조회 기간은 0일 초과 30일 이하여야 합니다.")
        return attrs


def unavailable():
    return Response(
        {
            "code": "LANGFUSE_TRACES_UNAVAILABLE",
            "detail": "AI 실행 추적 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.",
        },
        status=503,
    )


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_traces(request):
    query = TraceListSerializer(data=request.query_params)
    query.is_valid(raise_exception=True)
    params = query.validated_data
    try:
        page = read_roots(**params)
    except LangfuseUnavailable:
        return unavailable()
    return Response(
        {
            **page,
            "from_time": params["from_time"].isoformat(),
            "to_time": params["to_time"].isoformat(),
        }
    )


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_trace_detail(request, trace_id):
    if not valid_id(trace_id):
        return Response({"code": "INVALID_TRACE_ID"}, status=400)
    query = TraceCursorSerializer(data=request.query_params)
    query.is_valid(raise_exception=True)
    cursor = query.validated_data["cursor"]
    try:
        page = read_trace(trace_id, cursor=cursor)
    except LangfuseUnavailable:
        return unavailable()
    if not page["observations"] and not cursor:
        return Response(
            {"code": "TRACE_NOT_FOUND", "detail": "실행 추적을 찾을 수 없습니다."}, status=404
        )
    return Response(page)
