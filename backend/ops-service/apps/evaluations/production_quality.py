"""운영 표본의 무료 구조 검사와 사람 검토. 모델 호출이나 자동 품질 합격은 없다."""

import hashlib
import json
import re
import uuid
from datetime import timedelta
from unicodedata import category
from urllib.parse import urlencode, urlsplit

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Q
from django.db.models.functions import TruncDate
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import (
    ProductionQualitySample,
    ProductionRegressionCandidate,
    ProductionSampleDay,
    ProductionSampleReview,
)

SCOPE = "support-program-evidence-answer"
MAX_BODY_BYTES = 100 * 1024
HEX64 = re.compile(r"^[a-f0-9]{64}$")
STATUSES = {"ANSWERED", "INSUFFICIENT_EVIDENCE"}
DECISIONS = {"yes", "no", "unknown"}
# 고정 패턴만 사용한다. 원문·예외를 로그로 내보내지 않으며 의미 기반 PII 검출을 주장하지 않는다.
PRIVATE_PATTERNS = (
    re.compile(r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I),
    re.compile(r"(?<!\d)\d{6}\s*[-–]?\s*[1-8]\d{6}(?!\d)"),
    re.compile(
        r"(?<!\w)(?:\+82[- .]?|0)(?:1[016789]|2|[3-6][1-5]|70)[- .]?\d{3,4}[- .]?\d{4}(?!\d)"
    ),
    re.compile(r"\bBearer\s+[A-Za-z0-9_.~+/=-]+", re.I),
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b"),
    re.compile(
        r"\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|token)"
        r"\s*[=:]\s*[\"']?[^\s\"',;]+",
        re.I,
    ),
)


class ProductionQualityError(Exception):
    def __init__(self, code, status=400):
        self.code = code
        self.status = status
        super().__init__(code)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def redact(value):
    for pattern in PRIVATE_PATTERNS:
        value = pattern.sub("[REDACTED]", value)
    return value


def cutoff():
    return timezone.now() - timedelta(days=settings.LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS)


def retained_samples():
    return ProductionQualitySample.objects.filter(received_at__gte=cutoff())


def exact_fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys():
        raise ProductionQualityError("INVALID_SAMPLE_FIELDS")
    if value.keys() - set(required) - set(optional):
        raise ProductionQualityError("UNKNOWN_SAMPLE_FIELDS")


def text(value, maximum, *, blank=False):
    if not isinstance(value, str) or len(value) > maximum or (not blank and not value.strip()):
        raise ProductionQualityError("INVALID_TEXT")
    if any(category(c).startswith("C") and c not in "\n\r\t" for c in value):
        raise ProductionQualityError("INVALID_TEXT")
    return value


def identifier(value):
    text(value, 320)
    source, separator, original = value.partition(":")
    if (
        not separator
        or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", source)
        or not 1 <= len(original) <= 255
        or value != value.strip()
        or original != original.strip()
        or any(category(c).startswith("C") for c in value)
        or redact(value) != value
    ):
        raise ProductionQualityError("INVALID_DOCUMENT_ID")
    return value


def request_uuid(value):
    if not isinstance(value, str):
        raise ProductionQualityError("INVALID_REQUEST_ID")
    try:
        return uuid.UUID(value)
    except ValueError:
        raise ProductionQualityError("INVALID_REQUEST_ID") from None


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ProductionQualityError("INVALID_INTEGER")
    return value


def citation_ids(value):
    if (
        not isinstance(value, list)
        or len(value) > 5
        or any(not isinstance(item, str) or not HEX64.fullmatch(item) for item in value)
        or len(set(value)) != len(value)
    ):
        raise ProductionQualityError("INVALID_CITATION_IDS")
    return value


