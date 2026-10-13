import re
from urllib.parse import urlencode

from django.conf import settings
from django.http import Http404, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_http_methods
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .admission import AdmissionUnavailable
from .budget import BudgetUnavailable
from .catalog import DATASETS, public_datasets, selection
from .models import EvaluationRun
from .prefect_client import PrefectUnavailable, read_logs
from .quality import assess, save_fixture_review
from .rag_material import read_material as read_rag_material
from .rag_quality import assess as assess_rag_quality
from .rag_reference_reviews import save_reference_review as save_rag_reference_review
from .rag_reviews import review_state as rag_review_state
from .rag_reviews import save_review as save_rag_review
from .recovery import recovery_state, submit_recovery
from .reviews import (
    baseline_choices,
    clear_baseline,
    promote_baseline,
    review_material,
    review_state,
    save_case_review,
    save_review,
)
from .services import (
    DATASET_ID,
    PENDING_SYNC,
    RequestConflict,
    ResultsUnavailable,
    cancel_run,
    read_result,
    submit_run,
    sync_run,
)

ERROR_MESSAGES = {
    "PREFECT_CANCEL_UNCONFIRMED": (
        "취소 요청은 저장됐지만 실행 종료를 확인하지 못했습니다. 상태를 다시 확인합니다."
    ),
    "EXECUTION_SPEC_REQUIRED": (
        "과거 요청에는 실행 명세가 없습니다. 접수 이력을 확인한 뒤 새 요청으로 실행하세요."
    ),
    "EXECUTION_SPEC_MISMATCH": (
        "접수 당시 명세와 실행 환경이 달라 모델 호출 전에 차단했습니다. 실행기 버전을 확인하세요."
    ),
    "PREFECT_DISPATCH_UNCONFIRMED": (
        "실행 접수를 확인하지 못했습니다. 같은 요청으로 접수를 다시 확인하세요."
    ),
    "PREFECT_STATUS_UNAVAILABLE": (
        "실행 서버에 연결할 수 없습니다. 마지막으로 확인한 상태를 표시합니다."
    ),
    "RESULTS_UNAVAILABLE": (
        "작업은 종료됐지만 결과 파일을 확인할 수 없습니다. 결과 저장소를 확인하세요."
    ),
    "EVALUATION_FAILED": "평가 작업이 실패했습니다. Prefect 로그에서 실패 단계를 확인하세요.",
    "EVALUATION_CRASHED": "평가 실행 프로세스가 중단됐습니다. Prefect 로그를 확인하세요.",
    "EVALUATION_CANCELLED": "평가 실행이 취소됐습니다.",
}


@never_cache
@api_view(["GET"])
@permission_classes([AllowAny])
def api_session(request):
    operator = request.user.is_authenticated
    baselines = baseline_choices() if operator else {}
    try:
        datasets = public_datasets() if operator else []
    except (ResultsUnavailable, OSError, ValueError):
        return Response(
            {
                "code": "VECTOR_CACHE_UNAVAILABLE",
                "detail": "평가 벡터 저장소를 확인하지 못했습니다. 잠시 후 다시 조회하세요.",
            },
            status=503,
        )
    return Response(
        {
            "user": {
                "id": request.user.get_username(),
                "username": request.user.email or request.user.get_username(),
            }
            if operator
            else None,
            "csrf_token": get_token(request),
            "datasets": [
                {
                    **item,
                    "selection_guide": DATASETS.get(item["id"], {}).get("selection_guide"),
                    "baseline": baselines.get(item["id"]),
                }
                for item in datasets
            ]
            if operator
            else [],
            "live_enabled": settings.LLMOPS_LIVE_ENABLED if operator else False,
            "rag_live_enabled": settings.LLMOPS_LIVE_ENABLED and settings.LLMOPS_RAG_LIVE_ENABLED
            if operator
            else False,
            "search_traces_url": f"{settings.OPS_WEB_URL}/ops/traces" if operator else None,
        }
    )


