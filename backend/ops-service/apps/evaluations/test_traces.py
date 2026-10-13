import base64
import json
from datetime import UTC, datetime, timedelta
from http.client import IncompleteRead
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.test import APIClient

from . import trace_client
from .authentication import CoreUnavailable

TRACE_ID = "a" * 32
NOW = datetime(2026, 10, 14, 2, 0, tzinfo=UTC)


def row(**changes):
    return {
        "id": "b" * 16,
        "traceId": TRACE_ID,
        "projectId": "project-private",
        "name": "support-program-search",
        "type": "SPAN",
        "startTime": "2026-10-14T01:00:00Z",
        "endTime": "2026-10-14T01:00:01Z",
        "isRootObservation": True,
        "parentObservationId": None,
        "level": "DEFAULT",
        "statusMessage": "검색 서비스 연결 실패",
        "latency": 1.0,
        "totalCost": None,
        "environment": "production",
        "model": None,
        "userId": "not-in-response",
        "input": '{"question":"서울 제조 지원사업"}',
        "output": '{"status":"ANSWERED"}',
        "metadata": {"outcome": "SUCCESS"},
        "usageDetails": {"input": 20, "output": 8},
        **changes,
    }


def response_bytes(value):
    response = BytesIO(value if isinstance(value, bytes) else json.dumps(value).encode())
    response.status = 200
    return response