def validate_sample(payload):
    exact_fields(
        payload,
        {
            "schema_version",
            "id",
            "captured_at",
            "scope",
            "sample_rate_bps",
            "source_document_id",
            "trace_id",
            "release",
            "material",
        },
        {"evidence_redacted"},
    )
    evidence_redacted = payload.get("evidence_redacted", False)
    if type(evidence_redacted) is not bool:
        raise ProductionQualityError("INVALID_EVIDENCE_REDACTION")
    integer(payload["schema_version"], 1, 1)
    request_uuid(payload["id"])
    if payload["scope"] != SCOPE:
        raise ProductionQualityError("UNSUPPORTED_SAMPLE_SCOPE")
    integer(payload["sample_rate_bps"], 1, 10000)
    identifier(payload["source_document_id"])
    if not isinstance(payload["captured_at"], str):
        raise ProductionQualityError("INVALID_CAPTURE_TIME")
    try:
        captured = parse_datetime(payload["captured_at"])
    except ValueError:
        captured = None
    if captured is None or timezone.is_naive(captured):
        raise ProductionQualityError("INVALID_CAPTURE_TIME")
    if payload["trace_id"] is not None and (
        not isinstance(payload["trace_id"], str)
        or not re.fullmatch(r"[a-f0-9]{32}", payload["trace_id"])
    ):
        raise ProductionQualityError("INVALID_TRACE_ID")
    if payload["release"] is not None and (
        not isinstance(payload["release"], str)
        or not re.fullmatch(r"[a-f0-9]{40}", payload["release"])
    ):
        raise ProductionQualityError("INVALID_RELEASE")
    material = payload["material"]
    exact_fields(material, {"question", "chunks", "answer", "answer_status", "citation_chunk_ids"})
    text(material["question"], 500)
    text(material["answer"], 1200)
    if not isinstance(material["answer_status"], str) or material["answer_status"] not in STATUSES:
        raise ProductionQualityError("INVALID_ANSWER_STATUS")
    citation_ids(material["citation_chunk_ids"])
    chunks = material["chunks"]
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= 5:
        raise ProductionQualityError("INVALID_CHUNKS")
    for chunk in chunks:
        exact_fields(chunk, {"id", "document_id", "order", "text"})
        if not isinstance(chunk["id"], str) or not HEX64.fullmatch(chunk["id"]):
            raise ProductionQualityError("INVALID_CHUNK_ID")
        if chunk["document_id"] != payload["source_document_id"]:
            raise ProductionQualityError("CHUNK_DOCUMENT_MISMATCH")
        integer(chunk["order"], 0, 2147483647)
        text(chunk["text"], 12000)
    if len({chunk["id"] for chunk in chunks}) != len(chunks):
        raise ProductionQualityError("DUPLICATE_CHUNK_ID")
    clean = {
        **material,
        "question": redact(material["question"]),
        "answer": redact(material["answer"]),
        "chunks": [{**chunk, "text": redact(chunk["text"])} for chunk in chunks],
    }
    return {
        "id": request_uuid(payload["id"]),
        "captured_at": captured,
        "scope": SCOPE,
        "source_document_id": payload["source_document_id"],
        "sample_rate_bps": payload["sample_rate_bps"],
        "trace_id": payload["trace_id"],
        "release": payload["release"],
        "payload_sha256": digest(payload),
        "material": clean,
        "material_sha256": digest(clean),
        "redacted": evidence_redacted or clean != material,
    }


def ingest_sample(payload):
    if not settings.LLMOPS_PRODUCTION_SAMPLES_ENABLED:
        raise ProductionQualityError("PRODUCTION_SAMPLING_DISABLED", 503)
    values = validate_sample(payload)
    # 기존 ID 재전송을 먼저 확인해 같은 응답 재전송이 날짜·상한 검사를 다시 소비하지 않는다.
    with transaction.atomic():
        day = timezone.localdate()
        ProductionSampleDay.objects.get_or_create(day=day)
        counter = ProductionSampleDay.objects.select_for_update().get(day=day)
        existing = ProductionQualitySample.objects.filter(pk=values["id"]).first()
        if existing:
            if existing.payload_sha256 != values["payload_sha256"]:
                raise ProductionQualityError("SAMPLE_REQUEST_CONFLICT", 409)
            return existing, False
        now = timezone.now()
        if not now - timedelta(hours=24) <= values["captured_at"] <= now + timedelta(minutes=5):
            raise ProductionQualityError("CAPTURE_TIME_OUT_OF_RANGE")
        if counter.accepted >= settings.LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT:
            raise ProductionQualityError("PRODUCTION_DAILY_LIMIT_REACHED", 429)
        try:
            with transaction.atomic():
                sample = ProductionQualitySample.objects.create(**values)
        except IntegrityError:
            # 자정 전후 다른 날짜 잠금을 획득한 같은 ID도 중복 저장하지 않는다.
            existing = ProductionQualitySample.objects.filter(pk=values["id"]).first()
            if existing is not None and existing.payload_sha256 == values["payload_sha256"]:
                return existing, False
            raise ProductionQualityError("SAMPLE_REQUEST_CONFLICT", 409) from None
        counter.accepted += 1
        counter.save(update_fields=["accepted"])
    return sample, True