@require_http_methods(["GET"])
def web_redirect(request, run_id=None):
    # 기존 Django 화면의 북마크만 React로 옮긴다. 사용자 입력 URL로 리다이렉트하지 않는다.
    path = f"/ops/evaluations/{run_id}" if run_id else "/ops/evaluations"
    return redirect(settings.OPS_WEB_URL + path)


class RunRequestSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()
    dataset_id = serializers.ChoiceField(choices=list(DATASETS))
    candidate_capture_id = serializers.CharField(max_length=100, default=DATASET_ID)
    reference_capture_id = serializers.CharField(max_length=100, default=DATASET_ID)
    execution_mode = serializers.ChoiceField(choices=["replay", "live"], default="replay")
    live_config = serializers.JSONField(default=dict)
    confirm_paid_run = serializers.BooleanField(default=False)

    baseline_version = serializers.IntegerField(min_value=1, allow_null=True, default=None)
    execution_profile = serializers.RegexField(r"^[a-f0-9]{64}$", allow_null=True, default=None)


def run_data(run, viewer_id=None):
    # 저장 캡처 점수에는 trace가 없어 session 상세가 존재하지 않을 수 있다.
    # Langfuse 4.46 UI의 점수 필터 계약을 사용하고 기본 1일 범위를 해제한다.
    score_query = urlencode(
        {
            "filter": f"sessionId;string;;contains;{run.evaluation_run_id}",
            "dateRange": f"0-{int((run.finished_at or timezone.now()).timestamp() * 1000)}",
        }
    )
    return {
        "id": str(run.id),
        "dataset_id": run.dataset_id,
        "dataset_label": DATASETS[run.dataset_id]["label"],
        "candidate_capture_id": run.candidate_capture_id,
        "reference_capture_id": run.reference_capture_id,
        "baseline_version": run.baseline_version,
        "baseline_review_id": run.baseline_review_id,
        "candidate_label": selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )[1]["label"],
        "reference_label": selection(
            run.dataset_id, run.candidate_capture_id, run.reference_capture_id
        )[2]["label"],
        "comparison": run.comparison or None,
        "execution_mode": run.execution_mode,
        "evaluation_scope": run.execution_spec.get("evaluation_scope", run.comparison.get("scope")),
        "source_run_id": str(run.source_run_id) if run.source_run_id else None,
        "live_config": run.live_config or None,
        "execution_profile": run.execution_spec.get("profile_sha256"),
        "execution_spec_sha256": run.execution_spec_sha256 or None,
        "execution_spec": run.execution_spec or None,
        "requested_by": run.requested_by.email or run.requested_by.get_username(),
        "requested_by_id": run.requested_by.get_username(),
        "can_retry": bool(run.execution_spec)
        and run.prefect_flow_run_id is None
        and run.requested_by_id == viewer_id
        and run.cancel_requested_at is None
        and run.status in {"REQUESTED", "QUEUED", "RUNNING"},
        "can_cancel": run.requested_by_id == viewer_id
        and run.cancel_requested_at is None
        and run.status in {"REQUESTED", "QUEUED", "RUNNING", "CANCELLING"},
        "cancel_requested_at": run.cancel_requested_at,
        "cancel_requested_by": (
            run.cancel_requested_by.email or run.cancel_requested_by.get_username()
            if run.cancel_requested_by_id
            else None
        ),
        "status": run.status,
        "status_label": run.get_status_display(),
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "synced_at": run.synced_at,
        "sync_attempted_at": run.sync_attempted_at,
        "status_stale": run.status in PENDING_SYNC
        and (timezone.now() - (run.synced_at or run.created_at)).total_seconds() > 60,
        "error_code": run.error_code,
        "error_message": ERROR_MESSAGES.get(run.error_code, ""),
        "summary": run.summary,
        "model_api_calls": run.model_api_calls,
        "trace_links": [
            {
                "case_id": case["case_id"],
                "url": f"{settings.OPS_WEB_URL}/ops/traces/{case['candidate']['trace_id']}",
            }
            for case in run.comparison.get("cases", [])
            if re.fullmatch(r"[a-f0-9]{32}", case["candidate"].get("trace_id") or "")
        ],
        "evaluation_run_id": run.evaluation_run_id or None,
        "prefect_flow_run_id": str(run.prefect_flow_run_id) if run.prefect_flow_run_id else None,
        "prefect_url": (
            f"{settings.PREFECT_UI_URL}/v2/runs/flow-run/{run.prefect_flow_run_id}"
            if run.prefect_flow_run_id
            else None
        ),
        "langfuse_url": (
            f"{settings.LANGFUSE_PROJECT_URL}/scores?{score_query}"
            if run.evaluation_run_id
            and (
                run.execution_mode == "replay"
                or (
                    run.execution_mode == "recovery"
                    and not any(
                        case["candidate"].get("trace_id")
                        for case in run.comparison.get("cases", [])
                    )
                )
            )
            else None
        ),
        "report_url": (
            reverse("evaluation-report", args=[run.id]) if run.status == "COMPLETED" else None
        ),
        "detail_url": f"/ops/evaluations/{run.id}",
    }


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_runs(request):
    if request.method == "GET":
        paginator = PageNumberPagination()
        paginator.page_size = 25
        runs = paginator.paginate_queryset(
            EvaluationRun.objects.select_related("requested_by"), request
        )
        return paginator.get_paginated_response([run_data(run, request.user.pk) for run in runs])
    serializer = RunRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        run, created = submit_run(request.user, **serializer.validated_data)
    except AdmissionUnavailable as error:
        return Response({"code": error.code}, status=503)
    except BudgetUnavailable:
        return Response({"code": "LIVE_BUDGET_UNAVAILABLE"}, status=400)
    except RequestConflict:
        return Response({"code": "REQUEST_CONFLICT"}, status=409)
    except ValueError:
        return Response({"code": "INVALID_REFERENCE"}, status=400)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    # 응답 유실 가능성이 있으므로 접수 불확실을 실패/완료로 숨기지 않는다.
    status = (
        200
        if run.cancel_requested_at
        else 503
        if run.prefect_flow_run_id is None
        else (202 if created else 200)
    )
    return Response(run_data(run, request.user.pk), status=status)


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_run_detail(request, run_id):
    run = get_object_or_404(EvaluationRun.objects.select_related("requested_by"), pk=run_id)
    sync_run(run)
    return Response({**run_data(run, request.user.pk), "postprocessing": recovery_state(run)})