@override_settings(
    LANGFUSE_BASE_URL="http://langfuse-web:3000",
    LANGFUSE_PUBLIC_KEY="pk-project-test",
    LANGFUSE_SECRET_KEY="sk-project-private",
)
class TraceClientTests(SimpleTestCase):
    @patch("apps.evaluations.trace_client.build_opener")
    def test_list_uses_project_auth_v2_root_filter_and_exact_encoded_query(self, opener):
        opener.return_value.open.return_value = response_bytes(
            {"data": [row()], "meta": {"cursor": "bmV4dA=="}}
        )
        result = trace_client.read_roots(
            from_time=NOW - timedelta(days=7),
            to_time=NOW,
            name="공고&name=other",
            cursor="YWJj+/==",
        )
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.method, "GET")
        self.assertEqual(urlsplit(request.full_url).path, "/api/public/v2/observations")
        query = parse_qs(urlsplit(request.full_url).query)
        self.assertEqual(query["name"], ["공고&name=other"])
        self.assertEqual(query["cursor"], ["YWJj+/=="])
        self.assertEqual(query["isRootObservation"], ["true"])
        self.assertEqual(query["limit"], ["50"])
        self.assertNotIn("parseIoAsJson", query)
        self.assertNotIn("io", query["fields"][0].split(","))
        self.assertEqual(
            request.get_header("Authorization"),
            "Basic " + base64.b64encode(b"pk-project-test:sk-project-private").decode(),
        )
        self.assertIsInstance(opener.call_args.args[0], ProxyHandler)
        self.assertIsInstance(opener.call_args.args[1], trace_client.NoTraceRedirect)
        self.assertEqual(opener.return_value.open.call_args.kwargs, {"timeout": 5})
        self.assertEqual(result["next_cursor"], "bmV4dA==")
        self.assertEqual(result["results"][0]["latency_seconds"], 1.0)
        self.assertEqual(result["results"][0]["status_message"], "검색 서비스 연결 실패")
        for private in ("userId", "projectId", "input", "output", "metadata"):
            self.assertNotIn(private, result["results"][0])

    @patch("apps.evaluations.trace_client.read_page")
    def test_logical_roots_are_not_deduplicated_by_trace(self, read_page):
        read_page.return_value = (
            [row(), row(id="c" * 16, parentObservationId="b" * 16)],
            None,
        )
        data = trace_client.read_roots(from_time=NOW - timedelta(days=1), to_time=NOW)
        self.assertEqual(len(data["results"]), 2)
        self.assertEqual({item["trace_id"] for item in data["results"]}, {TRACE_ID})

    @patch("apps.evaluations.trace_client.build_opener")
    def test_detail_only_reads_requested_trace_and_preserves_incomplete_page(self, opener):
        opener.return_value.open.return_value = response_bytes(
            {"data": [row()], "meta": {"cursor": "bmV4dA=="}}
        )
        data = trace_client.read_trace(TRACE_ID, cursor="cGFnZTI=")
        request = opener.return_value.open.call_args.args[0]
        query = parse_qs(urlsplit(request.full_url).query)
        self.assertEqual(query["traceId"], [TRACE_ID])
        self.assertEqual(query["cursor"], ["cGFnZTI="])
        self.assertNotIn("isRootObservation", query)
        self.assertEqual(data["next_cursor"], "bmV4dA==")
        self.assertEqual(data["observations"][0]["input"], row()["input"])
        self.assertEqual(data["observations"][0]["usage_details"], {"input": 20, "output": 8})
        self.assertNotIn("projectId", data["observations"][0])
        opener.return_value.open.assert_called_once()

    @patch("apps.evaluations.trace_client.build_opener")
    def test_missing_or_unsafe_config_never_sends_keys(self, opener):
        for changes in (
            {"LANGFUSE_BASE_URL": ""},
            {"LANGFUSE_BASE_URL": "https://user:password@host"},
            {"LANGFUSE_BASE_URL": "https://host/path"},
            {"LANGFUSE_BASE_URL": "https://host?next=elsewhere"},
            {"LANGFUSE_BASE_URL": "https://host#fragment"},
            {"LANGFUSE_BASE_URL": "https://host:invalid"},
            {"LANGFUSE_BASE_URL": "file:///tmp/trace.json"},
            {"LANGFUSE_PUBLIC_KEY": ""},
            {"LANGFUSE_SECRET_KEY": ""},
            {"LANGFUSE_SECRET_KEY": "secret\nheader"},
        ):
            with self.subTest(changes=changes), self.settings(**changes):
                with self.assertRaises(trace_client.LangfuseUnavailable):
                    trace_client.read_trace(TRACE_ID)
        opener.assert_not_called()

    @patch("apps.evaluations.trace_client.build_opener")
    def test_unavailable_is_not_an_empty_page_and_never_retries(self, opener):
        failures = [
            URLError("private-upstream-error"),
            TimeoutError("private-upstream-error"),
            IncompleteRead(b"private-upstream-error"),
            *(
                HTTPError("http://private", code, "secret", {}, None)
                for code in (302, 401, 403, 500)
            ),
        ]
        for failure in failures:
            opener.return_value.open.reset_mock()
            opener.return_value.open.side_effect = failure
            with (
                self.subTest(error=failure),
                self.assertRaises(trace_client.LangfuseUnavailable) as raised,
            ):
                trace_client.read_trace(TRACE_ID)
            self.assertNotIn("private", str(raised.exception))
            opener.return_value.open.assert_called_once()
        self.assertIsNone(
            trace_client.NoTraceRedirect().redirect_request(
                None, None, 302, "", {}, "https://elsewhere"
            )
        )

    @patch("apps.evaluations.trace_client.build_opener")
    def test_invalid_or_oversized_pages_are_rejected(self, opener):
        invalid = [
            b"not json",
            b"x" * (trace_client.MAX_RESPONSE_BYTES + 1),
            {"data": [], "meta": []},
            {"data": {}, "meta": {}},
            {"data": [row()] * 51, "meta": {}},
            {"data": [], "meta": {"cursor": "x" * 2049}},
            {"data": [], "meta": {"cursor": "https://evil"}},
        ]
        for value in invalid:
            with self.subTest(value_type=type(value).__name__):
                opener.return_value.open.return_value = response_bytes(value)
                with self.assertRaises(trace_client.LangfuseUnavailable):
                    trace_client.read_trace(TRACE_ID)

    @patch("apps.evaluations.trace_client.read_page")
    def test_malformed_or_foreign_observations_fail_closed(self, read_page):
        changes = (
            {"traceId": "different-trace"},
            {"id": "../traces"},
            {"startTime": "2026-10-14T01:00:00"},
            {"endTime": "invalid"},
            {"latency": -1},
            {"totalCost": float("nan")},
            {"totalCost": True},
            {"input": {"not": "raw string"}},
            {"usageDetails": {"input": -1}},
            {"metadata": {"value": float("inf")}},
            {"parentObservationId": "https://elsewhere"},
        )
        for change in changes:
            with self.subTest(change=change):
                read_page.return_value = ([row(**change)], None)
                with self.assertRaises(trace_client.LangfuseUnavailable):
                    trace_client.read_trace(TRACE_ID)
        for rows in ([row(), row()], [row(isRootObservation=False)], [None]):
            read_page.return_value = (rows, None)
            with self.assertRaises(trace_client.LangfuseUnavailable):
                trace_client.read_roots(from_time=NOW - timedelta(days=1), to_time=NOW)