def structural_checks(material):
    """인용 참조와 응답 상태의 구조만 확인한다. 원문에 대한 의미적 지지는 판단하지 않는다."""
    chunk_ids = {chunk["id"] for chunk in material["chunks"]}
    cited = material["citation_chunk_ids"]
    codes = []
    if not set(cited) <= chunk_ids:
        codes.append("CITATION_NOT_IN_CONTEXT")
    if material["answer_status"] == "ANSWERED" and not cited:
        codes.append("ANSWER_WITHOUT_CITATION")
    if material["answer_status"] == "INSUFFICIENT_EVIDENCE" and cited:
        codes.append("INSUFFICIENT_WITH_CITATION")
    return codes


def process_pending_samples(batch_size=25):
    integer(batch_size, 1, 1000)
    processed = 0
    # 각 행을 짧게 잠가 여러 워커가 같은 결과를 덮어쓰지 않는다. 외부 호출은 없다.
    for _ in range(batch_size):
        with transaction.atomic():
            sample = (
                retained_samples()
                .select_for_update(skip_locked=True)
                .filter(checks_status="pending")
                .order_by("received_at", "id")
                .first()
            )
            if sample is None:
                break
            try:
                if digest(sample.material) != sample.material_sha256:
                    raise ValueError("MATERIAL_CHANGED")
                sample.check_codes = structural_checks(sample.material)
                sample.checks_status = "checked"
            except Exception:
                # 저장 자료 손상 등은 정상 checked로 바꾸지 않고 고정 오류만 보관한다.
                sample.checks_status = "error"
                sample.check_codes = ["STRUCTURAL_CHECK_FAILED"]
            sample.checked_at = timezone.now()
            sample.save(update_fields=["checks_status", "check_codes", "checked_at"])
            processed += 1
    return processed


def prune_expired_samples():
    # 검토·회귀후보의 원문 사본도 CASCADE로 만료시켜 별도 보관 경로를 남기지 않는다.
    expired = cutoff()
    removed, _ = ProductionQualitySample.objects.filter(received_at__lt=expired).delete()
    ProductionSampleDay.objects.filter(day__lt=timezone.localdate(expired)).delete()
    return removed


def review_data(review):
    if review is None:
        return None
    return {
        "id": str(review.pk),
        "version": review.version,
        "verdict": review.verdict,
        "grounded": review.grounded,
        "relevant": review.relevant,
        "complete": review.complete,
        "note": review.note,
        "reference_answer": review.reference_answer,
        "expected_status": review.expected_status,
        "expected_citation_ids": review.expected_citation_ids,
        "reviewer": review.reviewed_by.get_username(),
        "created_at": review.created_at.isoformat(),
    }


def sample_data(sample, *, detail=False):
    reviews = list(sample.reviews.select_related("reviewed_by").order_by("-version"))
    candidate = ProductionRegressionCandidate.objects.filter(sample=sample).first()
    value = {
        "id": str(sample.pk),
        "captured_at": sample.captured_at.isoformat(),
        "source_document_id": sample.source_document_id,
        "sample_rate_bps": sample.sample_rate_bps,
        "checks_status": sample.checks_status,
        "check_codes": sample.check_codes,
        "review_version": sample.review_version,
        "review": review_data(reviews[0] if reviews else None),
        "regression_candidate_id": str(candidate.pk) if candidate else None,
    }
    if detail:
        value.update(
            material=sample.material,
            material_sha256=sample.material_sha256,
            redacted=sample.redacted,
            trace_url=trace_url(sample),
            release=sample.release,
            scope=sample.scope,
            review_history=[review_data(review) for review in reviews],
        )
    return value


def trace_url(sample):
    base = settings.LANGFUSE_PROJECT_URL
    try:
        parsed = urlsplit(base)
    except ValueError:
        return None
    if not sample.trace_id or parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    return (
        base.rstrip("/")
        + "/traces?"
        + urlencode(
            {
                "filter": f"traceId;string;;equals;{sample.trace_id}",
                "dateRange": f"0-{int(timezone.now().timestamp() * 1000)}",
            }
        )
    )