class RunLogsQuerySerializer(serializers.Serializer):
    offset = serializers.IntegerField(min_value=0, default=0)


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_run_logs(request, run_id):
    query = RunLogsQuerySerializer(data=request.query_params)
    query.is_valid(raise_exception=True)
    run = get_object_or_404(EvaluationRun, pk=run_id)
    if run.prefect_flow_run_id is None:
        return Response({"code": "PREFECT_RUN_NOT_SUBMITTED"}, status=409)
    try:
        logs = read_logs(run.prefect_flow_run_id, query.validated_data["offset"])
    except PrefectUnavailable:
        return Response({"code": "PREFECT_LOGS_UNAVAILABLE"}, status=503)
    return Response(
        {"run_id": str(run.id), "prefect_flow_run_id": str(run.prefect_flow_run_id), **logs}
    )


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_rag_material(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    try:
        return Response(read_rag_material(run))
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)


class RagReviewRequestSerializer(serializers.Serializer):
    case_id = serializers.CharField(max_length=100)
    retrieval_decision = serializers.ChoiceField(choices=["SUITABLE", "UNSUITABLE", "DEFERRED"])
    answer_decision = serializers.ChoiceField(choices=["SUITABLE", "UNSUITABLE", "DEFERRED"])
    citation_decision = serializers.ChoiceField(choices=["SUITABLE", "UNSUITABLE", "DEFERRED"])
    comment = serializers.CharField(max_length=3000, allow_blank=False)
    material_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    rubric_version = serializers.CharField(max_length=40)
    review_version = serializers.IntegerField(min_value=0)


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_rag_reviews(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    try:
        if request.method == "POST":
            serializer = RagReviewRequestSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            save_rag_review(run, request.user, **serializer.validated_data)
        return Response(rag_review_state(run, request.user))
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    except ValueError:
        return Response({"code": "INVALID_RAG_REVIEW"}, status=400)


class RagReferenceRequestSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(
        choices=["APPROVED", "CHANGES_REQUESTED", "DEFERRED", "REVOKED"]
    )
    comment = serializers.CharField(max_length=3000, allow_blank=False)
    fixture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    case_ids = serializers.ListField(child=serializers.CharField(max_length=100), allow_empty=False)
    rubric_version = serializers.CharField(max_length=40)
    review_version = serializers.IntegerField(min_value=0)
    confirmed_all_cases = serializers.BooleanField()


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_rag_reference_review(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = RagReferenceRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        save_rag_reference_review(run, request.user, **serializer.validated_data)
        return Response(rag_review_state(run, request.user))
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    except ValueError:
        return Response({"code": "INVALID_RAG_REFERENCE_REVIEW"}, status=400)


class RagQualityRequestSerializer(serializers.Serializer):
    input_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class RagBaselineRequestSerializer(RagQualityRequestSerializer):
    assessment_id = serializers.IntegerField(min_value=1)
    baseline_version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=3000, allow_blank=False)


class RagBaselineClearSerializer(serializers.Serializer):
    baseline_version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=3000, allow_blank=False)