@override_settings(ALLOWED_HOSTS=["testserver"])
class TraceViewTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = get_user_model()(username="core:1", email="admin@example.test")
        self.url = "/api/v1/ops/traces"
        self.detail_url = self.url + "/" + TRACE_ID

    def test_current_admin_is_required_for_list_and_detail(self):
        with (
            patch("apps.evaluations.trace_views.read_roots") as roots,
            patch("apps.evaluations.trace_views.read_trace") as trace,
        ):
            for url in (self.url, self.detail_url):
                self.client.cookies.clear()
                self.assertEqual(self.client.get(url).status_code, 401)
                self.client.cookies["govbiz_session"] = "signed-session"
                for failure, code in (
                    (PermissionDenied(), 403),
                    (AuthenticationFailed(), 401),
                    (CoreUnavailable(), 503),
                ):
                    with patch(
                        "apps.evaluations.authentication.read_core_admin", side_effect=failure
                    ):
                        self.assertEqual(self.client.get(url).status_code, code)
            roots.assert_not_called()
            trace.assert_not_called()

    def test_admin_permission_is_rechecked_after_prior_success(self):
        self.client.cookies["govbiz_session"] = "signed-session"
        with (
            patch(
                "apps.evaluations.authentication.read_core_admin",
                side_effect=[
                    {"accountId": 1, "email": "admin@example.test", "role": "ADMIN"},
                    PermissionDenied(),
                ],
            ) as admin,
            patch.object(
                get_user_model().objects, "get_or_create", return_value=(self.user, False)
            ),
            patch(
                "apps.evaluations.trace_views.read_roots",
                return_value={"results": [], "next_cursor": None},
            ) as read,
        ):
            self.assertEqual(self.client.get(self.url).status_code, 200)
            self.assertEqual(self.client.get(self.url).status_code, 403)
            self.assertEqual(admin.call_count, 2)
            read.assert_called_once()

    @patch("apps.evaluations.trace_views.timezone.now", return_value=NOW)
    @patch(
        "apps.evaluations.trace_views.read_roots", return_value={"results": [], "next_cursor": None}
    )
    def test_first_page_defaults_and_next_page_reuses_explicit_window(self, read, _now):
        self.client.force_authenticate(self.user)
        first = self.client.get(self.url)
        self.assertEqual(first.status_code, 200)
        self.assertIn("no-store", first["Cache-Control"])
        self.assertEqual(first.data["results"], [])
        self.assertEqual(first.data["from_time"], (NOW - timedelta(days=7)).isoformat())
        self.assertEqual(first.data["to_time"], NOW.isoformat())
        second = self.client.get(
            self.url,
            {
                "cursor": "bmV4dA==",
                "from_time": first.data["from_time"],
                "to_time": first.data["to_time"],
                "name": "assistant-agent",
            },
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(read.call_args.kwargs["from_time"], NOW - timedelta(days=7))
        self.assertEqual(read.call_args.kwargs["to_time"], NOW)
        self.assertEqual(read.call_args.kwargs["cursor"], "bmV4dA==")
        self.assertEqual(read.call_args.kwargs["name"], "assistant-agent")
        self.assertEqual(self.client.post(self.url, {}).status_code, 405)

    @patch("apps.evaluations.trace_views.read_roots")
    def test_invalid_filters_do_not_call_langfuse(self, read):
        self.client.force_authenticate(self.user)
        for params in (
            {"cursor": "bmV4dA=="},
            {"cursor": "x" * 2049},
            {
                "cursor": "!valid!",
                "from_time": (NOW - timedelta(days=1)).isoformat(),
                "to_time": NOW.isoformat(),
            },
            {"name": "x" * 201},
            {"from_time": NOW.isoformat()},
            {"from_time": "invalid", "to_time": NOW.isoformat()},
            {"from_time": NOW.isoformat(), "to_time": NOW.isoformat()},
            {"from_time": NOW.isoformat(), "to_time": (NOW - timedelta(days=1)).isoformat()},
            {"from_time": (NOW - timedelta(days=31)).isoformat(), "to_time": NOW.isoformat()},
        ):
            with self.subTest(params=params):
                self.assertEqual(self.client.get(self.url, params).status_code, 400)
        read.assert_not_called()

    @patch("apps.evaluations.trace_views.read_trace")
    def test_detail_not_found_pagination_and_read_only_cache_policy(self, read):
        self.client.force_authenticate(self.user)
        read.return_value = {"trace_id": TRACE_ID, "observations": [], "next_cursor": None}
        self.assertEqual(self.client.get(self.detail_url).status_code, 404)
        data = self.client.get(self.detail_url, {"cursor": "bmV4dA=="})
        self.assertEqual(data.status_code, 200)
        self.assertIn("no-store", data["Cache-Control"])
        read.assert_called_with(TRACE_ID, cursor="bmV4dA==")
        self.assertEqual(self.client.post(self.detail_url, {}).status_code, 405)
        read.reset_mock()
        self.assertEqual(self.client.get(self.url + "/invalid.id").status_code, 400)
        for cursor in ("!valid!", "x" * 2049, "valid\n"):
            self.assertEqual(self.client.get(self.detail_url, {"cursor": cursor}).status_code, 400)
        read.assert_not_called()

    def test_upstream_failure_is_explicit_and_redacted(self):
        self.client.force_authenticate(self.user)
        for url, target in ((self.url, "read_roots"), (self.detail_url, "read_trace")):
            with patch(
                "apps.evaluations.trace_views." + target,
                side_effect=trace_client.LangfuseUnavailable("private secret"),
            ):
                data = self.client.get(url)
                self.assertEqual(data.status_code, 503)
                self.assertEqual(data.data["code"], "LANGFUSE_TRACES_UNAVAILABLE")
                self.assertNotIn("private", str(data.data))
                self.assertIn("no-store", data["Cache-Control"])