def sample_dashboard(page):
    integer(page, 1, 1000000)
    queryset = retained_samples()
    # 최신 검토만 집계한다. 검토 이력이 많은 요청에 가중치가 생기지 않도록 한다.
    current = Q(reviews__version=F("review_version"))
    totals = queryset.aggregate(
        stored=Count("id", distinct=True),
        checked=Count("id", filter=Q(checks_status="checked"), distinct=True),
        pending=Count("id", filter=Q(checks_status="pending"), distinct=True),
        reviewed=Count("id", filter=current, distinct=True),
        issues=Count("id", filter=current & Q(reviews__verdict="issue"), distinct=True),
        unassessable=Count(
            "id", filter=current & Q(reviews__verdict="unassessable"), distinct=True
        ),
    )
    days = list(
        queryset.order_by()
        .annotate(date=TruncDate("received_at"))
        .values("date")
        .annotate(
            samples=Count("id", distinct=True),
            reviewed=Count("id", filter=current, distinct=True),
            acceptable=Count(
                "id", filter=current & Q(reviews__verdict="acceptable"), distinct=True
            ),
            issues=Count("id", filter=current & Q(reviews__verdict="issue"), distinct=True),
            unassessable=Count(
                "id", filter=current & Q(reviews__verdict="unassessable"), distinct=True
            ),
        )
        .order_by("date")
    )
    for day in days:
        day["date"] = day["date"].isoformat()
    start = (page - 1) * 20
    return {
        "scope": SCOPE,
        "enabled": settings.LLMOPS_PRODUCTION_SAMPLES_ENABLED,
        "retention_days": settings.LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS,
        "daily_limit": settings.LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT,
        "summary": totals,
        "days": days,
        "results": [sample_data(sample) for sample in queryset[start : start + 20]],
        "count": totals["stored"],
        "next": start + 20 < totals["stored"],
        "page": page,
    }


def locked_sample(sample_id):
    sample = retained_samples().select_for_update().filter(pk=sample_id).first()
    if sample is None:
        raise ProductionQualityError("PRODUCTION_SAMPLE_NOT_FOUND", 404)
    if digest(sample.material) != sample.material_sha256:
        raise ProductionQualityError("SAMPLE_MATERIAL_CHANGED", 409)
    return sample


def validate_review(payload):
    exact_fields(
        payload,
        {"request_id", "version", "material_sha256", "grounded", "relevant", "complete", "note"},
        {"reference_answer", "expected_status", "expected_citation_ids"},
    )
    request_uuid(payload["request_id"])
    integer(payload["version"], 0, 2147483647)
    if not isinstance(payload["material_sha256"], str) or not HEX64.fullmatch(
        payload["material_sha256"]
    ):
        raise ProductionQualityError("INVALID_MATERIAL_HASH")
    if any(
        not isinstance(payload[key], str) or payload[key] not in DECISIONS
        for key in ("grounded", "relevant", "complete")
    ):
        raise ProductionQualityError("INVALID_REVIEW_DECISION")
    text(payload["note"], 1000)
    text(payload.get("reference_answer", ""), 2000, blank=True)
    if payload.get("expected_status") is not None and (
        not isinstance(payload["expected_status"], str)
        or payload["expected_status"] not in STATUSES
    ):
        raise ProductionQualityError("INVALID_EXPECTED_STATUS")
    citation_ids(payload.get("expected_citation_ids", []))
    return {
        **payload,
        "reference_answer": payload.get("reference_answer", ""),
        "expected_status": payload.get("expected_status"),
        "expected_citation_ids": payload.get("expected_citation_ids", []),
    }


