"""운영 표본의 권한·민감정보·상한·검토 및 회귀후보의 범위를 검증한다."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import timedelta
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient, APIRequestFactory

from .models import (
    EvaluationBaseline,
    EvaluationRun,
    ProductionQualitySample,
    ProductionRegressionCandidate,
    ProductionSampleDay,
    ProductionSampleReview,
)
from .production_quality import (
    MAX_BODY_BYTES,
    SCOPE,
    ProductionQualityError,
    digest,
    ingest_sample,
    process_pending_samples,
    prune_expired_samples,
    redact,
    sample_dashboard,
    save_regression_candidate,
    save_review,
    structural_checks,
    trace_url,
    validate_review,
    validate_sample,
)
from .production_views import api_ingest

SETTINGS = {
    "LLMOPS_PRODUCTION_SAMPLES_ENABLED": True,
    "LLMOPS_PRODUCTION_SAMPLE_TOKEN": "test-only-production-token-0123456789",
    "LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT": 100,
    "LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS": 14,
}
COLLECTION = "/api/v1/ops/production-quality"
INGEST = "/internal/llmops/production-samples"


def sample_payload(**changes):
    return {
        "schema_version": 1,
        "id": str(uuid.uuid4()),
        "captured_at": timezone.now().isoformat(),
        "scope": SCOPE,
        "sample_rate_bps": 500,
        "source_document_id": "BIZINFO:PBLN_123",
        "trace_id": "a" * 32,
        "release": "b" * 40,
        "material": {
            "question": "서울 소재 기업이 신청할 수 있나요?",
            "chunks": [
                {
                    "id": "c" * 64,
                    "document_id": "BIZINFO:PBLN_123",
                    "order": 0,
                    "text": "서울에 소재한 업력 3년 이하 기업이 신청할 수 있습니다.",
                }
            ],
            "answer": "서울 소재이며 업력 3년 이하인 기업이 대상입니다.",
            "answer_status": "ANSWERED",
            "citation_chunk_ids": ["c" * 64],
        },
        **changes,
    }


def review_payload(sample, **changes):
    return {
        "request_id": str(uuid.uuid4()),
        "version": sample.review_version,
        "material_sha256": sample.material_sha256,
        "grounded": "yes",
        "relevant": "yes",
        "complete": "yes",
        "note": "원문의 소재지와 업력 조건을 대조했습니다.",
        "reference_answer": "서울 소재이며 업력 3년 이하인 기업이 신청할 수 있습니다.",
        "expected_status": "ANSWERED",
        "expected_citation_ids": ["c" * 64],
        **changes,
    }


def candidate_payload(sample, **changes):
    return {
        "request_id": str(uuid.uuid4()),
        "version": sample.review_version,
        "material_sha256": sample.material_sha256,
        **changes,
    }


@override_settings(**SETTINGS)
class ProductionQualityValidationTests(SimpleTestCase):
    def test_redacts_material_without_mutating_input_or_chunk_provenance(self):
        payload = sample_payload()
        private = "person@example.com 010-1234-5678 900101-1234567 Bearer private-token-123"
        payload["material"]["question"] = private
        payload["material"]["answer"] = private
        payload["material"]["chunks"][0]["text"] = private
        before = deepcopy(payload)
        clean = validate_sample(payload)
        self.assertEqual(payload, before)
        self.assertTrue(clean["redacted"])
        self.assertEqual(clean["material_sha256"], digest(clean["material"]))
        self.assertEqual(clean["payload_sha256"], digest(payload))
        self.assertEqual(clean["material"]["chunks"][0]["id"], "c" * 64)
        stored = json.dumps(clean["material"])
        for value in private.split():
            self.assertNotIn(value, stored)

    def test_private_patterns_include_unformatted_phone_jwt_and_assignment(self):
        for raw in (
            "01012345678",
            "+82-10-1234-5678",
            "02-123-4567",
            "9001011234567",
            "Bearer abc-secret",
            "sk-private-token-0123456789",
            "eyJ0eXAiOiJKV1Q.eyJzdWIiOiIxMjM.signature",
            "api_key=private-secret",
            'password="my-password"',
            "refresh_token:secret123",
        ):
            with self.subTest(raw=raw):
                self.assertNotIn(raw, redact(raw))

    def test_no_redaction_claim_for_ordinary_material(self):
        for changes in ({}, {"evidence_redacted": False}):
            with self.subTest(changes=changes):
                payload = sample_payload(**changes)
                clean = validate_sample(payload)
                self.assertFalse(clean["redacted"])
                self.assertEqual(clean["payload_sha256"], digest(payload))
                self.assertEqual(clean["material_sha256"], digest(payload["material"]))

    def test_core_masked_evidence_preserves_redaction_hashes_and_citation_provenance(self):
        payload = sample_payload(evidence_redacted=True)
        payload["material"]["chunks"][0]["text"] = (
            "서울 소재 기업이 신청할 수 있습니다. 문의처: [REDACTED], [REDACTED]"
        )
        before = deepcopy(payload)
        clean = validate_sample(payload)
        self.assertEqual(payload, before)
        self.assertTrue(clean["redacted"])
        self.assertEqual(clean["material"], before["material"])
        self.assertEqual(clean["payload_sha256"], digest(payload))
        self.assertEqual(clean["material_sha256"], digest(clean["material"]))
        self.assertEqual(structural_checks(clean["material"]), [])

    def test_core_flag_does_not_disable_ops_contact_redaction(self):
        for flag in (False, True):
            payload = sample_payload(evidence_redacted=flag)
            payload["material"]["chunks"][0]["text"] = (
                "AI·ICT 분야 국내기업. 문의처: 02-3460-7474, aiax@kotra.or.kr"
            )
            with self.subTest(flag=flag):
                clean = validate_sample(payload)
                self.assertTrue(clean["redacted"])
                self.assertEqual(
                    clean["material"]["chunks"][0]["text"],
                    "AI·ICT 분야 국내기업. 문의처: [REDACTED], [REDACTED]",
                )
                self.assertEqual(clean["material_sha256"], digest(clean["material"]))

    def test_evidence_redaction_flag_requires_a_boolean_at_the_payload_boundary(self):
        for flag in (None, 0, 1, "true", "false", "", [], {}):
            with (
                self.subTest(flag=flag),
                self.assertRaisesMessage(ProductionQualityError, "INVALID_EVIDENCE_REDACTION"),
            ):
                validate_sample(sample_payload(evidence_redacted=flag))
        for section in ("material", "chunk"):
            payload = sample_payload()
            target = (
                payload["material"] if section == "material" else payload["material"]["chunks"][0]
            )
            target["evidence_redacted"] = True
            with (
                self.subTest(section=section),
                self.assertRaisesMessage(ProductionQualityError, "UNKNOWN_SAMPLE_FIELDS"),
            ):
                validate_sample(payload)

    def test_trace_link_only_uses_valid_configured_web_base(self):
        sample = ProductionQualitySample(**validate_sample(sample_payload()))
        with self.settings(LANGFUSE_PROJECT_URL="https://langfuse.example/project/test"):
            self.assertTrue(trace_url(sample).startswith("https://langfuse.example/project/test/"))
            self.assertIn("dateRange=0-", trace_url(sample))
        for base in (
            "javascript:alert(1)",
            "https://secret:token@example.com/",
            "https://[broken",
            "https://example.com/?redirect=elsewhere",
        ):
            with self.subTest(base=base), self.settings(LANGFUSE_PROJECT_URL=base):
                self.assertIsNone(trace_url(sample))

    def test_rejects_extra_fields_at_every_boundary(self):
        for section in (None, "material", "chunk"):
            payload = sample_payload()
            target = (
                payload
                if section is None
                else (
                    payload["material"]
                    if section == "material"
                    else payload["material"]["chunks"][0]
                )
            )
            target["private_customer_id"] = "private"
            with self.subTest(section=section), self.assertRaises(ProductionQualityError):
                validate_sample(payload)

    def test_rejects_invalid_types_limits_and_identities(self):
        cases = (
            ("schema_version", True),
            ("schema_version", 2),
            ("id", "secret"),
            ("captured_at", "2026-01-01T00:00:00"),
            ("captured_at", "invalid"),
            ("captured_at", 0),
            ("sample_rate_bps", False),
            ("sample_rate_bps", 0),
            ("sample_rate_bps", 10001),
            ("source_document_id", "same-id"),
            ("source_document_id", "bizinfo:123"),
            ("source_document_id", "BIZINFO:person@example.com"),
            ("trace_id", "unsafe/url"),
            ("trace_id", 123),
            ("release", "main"),
            ("scope", "all-service"),
        )
        for key, value in cases:
            with self.subTest(key=key, value=value), self.assertRaises(ProductionQualityError):
                validate_sample(sample_payload(**{key: value}))
        self.assertIsNone(validate_sample(sample_payload(trace_id=None, release=None))["trace_id"])

    def test_rejects_nested_material_shape_and_duplicate_ids(self):
        changes = (
            ("question", " "),
            ("question", "x" * 501),
            ("answer", "x" * 1201),
            ("answer_status", []),
            ("answer_status", "PASS"),
            ("citation_chunk_ids", "c" * 64),
            ("citation_chunk_ids", ["c" * 64] * 2),
            ("chunks", []),
            ("chunks", [{}]),
        )
        for key, value in changes:
            payload = sample_payload()
            payload["material"][key] = value
            with self.subTest(key=key), self.assertRaises(ProductionQualityError):
                validate_sample(payload)
        payload = sample_payload()
        payload["material"]["chunks"] *= 2
        with self.assertRaisesMessage(ProductionQualityError, "DUPLICATE_CHUNK_ID"):
            validate_sample(payload)

    def test_source_document_and_chunk_document_must_match(self):
        payload = sample_payload()
        payload["material"]["chunks"][0]["document_id"] = "OTHER:PBLN_123"
        with self.assertRaisesMessage(ProductionQualityError, "CHUNK_DOCUMENT_MISMATCH"):
            validate_sample(payload)

    def test_free_checks_do_not_claim_semantic_answer_quality(self):
        material = sample_payload()["material"]
        material["answer"] = "원문과 모순되는 내용도 의미 평가 없이 합격시키지 않습니다."
        self.assertEqual(structural_checks(material), [])
        material["citation_chunk_ids"] = ["d" * 64]
        self.assertEqual(structural_checks(material), ["CITATION_NOT_IN_CONTEXT"])
        material["citation_chunk_ids"] = []
        self.assertEqual(structural_checks(material), ["ANSWER_WITHOUT_CITATION"])
        material["answer_status"] = "INSUFFICIENT_EVIDENCE"
        self.assertEqual(structural_checks(material), [])
        material["citation_chunk_ids"] = ["c" * 64]
        self.assertEqual(structural_checks(material), ["INSUFFICIENT_WITH_CITATION"])

    def test_review_validation_does_not_coerce_boolean_version_or_decisions(self):
        sample = ProductionQualitySample(**validate_sample(sample_payload()))
        for changes in (
            {"version": True},
            {"grounded": []},
            {"complete": "PASS"},
            {"note": " "},
            {"note": "x" * 1001},
            {"reference_answer": "x" * 2001},
            {"expected_status": []},
            {"reviewer": "fake-admin"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ProductionQualityError):
                validate_review(review_payload(sample, **changes))

    def test_ingest_auth_precedes_parsing_and_does_not_accept_admin_cookies(self):
        factory = APIRequestFactory()
        for token in (None, "Bearer wrong", "Bearer " + "x" * 31):
            request = factory.post(INGEST, b"{private", content_type="application/json")
            request.COOKIES["govbiz_session"] = "admin-session"
            if token:
                request.META["HTTP_AUTHORIZATION"] = token
            response = api_ingest(request)
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.data, {"code": "PRODUCTION_SAMPLE_AUTH_REQUIRED"})

    def test_ingest_body_size_invalid_json_and_disabled_are_fixed_errors(self):
        factory = APIRequestFactory()
        for body, status, code in (
            (b"x" * (MAX_BODY_BYTES + 1), 413, "SAMPLE_TOO_LARGE"),
            (b'{"private":', 400, "INVALID_SAMPLE_JSON"),
            (b'{"value":NaN}', 400, "INVALID_SAMPLE_JSON"),
        ):
            with self.subTest(code=code):
                request = factory.post(INGEST, body, content_type="application/json")
                request.META["HTTP_AUTHORIZATION"] = (
                    "Bearer " + SETTINGS["LLMOPS_PRODUCTION_SAMPLE_TOKEN"]
                )
                response = api_ingest(request)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.data, {"code": code})
        with self.settings(LLMOPS_PRODUCTION_SAMPLES_ENABLED=False):
            with self.assertRaisesMessage(ProductionQualityError, "PRODUCTION_SAMPLING_DISABLED"):
                ingest_sample(sample_payload())


class ProductionQualityFixture:
    def setUp(self):
        self.user = get_user_model().objects.create_user("core:71", email="reviewer@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.payload = sample_payload()
        self.sample, _ = ingest_sample(self.payload)
        self.url = f"{COLLECTION}/{self.sample.pk}"

    def checked(self):
        process_pending_samples()
        self.sample.refresh_from_db()

    def reviewed(self, **changes):
        self.checked()
        self.sample = save_review(self.sample.pk, self.user, review_payload(self.sample, **changes))


@override_settings(**SETTINGS)
class ProductionQualityTests(ProductionQualityFixture, TestCase):
    def test_ingest_token_and_strict_payload_create_one_pending_sample(self):
        self.client.force_authenticate(None)
        payload = sample_payload()
        self.assertEqual(self.client.post(INGEST, payload, format="json").status_code, 403)
        self.client.credentials(
            HTTP_AUTHORIZATION="Bearer " + SETTINGS["LLMOPS_PRODUCTION_SAMPLE_TOKEN"]
        )
        response = self.client.post(INGEST, payload, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.client.post(INGEST, payload, format="json").status_code, 200)
        self.assertEqual(ProductionQualitySample.objects.count(), 2)
        sample = ProductionQualitySample.objects.get(pk=payload["id"])
        self.assertEqual(sample.checks_status, "pending")
        self.assertEqual(sample.review_version, 0)

    def test_core_masked_sample_is_stored_checked_and_exposed_without_automatic_review(self):
        payload = sample_payload(evidence_redacted=True)
        payload["material"]["chunks"][0]["text"] = (
            "서울 소재 기업이 신청할 수 있습니다. 문의처: [REDACTED], [REDACTED]"
        )
        sample, created = ingest_sample(payload)
        self.assertTrue(created)
        repeated, created = ingest_sample(payload)
        self.assertFalse(created)
        self.assertEqual(repeated.pk, sample.pk)
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 2)
        self.assertEqual(process_pending_samples(), 2)
        sample.refresh_from_db()
        self.assertTrue(sample.redacted)
        self.assertEqual(sample.payload_sha256, digest(payload))
        self.assertEqual(sample.material_sha256, digest(sample.material))
        self.assertEqual(sample.material, payload["material"])
        response = self.client.get(f"{COLLECTION}/{sample.pk}")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["redacted"])
        self.assertEqual(response.data["checks_status"], "checked")
        self.assertEqual(response.data["check_codes"], [])
        self.assertEqual(response.data["material"], payload["material"])
        self.assertIsNone(response.data["review"])
        self.assertEqual(response.data["review_version"], 0)
        with self.assertRaisesMessage(ProductionQualityError, "SAMPLE_REQUEST_CONFLICT"):
            ingest_sample({**payload, "evidence_redacted": False})
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 2)

    def test_daily_cap_counts_once_and_duplicates_work_at_cap(self):
        with self.settings(LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT=1):
            row, created = ingest_sample(self.payload)
            self.assertEqual(row.pk, self.sample.pk)
            self.assertFalse(created)
            with self.assertRaisesMessage(ProductionQualityError, "PRODUCTION_DAILY_LIMIT_REACHED"):
                ingest_sample(sample_payload())
            changed = deepcopy(self.payload)
            changed["material"]["answer"] = "다른 응답"
            with self.assertRaisesMessage(ProductionQualityError, "SAMPLE_REQUEST_CONFLICT"):
                ingest_sample(changed)
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 1)

    def test_rejects_old_or_future_samples_without_consuming_cap(self):
        for time in (timezone.now() - timedelta(hours=25), timezone.now() + timedelta(minutes=6)):
            with self.assertRaisesMessage(ProductionQualityError, "CAPTURE_TIME_OUT_OF_RANGE"):
                ingest_sample(sample_payload(captured_at=time.isoformat()))
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 1)

    def test_worker_is_free_idempotent_and_runs_after_collection_is_disabled(self):
        with self.settings(LLMOPS_PRODUCTION_SAMPLES_ENABLED=False):
            self.assertEqual(process_pending_samples(), 1)
            self.assertEqual(process_pending_samples(), 0)
        self.sample.refresh_from_db()
        self.assertEqual(self.sample.checks_status, "checked")
        self.assertEqual(self.sample.check_codes, [])
        self.assertEqual(self.sample.review_version, 0)
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBaseline.objects.exists())

    def test_worker_marks_corrupt_data_error_without_raw_exception(self):
        ProductionQualitySample.objects.filter(pk=self.sample.pk).update(
            material={"secret": "private"}
        )
        process_pending_samples()
        self.sample.refresh_from_db()
        self.assertEqual(self.sample.checks_status, "error")
        self.assertEqual(self.sample.check_codes, ["STRUCTURAL_CHECK_FAILED"])
        with self.assertRaises(ProductionQualityError):
            save_review(self.sample.pk, self.user, review_payload(self.sample))

    def test_review_requires_completed_checks_and_matching_version_and_material(self):
        response = self.client.post(
            self.url + "/review", review_payload(self.sample), format="json"
        )
        self.assertEqual(response.status_code, 409)
        self.checked()
        for changes in ({"version": 1}, {"material_sha256": "0" * 64}):
            response = self.client.post(
                self.url + "/review", review_payload(self.sample, **changes), format="json"
            )
            self.assertEqual(response.status_code, 409)
        self.assertFalse(ProductionSampleReview.objects.exists())

    def test_append_only_review_idempotent_retry_and_different_actor_conflict(self):
        self.checked()
        payload = review_payload(self.sample)
        response = self.client.post(self.url + "/review", payload, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["review"]["reviewer"], "core:71")
        self.sample.refresh_from_db()
        second = review_payload(self.sample, complete="no", note="누락 조건을 다시 확인했습니다.")
        self.assertEqual(
            self.client.post(self.url + "/review", second, format="json").status_code, 200
        )
        response = self.client.post(self.url + "/review", payload, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["review_version"], 2)
        self.assertEqual(len(response.json()["review_history"]), 2)
        self.assertEqual(response.json()["review"]["verdict"], "issue")
        self.assertEqual(ProductionSampleReview.objects.count(), 2)
        payload["note"] = "다른 검토"
        self.assertEqual(
            self.client.post(self.url + "/review", payload, format="json").status_code, 409
        )
        payload["note"] = "원문의 소재지와 업력 조건을 대조했습니다."
        other = get_user_model().objects.create_user("core:72")
        self.client.force_authenticate(other)
        self.assertEqual(
            self.client.post(self.url + "/review", payload, format="json").status_code, 409
        )

    def test_structural_findings_cannot_be_overridden_to_acceptable(self):
        payload = sample_payload()
        payload["material"]["citation_chunk_ids"] = ["d" * 64]
        sample, _ = ingest_sample(payload)
        process_pending_samples()
        sample.refresh_from_db()
        with self.assertRaisesMessage(ProductionQualityError, "STRUCTURAL_ISSUES_REQUIRE_REVIEW"):
            save_review(sample.pk, self.user, review_payload(sample))
        sample = save_review(sample.pk, self.user, review_payload(sample, grounded="no"))
        self.assertEqual(sample.reviews.get().verdict, "issue")

    def test_unknown_is_unassessable_and_review_text_is_redacted(self):
        self.reviewed(
            grounded="unknown",
            note="person@example.com 에게 확인 필요",
            reference_answer="전화 010-1234-5678로 확인",
        )
        review = self.sample.reviews.get()
        self.assertEqual(review.verdict, "unassessable")
        self.assertNotIn("person@example.com", review.note)
        self.assertNotIn("010-1234-5678", review.reference_answer)
        self.assertEqual(sample_dashboard(1)["summary"]["unassessable"], 1)

    def test_candidate_requires_review_reference_and_valid_citations(self):
        response = self.client.post(
            self.url + "/regression-candidate",
            candidate_payload(self.sample, version=1),
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.reviewed(grounded="unknown")
        with self.assertRaisesMessage(ProductionQualityError, "REGRESSION_REFERENCE_REQUIRED"):
            save_regression_candidate(self.sample.pk, self.user, candidate_payload(self.sample))
        for changes, code in (
            ({"reference_answer": ""}, "REGRESSION_REFERENCE_REQUIRED"),
            ({"expected_status": None}, "REGRESSION_REFERENCE_REQUIRED"),
            ({"expected_citation_ids": []}, "REGRESSION_CITATIONS_REQUIRED"),
            ({"expected_status": "INSUFFICIENT_EVIDENCE"}, "REGRESSION_CITATIONS_REQUIRED"),
        ):
            self.sample = save_review(
                self.sample.pk, self.user, review_payload(self.sample, **changes)
            )
            with (
                self.subTest(changes=changes),
                self.assertRaisesMessage(ProductionQualityError, code),
            ):
                save_regression_candidate(self.sample.pk, self.user, candidate_payload(self.sample))

    def test_issue_can_be_candidate_with_human_expected_answer_and_immutable_provenance(self):
        self.reviewed(grounded="no")
        payload = candidate_payload(self.sample)
        response = self.client.post(self.url + "/regression-candidate", payload, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.json()["regression_candidate_id"])
        retry = self.client.post(self.url + "/regression-candidate", payload, format="json")
        self.assertEqual(retry.status_code, 200)
        first = self.client.get(self.url + "/regression-candidate").json()
        self.assertEqual(first["schemaVersion"], "production-regression-candidate-v1")
        self.assertEqual(first["review_version"], 1)
        self.assertFalse(first["fixture_registered"])
        self.assertFalse(first["baseline_eligible"])
        self.sample = save_review(
            self.sample.pk, self.user, review_payload(self.sample, reference_answer="재검토 답변")
        )
        self.assertEqual(self.client.get(self.url + "/regression-candidate").json(), first)
        self.assertEqual(ProductionRegressionCandidate.objects.count(), 1)
        self.assertFalse(EvaluationRun.objects.exists())
        self.assertFalse(EvaluationBaseline.objects.exists())

    def test_expected_citations_must_reference_stored_context(self):
        self.checked()
        response = self.client.post(
            self.url + "/review",
            review_payload(self.sample, expected_citation_ids=["d" * 64]),
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(ProductionSampleReview.objects.exists())

    def test_dashboard_counts_latest_review_and_only_retained_observed_samples(self):
        self.reviewed()
        self.sample = save_review(
            self.sample.pk, self.user, review_payload(self.sample, complete="no")
        )
        other, _ = ingest_sample(sample_payload())
        ProductionQualitySample.objects.filter(pk=other.pk).update(
            received_at=timezone.now() - timedelta(days=15)
        )
        response = self.client.get(COLLECTION)
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        data = response.json()
        self.assertEqual(
            data["summary"],
            {
                "stored": 1,
                "checked": 1,
                "pending": 0,
                "reviewed": 1,
                "issues": 1,
                "unassessable": 0,
            },
        )
        self.assertEqual(data["days"][0]["samples"], 1)
        self.assertEqual(data["days"][0]["acceptable"], 0)
        self.assertEqual(data["days"][0]["issues"], 1)
        self.assertNotIn("material", data["results"][0])
        self.assertNotIn("total_service_requests", data)
        self.assertEqual(self.client.get(f"{COLLECTION}/{other.pk}").status_code, 404)

    def test_retention_removes_review_and_candidate_copies_with_material(self):
        self.reviewed()
        save_regression_candidate(self.sample.pk, self.user, candidate_payload(self.sample))
        ProductionQualitySample.objects.filter(pk=self.sample.pk).update(
            received_at=timezone.now() - timedelta(days=15)
        )
        self.assertGreater(prune_expired_samples(), 0)
        self.assertFalse(ProductionQualitySample.objects.exists())
        self.assertFalse(ProductionSampleReview.objects.exists())
        self.assertFalse(ProductionRegressionCandidate.objects.exists())
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 1)

    def test_admin_auth_csrf_and_private_export_are_required(self):
        anonymous = APIClient(enforce_csrf_checks=True)
        for path in (COLLECTION, self.url, self.url + "/regression-candidate"):
            self.assertEqual(anonymous.get(path).status_code, 401)
        anonymous.cookies["govbiz_session"] = "member-session"
        with patch("apps.evaluations.authentication.read_core_admin", side_effect=PermissionDenied):
            self.assertEqual(anonymous.get(self.url).status_code, 403)
        with patch(
            "apps.evaluations.authentication.read_core_admin",
            return_value={"accountId": 71, "email": "reviewer@example.com", "role": "ADMIN"},
        ):
            self.assertEqual(anonymous.get(self.url).status_code, 200)
            self.assertEqual(
                anonymous.post(
                    self.url + "/review", review_payload(self.sample), format="json"
                ).status_code,
                403,
            )

    def test_pagination_and_bad_query_do_not_return_unbounded_material(self):
        self.assertEqual(self.client.get(COLLECTION + "?page=0").status_code, 400)
        self.assertEqual(self.client.get(COLLECTION + "?page=oops").status_code, 400)
        self.assertEqual(self.client.get(COLLECTION + "?page_size=99999").status_code, 400)
        self.assertEqual(self.client.get(COLLECTION + "?page=2").json()["results"], [])


@override_settings(**{**SETTINGS, "LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT": 1})
@skipUnless(connection.vendor == "mysql", "Actual MySQL row locking is required")
class ProductionQualityConcurrencyTests(TransactionTestCase):
    def competing_requests(self, model, samples, user, payloads, save):
        barrier = Barrier(2)
        create = model.objects.create

        def create_after_both_miss_retry(*args, **kwargs):
            # 각 요청은 서로 다른 sample을 잠그고 같은 request_id의 부재를 확인한 상태다.
            barrier.wait(timeout=10)
            return create(*args, **kwargs)

        def submit(item):
            sample, payload = item
            close_old_connections()
            try:
                try:
                    save(sample.pk, user, payload)
                    return "accepted"
                except ProductionQualityError as error:
                    return error.code
            finally:
                close_old_connections()

        with patch.object(model.objects, "create", side_effect=create_after_both_miss_retry):
            with ThreadPoolExecutor(max_workers=2) as pool:
                return list(pool.map(submit, zip(samples, payloads, strict=True)))

    def sample_pair(self):
        user = get_user_model().objects.create_user("core:74")
        with self.settings(LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT=2):
            samples = [ingest_sample(sample_payload())[0] for _ in range(2)]
        process_pending_samples()
        return user, samples

    def test_same_request_id_on_different_samples_cannot_race_into_two_reviews(self):
        user, samples = self.sample_pair()
        request_id = str(uuid.uuid4())
        results = self.competing_requests(
            ProductionSampleReview,
            samples,
            user,
            [review_payload(sample, request_id=request_id) for sample in samples],
            save_review,
        )
        self.assertCountEqual(results, ["accepted", "REVIEW_REQUEST_CONFLICT"])
        self.assertEqual(ProductionSampleReview.objects.count(), 1)
        self.assertEqual(
            sum(ProductionQualitySample.objects.values_list("review_version", flat=True)), 1
        )

    def test_same_request_id_on_different_samples_cannot_race_into_two_candidates(self):
        user, samples = self.sample_pair()
        samples = [save_review(sample.pk, user, review_payload(sample)) for sample in samples]
        request_id = str(uuid.uuid4())
        results = self.competing_requests(
            ProductionRegressionCandidate,
            samples,
            user,
            [candidate_payload(sample, request_id=request_id) for sample in samples],
            save_regression_candidate,
        )
        self.assertCountEqual(results, ["accepted", "CANDIDATE_REQUEST_CONFLICT"])
        self.assertEqual(ProductionRegressionCandidate.objects.count(), 1)

    def test_parallel_review_preserves_one_version_and_rejects_stale_writer(self):
        user = get_user_model().objects.create_user("core:73")
        sample, _ = ingest_sample(sample_payload())
        process_pending_samples()
        barrier = Barrier(2)

        def submit(payload):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    save_review(sample.pk, user, payload)
                    return "accepted"
                except ProductionQualityError as error:
                    return error.code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [review_payload(sample), review_payload(sample)]))
        self.assertCountEqual(results, ["accepted", "REVIEW_VERSION_CONFLICT"])
        sample.refresh_from_db()
        self.assertEqual(sample.review_version, 1)
        self.assertEqual(ProductionSampleReview.objects.count(), 1)

    def test_parallel_ingest_cannot_exceed_daily_cap(self):
        ProductionSampleDay.objects.create(day=timezone.localdate())
        barrier = Barrier(2)

        def submit(payload):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    ingest_sample(payload)
                    return "accepted"
                except ProductionQualityError as error:
                    return error.code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [sample_payload(), sample_payload()]))
        self.assertCountEqual(results, ["accepted", "PRODUCTION_DAILY_LIMIT_REACHED"])
        self.assertEqual(ProductionQualitySample.objects.count(), 1)
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 1)

    def test_parallel_first_day_creation_and_duplicate_only_count_once(self):
        barrier = Barrier(2)
        payload = sample_payload()

        def submit(_):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return ingest_sample(payload)[1]
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertCountEqual(results, [True, False])
        self.assertEqual(ProductionSampleDay.objects.get().accepted, 1)
