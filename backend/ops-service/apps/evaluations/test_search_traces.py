from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from .views import api_session


@override_settings(OPS_WEB_URL="https://govbiz.example", LANGFUSE_PROJECT_URL="")
class SearchTraceLinkTests(SimpleTestCase):
    @patch("apps.evaluations.views.public_datasets", return_value=[])
    @patch("apps.evaluations.views.baseline_choices", return_value={})
    def test_only_authenticated_ops_session_receives_trace_link(self, _baselines, _datasets):
        factory = APIRequestFactory()
        request = factory.get("/api/v1/ops/session")
        self.assertIsNone(api_session(request).data["search_traces_url"])
        request = factory.get("/api/v1/ops/session")
        force_authenticate(
            request,
            user=SimpleNamespace(
                is_authenticated=True,
                email="operator@example.test",
                get_username=lambda: "core:1",
            ),
        )
        response = api_session(request)
        self.assertEqual(
            response.data["search_traces_url"],
            "https://govbiz.example/ops/traces",
        )