def save_review(sample_id, user, payload):
    values = validate_review(payload)
    stamp = digest({**values, "actor": user.pk, "sample_id": str(sample_id)})
    with transaction.atomic():
        sample = locked_sample(sample_id)
        previous = ProductionSampleReview.objects.filter(request_id=values["request_id"]).first()
        if previous:
            if previous.sample_id != sample.pk or previous.request_sha256 != stamp:
                raise ProductionQualityError("REVIEW_REQUEST_CONFLICT", 409)
            return sample
        if (
            sample.review_version != values["version"]
            or sample.material_sha256 != values["material_sha256"]
        ):
            raise ProductionQualityError("REVIEW_VERSION_CONFLICT", 409)
        if sample.checks_status != "checked":
            raise ProductionQualityError("SAMPLE_CHECKS_REQUIRED", 409)
        decisions = [values[key] for key in ("grounded", "relevant", "complete")]
        verdict = (
            "issue"
            if "no" in decisions
            else ("acceptable" if all(value == "yes" for value in decisions) else "unassessable")
        )
        if verdict == "acceptable" and sample.check_codes:
            raise ProductionQualityError("STRUCTURAL_ISSUES_REQUIRE_REVIEW")
        if not set(values["expected_citation_ids"]) <= {
            chunk["id"] for chunk in sample.material["chunks"]
        }:
            raise ProductionQualityError("EXPECTED_CITATION_NOT_IN_CONTEXT")
        sample.review_version += 1
        try:
            with transaction.atomic():
                ProductionSampleReview.objects.create(
                    sample=sample,
                    request_id=values["request_id"],
                    request_sha256=stamp,
                    version=sample.review_version,
                    material_sha256=sample.material_sha256,
                    verdict=verdict,
                    grounded=values["grounded"],
                    relevant=values["relevant"],
                    complete=values["complete"],
                    note=redact(values["note"])[:1000],
                    reference_answer=redact(values["reference_answer"])[:2000],
                    expected_status=values["expected_status"],
                    expected_citation_ids=values["expected_citation_ids"],
                    reviewed_by=user,
                )
        except IntegrityError:
            raise ProductionQualityError("REVIEW_REQUEST_CONFLICT", 409) from None
        sample.save(update_fields=["review_version"])
    return sample


def save_regression_candidate(sample_id, user, payload):
    exact_fields(payload, {"request_id", "version", "material_sha256"})
    request_uuid(payload["request_id"])
    integer(payload["version"], 1, 2147483647)
    if not isinstance(payload["material_sha256"], str) or not HEX64.fullmatch(
        payload["material_sha256"]
    ):
        raise ProductionQualityError("INVALID_MATERIAL_HASH")
    stamp = digest({**payload, "actor": user.pk, "sample_id": str(sample_id)})
    with transaction.atomic():
        sample = locked_sample(sample_id)
        previous = ProductionRegressionCandidate.objects.filter(
            request_id=payload["request_id"]
        ).first()
        if previous:
            if previous.sample_id != sample.pk or previous.request_sha256 != stamp:
                raise ProductionQualityError("CANDIDATE_REQUEST_CONFLICT", 409)
            return sample
        if (
            sample.review_version != payload["version"]
            or sample.material_sha256 != payload["material_sha256"]
        ):
            raise ProductionQualityError("REVIEW_VERSION_CONFLICT", 409)
        review = sample.reviews.filter(version=sample.review_version).first()
        if (
            review is None
            or review.verdict == "unassessable"
            or not review.reference_answer.strip()
            or review.expected_status not in STATUSES
        ):
            raise ProductionQualityError("REGRESSION_REFERENCE_REQUIRED")
        if (review.expected_status == "ANSWERED" and not review.expected_citation_ids) or (
            review.expected_status == "INSUFFICIENT_EVIDENCE" and review.expected_citation_ids
        ):
            raise ProductionQualityError("REGRESSION_CITATIONS_REQUIRED")
        if ProductionRegressionCandidate.objects.filter(sample=sample).exists():
            raise ProductionQualityError("REGRESSION_CANDIDATE_EXISTS", 409)
        try:
            with transaction.atomic():
                ProductionRegressionCandidate.objects.create(
                    sample=sample,
                    review=review,
                    request_id=payload["request_id"],
                    request_sha256=stamp,
                    created_by=user,
                    snapshot={
                        "schemaVersion": "production-regression-candidate-v1",
                        "scope": SCOPE,
                        "sample_id": str(sample.pk),
                        "review_id": str(review.pk),
                        "review_version": review.version,
                        "material_sha256": sample.material_sha256,
                        "source_document_id": sample.source_document_id,
                        "captured_at": sample.captured_at.isoformat(),
                        "release": sample.release,
                        "material": sample.material,
                        "redacted": sample.redacted,
                        "reference_answer": review.reference_answer,
                        "expected_status": review.expected_status,
                        "expected_citation_ids": review.expected_citation_ids,
                        "review": review_data(review),
                        "fixture_registered": False,
                        "baseline_eligible": False,
                    },
                )
        except IntegrityError:
            raise ProductionQualityError("CANDIDATE_REQUEST_CONFLICT", 409) from None
    return sample