@never_cache
@api_view(["POST", "DELETE"])
@permission_classes([IsAuthenticated])
def api_rag_baseline(request, run_id):
    from .rag_baselines import clear_baseline, select_baseline

    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = (
        RagBaselineClearSerializer if request.method == "DELETE" else RagBaselineRequestSerializer
    )(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        action = clear_baseline if request.method == "DELETE" else select_baseline
        action(run, request.user, **serializer.validated_data)
        return Response(rag_review_state(run, request.user))
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_rag_quality(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = RagQualityRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        assess_rag_quality(run, request.user, serializer.validated_data["input_sha256"])
        return Response(rag_review_state(run, request.user))
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_cancel(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    try:
        run = cancel_run(run, request.user)
    except PermissionError:
        return Response({"code": "CANCEL_FORBIDDEN"}, status=403)
    except RequestConflict:
        return Response({"code": "CANCEL_CONFLICT"}, status=409)
    # 취소 의사를 먼저 커밋해 다음 호출을 막고, 외부 종료를 별도로 확인한다.
    sync_run(run)
    return Response(
        run_data(run, request.user.pk), status=202 if run.status == "CANCELLING" else 200
    )


class RecoveryRequestSerializer(serializers.Serializer):
    request_id = serializers.UUIDField()


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_recover(request, run_id):
    source = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = RecoveryRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        run, created = submit_recovery(
            request.user, source, serializer.validated_data["request_id"]
        )
    except AdmissionUnavailable as error:
        return Response({"code": error.code}, status=503)
    except RequestConflict:
        return Response({"code": "RECOVERY_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RECOVERY_INPUTS_UNAVAILABLE"}, status=409)
    status = (
        200
        if run.cancel_requested_at
        else 503
        if run.prefect_flow_run_id is None
        else (202 if created else 200)
    )
    return Response(run_data(run, request.user.pk), status=status)


class ReviewRequestSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["APPROVED", "CHANGES_REQUESTED"])
    comment = serializers.CharField(max_length=3000, allow_blank=False)
    capture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    fixture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    rubric_version = serializers.CharField(max_length=40)
    review_version = serializers.IntegerField(min_value=0)


class FixtureReviewSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["APPROVED", "CHANGES_REQUESTED", "DEFERRED"])
    comment = serializers.CharField(max_length=3000, allow_blank=False)
    fixture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    case_ids = serializers.ListField(child=serializers.CharField(max_length=100), allow_empty=False)
    rubric_version = serializers.CharField(max_length=40)
    fixture_version = serializers.IntegerField(min_value=0)


class QualityRequestSerializer(serializers.Serializer):
    input_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


def review_response(run):
    try:
        material = review_material(run)
    except ResultsUnavailable:
        material = None
    return Response(
        {
            **review_state(run, material),
            "material": material,
            "material_error": "검토 자료를 확인할 수 없습니다. 완료 상태와 저장소를 확인하세요."
            if material is None
            else "",
        }
    )


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_fixture_review(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = FixtureReviewSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        save_fixture_review(run, request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    return review_response(run)


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_quality(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = QualityRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        assess(run, request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    return review_response(run)


class CaseReviewRequestSerializer(serializers.Serializer):
    case_id = serializers.CharField(max_length=100)
    decision = serializers.ChoiceField(choices=["SUITABLE", "UNSUITABLE", "DEFERRED"])
    comment = serializers.CharField(max_length=3000, allow_blank=False)
    capture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    fixture_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    rubric_version = serializers.CharField(max_length=40)
    review_version = serializers.IntegerField(min_value=0)


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_review(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    if request.method == "POST":
        serializer = ReviewRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            save_review(run, request.user, **serializer.validated_data)
        except RequestConflict:
            return Response({"code": "REVIEW_CONFLICT"}, status=409)
        except ResultsUnavailable:
            return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    try:
        material = review_material(run)
    except ResultsUnavailable:
        material = None
    return Response(
        {
            **review_state(run, material),
            "material": material,
            "material_error": "검토 자료를 확인할 수 없습니다. 완료 상태와 저장소를 확인하세요."
            if material is None
            else "",
        }
    )


@never_cache
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_case_review(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer = CaseReviewRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        save_case_review(run, request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ValueError:
        return Response({"code": "INVALID_CASE"}, status=400)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    try:
        material = review_material(run)
    except ResultsUnavailable:
        material = None
    return Response(
        {
            **review_state(run, material),
            "material": material,
            "material_error": "검토 자료를 확인할 수 없습니다. 새로고침 후 확인하세요."
            if material is None
            else "",
        }
    )


class BaselineRequestSerializer(serializers.Serializer):
    review_id = serializers.IntegerField(min_value=1)
    baseline_version = serializers.IntegerField(min_value=0)


class BaselineClearSerializer(serializers.Serializer):
    baseline_version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=3000, allow_blank=False)


@never_cache
@api_view(["POST", "DELETE"])
@permission_classes([IsAuthenticated])
def api_baseline(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id)
    serializer_class = (
        BaselineClearSerializer if request.method == "DELETE" else BaselineRequestSerializer
    )
    serializer = serializer_class(data=request.data)
    serializer.is_valid(raise_exception=True)
    try:
        if request.method == "DELETE":
            clear_baseline(run, request.user, **serializer.validated_data)
        else:
            promote_baseline(run, request.user, **serializer.validated_data)
    except RequestConflict:
        return Response({"code": "REVIEW_CONFLICT"}, status=409)
    except ResultsUnavailable:
        return Response({"code": "RESULTS_UNAVAILABLE"}, status=503)
    try:
        material = review_material(run)
    except ResultsUnavailable:
        material = None
    return Response(
        {
            **review_state(run, material),
            "material": material,
            "material_error": "검토 자료를 확인할 수 없습니다. 완료 상태와 저장소를 확인하세요."
            if material is None
            else "",
        }
    )


@never_cache
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def evaluation_report(request, run_id):
    run = get_object_or_404(EvaluationRun, pk=run_id, status="COMPLETED")
    try:
        _, _, report, _ = read_result(run)
        response = HttpResponse(report, content_type="text/html; charset=utf-8")
    except (ResultsUnavailable, OSError) as exc:
        raise Http404("보고서를 확인할 수 없습니다.") from exc
    # 생성 HTML의 스크립트가 Ops 쿠키·DOM·API를 읽을 수 없는 별도 origin sandbox.
    response["Content-Security-Policy"] = (
        "sandbox allow-scripts; default-src 'none'; "
        "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
        "img-src data: blob:; font-src data:; connect-src 'none'"
    )
    response["Cache-Control"] = "private, no-store"
    return response
