from django.urls import path

from . import (
    budget_admin_views,
    budget_views,
    dashboard,
    dashboard_reviews,
    runtime_views,
    schedule_views,
    trace_views,
    views,
)

urlpatterns = [
    path("api/v1/ops/traces", trace_views.api_traces),
    path("api/v1/ops/traces/<str:trace_id>", trace_views.api_trace_detail),
    path("api/v1/ops/dashboard", dashboard.api_dashboard),
    path(
        "api/v1/ops/dashboard/runs/<uuid:run_id>/review-status", dashboard_reviews.api_review_status
    ),
    path("api/v1/ops/schedules", schedule_views.api_schedules),
    path("api/v1/ops/schedules/<uuid:schedule_id>/pause", schedule_views.api_pause_schedule),
    path("api/v1/ops/budget", budget_admin_views.api_summary),
    path("api/v1/ops/budget/limits", budget_admin_views.api_change_limits),
    path("api/v1/ops/budget/daily-limits", budget_admin_views.api_change_daily_limits),
    path("api/v1/ops/budget/reservations", budget_admin_views.api_reservations),
    path("api/v1/ops/budget/unaccounted-runs", budget_admin_views.api_unaccounted_runs),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/legacy-usage-preview",
        budget_admin_views.api_legacy_usage_preview,
    ),
    path("api/v1/ops/evaluations/<uuid:run_id>/budget", budget_admin_views.api_run_budget),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/legacy-usage",
        budget_admin_views.api_apply_legacy_usage,
    ),
    path("api/v1/ops/runtime", runtime_views.runtime_status),
    path("api/v1/ops/evaluations/live-readiness", runtime_views.live_readiness),
    path("api/v1/ops/evaluations/<uuid:run_id>/cancel", views.api_cancel, name="evaluation-cancel"),
    path("api/v1/ops/evaluations/<uuid:run_id>/logs", views.api_run_logs),
    path("internal/llmops/evaluations/<uuid:run_id>/budget/<str:action>", budget_views.api_budget),
    path("api/v1/ops/evaluations/<uuid:run_id>/fixture-review", views.api_fixture_review),
    path("api/v1/ops/evaluations/<uuid:run_id>/quality", views.api_quality),
    path("api/v1/ops/evaluations/<uuid:run_id>/rag-material", views.api_rag_material),
    path("api/v1/ops/evaluations/<uuid:run_id>/rag-reviews", views.api_rag_reviews),
    path("api/v1/ops/evaluations/<uuid:run_id>/rag-quality", views.api_rag_quality),
    path("api/v1/ops/evaluations/<uuid:run_id>/rag-baseline", views.api_rag_baseline),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/rag-reference-review", views.api_rag_reference_review
    ),
    path("", views.web_redirect),
    path("ops/login", views.web_redirect),
    path("ops/evaluations", views.web_redirect),
    path("ops/evaluations/<uuid:run_id>", views.web_redirect),
    path("api/v1/ops/session", views.api_session),
    path("api/v1/ops/evaluations", views.api_runs, name="api-evaluations"),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>", views.api_run_detail, name="api-evaluation-detail"
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/recover",
        views.api_recover,
        name="evaluation-recover",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/review",
        views.api_review,
        name="evaluation-review",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/case-review",
        views.api_case_review,
        name="evaluation-case-review",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/baseline",
        views.api_baseline,
        name="evaluation-baseline",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/report",
        views.evaluation_report,
        name="evaluation-report",
    ),
]
