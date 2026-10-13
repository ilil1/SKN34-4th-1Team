# GovBiz Ops Service

LLMOps·관리자 시스템 개발을 위한 Django 서비스이며, `GovBiz` 모노레포의
`backend/ops-service`에서 관리합니다. 같은 저장소의 Core API·AI Service와 코드를 함께
관리하지만, Django 프로세스와 Ops 데이터베이스는 독립적으로 실행합니다.

소스 디렉터리·Compose 서비스·Kubernetes Deployment/Service/컨테이너 이름은 `ops-service`로 통일했습니다.
DB 컨테이너·내부 DNS는 `ops-mysql`, Python 패키지·health 응답은 `govbiz-ops-service`,
Kubernetes 검증 이미지 접두사는 `govbiz-ops-service`입니다.
이전 `.env.compose`에 `GOVBIZ_DJANGO_ENV_FILE=./backend/ops/.env`를 지정했다면
값을 `./backend/ops-service/.env`로 갱신하세요. 실제 비밀값과 데이터 볼륨은 바꾸지 않습니다.

[GovBiz-Team/GovBiz-ops](https://github.com/GovBiz-Team/GovBiz-ops)의 커밋
[`611232de21f69689c4024f3935b8d693b03b7777`](https://github.com/GovBiz-Team/GovBiz-ops/commit/611232de21f69689c4024f3935b8d693b03b7777)
추적 파일을 가져온 스냅샷입니다. 원본 Git 이력은 원래 저장소에 보존되며,
이 디렉터리는 서브모듈이 아닙니다. 실제 `.env`, 로컬 가상환경·Git 메타데이터는
가져오지 않았습니다.

현재 범위는 상태 확인 API, 기존 Core 관리자 인증 연동, 저장 응답 재평가·승인 기반 새 모델 평가 실행·이력·결과,
관리자 응답 검토·비교 기준 지정·실패 후처리 복구 API와
Gunicorn 이미지입니다. 공고·회원·신청 관리 업무와 기존 Spring Boot/FastAPI의
운영 데이터는 이전하지 않았습니다. 운영 배포는 별도입니다.

## 기술 구성

- Python 3.12
- Django 5.2 LTS, Django REST Framework
- Gunicorn 26.2 WSGI 실행 서버(배포 이미지 기본값)
- MySQL 8.4, `utf8mb4`
- uv 0.12.5와 `uv.lock`을 통한 의존성 고정
- Ruff, Django 테스트 러너
- Docker Compose, GitHub Actions CI

기존 웹의 관리자 계정으로 로그인합니다. Django는 요청마다 `govbiz_session` 쿠키만 Core의
`GET /api/v1/admin/session`에 전달해 현재 세션과 `ADMIN` 권한을 확인합니다. 로그아웃·만료·정지·
권한 변경이 다음 Ops 요청에 반영됩니다. Core 연결 실패는 `503`으로 거절합니다.
Django 사용자 행은 `core:{회원 ID}`와 이메일로 실행 요청자를 연결하며 로그인 가능한 비밀번호를
저장하지 않습니다. 이전 Django 운영자 세션이나 `is_staff` 값으로는 API에 접근할 수 없습니다.
회원 DB·JWT 서명 키는 Core만 소유하고 쓰기 요청에는 Django CSRF 검증도 적용합니다.

## LLMOps 운영 화면

### 성능 대시보드 조회

React `/ops/dashboard`는 기존 Core 관리자 인증을 거쳐 `GET /api/v1/ops/dashboard`를 호출합니다.
흐름은 `React → 같은 origin 프록시 → Django 관리자 인증 → EvaluationRun DB 요약 → 지표·추이`입니다.
집계 시 Prefect·산출물 서버·모델을 호출하거나 평가·예산·검토 데이터를 변경하지 않습니다.

- 최근 요청 200건을 조회하고 전체 건수·제한 여부·조회 시각·실행 상태와 제외 사유별 건수를 제공합니다.
  실행 상태 집계는 화면의 모델·자료·기간 필터 적용 전 범위입니다.
- 완료된 `live`와 `live`를 직접 원본으로 둔 완료 `recovery`만 실측으로 사용합니다. 복구는 원본 실행
  시각을 사용하고, 같은 조건·응답 해시는 최신 평가 결과 하나만 남깁니다. 재채점·합성·미완료 또는
  모델·자료·평가 버전 등 출처를 확인할 수 없는 결과는 제외합니다.
- 자료 ID·자료 해시·사례 집합·모델·평가 범위·채점 버전·검색 K가 같은 결과만 같은 추이로 묶습니다.
  프롬프트 변경은 이력에 표시합니다. 상태/인용/검색 지표와 측정 사례 수를 보존하고, 동일 측정 사례
  여부를 해시로 반환해 일부 사례가 바뀐 평균끼리 변화량을 계산하지 않습니다.
- 고정 근거 답변의 저장된 평균 지연·입출력 토큰은 그대로 제공합니다. RAG는 사례별 `answerElapsedMs`를
  집계한 `meanAnswerLatencyMs`와 측정 표본 수를 제공합니다. 임베딩·검색을 제외한 답변 Service 호출
  시간이며 전체 API 지연과 다릅니다. 시간 기록이 없는 과거 실행과 미측정 지표는 `null`로 유지하고
  화면에 사유를 표시합니다. 비용을 추정하거나 사람 검토 합격률로 바꾸지 않습니다.
- `configured_model`은 `LLMOPS_LIVE_MODEL`의 Ops 평가 설정입니다. 서비스 배포 모델 확인이나 실시간
  서비스 전체 품질 측정이 아닙니다. 자동 지표의 사람 검토는 기존 평가 상세에서 수행합니다.
- `allowed_models`는 새 평가와 동일한 허용 목록입니다. 웹은 기존 실측 모델과 함께 선택지에 표시하며,
  조회 범위에 결과가 없는 모델은 `미측정`으로 구분합니다. 빈 지표나 실행 기록을 생성하지 않습니다.
- 웹의 모델별 비교는 위 계열 정보에서 모델만 다른 최신 실측들을 나란히 표시합니다. 프롬프트·모델 외
  생성 설정·지표별 측정 사례까지 같을 때만 선택 모델 대비 차이를 계산하며, 조회 중 새 평가는 접수하지 않습니다.
  `generation_config_sha256`은 원본 live 실행의 생성 코드·설정과 입력/출력 상한·임베딩 설정을 묶습니다.
  해당 설정을 확인할 수 없는 과거 실행은 `null`이며 원래 지표와 상세 조회는 유지합니다.

집계/권한 단위 테스트는 `apps.evaluations.test_dashboard.DashboardAggregationTests`, 실제 MySQL API
조회·제한·쿼리·읽기 전용 검증은 `apps.evaluations.test_dashboard.DashboardApiTests`입니다. 후자는 Ops CI의
MySQL 8.4 전체 테스트에 포함됩니다.

선택한 최근 실측의 사람 검토는 별도 `GET /api/v1/ops/dashboard/runs/{run_id}/review-status`로
확인합니다. `React → Django 관리자 인증 → 기존 고정 근거/RAG 자료 검증·검토 판정 → 요약` 흐름으로,
현재 실행과 같은 자료의 지정 기준 실행만 확인합니다. 자료 검증에는 기존 산출물 저장소 읽기가
포함되며, 평가 실행·품질 판정 저장·기준 지정·예산 변경은 수행하지 않습니다.

- 현재 자료에 유효한 적합·부적합·보류, 미검토와 자료 변경으로 재검토할 사례 수를 구분합니다.
  RAG은 검색·답변·인용을 모두 적합으로 검토해야 사례 적합으로 셉니다.
- 참조 자료 승인, 고정 근거 답변의 전체 승인, 현재 품질 판정은 별도 상태입니다. 과거 합격도
  입력·정책이 달라지면 `STALE`, 자료·정책 확인이 안 되면 `UNAVAILABLE`로 표시합니다.
- 비교 기준은 현재 지정 행과 기존 승인·품질 조건을 다시 확인합니다. 다른 실행이나 조회 범위 밖의
  실행도 기준일 수 있습니다. 기준의 재검토 필요·확인 불가를 미지정과 구분합니다.
- 조회 실패는 503이며 미검토로 대체하지 않습니다. API는 GET 전용·캐시 금지이며 답변 본문,
  검토 사유·검토자 정보는 요약 응답에 포함하지 않습니다.

검토 요약의 DB 없는 테스트는 `apps.evaluations.test_dashboard_reviews.ReviewSummaryTests`,
고정 근거·RAG의 승인/철회/기준/자료 변경/권한 통합 테스트는 같은 모듈의
`FixedDashboardReviewTests`, `RagDashboardReviewTests`입니다. 실제 MySQL 검증은 Ops CI에서 수행합니다.

### 평가 자료와 실행 환경

실제 공고의 과거 답변 자료 `official-answer-20260907-v3`는 v2의 H01 참조에서 빠진
중소·중견 제조기업 범위를 보완한 별도 자료입니다. `/review`의 `material.reference_revision`은
이전 자료 ID·해시, 변경 사례, 사유, 원문 인용을 반환하며 React 상세에 표시합니다.
기존 버전에는 이 필드가 null이고 이전 API에서 필드가 없어도 화면은 동작합니다.
모델 응답은 과거 자료 그대로이며 이전 버전의 사람 승인·비교 기준을 승계하지 않습니다.
[자료 생성·검증 방법](../../evaluation/support-program-evidence/README.md#실제-공고의-과거-답변을-검토-자료로-사용)을 참고하세요.

첫 전체 실행은 [LLMOps 개발 환경](../../infrastructure/llmops/README.md#django-운영-화면)을 따르세요.
화면은 `frontend/web`의 React가 [localhost:5173/ops/evaluations](http://localhost:5173/ops/evaluations)에서
제공하고 Django는 18001 포트의 `/api/v1/ops` API를 담당합니다. 기존 Django 화면 주소는
`OPS_WEB_URL`(기본 `http://localhost:5173`)로 이동합니다. 아래 단독 Ops 구성은 8001 포트이므로
웹의 `OPS_DEV_PROXY_TARGET=http://127.0.0.1:8001` 설정과 평가 실행기 연결이 별도로 필요합니다.
루트 통합 Compose는 Django에서 `http://core-service:8080`으로 관리자 세션을 확인합니다.
전용 LLMOps Compose는 호스트 Core를 사용하며 회원 DB를 공유하지 않습니다.

- React: 기존 `/login`으로 로그인 후 Ops 복귀, 평가 요청·목록, 실행 상세·결과 요약, 보고서 링크
- Django: Core 관리자 확인, CSRF 토큰, 평가 요청·조회, 인증된 HTML 보고서 API
- Core: 기존 로그인·로그아웃과 관리자 세션 검증. 일반 회원은 Ops 접근 불가
- 가상 6건 재현과 과거 프롬프트 실행의 공통 E01 비교를 선택 가능; 임의 경로·코드를 요청으로 받지 않음; 모델은 서버가 제시한 승인 설정과 일치해야 함
- 새 응답 생성은 자료별 `live_options`의 모델·`live_config`·`execution_profile`을 함께 선택합니다.
  기존 `live_config`와 `execution_profiles.live`는 기본 모델 옵션으로 유지해 이전 클라이언트도 지원합니다.
  준비 조회(`evaluations/live-readiness`)는 선택한 `model`을 받으며 해당 모델의 실행 설정 해시를 확인합니다.
- 후보는 서버의 `apps/evaluations/capture_catalog.json` 등록 캡처 또는 승인된 새 응답 생성만 허용. 기준은 같은 자료의 등록 캡처 또는 관리자가 검토 후 지정한 완료 실행을 허용
- `EvaluationRun`: 요청 UUID, 요청자·자료·기준/후보·상태·시간, Prefect 실행 ID, 콘텐츠 평가 ID, 요약·비교 저장
- 요청 UUID를 DB 기본 키와 Prefect idempotency key로 사용; 같은 요청 재전송은 같은 실행을 반환
- Prefect `create_flow_run`의 일시적 HTTP 503만 같은 deployment·요청 바이트·idempotency key로
  최대 3회 전송하며 0.5초·1초 간격을 둡니다. 계속 실패하면 접수 미확인 상태를 유지합니다.
  deployment 조회 실패, 응답 유실·시간 초과·잘못된 JSON/실행 ID와 다른 HTTP 오류는 자동 재시도하지 않습니다.
  이 정책은 예산 승인·정산·모델 호출·취소 요청에는 적용하지 않습니다.
- Prefect 접수 응답 유실 시 `REQUESTED`와 오류 코드를 유지; 같은 요청으로 접수 재확인 가능
- 상태 원본은 Prefect. 상세/API 조회가 DB의 마지막 상태를 갱신하고 상세 화면은 진행 중 5초 간격으로 조회
- 실행 로그는 `GET /api/v1/ops/evaluations/{요청 UUID}/logs?offset=0`으로 조회합니다. Core 관리자 인증 후
  저장된 Prefect 실행 ID에 해당하는 로그만 내부 API에서 읽으며, 최신순 100개와 `next_offset`을 반환합니다.
  조회는 평가 실행·상태 동기화를 요청하지 않습니다. Prefect 장애는 503, 아직 접수되지 않은 실행은 409이며
  정상 조회의 빈 로그와 구분합니다. 브라우저의 `localhost:14200`이나 Prefect UI 공개는 필요하지 않습니다.
- 연결 장애는 마지막 상태와 오류를 함께 표시. 실패·취소·프로세스 중단·결과 확인 실패를 구별
- Prefect 완료와 결과 파일의 요청·선택 캡처 연결, 비교 JSON·보고서 해시를 모두 확인해야 Ops에서 완료 처리
- 평가 프로세스는 결과 볼륨에 쓰고 Django는 읽기 전용으로 접근. 보고서는 운영자 인증과 CSP sandbox 적용
- 과거 캡처에는 trace가 없으므로 Langfuse 세션 상세 대신 평가 ID로 필터링한 점수 목록에 연결

호출 흐름은 `React 운영 화면 → 같은 origin 프록시 → Django 인증·API → 평가 Service → Prefect HTTP API → 상시 평가 실행기`
입니다. 인증 경로는 `Django → Core 관리자 API → AdminPrincipalArgumentResolver → AccountSessionService`입니다. 실행기는 기존 `pandas → Pandera → 지표 재계산 → Evidently / Langfuse` 흐름을 사용합니다.
Django HTTP 요청 안에서는 평가하지 않으며 Django에 평가 SDK 전체를 설치하지 않습니다.
별도 Celery·Airflow·LLM provider는 추가하지 않았습니다. 저장 응답 재평가는 모델 호출 0회이며, 새 응답 생성은 아래 승인 계약을 따릅니다.

평가 모델 기본 목록은 `gpt-6-luna,gpt-6-sol,gpt-5.6-luna`입니다. `LLMOPS_ALLOWED_MODELS`로 CSV 목록을
조정할 수 있으며 `LLMOPS_LIVE_MODEL`은 기본 선택 모델로 항상 포함됩니다. 기본 모델만 허용하려면
두 설정에 같은 모델 하나를 지정합니다. API·평가 실행기에 같은 목록을 적용해야 합니다. Kubernetes도
같은 코드 기본값을 사용하며, 별도 환경변수로 덮어쓸 때는 Ops와 실행기 양쪽을 함께 반영합니다.
서버가 허용하지 않은 모델이나 모델에 맞지 않는 실행 설정은 접수·실행 전에 거절합니다. 기존 요청·일정은
저장한 모델을 유지하고 허용이 철회되면 차단되며 기본 모델로 대체하지 않습니다.

현재 평가 호출의 `reasoning.effort=none`과 구조화 응답을 지원하는 모델을 목록에 넣어야 합니다.
기본 후보는 [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)과
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)의 공식 호출 계약을 기준으로
선정했습니다. 목록에 표시된다고 프로젝트 API 키의 접근 권한이나 실제 평가 성공이 검증된 것은 아닙니다.
기존 예산은 호출 수·토큰 상한이며 모델별 금액 상한이 아닙니다. 각 유료 실행은 선택한 모델·자료·예산의
확인이 필요합니다.

## 실제 공고의 과거 답변 검토

`official-answer-20260907-v2`를 등록했다. 실제 기업마당 공고 2개·질문 6개를 고정 근거 범위로
재평가하며, 과거 `gpt-5.6-luna` 응답을 현재 모델 결과로 표시하지 않는다. 기존 `replay` 접수·검토·
품질 판정·기준 API를 사용한다. 새 DB migration·의존성·모델 호출은 필요 없다.

`GET .../{id}/review`의 material에 선택 필드 `data_type`, `candidate_origin`, `recorded_model`,
`recorded_at`을 추가했다. 사례의 `source`는 공식 URL·수집 시각·HTML/본문 해시·수집 범위를 담으며
가상 자료는 null이다. React는 이를 출처 링크·과거 응답 안내로 표시한다. 기존 API 응답도 계속 읽는다.
실제 공고 fixture v2의 원래 Core 청크 ID를 보존하고, 기존 가상 fixture v1의 ID 계약은 유지한다.

원본 참조는 AI 작성이다. 같은 `FixtureReview`와 사례별 검토·품질 정책을 적용하므로 사람 검토 없는
자동 합격·기준 지정은 허용하지 않는다. 새 자료를 파일에 등록해도 검토/평가 DB 행은 생성되지 않는다.
자료 형식·무료 검증·한계는 [평가 안내](../../evaluation/support-program-evidence/README.md#실제-공고의-과거-답변을-검토-자료로-사용)를 따른다.

## 고정 원문·청크의 새 RAG 실행

Ops에서 호출 계획이 등록된 RAG 자료를 고르고 **새 응답 생성**을 선택할 수 있습니다.
`React → Django 승인·누적 예산 예약 → Prefect → AI Service 임베딩·검색 → Answer Service/Agent → OpenAI → 캡처·보고서 → Ops 검토`로 진행합니다.
Django에는 평가 SDK나 별도 작업 큐를 추가하지 않습니다.

- API와 실행기에 `LLMOPS_LIVE_ENABLED=true`와 `LLMOPS_RAG_LIVE_ENABLED=true`가 모두 필요합니다.
  두 설정의 기본값은 `false`입니다. 기존 고정 근거 평가 활성화만으로 RAG를 실행하지 않습니다.
- 관리자가 자료·모델·호출 및 토큰 상한을 확인해야 접수합니다. 문서/질문 임베딩과 답변을
  하나의 요청으로 예약하며, 입력 토큰 누적 한도가 없거나 부족하면 접수하지 않습니다.
- 서버의 `rag_live_plans.json`은 원문을 복제하지 않고 토큰 배치·해시·호출 상한을 고정합니다.
  실행기는 실제 fixture와 토크나이저로 계획을 재계산하고 접수 명세와 다르면 호출 전에 거절합니다.
- 원문·청크는 등록 fixture로 고정합니다. 평가 전용 청크 벡터를 재사용하고 없는 것만 생성합니다.
  사례별 메모리 Qdrant로 복원한 뒤 질문 임베딩·검색·답변을 새로 실행합니다.
  **Core HTTP 경유, 원문 재수집·재청킹, 운영 색인 성능 측정은 포함하지 않습니다.**
- `live_config.document_vectors`는 사례별 벡터 키·파일 SHA-256·같은 실행에서 먼저 생성하는 사례를 고정합니다.
  저장 벡터와 동일 실행의 중복 문서 임베딩을 호출 계획에서 제외하여 호출·입력 예약을 줄입니다.
  session 조회 이후 계획이 바뀌면 다시 조회·확인해야 접수하며 같은 UUID 재전송은 기존 명세를 유지합니다.
  재사용 파일의 삭제·변경은 실행 전에 거절하고 유료 재생성으로 대체하지 않습니다.
- 벡터 파일은 기존 결과 볼륨의 `vector-cache/`에 보존합니다. Ops가 원격 결과 저장소를 쓰면 인증된
  `GET /v1/vector-cache/{64자리 키}`로 존재 여부·해시만 조회합니다. 파일 손상·조회 장애는 cache miss로 처리하지 않습니다.
  생성 후 준비 상태가 달라진 정기 실행 계획도 다시 검토해야 합니다. 정기 실행은 벡터가 준비된 상태에서 승인하는 것을 권장합니다.
- `capture/capture.json`에는 실제 검색·답변과 실패 단계를, `capture/usage-summary.json`에는
  실행 명세 해시·관측한 모델 전송 시도·입력 토큰 계산 요청 횟수를 저장합니다.
  호출별 인증된 사용량 영수증과 기존 예산 원장이 정산을 담당합니다. 미확정 사용량은 예약을 유지합니다.
- 자동 모델 재호출은 없습니다. 취소·승인 거절·사용량 미확정 이후에는 후속 모델 호출을 중단합니다.
  같은 UUID 재전송은 기존 실행을 반환하며, RAG 비활성화는 신규 접수와 worker 승인도 차단합니다.
- 새 실행 결과는 `recorded-live-evaluation`으로 표시합니다. 검색·인용·답변 상태 지표를 분리하고,
  품질 정책 `rag-review-quality-v4`에서도 자료와 사례의 사람 검토 없이는 합격·기준 지정이 불가능합니다.
- 모델 실행은 끝났으나 보고서·점수 등록이 실패한 경우, 검증된 완료 캡처로 무료 후처리 복구가 가능합니다.
  복구에는 새 모델 호출·예산 예약이 없으며 원본 실행과 복구 실행의 호출 수를 구분합니다.

활성화와 호출 범위는 [Compose 실행 안내](../../infrastructure/llmops/README.md#고정-원문청크의-rag-live-평가)를 따릅니다.
기능 구현·무료 대역 테스트는 실제 모델 품질 측정이나 사람의 검토 승인을 뜻하지 않습니다.

## 전체 RAG 저장 캡처 재평가

`rag-synthetic-multichunk-v1` 자료와 `rag-synthetic-capture-v1` 캡처를 선택하면 원문·청크·저장 검색
결과·저장 답변의 계약을 검증하고 검색 재현율·답변 인용 재현율·답변 상태 일치율을 재계산합니다.
등록 자료는 AI 작성 가상 공고·수동 분할 청크·합성 응답 3사례입니다. 실제 Core 청커나 모델의
실행 결과가 아니며 새 수집·검색·색인·임베딩·답변 생성은 수행하지 않습니다.

호출 흐름: `React → Django 명세 고정 → Prefect → rag_evaluate → Pandera → Evidently·Langfuse
점수 등록/재조회 → ops-sync → React 결과 조회`.

- 이 절은 `source-chunks-retrieval-answer` 범위의 `replay` 모드입니다. 호출 계획이 없는 자료는
  session의 `live_config`와 `execution_profiles.live`가 `null`입니다. 계획이 있는 자료의 새 실행은
  위 별도 활성화·승인·예산 계약을 따릅니다. 검토 기준(`run:`)은
  아래의 현재 RAG 합격 판정과 기준 버전을 검증한 경우에만 비교 대상으로 허용합니다.
- release의 `rag_evaluation`이 평가기·API 모델·결과 계약·잠금 의존성을 별도로 고정합니다.
  접수 명세에는 fixture·후보·비교 캡처 해시와 출처를 포함하며 기존 고정 근거 결과 형식은 유지합니다.
- 비교 결과 v3는 지표 값과 측정/대상 사례 수, 원본 실패 단계, 출처를 보존합니다.
  `summary.completed`는 **원본 답변의 완료 여부**입니다. Ops `COMPLETED`는 재계산·보고서·점수
  등록과 재조회 성공을 뜻하며 품질 합격이나 실제 RAG 실행 성공을 뜻하지 않습니다.
- 계약에 맞는 원본 실패·미실행 사례도 재평가할 수 있습니다. 손상된 입력·보고서 생성 실패·점수
  등록 실패는 작업 실패로 남깁니다. 후처리 복구는 같은 평가기와 고정 입력을 검증한 새 요청으로
  실행하며 원본 이력과 점수 ID를 유지합니다. 추가 모델 호출은 0회입니다.
- 합성 캡처에는 모델·프롬프트·trace를 만들지 않습니다. `baselineEligible=false`를 유지하며
  자동 의미적 사실성 점수는 미측정입니다. 별도의 사람 검토·품질 판정은 아래 절을 따르며,
  합성·무료 대역 출처는 모든 검토를 저장해도 합격·비교 기준으로 지정할 수 없습니다.

재평가 실행기 자체는 새 의존성·서비스가 필요하지 않습니다. 현재 검토·기준 기능에는 `0023`까지 migration이 필요하며 Ops·실행기·Web을 같은 소스로 갱신해야 합니다.
LLMOps CI의 `ops_smoke.py --rag-replay`는 기존 관리자 인증·CSRF·중복 UUID·보고서 접근·공유 로그아웃
경로에서 검색 0.5, 인용 0.25, 신규 모델 호출 0회와 출처 표시를 확인합니다.

실제 Core 무료 수집도 [저장 재평가 등록 명령](../../evaluation/support-program-evidence/README.md#core-캡처의-ops-저장-재평가-등록)으로
동일한 접수·Prefect 경로에 추가할 수 있습니다. 등록 목록·release·원본 자료를 함께 배포한 뒤 기존 React
목록에서 선택합니다. CI는 v1 9건·v2 1건의 원본 실패·trace·해시·보고서를 대조합니다. 이 기능은
무료 저장 캡처의 재계산이며 이를 실행해도 RAG live가 활성화되지는 않습니다. 사례 검토·품질 판정·비교 기준은 아래에서 별도로 관리합니다.

### RAG 사례 검토 자료 조회

완료된 RAG 실행의 React 상세 화면에서 **검토 자료 보기**를 누르면 고정 원문·청크, 후보·비교 답변,
검색 순서·답변 입력 순서·인용 근거를 대조할 수 있습니다. 사례 선택으로 전환하며 원문과 AI 작성
참조 조건은 펼쳐서 확인합니다. 원문은 HTML로 실행하지 않고 텍스트로 표시합니다.

조회 경로는 `React → GET /api/v1/ops/evaluations/{id}/rag-reviews → Core 관리자 인증
→ Django의 완료 보고서·접수 명세 검증 → 고정 fixture·후보·비교 캡처 → React`입니다.
GET은 자료와 현재 검토 버전·이력을 함께 반환하며 검토 기록을 쓰지 않습니다. 기존 `/rag-material`은 자료만 반환하는 읽기 API로 유지합니다. 조회·검토 저장 모두 새 모델 호출이나 Prefect 실행은 없습니다.

- 접수 명세의 SHA-256과 원본 바이트, 보고서의 사례·출처·검색/인용·실패를 대조합니다.
  `recovery` 실행은 복구 요청에 보존한 입력 artifact를 읽습니다. 불일치·누락은 `503 RESULTS_UNAVAILABLE`이며
  다른 자료로 대체하지 않습니다. 조회 응답은 `no-store`, 미인증은 `401`, 일반 계정은 `403`입니다.
- 원본 답변 실패에도 남아 있는 검색·답변 입력을 표시합니다. 미실행/미확인의 `null`과 실제 빈 인용 `[]`를
  구분하고, 합성·무료 모델 대역·저장 모델 기록의 출처를 따로 표시합니다.
- 자료 표시용 `material_sha256`은 **검토 승인 토큰이 아닙니다**. 원본의 AI 작성 출처와
  `baseline_eligible=false`를 유지합니다. 사람의 참조 자료 승인 여부는 `reference_review`에서 별도로
  확인합니다. 후보 사례 검토와 품질 판정·기준 지정은 아래 API로 별도 수행합니다.

Ops와 Web을 같은 소스로 갱신해야 새 화면과 조회 API를 사용할 수 있습니다. LLMOps CI의 기존 합성/Core
재평가 smoke에 자료 조회·해시·사례·실패 대조와 Core 로그아웃 뒤 접근 거절 검사를 추가했습니다.
로컬 검사 결과와 아직 확인하지 않은 통합 범위는 [후속 개발 전략](../../docs/llmops-next-development-plan.md)에 기록합니다.

### RAG 사례 검토 저장·이력

**후보 사례 검토 저장**에서 검색 적합성·답변 정확성·인용 적합성을 각각 `적합 / 부적합 / 판단 보류`로
선택하고 원문·청크를 대조한 근거를 1~3,000자로 기록합니다. 측정된 항목은 기본 판단을 미리 선택하지
않습니다. 검색 결과가 미측정이면 검색 판단은 보류만, 후보 답변이 없으면 답변·인용 판단은 보류만
허용합니다. 실제 빈 검색/인용 `[]`는 미측정 `null`과 구별합니다.

저장 흐름은 `React → 현재 Core 관리자·CSRF 재확인 → POST /api/v1/ops/evaluations/{id}/rag-reviews
→ 고정 자료 검증 → 짧은 MySQL transaction에서 실행 행 잠금 → 검토 이력 추가·버전 증가 → React`입니다.
외부 자료 읽기는 transaction 밖에서 수행하고 잠금 후 실행 명세·상태를 다시 대조합니다.

- 요청은 `case_id`, `retrieval_decision`, `answer_decision`, `citation_decision`, `comment`,
  `material_sha256`, `rubric_version`, `review_version`을 포함합니다. 판단 값은 `SUITABLE`, `UNSUITABLE`,
  `DEFERRED`입니다. 검토 기준은 `rag-case-review-v1`이며 GET에서 세 판단의 설명을 제공합니다.
- DB에는 세 판단·검토자·시각·의견과 자료/fixture/후보/비교/실행 명세 해시·검토 기준 버전을 보존합니다.
  새 판단은 기존 행을 수정하지 않고 추가하며 실행별 버전은 유일합니다. 최신 자료·기준과 일치하는
  사례별 마지막 기록만 `is_current=true`로 표시합니다. 이는 품질 합격을 뜻하지 않습니다.
- 동일 계정의 동일 본문·버전 재전송은 이력을 중복 생성하지 않습니다. 다른 계정·다른 판단·오래된
  자료/버전은 `409 REVIEW_CONFLICT`이며, 동시 요청은 실행 행 잠금으로 조정합니다.
- 입력 중에는 사례 전환·자료 새로고침을 잠급니다. 충돌이 나면 입력을 보존하되 저장을 막고,
  **입력 취소 → 검토 자료 새로고침 → 재검토**를 요구합니다. 통신 실패 뒤 같은 요청 재시도는 가능합니다.
  검토 중 로그인 계정이 바뀌면 POST 전에 중단합니다.
- RAG 사례 기록은 기존 고정 근거 승인·비교 기준 테이블에 쓰지 않습니다. RAG 품질 점검은 별도 정책으로 명시적으로 저장합니다. AI 작성 참조 조건을
  사람 검토 정답으로 바꾸지 않으며 합성/무료 대역 결과도 현재 모델의 기준으로 승격하지 않습니다.

`0021_rag_case_reviews`는 새 이력 테이블·제약만 추가하며 기존 평가·승인·기준 행은 변경하지 않습니다.
실제 사용 전 [갱신 절차](../../docs/ops-upgrade-runbook.md)에 따라 migration을 적용하고 Ops/Web을 함께
갱신해야 합니다. 이번 로컬 검증은 별도 MySQL 8.4의 `/app` 컨테이너에서 새 migration, 자료 경로,
동시 저장·CSRF·rollback과 기존 검토/기준 회귀 30건을 확인한 것입니다. 개발/운영 DB에는 적용하지 않았습니다.
새 SHA 전체 CI와 실제 관리자 브라우저→배포된 API의 저장 확인은 별도로 필요합니다.

### RAG 원문·참조 자료 검토와 승인 철회

**원문·참조 자료 검토**는 이 실행에 고정된 **모든 사례**의 원문·청크·질문·기대 상태·기대 인용을
대조한 사람의 판단을 저장합니다. `참조 자료 승인 / 수정 필요 / 판단 보류 / 승인 철회`를 선택하고,
근거 1~3,000자와 전체 대상 확인을 입력해야 합니다. 기본 판단은 비어 있습니다.
검토 중 사례를 전환해 전체 자료를 읽을 수 있으며 후보 검토·품질 점검·새로고침은 잠깁니다.

호출 흐름은 `React → 현재 Core 관리자·CSRF 확인 → POST .../{id}/rag-reference-review
→ 고정 자료 검증 → 실행 행 잠금·공유 검토 버전 확인 → 참조 이력 추가 → React`입니다.
자료 읽기는 DB transaction 밖에서 수행하고 잠금 후 실행 상태·명세를 다시 대조합니다.

- `GET .../{id}/rag-reviews`의 `reference_review`는 현재 승인 여부·최신 기록 ID·철회 가능 여부·전체
  이력과 검토 기준 `rag-reference-review-v1`을 제공합니다. 적용 범위는 `this-run-all-cases`입니다.
- POST 필드는 `decision`, `comment`, `fixture_sha256`, **순서를 포함한 전체** `case_ids`,
  `rubric_version`, `review_version`, `confirmed_all_cases=true`입니다. 결정 값은 `APPROVED`,
  `CHANGES_REQUESTED`, `DEFERRED`, `REVOKED`입니다. 부분·중복·과거 대상/버전은 거절합니다.
- `RagReferenceReview`는 자료·실행 명세 해시, 대상, 기준, 작성자·시각·근거·공유 버전을 저장합니다.
  후보 검토와 같은 `EvaluationRun.review_version` 및 행 잠금을 사용해 동시 저장을 조정합니다.
  원본 AI 출처·fixture·캡처·접수 명세는 변경하지 않고 다른 실행에 승인을 재사용하지 않습니다.
- 최신 참조 판단이 승인일 때만 철회할 수 있습니다. 철회는 원래 승인을 삭제하지 않고 대상 기록 ID를
  가리키는 새 이력을 추가합니다. 동일 작성자의 같은 본문·버전 재전송은 기존 행만 반환하므로
  철회 뒤 과거 승인 재전송으로 승인이 복원되지 않습니다. 재승인은 최신 버전에서 별도로 판단합니다.
- 자료 해시·대상·기준·실행 명세가 다르면 과거 승인은 현재 승인으로 취급하지 않습니다.
  참조 검토 변경 시 이전 품질 판정도 현재 판정에서 제외하고 명시적인 재점검을 요구합니다.
- `409 REVIEW_CONFLICT` 후에는 **참조 입력 취소 → 검토 자료 새로고침 → 재검토**가 필요합니다.
  자료 검증 실패는 `503`, 전체 확인/근거 누락은 `400`입니다. 기존 관리자·CSRF 경계와
  계정 변경·실행 이동 뒤 늦은 응답 차단을 유지합니다.

`0022_rag_reference_reviews`는 참조 이력 테이블과 제약만 추가합니다. 기존 검토·판정·기준을
변환하지 않으며 과거 실행에 승인을 만들어 넣지 않습니다. 실제 사용 전 [갱신 절차](../../docs/ops-upgrade-runbook.md)에
따라 migration과 Ops/Web 갱신이 필요합니다. 로컬 검증은 격리 DB에서만 수행했고 실제 사용자 승인이나
개발/운영 DB는 변경하지 않았습니다. 참조 승인 자체는 품질 합격·기준 지정·유료 실행 승인이 아닙니다.

### RAG 품질 점검·판정 이력

검토 자료 화면의 **현재 검토로 품질 점검 저장**은 저장된 사람 검토로 검색·답변·인용의 부적합과
검토 필요 사유를 기록합니다. GET 조회나 사례 검토 저장만으로 판정 행을 만들지 않습니다.
기존 `GET .../{id}/rag-reviews`에 `quality` 상태·현재 입력 해시·정책·이력이 추가되고,
`POST .../{id}/rag-quality`는 `input_sha256`을 받아 결과를 같은 검토 응답 형식으로 반환합니다.

현재 정책 `rag-review-quality-v4`의 규칙은 다음과 같습니다. 이전 v1·v2·v3 판정은 이력으로 보존하며 현재 판정으로 소급 변환하지 않습니다.

| 조건 | 처리 |
|---|---|
| 측정된 항목을 현재 사람 검토에서 부적합으로 판단 | `FAIL` — 화면에 부적합 표시; 다른 사례와 평균내어 감추지 않음 |
| 미검토·판단 보류·과거 자료/기준에 대한 검토 | 해당 항목의 검토 필요 사유 기록 |
| 검색/답변 미측정 | `NOT_MEASURED`; 0점이나 부적합으로 대체하지 않음 |
| 원본 실행 실패 | 사례별 실패 정보와 별도 사유 보존; 실패만으로 의미 품질 부적합을 단정하지 않음 |
| 합성·무료 대역 출처 | 현재 모델 품질이나 비교 기준의 근거가 아님을 표시 |
| 현재 원문·참조 조건 미승인·보류·과거 자료 승인 | `REFERENCE_REVIEW_REQUIRED` |
| 현재 참조 판단이 수정 필요·승인 철회 | 각각 `REFERENCE_CHANGES_REQUESTED`, `REFERENCE_REVOKED` |
| 실제 모델 저장 기록 + 현재 참조 승인 + 전체 사례의 검색·답변·인용 적합 + 실패/미측정 없음 | `PASS`; 비교 기준 지정은 별도 요청 필요 |
| 부적합은 없으나 위 조건 미충족 또는 빈 사례 | `NEEDS_REVIEW`; 합격·기준 지정 불가 |

미검토 AI 참조 조건과의 수치 불일치로 품질을 불합격 처리하지 않습니다. 현재 단계는 후보 검토 기반
품질 판정이며, 참조 승인은 별도 이력으로 반영합니다. 현재 정책은 `pass_enabled=true`이지만
`quality.baseline_eligible`은 현재 입력의 판정이 `PASS`일 때만 true입니다. 원본 보고서·조회 자료의
`baselineEligible=false`/`baseline_eligible=false`는 원본 계산만으로 승격하지 않는다는 뜻이며 사람 검토 판정과 별개입니다.

판정 흐름: `React → Core 관리자·CSRF 재확인 → 고정 자료·검토 스냅샷 조회 → 실행 행 잠금·버전 재검증
→ 정책 판정 → QualityAssessment 이력 저장 → React 사유·이력 표시`.

- 기존 품질 이력 테이블을 사용하되 실행 범위와 정책을 분리하며 고정 근거 승인·비교 기준은 변경하지 않습니다.
- 사후 점검의 정책 정의·정책 코드 해시·판정 코드 해시·자료/캡처 해시·실행 명세 해시·검토 기준·사례별 검토
  기록과 실패/측정 여부, 참조 승인·철회 상태와 이력을 입력 스냅샷으로 저장합니다. 접수 당시 정책·실행 명세는 소급 변경하지 않습니다.
- 검토 버전·자료·정책이 바뀌면 과거 판정은 이력으로 남고 현재 상태는 `NOT_EVALUATED`가 됩니다.
  UI는 다시 점검해야 함을 표시합니다. 저장 전 입력 해시 불일치는 `409 REVIEW_CONFLICT`입니다.
- 같은 입력의 동시 요청·재전송은 한 판정만 저장하며 최초 판정자·시각을 보존합니다. 다른 관리자가 동일한
  결정적 판정을 재요청해도 별도 행을 만들지 않습니다. 사례별 수동 판단의 작성자 충돌 규칙과는 별개입니다.
- 저장하지 않은 검토 초안이 있으면 품질 점검을 막습니다. 점검 저장 중에는 사례 입력·전환·새로고침을
  잠그고, 충돌 시 재조회·확인 후 재요청합니다. 계정 변경과 다른 실행으로 이동한 뒤의 늦은 응답도 차단합니다.

품질 판정은 기존 테이블을 사용합니다. 기준 지정까지 포함한 현재 응답에는 `0023` 적용과
Ops/Web 동시 갱신이 필요하며 production 의존성·모델 호출은 추가하지 않았습니다.

### RAG 비교 기준 지정·해제와 재평가

현재 `PASS`인 실행은 React에서 사유를 입력하고 **합격 실행을 비교 기준으로 지정**할 수 있습니다.
기준 지정은 자동으로 수행하지 않으며 모델을 호출하지 않습니다. 검토 기준은 자료별 한 개입니다.

- `GET .../{id}/rag-reviews`의 `baseline`은 버전·기준 실행·판정 ID·현재 선택 여부·변경 이력을 제공합니다.
- `POST .../{id}/rag-baseline`: `assessment_id`, `input_sha256`, `baseline_version`, `reason`을 검증합니다.
- `DELETE .../{id}/rag-baseline`: `baseline_version`, `reason`으로 지정된 기준을 해제합니다.
  판정이 오래돼 사용할 수 없는 기준도 명시적으로 해제할 수 있습니다.
- 현재 판정·자료·기준 버전과 일치해야 지정합니다. 후보 검토 변경이나 참조 승인 철회 시 기준을 해제하고
  변경 사유·이력을 보존합니다. 정책·자료가 달라진 과거 기준은 목록에서 제외하고 신규 접수도 거절합니다.
- 지정·해제 재전송은 같은 작성자·입력·버전의 기존 기록을 사용합니다. 철회 뒤 과거 지정 요청을 다시 보내도
  기준을 복원하지 않습니다. 기준 행 → 실행 행 순서로 잠그고 검토 변경과의 경합을 제어합니다.
- 관리자 세션에 유효한 `run:<UUID>` 기준을 제공하며 신규 재평가는 기준 버전과 판정 입력을 다시 검증합니다.
  `reference_config`에 기준 실행·캡처/fixture 해시·판정 ID/입력 해시를 고정하고 실행기는 해당 캡처를 복사·검증합니다.
  접수 뒤 기준이 철회돼도 기존 UUID 재전송의 명세는 유지하며, 철회된 기준을 사용하는 신규 요청은 거절합니다.

호출 흐름: `React 기준 선택 → Core 관리자·CSRF 확인 → Django 기준/현재 판정 검증 → 실행 명세 고정
→ Prefect → 기준 캡처 복사·무결성 검증 → 저장 캡처 재평가 → 보고서·점수·조회`.

`0023_rag_baselines`는 기존 기준·변경 이력에 RAG 판정 참조와 유형 혼용 방지 제약을 추가합니다.
기존 고정 근거 기준, RAG 참조 검토 및 과거 판정을 보존하며 자동으로 RAG 기준을 만들지 않습니다.
실제 모델 평가 자료·예산 승인은 별도이며 합격 판정만으로 유료 실행·정기 실행을 활성화하지 않습니다.

## 갱신 중 새 평가 접수 중지

`0020_evaluation_admission`은 접수 상태와 변경 기록 테이블을 추가하며 기존 평가·예산 행을 변경하지 않습니다.
기본 접수 상태는 허용입니다. 운영자는 `python manage.py evaluation_admission status`로 현재 상태·버전을
조회하고 `pause`/`resume`에 `--expected-version`, `--request-id`, `--actor`, `--reason`을 지정합니다.
동일 요청 재시도는 새 변경을 만들지 않으며, 이전 resume 재시도로 이후 pause를 해제하지 않습니다.
새 UUID를 사용하는 평가·후처리 복구는 중지 중 503 `EVALUATION_ADMISSION_PAUSED`로 거절합니다.
접수 상태 DB 조회 실패는 503 `EVALUATION_ADMISSION_UNAVAILABLE`이며 정상 허용으로 대체하지 않습니다.
기존 요청 재확인·동기화·취소·예산 정산·보고서 조회는 계속 허용합니다.

호출 흐름은 `새 요청 → 기준 검증 → DB 접수 상태 잠금 → 요청·예산 기록 → commit → Prefect HTTP`입니다.
중지 명령과 새 요청 생성이 같은 행을 잠급니다. 접수 상태 잠금은 기준 자료의 HTTP 조회가 끝난 뒤
획득하고 Prefect 실행 요청 전에 해제하므로, 자료 조회 지연이 접수 중지 명령을 막지 않습니다.
이 제어는 Prefect 직접 호출·스케줄을 중지하거나 백업 일관성을 보장하지 않습니다.
실제 명령과 최초 적용·재개 절차는 [갱신 runbook](../../docs/ops-upgrade-runbook.md)을 따릅니다.

최초 전환에는 `migrate_deployment --pause-request-id <UUID> --pause-actor <변경자>
--pause-reason <사유>`로 migration과 최초 접수 중지를 한 명령에서 확인할 수 있습니다.
세 옵션은 함께 지정하며 입력은 DB 변경 전에 검증합니다. 실행 흐름은
`입력 검증 → MySQL 배포 잠금 → 최초 접수 상태 확인 → 전진 migration → schema 확인 → 접수 중지 → 잠금 해제`입니다.
아직 변경하지 않은 접수 상태 또는 같은 UUID·변경자·사유의 version 1 중지만 허용합니다.
같은 요청의 반복 실행은 감사 행을 중복 생성하지 않으며, 이후 재개·추가 중지가 있었다면 재사용을 거절합니다.
옵션이 없을 때의 migration 동작은 그대로이며 이미 사용하는 접수 상태를 자동 변경하지 않습니다.
이 명령은 서비스 중지·백업·배포 승인을 대신하지 않습니다. 외부 접수와 API·sync·실행기를 먼저 중지해야 하며,
DDL 이후 실패하면 DB 일부가 변경됐을 수 있으므로 중지 상태를 유지하고 확인해야 합니다.

## 새 응답 생성 API

설정은 [LLMOps 실행 문서](../../infrastructure/llmops/README.md#ops에서-새-모델-평가)를 따릅니다.
`LLMOPS_LIVE_ENABLED=false`가 기본입니다. `GET /api/v1/ops/session`은 `live_enabled`와 자료별
`live_config`(모델, fixture SHA-256, 최대 호출 수, 호출당 최대 입력·출력 토큰)를 반환합니다.
POST는 기존 요청에 `execution_mode: "live"`, `candidate_capture_id: "new-model-response"`,
`live_config: <사용자가 확인한 session의 명세>`, `confirm_paid_run: true`,
`execution_profile: <session의 execution_profiles.live>`를 함께 전송해야 합니다.
기준 캡처는 같은 자료의 등록 캡처 또는 현재 검토 기준 실행만 가능합니다. 명세 불일치·미확인·비활성화는 DB 생성 전에 400입니다.
기존 요청 키로 실행 방식·승인 명세를 바꾸면 409이며 접수 재확인은 같은 명세를 유지합니다.

Migration `0003_evaluationrun_live`는 실행 방식·승인 명세·실제 호출 시도 수를 추가합니다.
기존 실행은 replay/0회로 유지합니다. 새 실행의 아직 확인되지 않은 호출 수는 null입니다.
실패한 실행도 부분 캡처가 있으면 시도 횟수를 표시하며 미확인 값을 0으로 만들지 않습니다.
비교 단계 manifest의 `model_api_calls: 0`은 **저장된 새 캡처를 채점하는 단계만** 뜻합니다.
Ops 응답의 `model_api_calls`는 새 응답 생성 단계의 `capture.modelApiCalls`를 확인한 값입니다.
완료 판정에는 기존 보고서 검증 외에 새 캡처 해시·모델·자료·사례·예산 확인이 필요합니다.
`trace_links`는 사례별 Langfuse 추적/점수 링크이며 과거 캡처는 기존 점수 목록 링크를 사용합니다.

### 실행 전 설정·예산 점검

React에서 **새 응답 생성 → 실행 설정·예산 점검**을 누르면
`GET /api/v1/ops/evaluations/live-readiness?dataset_id=...&execution_profile=...`로
선택한 자료의 실행 계획과 현재 장부를 읽습니다. `execution_profile`은 session 응답의
`execution_profiles.live`이며 서버 설정이 바뀌었으면 `409`로 새로고침을 요청합니다.

- 고정 근거는 답변 작업, 고정 원문 RAG는 문서·질문 임베딩과 답변 작업을 합산합니다.
  접수 때 사용하는 `profile`·`operation_plan`을 재사용하며 임베딩 출력은 0으로 계산합니다.
- `required`는 최대 예약량, `remaining`은 조회 시점의 잔여 호출·입력·출력 토큰입니다.
  금액 견적이나 실제 사용량이 아닙니다. 한도 미설정·장부 불일치 시 잔여량은 `null`이며
  입력 미확인도 0으로 채우지 않습니다.
- live/RAG 활성화, 새 접수 중지, 실행기 예산 인증 설정, 한도와 장부 일치·잔여량을 확인합니다.
  누적 입력 한도 미설정은 기존 정책대로 고정 근거에서 주의, RAG에서 차단입니다.
- `state=checked`는 이 점검 범위에서 차단 사유가 없다는 뜻입니다. `blockers`와 `warnings`를
  구분하며 API 키 유효성·실행기 가동·선택한 비교 기준·자료 승인·품질 합격은 확인하지 않습니다.
- 흐름은 `React → Core 관리자 세션 확인 → Django 실행 계획·MySQL 장부 조회 → React`입니다.
  GET은 접수 제어 행도 새로 만들지 않으며 모델·Prefect 호출, 예약·한도·감사 기록 저장이 없습니다.
  실제 접수 시 기존 승인·명세·기준·예산 검증을 다시 수행합니다.

관련 MySQL 테스트는 `apps.evaluations.test_live_readiness`입니다. API와 Web을 함께 반영해야 하며
이번 기능에 추가 의존성이나 migration은 없습니다.

## 일별 호출·입력·출력 토큰 한도

`0026_daily_evaluation_budget`부터 선택적인 **서울 시간(Asia/Seoul) 00:00~다음 날 00:00**
한도를 지원합니다. 정책이 없거나 해제돼 있으면 누적 한도만 적용합니다. migration은 정책이나
기본 한도를 만들지 않으며, 누적 사용량을 초기화하지 않습니다.

호출 흐름은 `관리자 접수 → 누적 예산 행 잠금 → 누적·일별 한도 검사 → 예약 → Prefect →
claim/호출별 authorize의 예약 날짜 검사 → 정산·종료`입니다. 고정 근거와 Ops RAG의 임베딩·답변
작업에 같은 검사를 적용합니다. 동일 접수 재전송은 기존 예약을 반환하지만 일별 정책이 적용 중이면
전날 예약의 새 claim/authorize는 거절합니다. 기존 호출의 정산·예약 종료·취소·증거 보정은 허용합니다.

일별 할당량은 **오늘 접수한 예약의 할당량 + 이전 날짜에서 남은 미확정 호출·미승인 예약·반환 대기량**입니다.
입력·출력 상한을 알 수 없거나 누락·불일치 장부가 있으면 잔여량은 `null`이고 신규 예약을 차단합니다.
확정된 이전 날짜 사용량은 누적 장부에 유지하며 오늘 한도에 다시 합산하지 않습니다.
과거 저장 응답 반영분은 반영 날짜가 아닌 원래 실행의 접수 날짜로 집계합니다.
늦은 정산·서명된 사용량 보정·취소 후 실제로 해제된 몫만 이월량에서 빠집니다.

일별 정책과 신규 예약은 같은 MySQL 누적 예산 행을 잠그므로 여러 API/실행기의 동시 접수도 같은
한도를 검사합니다. 일별 카운터 초기화 작업이나 별도 스케줄러는 없습니다.
이 정책의 날짜는 **예약 접수일**이며, 자정 직전 승인 후 자정을 지나 외부 API에 전송될 수 있으므로
제공자의 실제 청구일 기준 지출 상한으로 해석하지 않습니다. 월별·금액 한도는 지원하지 않습니다.

실제 적용 값은 운영자가 별도로 승인한 뒤 다음 명령으로 설정합니다. 누적 한도도 충분해야 합니다.

```bash
uv run --locked python manage.py set_daily_evaluation_budget \
  --calls "$APPROVED_DAILY_CALL_LIMIT" --input-tokens "$APPROVED_DAILY_INPUT_LIMIT" \
  --output-tokens "$APPROVED_DAILY_OUTPUT_LIMIT" \
  --actor "$BUDGET_OPERATOR" --reason "$BUDGET_CHANGE_REASON" --request-id "$BUDGET_CHANGE_REQUEST_ID"

# 일별 제한만 해제. 누적 한도·기존 예약·감사 이력은 유지합니다.
uv run --locked python manage.py set_daily_evaluation_budget --disable \
  --actor "$BUDGET_OPERATOR" --reason "$BUDGET_CHANGE_REASON" --request-id "$BUDGET_CHANGE_REQUEST_ID"
```

적용에는 호출·입력·출력 세 한도가 모두 필요하며, 현재 일별 할당량보다 낮은 값은 거절합니다.
동일 UUID·내용의 재전송은 기존 기록을 반환하고 나중 정책을 되돌리지 않습니다. 새 변경은 새 UUID를
사용합니다. 변경 전후 정책·변경자·사유를 저장하며 CLI 변경자는 운영자가 입력한 식별자입니다.
이 명령은 새 모델 실행·정기 실행을 활성화하지 않습니다.

`GET /api/v1/ops/budget`, `/budget/reservations`, `/evaluations/live-readiness`는 `daily`에
기간·상태(`disabled/enforced/unknown/exceeded`)·한도·오늘 몫·이월·잔여·최근 정책 이력을 반환합니다.
React 예산 화면과 실행 전 점검에서 이를 조회하며 일별 부족도 접수 차단 사유로 표시합니다.
`0027_admin_daily_budget_writes`부터 관리자 웹에서도 **일별 한도 설정 → 일별 변경 내용 확인 →
확인한 일별 정책 저장**으로 설정·변경·해제할 수 있습니다. 호출 흐름은
`React 확인 화면 → Core 관리자 세션·CSRF 검증 → 일별 정책 Service → 누적 예산 행 잠금 → 정책·감사 저장`입니다.
누적 예산이 먼저 설정되어 있어야 하며 일별 한도·기본 정책을 자동 생성하지 않습니다.

`POST /api/v1/ops/budget/daily-limits`는 `request_id`, `daily.limits_revision`을 담은
`expected_revision`, `disable`, `calls`, `input_tokens`, `output_tokens`, `reason`을 받습니다.
적용은 `disable=false`와 세 정수 한도를, 해제는 `disable=true`와 세 한도 모두 `null`을 전달합니다.
서버가 인증된 변경자를 기록하므로 클라이언트의 변경자·출처 지정은 거절합니다.
CLI 이력은 `source=CLI`, 인증된 관리자 이력은 `source=CORE_ADMIN`으로 구분합니다.

조회 이후 CLI나 다른 관리자가 정책을 바꾸면 409로 거절합니다. 이전 값으로 되돌린 변경도 감지하며,
잠금 안에서 오늘 할당량·이월량·장부 일치를 다시 검사합니다. 같은 관리자·UUID·버전·내용의 재전송은
이전 기록만 반환하고 이후 정책을 덮어쓰지 않습니다. 화면은 통신 응답 유실 시 동일 요청을 재확인하고,
409에서는 입력을 보존한 채 재전송을 막아 예산 재조회·재작성을 요구합니다.
저장 성공 시 이전 실행 전 점검 결과를 지웁니다. 페이지 이탈 이후 요청 복원 기능은 없습니다.
일별 제한 해제 후에도 누적 한도·사용량·예약·감사 이력을 유지하며 live/정기 실행을 활성화하지 않습니다.
`daily.limits_revision`이 없는 이전 API에서는 웹 설정 버튼을 숨기므로 Ops API와 Web을 함께 갱신해야 합니다.

## 누적 호출·출력 토큰 한도

Ops로 접수한 새 응답 생성은 `EvaluationBudget`의 **DB 전체 누적 호출 수·입력·출력 토큰 한도**를
공유합니다. 사용자·자료·실행기별로 별도 한도를 만들어 우회하지 않습니다. 예약·확정·미확인 사용량을
합산하며, 달력 기준 자동 초기화는 없습니다. 누적 입력 한도는 운영자가 `--input-tokens`로
명시적으로 활성화해야 합니다. 고정 근거 평가는 미설정이면 기존 호출·출력 한도만 적용되고,
Ops RAG live는 입력 한도가 없으면 접수하지 않습니다. 이 기능은 원화/달러 지출 상한이 아닙니다.
수동 `evaluate.py --execute`처럼 Ops 예약·승인 경로를 거치지 않는 호출은 적용 대상이 아닙니다.

호출 흐름은 `관리자 접수 → MySQL 전역 한도 잠금·예약 → Prefect → 실행기 소유권 확보 →
OpenAI 입력 토큰 계산 → 각 생성 전 Ops 승인 → 모델 응답 사용량 정산 → 실행 종료 시 미사용 예약 반환`입니다.

- 같은 UUID 재전송은 같은 예약을 사용합니다. 신규 UUID는 같은 DB 행을 잠그고 원자적으로 예약합니다.
- 실행기에는 매 프로세스마다 새 소유자 UUID를 부여합니다. 같은 작업의 다른 소유자와 중복 호출 번호는 거절합니다.
- 전송 승인 응답이 유실되면 다시 승인받아 모델을 재호출하지 않습니다. 해당 호출은 미확인 예약으로 남습니다.
- 입력·출력·총 토큰이 정수이고 합계·입력·출력 한도가 맞는 응답만 정산합니다. 사용량 누락·DB 장애·정산 실패는 다음 호출을 차단합니다.
- 종료가 확인된 실행은 미전송 몫과 확인된 입력·출력 차액만 반환합니다. 전송 후 timeout·사용량 미확인은 호출 1회와 기록된 최대 입력·출력 예약을 유지합니다.
- 강제 종료·접수 미확인·실행 전 오류로 종료 확인까지 도달하지 못한 예약은 자동 환급하지 않습니다.
  사람이 실행·공급자 사용량을 대조하는 복구 절차는 후속 과제이며 DB 값을 임의로 0으로 바꾸지 않습니다.

적용 순서는 같은 버전의 Ops·실행기를 빌드하고 migration `0018_operation_token_limits`까지 적용한 뒤,
양쪽에 동일한 `LLMOPS_BUDGET_TOKEN`을 주입하는 것입니다. 32자 이상의 무작위 비밀값을 사용하며
관리자 쿠키·모델 API 키와 공유하지 않습니다. 실행기의 `LLMOPS_OPS_API_URL`은 Ops의 내부 주소입니다.
과거 live 접수에 예약을 소급 생성하지 않으며, 예약이 없는 기존 미전송 요청은 차단합니다.

운영자가 승인한 한도만 아래 명령으로 설정합니다. 예시는 형식 설명이며 실행 승인이 아닙니다.

```bash
# backend/ops-service, 승인된 환경변수 값을 사용
uv run --locked python manage.py set_evaluation_budget \
  --calls "$APPROVED_CALL_LIMIT" --output-tokens "$APPROVED_OUTPUT_TOKEN_LIMIT" \
  --input-tokens "$APPROVED_INPUT_TOKEN_LIMIT" \
  --actor "$BUDGET_OPERATOR" --reason "$BUDGET_CHANGE_REASON" --request-id "$BUDGET_CHANGE_REQUEST_ID"
```

이 명령은 사용량을 초기화하거나 live를 활성화하지 않습니다. 기존 예약·확정 합계보다 낮은 한도는
거절합니다. 미설정·한도 부족·실행기 인증 미설정 상태의 신규 접수는 HTTP 400
`LIVE_BUDGET_UNAVAILABLE`로 거절하며 Prefect에 전송하지 않습니다. 기존 자료·모델 동의와
`LLMOPS_LIVE_ENABLED` 조건도 계속 필요합니다.

실행기 전용 API는 `POST /internal/llmops/evaluations/{run_id}/budget/{claim|authorize|settle|close}`이며,
별도 Bearer 비밀값과 실행 UUID·명세 해시·소유자 UUID를 확인합니다. 사용자 세션 API와 인증을 공유하지 않습니다.
기본 한도를 넣거나 스케줄·유료 평가를 자동 활성화하지 않습니다.

### 입력 상한과 이전 장부 전환

새 고정 근거 평가에는 호출당 입력 **32,768토큰**을 명세·예약에 고정합니다. 접수 시 사례 수 × 상한을
예약하고 생성 직전에 OpenAI `/v1/responses/input_tokens`로 실제 요청의 모델·메시지·지침·응답 JSON
스키마·추론 설정을 계산합니다. 정수 결과가 없거나 상한을 넘으면 생성 승인·전송 없이 중단합니다.
`authorize.input_token_count`는 그 계산값이며, 실제 정산 사용량으로 대체하지 않습니다.
계산 API는 추가 외부 요청입니다. `modelApiCalls`에는 답변 생성만, 계산 요청에는 별도 캡처 카운터를 씁니다.

`0017_input_token_budget`는 기존 정산·보정에서 확인된 입력만 합산해 새 할당 장부를 초기화합니다.
과거 예약 상한과 생성 전 계산값은 NULL로 보존합니다. 열린 구형 예약, 미정산 구형 호출 또는 예약 없는
과거 live가 있으면 입력 한도 활성화를 거절합니다. 증거 없는 사용량을 0으로 보정하거나 임의로 삭제하지 않습니다.
예약 없는 과거 실행의 소급 정산 도구는 아직 없습니다. 이런 환경은 전체 입력 예산을 적용했다고 간주하면 안 됩니다.
입력 상한 없는 구형 호출은 정산·증거 보정 시 확인된 입력을 합산하며 같은 요청의 재전송은 중복 반영하지 않습니다.

새 예약은 입력 한도 미설정 상태에서도 입력 몫을 기록합니다. 한도를 활성화하면 기존 할당량보다 작게
설정하거나 후속 변경 명령에서 입력 한도를 생략·해제할 수 없습니다. 같은 요청 UUID는 입력 한도까지
같아야 재사용됩니다. 정산 후 종료 전에는 입력 차액도 반환 대기로 남고, 미확인 호출은 종료 후에도
32,768 입력 예약을 유지합니다. 종료 정리와 서명 증거 보정은 입력·출력 장부를 함께 원자적으로 갱신합니다.
배포 전 기존 실행을 종료·정리하고 migration → 같은 소스의 Ops·실행기 배포 순서를 지킵니다.
이번 개발에서는 기존 개발 DB에 migration이나 실제 한도 변경을 적용하지 않았습니다.

### 사례별 답변 작업 승인

새 live 명세의 `model_operations`는 사례 순서별 `answer:{case_id}` 작업 ID·종류 `answer`·
사례 ID·모델·최대 입력·출력 토큰을 고정합니다. 실행기는 실제 HTTP 전송 직전 해당 작업 ID를
`authorize`에 전달하고, 그 요청에 연결된 같은 ID로 `settle`합니다.
서버는 명세의 사례·모델·상한·순서와 다른 작업, ID 누락, 중복 승인, 미정산 상태의 다음 승인을 거절합니다.
취소 뒤 새 작업은 승인하지 않지만 이미 승인한 작업의 정산·예약 닫기는 허용합니다.
승인 응답이 유실되어도 같은 작업 승인을 다시 발급하지 않으며 미확인 몫은 유지합니다.

흐름: `접수 명세의 사례별 작업 → 실행기 HTTP 전송 직전 승인 → MySQL 호출 장부 →
응답 요청에 연결된 작업 정산 → 관리자 API → React 실행 예산 장부`.
`0016_budget_operation_identity`는 호출의 nullable `operation_id`와 예약 안의 작업 고유성 제약을
추가합니다. 과거 호출은 null로 유지하고 현재 사례 순서로 소급 매핑하지 않습니다.
작업 계획이 없는 기존 명세에는 기존 프로토콜만 허용합니다. 새 실행기는 현재 실행 명세와 파일 해시가
일치해야 하므로 구형 요청을 새 계획으로 자동 실행하지 않습니다. 배포 시 migration 후 Ops와 실행기를
같은 소스로 갱신해야 합니다. 서명 사용량 기록 v1의 실행·명세 해시·호출 번호는 그대로 해당 장부를 식별합니다.

### 임베딩 배치별 예산: 내부 실행 계약

`source-chunks-retrieval-answer`의 내부 작업 명세에 문서 임베딩·질문 임베딩·답변을 구분했습니다.
공개 접수·Prefect의 고정 원문·청크 RAG live는 위 별도 활성화·승인 계약으로 이 예산 경계를 사용합니다.
내부 예산 계약 자체는 품질 판정을 수행하지 않으며 일반 서비스의 임베딩 호출에 자동 적용되지 않습니다.

- 예약은 작업별 입력·출력 상한의 **합계**입니다. 임베딩 출력 상한은 0이고 누적 입력 한도 설정이 필수입니다.
  실행의 `max_input_tokens`·`max_output_tokens`는 작업 상한 중 최댓값이며 총 예약량이 아닙니다.
- 임베딩은 `document_embedding:{label}:{batch}` / `query_embedding:{label}:{batch}` ID에
  모델·차원·전처리된 실제 배치의 SHA-256·최대 입력을 고정합니다. Ops에는 원문을 보내지 않습니다.
- 승인 시 해당 작업의 ID·모델·차원·입력 해시·계산값·출력 0을 대조합니다. 캐시로 전송하지 않은
  임베딩 슬롯만 건너뛸 수 있으며 이전 슬롯 재승인·답변 건너뛰기·미정산 상태의 다음 호출은 거절합니다.
- `0018_operation_token_limits`는 예약 총량과 호출별 입력·출력 상한 4개 nullable 필드를 추가합니다.
  과거 값은 NULL로 보존하고 당시 예약 상한으로 읽습니다. 미확인 입력을 0으로 소급 채우지 않습니다.
- 정산·취소·종료 정리·장부 조회는 개별 호출 상한을 사용합니다. 캐시 미전송 몫과 확인된 차액은
  종료 때만 반환하며 미확인 임베딩은 해당 입력 상한을 유지합니다. 동시 예약은 같은 전역 행을 잠급니다.
- 기존 서명 영수증 v1은 **답변 보정 전용**입니다. 임베딩은 별도 v2 증거로 승인 배치와
  제공자의 요청 ID를 대조해 입력 차액만 보정합니다. timeout·사용량/요청 ID 누락 등 증거가 없는
  미확인 호출은 입력 예약을 유지합니다. [보정 계약](#증거-기반-미확인-사용량-보정)을 따릅니다.

실제 SDK 전송 검증은 [평가 실행기 임베딩 가드](../../evaluation/support-program-evidence/README.md#임베딩-배치-예산-연결-내부-실행기)를 따릅니다.
기존 AI 색인·검색·답변을 같은 예약으로 실행하는
[혼합 RAG 예산 세션](../../evaluation/support-program-evidence/README.md#혼합-rag-예산-세션)도 추가했습니다.
이미 예약된 내부 명세를 받으며 claim/close, 실제 검색 근거 대조, 답변 입력 계산·승인·정산을 수행합니다.
기존 실행기 단위 테스트의 예산 HTTP는 대역입니다. 별도의
[실제 Ops HTTP·MySQL 통합 검사](../../evaluation/support-program-evidence/README.md#실제-ops-httpmysql-혼합-예산-검증)는
격리 MySQL 8.4와 별도 AI 프로세스로 정상·캐시·취소·동시 승인·정산 전후 응답 유실·증거 보정을
검증하며 필수 Ops CI에 연결했습니다. 이 검사에서도 모델은 무료 전송 대역입니다.
추가로 [Core 캡처의 Ops 예약·정산 검사](../../evaluation/support-program-evidence/README.md#core-캡처의-ops-예약정산-연결)는
실제 Core 준비 명세로 테스트 DB의 실행·예약을 만들고 같은 명세의 HTTP 승인·정산을 대조합니다.
예산 부족 시 실행·예약 롤백, 입력 변경 차단과 미확정 사용량 유지도 검사하며 필수 LLMOps CI에 연결했습니다.
고정 원문·청크 RAG의 공개 접수·manifest·Prefect 연결은 위 신규 실행 경로에 구현했습니다.
Core 원문 재수집·재청킹, runner→Kubernetes Ops 왕복 검증, 금액·월별 한도는 별도 범위입니다.

## 예산 조회와 한도 변경 감사

호출 흐름은 `React → Core 관리자 세션을 확인하는 Django Ops API → MySQL 장부`입니다.
추가 production 의존성과 모델 호출은 없습니다. 아래 API는 기존 관리자 로그인을 재사용합니다.
내부 실행기 Bearer 토큰이나 이전 Django 세션으로는 접근할 수 없습니다.
쓰기는 Core 관리자 재검증과 CSRF·Origin 검사를 거칩니다.
관리자는 다른 요청자의 장부도 볼 수 있지만, 평가 취소는 계속 요청자만 가능합니다.

| API | 응답 |
|---|---|
| `GET /api/v1/ops/budget` | 전체 한도·저장된 할당량·잔여 한도·구성별 총계·최근 변경 10건과 전체 변경 건수 |
| `GET /api/v1/ops/budget/reservations?page=1` | 25건씩 예약 목록과 같은 조회 시점의 **전체** 예산 요약 |
| `GET /api/v1/ops/evaluations/{run_id}/budget` | 해당 실행의 예약·호출별 작업 ID(과거 null)·승인 시각·확정 사용량·정산 시각 |
| `GET /api/v1/ops/budget/unaccounted-runs?page=1` | 예약·과거 사용량 반영 기록이 없는 live 실행을 25건씩 조회. 미완료·새 명세 실행도 누락 없이 표시 |
| `GET /api/v1/ops/evaluations/{run_id}/legacy-usage-preview` | 기존 과거 사용량 검증기로 저장 자료 무결성·전체 사용량·현재 한도 대비 반영 조건을 읽기 전용 확인 |
| `POST /api/v1/ops/budget/limits` | 조회한 한도 버전·요청 UUID·사유와 호출/입력/출력 누적 한도를 검증하고 변경 감사 저장 |
| `POST /api/v1/ops/budget/daily-limits` | 일별 정책 버전·요청 UUID·사유를 확인하고 일별 세 한도 설정·변경·해제와 감사 저장 |
| `POST /api/v1/ops/evaluations/{run_id}/legacy-usage` | 검토한 증거 해시·요청 UUID·사유로 과거 저장 응답 사용량을 재검증·반영 |

React 평가 목록에는 전체 요약·실행별 예약·최근 한도 변경을, 실행 상세에는 예약과 호출별
승인·정산을 표시합니다. 15초 간격으로 조회하며 실패 시 마지막 조회 시각과 오류를 함께 유지합니다.
**누적 한도 설정 → 변경 내용 확인 → 확인한 한도 저장**으로 누적 한도를 변경합니다.
자동 환급은 하지 않습니다. 전체 변경 이력은 DB에 보존하며 첫 화면은 최근 10건만 표시합니다.

한도 POST에는 `request_id`, GET 요약의 `limits_revision`을 담은 `expected_revision`,
`calls`, `input_tokens`, `output_tokens`, `reason`을 전달합니다. 입력 한도 최초 미설정은
명시적인 `null`이며 활성화한 입력 한도를 다시 해제할 수 없습니다. 조회 후 한도가 변경되면
409로 재검토를 요구합니다. 이전 값으로 되돌아온 변경도 감지하며, 저장 시 잠금 안에서 최신
할당량과 장부 일치를 재검증합니다. 기존 할당량 아래로 낮추거나 미확인 과거 입력을 남긴 채
입력 한도를 활성화할 수 없습니다. 금액·기간별 예산이나 모델 실행 활성화 설정은 아닙니다.

**미반영 실행 목록 확인 → 대상의 사용량 확인**으로 검토 대상을 찾을 수 있습니다.
목록은 사용량 반영 가능성을 보장하지 않으며 파일을 읽지 않습니다. 개별 확인에서만
`reconcile_legacy_usage(..., apply=False)`로 CLI와 같은 저장 request·manifest·comparison·capture
연결과 전체 호출 사용량을 검증합니다. 이 API는 모델·Prefect 호출, 예약 생성, 한도 변경,
사용량 감사 저장을 하지 않습니다. POST·PUT·PATCH·DELETE는 405입니다.

미리보기의 `state=verified`는 저장된 사용량을 확인했다는 뜻입니다. 한도 미설정·부족 또는
장부 불일치는 `can_apply=false`와 `blockers`로 표시하되 확인한 사용량은 유지합니다.
대상 조건·자료 무결성·전체 사용량을 확인하지 못하면 `state=unavailable`과 사유만 반환하고
토큰 수나 해시를 추정하지 않습니다. 응답에는 원문·답변·실행 명세·가짜 검토자 기록을 담지 않습니다.
`as_of`는 검증 완료 시각이며 예상 반영 후 합계는 실제 반영 결과가 아닙니다.
화면은 다른 실행 선택·페이지 이동·새로고침 때 이전 결과를 제거하고 지연 응답을 무시합니다.

과거 사용량은 `0024_legacy_usage`의 별도 감사 테이블에 기록합니다. 화면에서는 반영 조건을
충족한 미리보기에 검토 사유·사용량/출처 확인을 입력하고 **검토한 사용량 반영**을 누릅니다.
POST는 `request_id`, `evidence_sha256`, `reason`만 받으며 검토한 자료·전체 사용량·한도를
잠금 안에서 다시 확인합니다. CLI의 `reconcile_legacy_evaluation_usage --apply`도 유지합니다.
조회나 장부 반영은 답변 품질 승인이 아니며 저장 응답 사용량은 제공자의 청구 확인과 구분합니다.

위 쓰기 API는 변경자·출처를 클라이언트에서 받지 않습니다. 인증된 Core 사용자와
`CORE_ADMIN` 출처를 기록하며, 기존 CLI 이력의 자기 기입 변경자와 `CLI` 출처를 보존합니다.
동일 요청 UUID·동일 관리자·동일 입력의 재전송은 이전 이력만 반환합니다. 다른 요청 내용이나
관리자로 UUID를 재사용하면 409입니다. 화면은 응답 유실 후 같은 UUID로 재확인하며
한도·사용량 저장으로 새 모델 호출, 예약 생성 또는 사람 검토 승인을 수행하지 않습니다.

예산 구성은 다음과 같습니다. 호출 한도는 호출 횟수, 출력 한도는 토큰 수이며 금액이 아닙니다.

| 구분 | 호출 수 | 출력 토큰 |
|---|---|---|
| 확정 사용량 | 정산 또는 증거 보정 완료 호출 | 정산값 또는 검증한 보정값 |
| 승인 후 미확인 | 정산·보정 모두 없는 승인 호출 | 해당 호출의 최대 출력 예약 |
| 미승인 예약 | 열린 예약의 미승인 호출 | 미승인 호출 × 호출당 최대 출력 |
| 종료 전 반환 대기 | 추가 호출 없음 | 열린 예약의 정산 완료 호출별 최대 출력 − 실제 출력 |

`settle`은 사용량만 기록하므로 6회 × 2,000을 예약해 첫 호출이 50토큰으로 정산돼도
`close` 전 할당량은 12,000입니다(확정 50 + 미승인 10,000 + 반환 대기 1,950).
미확인 호출은 예약이 닫힌 뒤에도 최대 출력 몫을 유지합니다. 입력 토큰도 같은 예약·정산 구조로 집계하되, 과거 상한 누락을 미확인으로 구분합니다.
승인 기록을 실제 전송 완료·비용 확정으로 해석하지 않습니다.

전체 장부·예약·실행 장부 응답은 전역 예산 행을 쓰기 경로와 같은 방식으로 잠그고 총계·페이지 내역을 구체화한 후 해제합니다.
외부 관리자 인증은 이 transaction 전에 끝납니다. `as_of`는 잠금을 획득한 조회 시각입니다.
합계가 저장된 할당량과 다르면 `state=inconsistent`, `remaining=null`이며 자동 보정하지 않습니다.
미설정은 `unconfigured`와 null 값으로 표시합니다. 과거 live 실행의 예약 부재는 `missing`으로
구분하고 전체 응답에 `legacy_live_run_count`를 제공합니다. 입력은 `input_state`의 `enforced`/
`unconfigured`/`legacy_unknown`으로 구분하며 과거 미확인 몫이 있으면 `allocated.input_tokens`와
`remaining.input_tokens`는 null입니다. 상세 `allocated_input_tokens`는 확인값과 상한이 있는 예약의 부분 합계로,
`unbounded_input_calls`/`unbounded_input_reservations`가 있으면 전체 입력 사용량이 아닙니다. 이 실행의 사용량을 0으로 만들지 않습니다.
replay/recovery 자체에는 새 모델 예약이 없어 `not_applicable`이며 원본 비용은 원본 장부를 확인합니다.

최신 Ops API 배포 전 migration **`0028_daily_evaluation_schedules`까지** 적용해야 합니다.
`0028`은 종료일이 있는 정기 계획과 날짜별 접수 이력 테이블을 추가합니다. 기존 평가·예산 행은 수정하지 않습니다.
`0027`은 일별 정책 변경의 인증된 변경자 FK·조회 버전·출처 제약을 추가하며 기존 CLI 기록을 보존합니다.
`0025`는 인증된 변경자 FK·한도 조회 버전·출처 제약을 추가하며 기존 CLI 기록을 그대로 보존합니다.
`0013_budget_change_audit`는 한도 변경 감사를, `0014`는 종료 예약 정리 감사를,
`0015_usage_correction`은 사용량 보정과 원본 증거를, `0016`은 새 호출의 작업 ID를 저장합니다.
`0017`은 입력 한도·할당량·예약 상한·생성 전 계산값을 추가하고 확인된 과거 입력만 합산합니다.
`0018`은 작업별 상한·예약 합계를, `0019`는 임베딩 요청 ID와 응답 식별자 제약을 추가합니다.
기존 답변 보정의 ID·증거·사용량을 보존하며, 새 코드 배포 전에 migration을 적용합니다.
`set_evaluation_budget`에는 변경자·사유·요청 UUID가 필수입니다. `--actor`는 CLI 운영자가 입력하는
식별자이며 Core 로그인으로 인증한 신원이 아닙니다. 위 예시의 `BUDGET_CHANGE_REQUEST_ID`는
요청 전에 한 번 생성·보관한 UUID를 사용하고 **같은 요청 재시도에는 같은 값**을 전달합니다.
동일 UUID의 한도·변경자·사유가 다르면 거절하며, 이전 요청을 재전송해도 이후 변경을 되돌리지 않습니다.
현재 한도 변경과 감사 행 저장은 같은 transaction입니다. 감사 저장 실패 시 한도 변경도 롤백합니다.
이전/새 한도·CLI 출처·변경자·사유·시각을 저장하며 기존 한도에 가짜 과거 이력을 소급 생성하지 않습니다.

관련 검증은 `apps.evaluations.test_admin_budget_writes`, `test_budget_reporting`, `test_budget`,
`test_legacy_usage`, `test_legacy_usage_views`, `test_cancellation`과 Web의 `BudgetLimitsForm.test.tsx`,
`UnaccountedRunsPanel.test.tsx`, `BudgetPanel.test.tsx`, `App.ops.test.tsx`입니다. MySQL 동시 조회/정산·최초 한도 설정 경합·
감사 실패 롤백, API 권한·페이지 경계, 화면의 미확인/0토큰 구분을 포함합니다.
전체 Ops/MySQL·Web 빌드·실제 취소 서버 검증은 기존 필수 CI에서 계속 실행합니다.

## 종료된 예약의 미사용 몫 정리

취소 없이 실패하거나 실행기의 `close`가 실패해 열린 예약이 남았을 때 운영자가
`cleanup_evaluation_budget`를 사용합니다. 기본값은 **쓰기 없는 미리보기**이며 `--apply`를
명시해야 예약을 닫습니다. 새로운 production 의존성·모델 호출·실행 재개는 없습니다.
기존 실행기의 `close`와 취소 종료 정리는 유지하며, 이 CLI는 이미 닫힌 예약에 이력을 소급 생성하지 않습니다.

호출 흐름은 `운영자 CLI → Prefect 종료 증거 GET → Django → MySQL 예약·정리 감사`입니다.
외부 조회는 transaction 밖에서 끝내고 `실행 → 전역 예산 → 예약` 순서로 잠급니다.
잠금 안에서 소유자·명세·예약 변경 여부와 전체 장부 합계를 다시 대조합니다.

- Prefect의 실행 ID·접수 UUID·전체 실행 파라미터·명세 해시·종료 상태 ID/시각을 확인합니다.
  `COMPLETED`, `FAILED`, `CRASHED`, `CANCELLED`만 허용합니다. 로컬 DB 상태나 시간 경과만으로 정리하지 않습니다.
- 미승인 호출 몫과 정산된 호출의 최대 출력 대비 차액만 반환합니다. 승인 후 미확인 호출은
  최대 출력 몫을 그대로 유지합니다. 호출 번호가 끊기거나 전체 할당량이 상세와 다르면 거절합니다.
- 정리 이후 기존 worker의 claim·authorize·settle은 거절됩니다. 늦은 사용량 증거를 반영하는
  C2는 아래의 별도 CLI로만 적용하며, 증거 없는 미확인 예약은 유지합니다.
- 변경자·사유·요청 UUID·종료 증거·당시 소유자/호출별 승인·정산·전후 장부를
  `EvaluationBudgetCleanup`에 같은 transaction으로 기록합니다. 감사 저장 실패 시 정리도 롤백합니다.
- 같은 요청 UUID/실행/변경자/사유의 재전송은 원래 기록을 반환합니다. 이때 Prefect가 내려가도
  새 조회·반환을 하지 않습니다. UUID의 내용 변경은 거절하고 예약당 정리 감사는 DB에서 한 건으로 제한합니다.
- `--actor`는 CLI 운영자의 자기 기입 값이며 Core에서 인증한 신원이 아닙니다.

```bash
# backend/ops-service: 운영자가 확인한 실행·사유·고정 요청 UUID. 예시는 실행 승인이 아닙니다.
uv run --locked python manage.py cleanup_evaluation_budget \
  --run-id "$CLEANUP_RUN_ID" --actor "$BUDGET_OPERATOR" \
  --reason "$CLEANUP_REASON" --request-id "$CLEANUP_REQUEST_ID"

# 미리보기의 반환량·미확인 유지분을 확인한 뒤 같은 인자에 --apply를 추가합니다.
uv run --locked python manage.py cleanup_evaluation_budget \
  --run-id "$CLEANUP_RUN_ID" --actor "$BUDGET_OPERATOR" \
  --reason "$CLEANUP_REASON" --request-id "$CLEANUP_REQUEST_ID" --apply
```

미리보기와 적용 사이에 승인·정산이 진행되면 적용 시점의 잠긴 장부로 다시 계산합니다.
응답의 `applied=false`는 미리보기, `applied=true/replayed=false`는 이번 적용,
`applied=true/replayed=true`는 기존 정리 결과의 재조회입니다. 미리보기 자체는 요청 UUID를 예약하지 않습니다.
6회 × 2,000 예약에서 확정 50토큰 1회와 미확인 1회가 있으면 **4회·9,950토큰 반환**, **2회·2,050토큰 유지**입니다.
이는 누적 예약 한도 반환이며 결제 환불이 아닙니다.

실행별 예산 GET 응답의 `cleanup`에는 공개 감사 항목을 추가했고, React 상세는 반환분·미확인
유지분·변경자·사유·Prefect 종료 근거를 읽기 전용으로 표시합니다. 없으면 null이며 브라우저에
실행기 소유자 UUID를 노출하지 않습니다. 정리·한도 변경 버튼은 제공하지 않습니다.

`apps.evaluations.test_budget_cleanup`은 미리보기, 정합성 거절, 멱등·rollback,
승인/정산/worker close 경합을 실제 MySQL 8.4에서 검증합니다. 실제 Prefect 응답과
`close` 실패·`settle/close` 동시 실패 후 정리 경로는 [기존 통합 도구](../../infrastructure/llmops/README.md#실제-취소예산-통합-검증)의
LLMOps CI에서 검증합니다. 해당 CI 성공 전에는 실제 서버 통합 검증 완료로 표시하지 않습니다.

## 증거 기반 미확인 사용량 보정

모델 응답을 받았지만 `settle` 전송이 실패한 경우 `correct_evaluation_usage`를 사용합니다.
새 production 의존성은 없습니다. 기존 worker 정산 API에서 닫힌 예약을 다시 여는 기능도 아닙니다.
호출 흐름은 `모델 응답 → 실행기 서명 기록 저장 → 기존 settle 시도`이며, 실패 후에는
`운영자 CLI → 구성된 로컬/내부 HTTP 증거 조회 → 서명·승인 명세 검증 → Django/MySQL 보정 이력
→ 관리자 GET → React`입니다. 증거 조회와 서명 검증은 DB 잠금을 잡기 전에 끝냅니다.

### 증거와 신뢰 범위

- 실행기는 정산 HTTP 전에 `/results/{run UUID}/capture/usage-{0부터 시작하는 호출 번호}.json`에
  기록합니다. 공통 항목은 실행·flow·worker·명세 해시·호출 번호·모델·상한·사용량·관측 시각입니다.
  답변 v1은 응답 ID/상태, 임베딩 v2는 작업 ID/종류·차원·배치 해시·제공자 요청 ID를 추가합니다.
  질문·답변·청크 원문·임베딩 벡터·API 키는 포함하지 않습니다.
- 답변 `WORKER_RESPONSE` v1과 임베딩 `WORKER_EMBEDDING_RESPONSE` v2의 정렬된 JSON을
  각각 `govbiz-budget-usage-v1\n` / `govbiz-budget-usage-v2\n` 도메인으로 HMAC-SHA256 서명합니다.
  기존 v1 서명 형식은 유지하며 두 버전의 필드·출처·도메인을 혼용할 수 없습니다.
  키는 기존 `LLMOPS_BUDGET_TOKEN`이며 토큰 자체는 파일에 저장하지 않습니다. fsync 후 배타적
  파일 생성으로 기존 증거를 덮어쓰지 않습니다. 저장 실패는 명시적인 실행 실패로 처리합니다.
- 이는 **정산 권한이 있는 실행기가 관측한 응답**의 무결성을 확인합니다. OpenAI가 서명한
  청구서나 독립적인 결제 확인이 아니며, 키를 가진 실행기 자체가 침해된 상황을 입증하지 못합니다.
- 답변은 HTTP 200·종료된 응답·응답 ID·정수 사용량 합계를 확인해야 합니다. 임베딩은 HTTP 200·
  승인 모델·입력 상한 안의 정수 사용량과 실제 응답 헤더 `x-request-id`가 필요합니다.
  요청 ID는 1~200자의 영문·숫자·`_`·`-`(첫 글자는 영문/숫자)만 허용하는 현재 저장 계약이며,
  `req_` 접두사를 요구하거나 `resp_` ID를 만들어 넣지 않습니다. 제공자 형식 변경 시 이 계약을 검토해야 합니다.
  ID가 없거나 허용 형식이 아니면 증거 없이 일반 정산만 시도합니다. 정산까지 실패하면 입력 예약을 유지합니다.
  응답 유실·사용량 누락·이 기능 도입 전 기록에는 과거 증거를 소급 생성하지 않습니다.
- Ops는 서버가 구성한 저장소에서 고정 경로의 8 KiB 이하 파일만 읽습니다. symlink·중복 JSON 키·잘못된 서명·
  다른 실행/명세/소유자·승인 이전 또는 종료 이후 관측·출력 상한 초과는 거절합니다.
- `LLMOPS_ARTIFACT_URL`을 설정하면 별도 `LLMOPS_ARTIFACT_TOKEN`으로
  `GET /v1/usage-receipts/{run UUID}/{sequence}`를 조회합니다. 호출 번호는 0~511이며
  임의 경로·업로드·목록 조회는 제공하지 않습니다. 서버와 클라이언트 모두 8 KiB를 제한하고,
  리다이렉트·압축·부분/불완전 응답·인증 실패·시간 초과는 보정을 중단합니다.
  원격 장애 시 로컬 파일을 읽거나 미확정 사용량을 0으로 처리하지 않습니다.
  artifact 서버는 서명 키를 받지 않으며 최종 v1/v2 서명 검증은 Ops가 기존 예산 키로 수행합니다.
- 임베딩 v2는 승인된 문서/질문 배치의 ID·종류·모델·차원·입력 해시·개별 입력/출력 상한까지
  일치해야 합니다. 출력은 0이며 답변 호출을 임베딩 증거로 보정할 수 없습니다.
- 최초 적용은 현재 토큰으로 검증합니다. 토큰 교체 후 이전 키의 미적용 증거는 거절하며
  수동으로 재서명하거나 새 worker로 재실행해 해소하지 않습니다. 키 보관/회전 확장은 별도 과제입니다.

### 미리보기와 적용

예약이 먼저 닫혀 있어야 합니다. `close`까지 실패했다면 앞 절의 C1 정리로 미확인 몫을 유지한 채
닫은 뒤 진행합니다. 미리보기는 쓰기가 없으며, 적용에는 검토한 `evidence_sha256`가 필수입니다.

```bash
# backend/ops-service: 운영자가 확인한 실행·호출·사유와 재사용할 요청 UUID
uv run --locked python manage.py correct_evaluation_usage \
  --run-id "$CORRECTION_RUN_ID" --sequence 0 --actor "$BUDGET_OPERATOR" \
  --reason "$CORRECTION_REASON" --request-id "$CORRECTION_REQUEST_ID"

# 위 출력의 사용량·반환 차액·evidence_sha256를 확인한 뒤 적용
uv run --locked python manage.py correct_evaluation_usage \
  --run-id "$CORRECTION_RUN_ID" --sequence 0 --actor "$BUDGET_OPERATOR" \
  --reason "$CORRECTION_REASON" --request-id "$CORRECTION_REQUEST_ID" \
  --evidence-sha256 "$CORRECTION_EVIDENCE_SHA256" --apply
```

`실행 → 전역 예산 → 예약` 잠금 아래 전체 장부를 대조하고 보정 이력과 입력·출력 차액 반영을 함께
커밋합니다. 감사 저장 실패 시 반환도 롤백합니다. 호출 횟수는 유지합니다. 예를 들어 닫힌 예약의
미확인 1회·2,000토큰에서 확인된 출력이 50이면 **1회·50토큰 유지, 출력 차액 1,950 반환**입니다.
명확한 0토큰 응답도 호출 1회는 남으며, 증거 없는 호출은 최대 예약을 계속 유지합니다.
임베딩 입력 상한 500·확인 입력 100이면 **호출 1회·입력 100 유지, 입력 차액 400 반환**이며
출력 장부는 변하지 않습니다. 문서·질문 임베딩 모두 같은 CLI의 미리보기/해시 적용 절차를 사용합니다.

원래 `EvaluationBudgetCall`의 토큰·정산 시각과 C1 정리 당시 스냅샷을 수정하지 않습니다.
`EvaluationUsageCorrection`에 원본 증거 바이트·SHA-256·응답 ID·원래 호출 스냅샷·변경자/사유·
전후 장부를 추가합니다. 호출당 한 건, 증거 해시와 응답 ID 중복 금지는 DB에서도 보장합니다.
임베딩은 `response_id=null`, 고유한 `provider_request_id`를 저장합니다. migration `0019`의
제약은 두 식별자 중 정확히 하나만 있도록 보장하며 같은 요청 증거의 다른 실행 재사용도 거절합니다.
동일 요청 UUID·실행·번호·담당자·사유·증거 해시는 기존 결과를 반환하며 파일 삭제/키 교체 후에도
이미 적용된 결과를 다시 반환합니다. 다른 요청 UUID로 같은 호출을 보정하거나 이미 정산된 값을
변경하는 작업은 거절합니다. 미리보기 후 파일이 달라지면 재검토해야 합니다.
접수 중지 상태에서도 기존 닫힌 예약의 보정은 허용합니다. HTTP 조회 실패·증거 변경·서명 검증
실패는 장부와 감사 이력을 바꾸지 않습니다. 적용된 동일 요청은 저장된 이력을 반환하므로
artifact 서버 장애 중에도 재전송할 수 있습니다.

예산 총계와 예약 목록의 확정 사용량에는 보정을 포함합니다. 상세 `calls`는 원래 정산 값을 유지하고,
새 `corrections` 배열과 React 이력에 보정값·출처·증거 해시·담당자/사유·차액을 표시합니다.
답변의 응답 ID와 임베딩의 요청 ID를 구분하고, 임베딩은 입력 차액을 표시합니다.
원본 증거·서명·worker ID는 관리자 API에도 노출하지 않습니다. 보정 쓰기는 CLI만 제공합니다.
`--actor`는 운영자의 자기 기입 값이며 Core 로그인 인증 이력과 다릅니다.

`apps.evaluations.test_usage_correction`은 실제 실행기 기록과의 계약, 서명/식별자/시간 검증,
원본 보존·중복·경합·rollback·기존 C1 이후 처리·API 합계를 검증합니다.
실제 Prefect의 정산 실패 및 정산/종료 동시 실패 시나리오에도 미리보기·보정·재전송·원본 보존과
추가 모델 전송 0회 확인을 연결했습니다. 전체 서버 실행은 해당 변경의 CI에서 확인해야 합니다.
임베딩은 `apps.evaluations.test_embedding_receipts`에서 실제 실행기 v2 파일·질문/문서 배치·
서명/상한/시각 오류·중복/동시 보정·DB 식별자 제약·rollback·API 비밀 비노출을 검증합니다.
SDK 무료 검증과 MySQL 검증은 분리합니다. 새 RAG 실행의 Ops 접수·Prefect 연결도 무료 대역과 격리 DB로 검증하며 실제 유료 품질 측정과 구분합니다.
`apps.evaluations.test_receipt_transport`는 실제 내부 HTTP 서버와 실행기 v1/v2 증거를 사용해
로컬 마운트 없는 조회·인증·크기·경로·변조·리다이렉트·장애 시 대체 금지를 DB 없이 검증합니다.
위 두 MySQL 테스트 모듈에는 HTTP 보정·접수 중지·미리보기 이후 변경·단발성 차액 반환도 포함됩니다.

## 평가 취소

상세 화면의 **평가 취소 요청**은 현재 Core 관리자 세션 중 해당 평가 요청자만 사용할 수 있습니다.
`POST /api/v1/ops/evaluations/{run_id}/cancel`에 빈 JSON과 CSRF 토큰을 보냅니다.
`REQUESTED`, `QUEUED`, `RUNNING`, `CANCELLING`에서 접수하며, 이미 종료된 실행의 새 취소는
`409 CANCEL_CONFLICT`, 다른 요청자는 `403 CANCEL_FORBIDDEN`입니다. 동일 실행 재요청은
최초 취소 요청자·시각을 보존하며 새 평가를 만들지 않습니다.

흐름은 `React → Django 인증·요청자 확인 → 취소 의사 DB 커밋 → Prefect 취소 요청 →
ops-sync/상세 조회의 실제 종료 확인 → 미사용 예약 정리`입니다. 새 production 의존성은 없습니다.

- `0012_evaluation_cancellation` migration으로 `cancel_requested_at`, `cancel_requested_by`와
  `CANCELLING` 상태를 추가합니다. 과거 실행의 두 필드는 null이며 운영 데이터는 삭제하지 않습니다.
- 응답의 `can_cancel`은 현재 사용자의 취소 가능 여부입니다. 목록·상세에 최초 취소 요청자와 시각을
  제공하며 취소 요청 뒤에는 `can_retry=false`로 접수 재전송을 막습니다.
- 취소 접수는 실행 행과 전역 예산 행 잠금으로 호출 승인과 직렬화합니다. 커밋 뒤 새 소유권·호출
  승인을 거절하며 이미 승인된 요청의 전송·과금을 취소했다고 보장하지 않습니다.
- Prefect에는 `CANCELLING`, `force=false`로 요청합니다. HTTP 성공만으로 완료 처리하지 않고
  실행 상태를 다시 확인합니다. `CANCELLING`은 HTTP 202이며 확인된 최종 상태는 HTTP 200입니다.
  완료가 먼저 확정되면 결과 검증을 거쳐 `COMPLETED`를 유지하고 취소 이력도 보존합니다.
- Prefect 장애·접수 응답 유실은 `CANCELLING / PREFECT_CANCEL_UNCONFIRMED`로 남깁니다.
  백그라운드 동기화는 기존 실행만 찾아 재확인하며 새 실행을 생성하지 않습니다. 끝내 실행 ID를
  찾지 못하면 취소를 완료로 꾸미거나 예약을 자동 반환하지 않습니다.
- 실행기의 정상 close 또는 취소 요청의 실제 종료 확인 시 미승인 호출 몫과 확인된 입력·출력 차액만
  반환합니다. 승인됐지만 사용량이 불명확한 호출은 1회와 최대 출력 토큰을 유지합니다.
  중복 종료·실행기 close와 동기화 경합도 한 번만 반환합니다.
- 실행기 재시작의 소유권 인계, 증거 없는 사용량의 추정 보정, 금액·기간 예산은 지원하지 않습니다.
  서명된 실행기 응답이 있는 닫힌 예약은 아래 사용량 보정 계약을 따릅니다.

취소 계약·웹 테스트는 무료 대역으로 검증하고 MySQL 잠금·환급 경합 테스트는 Ops CI에서 실행합니다.
실제 Prefect 실행기 강제 종료와 유료 호출 중단은 별도 운영 검증이 필요합니다.
Prefect의 [상태 변경 API](https://reference.prefect.io/prefect/server/api/flow_runs/) 계약을 사용합니다.

## 접수 시 실행 명세 고정

새 접수는 session의 `datasets[].execution_profiles.replay` 또는 `.live`를
`execution_profile`로 전송합니다. 현재 서버 명세와 다르면 DB 생성·Prefect 전송 전에 `400`입니다.
같은 UUID에 다른 명세를 보내면 `409`이며, 접수 응답 유실 후 재전송은 최초 명세를 유지합니다.
React가 쓰기 직전 세션을 다시 조회해도 사용자가 확인한 명세를 최신 값으로 자동 교체하지 않습니다.

`0009_execution_spec`은 `execution_spec` JSON과 `execution_spec_sha256`을 추가합니다.
서버가 생성한 명세에 순서가 있는 사례 ID, fixture·후보·기준 해시, 평가 코드·잠금 의존성,
실행 흐름 코드, 검토 기준 버전·승인 ID를 고정합니다. 새 응답 생성에는 모델·프롬프트·
Agent/Service/공통 호출 코드·출력 제한·추론·timeout·재시도 설정도 포함합니다.
Django에는 모델 SDK를 추가하지 않았습니다.

흐름: `React 확인 식별자 → Django DB 명세 고정 → Prefect → 실제 실행 파일·입력 검증 → 생성/평가`.
`request.json`은 명세 전체와 SHA-256을, 평가 `manifest.json`은 같은 SHA-256을 기록합니다.
Ops는 결과의 명세·평가기·선택 사례·입력 해시를 확인한 뒤 완료로 표시합니다.
실행기의 `preflight.json`이 요청과 일치하고 호출 전 거절을 입증할 때만 실패 호출 수를 0으로 확정합니다.
전송 후 timeout 등 확인되지 않은 호출 수는 계속 `null`입니다.

- `EXECUTION_SPEC_MISMATCH`: 접수 조건과 실행 파일·입력·설정 불일치. 실행기를 확인하고 새 조건을 검토합니다.
- `EXECUTION_SPEC_REQUIRED`: 명세가 없는 구형 미접수 요청을 최신 기본값으로 실행하지 않습니다.
  먼저 기존 Prefect 접수 여부를 확인합니다. 기존 실행 조회는 계속 가능합니다.
- 구형 완료·검토 기록에는 명세를 소급 생성하지 않습니다. 화면에 **기존 기록 · 실행 명세 없음**을 표시합니다.
- 저장 응답 재평가는 과거 모델·프롬프트가 달라도 가능합니다. 이번 평가기와 입력만 고정합니다.
- 후처리 복구는 원본 manifest의 평가기와 현재 평가기가 같아야 합니다. 검증 불가·버전 변경이면 복구를 차단합니다.
  예전 두 파일 해시만 있는 기록은 새 의존성 포함 평가기와 동일함을 입증할 수 없어 복구 대상이 아닙니다.
- 활성 기준의 교체·해제는 이미 접수된 기준 스냅샷을 바꾸지 않습니다.

명세 생성·이미지 갱신·불일치 smoke는 [LLMOps 실행 명세 운영](../../infrastructure/llmops/README.md#실행-명세-생성과-갱신)을 따릅니다.

### 평가 범위 계약

`core-rag-20261002-v1`(9사례), `core-rag-20261002-v2`(1사례)를 저장 캡처 카탈로그에 등록했습니다.
출처는 실제 Core CI의 모델 HTTP 대역이며 `integration-stub`로 명세에 고정합니다. 기존 관리자 화면의
자료 선택과 Prefect 재평가를 사용하며 v1의 원본 실패 4건은 재평가 완료 후에도 유지합니다.
유료 호출·예산 예약·live 프로필·품질 기준 지정은 허용하지 않습니다. 입력 해시·이미지 갱신·CI 확인은
[등록 Core 캡처 안내](../../evaluation/support-program-evidence/README.md#등록된-core-캡처의-ops-재평가)를 따릅니다.

새 실행 명세는 `schema_version=2`이며 자료별 `evaluation_scope`를 프로필 해시에 포함합니다.
session의 `datasets[].evaluation_scope`와 실행 응답의 `evaluation_scope`로 접수 전후 범위를
확인합니다. 고정 근거 답변은 `fixed-answer-context-only`, 위 무료 RAG 재평가는
`source-chunks-retrieval-answer`입니다. 두 경로 모두 새 원문 수집·청킹·색인·검색을 실행하지 않습니다.
고정 근거의 인용 재현율을 검색 재현율로 해석하지 않습니다.

고정 근거 실행기는 새 캡처·manifest·비교 보고서에 `scope`를 기록하고 비교·Langfuse 점수에는
`retrieval_evaluated=false`를 기록합니다. 다른 범위의 입력·캡처, 서로 다른 범위의 비교,
명세·보고서의 범위 불일치는 거절합니다. 새 명세에 필요한 범위나 검색 미측정 표시가 누락돼도
완료로 인정하지 않습니다. 자료 범위와 품질 정책 범위가 다르면 품질 판정·기준 지정도 차단합니다.

과거 v1 고정 근거 캡처는 명시적 scope가 없어도 기존 스키마·입력 해시 검증으로 읽으며 파일을
수정하지 않습니다. 과거 비교 v2는 이미 기록된 `scope`를 검증하고, 실행 명세·비교 기록 모두에
범위가 없으면 화면에 **미확인 또는 지원하지 않는 범위**를 표시합니다. 구형 서버의 session에
범위가 없으면 새 접수 버튼을 비활성화하며 이미 보관한 요청의 재확인 정책은 유지합니다.

실행 명세 해시를 재생성했으므로 Ops와 실행기를 같은 소스로 배포해야 합니다. 기존 요청·캡처·검토
이력은 소급 갱신하지 않습니다. 품질 입력 해시에는 범위도 포함되므로 이전 품질 판정은 그대로
보존하고 현재 판정으로 쓰려면 명시적으로 재판정합니다. 자동 승인이나 새 모델 호출은 없습니다.
전체 RAG 사례·참조 검토, 합격·기준 지정은 위 별도 계약을 따릅니다. 고정 원문·청크 RAG live 접수는 위의 별도 활성화·예산 계약을 따릅니다.
무료 저장 캡처 재평가 성공을 실제 RAG 생성·검색이나 현재 모델 품질 검증으로 해석하지 않습니다.

## 응답 검토와 비교 기준

완료 상세의 **응답 검토와 기준 지정**에서 선택된 모든 사례의 질문·제공 근거·후보 답변·기존 기준 답변을
확인합니다. 각 사례를 **적합 / 부적합 / 판단 보류**로 판단하고 사유를 저장합니다. 필수 사례 전체에
현재 자료·응답 해시와 검토 기준 버전이 일치하는 적합 기록이 있어야 전체 승인할 수 있습니다.
전체 승인과 비교 기준 지정은 별도 동작입니다. 새 기준 지정에는 아래의 유효한 품질 합격도 필요합니다.
기준은 데이터셋별 하나이며 사례별 검토 또는 전체
검토가 바뀌면 그 실행의 승인 자격과 기준 지정은 해제됩니다. 이전 판단과 승인 이력은 보존됩니다.
AI 작성 참조 자료의 출처와 미측정 의미 충실도는 검토 승인으로 바뀌지 않습니다.

- `GET /api/v1/ops/evaluations/{id}/review`: 해시 검증을 거친 사례·근거, 전체/사례 검토 이력, `review_version`,
  `rubric`, `can_approve`, `approval_current`, `baseline_requires_review`, 현재 기준 여부
- `POST .../{id}/case-review`: `case_id`, `decision` (`SUITABLE` / `UNSUITABLE` / `DEFERRED`),
  `comment` (1~3000자), `capture_sha256`, `fixture_sha256`, `rubric_version`, `review_version`
- `POST .../{id}/review`: `decision` (`APPROVED` / `CHANGES_REQUESTED`), `comment` (1~3000자),
  `capture_sha256`, `fixture_sha256`, `rubric_version`, `review_version`
- `POST .../{id}/baseline`: `review_id`, `baseline_version`(검토 GET에서 확인한 현재 버전); 완료 파일·최신 승인 기록·버전이 일치해야 지정 가능
- `DELETE .../{id}/baseline`: `baseline_version`, `reason`(1~3000자); 해당 실행이 현재 기준일 때 해제. 오래된 버전은 409
- session의 데이터셋별 `baseline`은 현재 기준 선택지 또는 null. 새 평가의 `reference_capture_id`에
  `run:<요청 UUID>`와 선택지의 `version`을 `baseline_version`으로 함께 전송하며 임의 UUID·다른 자료·미승인 실행은 거절
- 접수 시 `reference_config`에 기준 UUID·캡처/fixture SHA-256을 서버가 고정. 실행기는 이를 재검증하고
  `reference-capture.json`을 실행 폴더에 보존. 나중의 기준 교체·철회는 이미 접수한 실행을 변경하지 않음
- 원본 파일을 확인할 수 없거나 해시가 바뀌면 검토·지정·새 접수를 거절. 자동으로 다른 기준을 사용하지 않음
- 검토·기준 지정은 Core 관리자 인증과 CSRF 적용. 검토·기준 지정 자체에는 모델 API 호출 없음

Migration `0004_evaluation_review_baseline`은 검토 이력·데이터셋별 기준 테이블과 기준 명세를 추가합니다.
기존 결과는 미검토 상태로 유지합니다. 비교 상세가 없는 초기 결과는 무료 저장 응답 재평가 후 검토합니다.

Migration `0008_case_reviews`는 사례별 이력과 실행의 검토 버전, 전체 승인이 참조하는 사례 검토
기록을 추가합니다. 기존 전체 승인은 버전·사례 판단을 추정해 채우지 않습니다. 기존 기준 행과 과거
실행을 보존하되, 사례별 재검토와 새 전체 승인을 거치기 전에는 새 평가 기준으로 사용할 수 없습니다.
이미 접수된 같은 UUID 재전송은 당시 기준 명세를 유지합니다.

검토 기준 `evidence-review-v1`은 신청 조건·예외·제외 사유의 누락/추가, 답변의 근거 일치와 근거 부족
판단, 인용 적절성을 다룹니다. 검토자·시각·해시·기준 버전을 기록하며 수정은 새 행으로 추가합니다.
사례 저장과 전체 승인은 실행의 `review_version`을 공유합니다. 같은 관리자·내용·직전 버전의 응답
유실 재전송은 기존 기록을 반환하고, 다른 변경이 끼어든 오래된 요청은 409로 거절합니다.
알 수 없는 사례, 잘못된 해시/기준, 미검토·부적합·보류는 승인 자격을 얻지 못합니다.
데이터셋 기준 행 → 실행 행 순서로 잠가 검토 변경·전체 승인·기준 지정·다음 접수의 경계를 유지합니다.
`LLMOPS_EVIDENCE_DIR`에는 버전이 고정된 `evaluation/support-program-evidence`를 읽기 전용으로 연결합니다.
로컬 Python은 저장소 경로가 기본이며 단독·루트 통합·LLMOps Compose는 모두 `/evaluation-data`에 마운트합니다.
루트 Compose 검증은 자료 경로와 읽기 전용 마운트를 확인하며, 컨테이너 테스트도 같은 자료를 사용합니다.
다른 배포 방식에서는 결과 볼륨과 이 자료 경로를 함께 제공해야 합니다. Django에는 평가 SDK를 추가하지 않습니다.

호출 흐름: `React 사례 판단 → Django 관리자·CSRF·자료 해시/버전 확인 → MySQL 사례 이력 저장 → 전체 승인 → 기준 지정`.
다음 평가는 `Django 기준 명세 고정 → Prefect → 기준 응답 복사·검증 → 기존 평가 파이프라인`을 거칩니다.

## 평가 기준 검토와 품질 판정

실행의 `COMPLETED`와 품질 합격은 별개입니다. `0010_quality_assessments`는 기존 실행·승인·기준을
보존하면서 `FixtureReview`와 `QualityAssessment`를 추가하며 과거 합격을 소급 생성하지 않습니다.
새 접수의 실행 명세에는 `quality_policy`의 내용·코드 해시가 포함됩니다.

현재 정책 `fixed-evidence-quality-v1`은 고정 근거의 선택 사례에만 적용합니다. 사람의 기준 자료
검토, 필수 사례 전체의 적합 판단, 검토된 기대 상태 일치와 필수 인용 충족이 필요합니다.
기대 인용이 없는 경우 `해당 없음`으로 계산하며 자동 의미 충실도 수치는 계속 미측정입니다.
사례별 사람 검토로 의미 판단을 기록하지만 숫자 의미 점수를 생성하지 않습니다.

| 품질 표시 | 의미 |
|---|---|
| 미판정 `NOT_EVALUATED` | 판정 기록 또는 신뢰할 수 있는 완료 자료가 없음 |
| 검토 필요 `NEEDS_REVIEW` | 기준 자료·사례의 검토가 부족하거나 기존 판정 이후 근거가 변경됨 |
| 불합격 `FAIL` | 필수 사례의 부적합 또는 검토된 필수 상태·인용 조건 위반 |
| 합격 `PASS` | 현재 자료·정책·사람 검토에서 모든 필수 조건 충족. 일반 모델 품질 보장은 아님 |

자료 손상·실행 오류는 모델 품질 불합격으로 단정하지 않습니다. 미검토 AI 참조와 다르다는 이유만으로
불합격을 만들지 않으며, 필수 사례의 부적합은 평균으로 상쇄하지 않습니다.

- `GET .../{id}/review`의 `quality`: 현재 유효 상태·정책, `input_sha256`, 자료 검토 버전·이력과
  판정 이력. `can_promote`는 최신 전체 승인과 유효한 품질 합격이 모두 있는지 나타냅니다.
- `POST .../{id}/fixture-review`: `decision` (`APPROVED` / `CHANGES_REQUESTED` / `DEFERRED`),
  `comment`, `fixture_sha256`, 순서가 있는 `case_ids`, `rubric_version`, `fixture_version`.
  기준 자료의 기대 상태·인용·필수 사실·금지 주장을 사람이 검토했다는 기록입니다.
  후보 답변 검토와 구별하고 원본 `ai-authored` 출처를 유지합니다.
- `POST .../{id}/quality`: 화면에서 받은 `input_sha256`. Django가 자료·최신 검토를 다시 확인하고
  정책 판정을 저장합니다. 자료·검토·정책이 바뀌었으면 409이며 같은 근거의 재전송은 기존 판정을 반환합니다.
  모델·Prefect·Langfuse에 새 요청을 보내지 않습니다.

판정에는 정책 스냅샷·해시, 자료·응답·비교 결과 해시, 사례/자료 검토 ID, 접수 명세와 접수 정책 해시,
판정 코드·담당자·시각을 보존합니다. 정책 변경 후 명시적 재판정은 현재 정책의 새 기록으로 남기며,
접수 당시 정책과 이전 판정은 덮어쓰지 않습니다. 판단 코드가 바뀐 경우도 별도 입력 해시로 구별합니다.

자료 검토 변경은 데이터셋 기준 행을 잠그고 활성 기준을 해제합니다. 응답 검토 변경도 기존 계약대로
처리합니다. 과거 판정 이력은 남지만 현재 합격으로 취급하지 않습니다. 기준 지정·새 기준 사용 접수는
서버에서 유효한 품질 합격을 검사하며 이미 접수된 요청의 기준 스냅샷은 유지합니다.

호출 흐름: `React 검토·판정 요청 → Django 관리자/CSRF·입력/버전 검증 → 정책 판정 → MySQL 이력 저장`.
모든 기준 자료·답변을 실제로 사람이 검토하기 전에는 개발 확인만으로 합격이나 기준 지정을 하지 않습니다.

## 접수 복원과 기준 버전

React는 전송 전에 요청 UUID·자료/캡처 ID·기준 버전·확인한 모델/호출 설정만 관리자별
`sessionStorage`에 보관합니다. `GET /api/v1/ops/session`의 `user.id`와 실행 응답의
`requested_by_id`는 이메일 변경과 무관한 Ops 연결 식별자(`core:{회원 ID}`)입니다.
같은 탭에서 새로고침·재로그인하면 먼저 기존 UUID를 GET으로 확인합니다. 조회만으로 모델을
호출하지 않으며 404여도 자동 POST하지 않습니다. 운영자가 재확인하면 같은 UUID·명세로 전송합니다.
다른 관리자 기록은 재사용하지 않고, 전송 직전 세션 계정도 대조합니다. 저장소 오류·손상은 접수를
차단하며 인증정보·질문·답변 원문은 저장하지 않습니다. 탭 종료·저장소 삭제 이후 복원은 보장하지 않습니다.
서버가 400으로 접수를 거절한 조건은 명시적으로 다시 선택하고 유료 전송 확인을 새로 받습니다.

Migration `0007_baseline_versions`는 해제해도 남는 데이터셋 기준 행과 단조 증가 버전,
`EvaluationBaselineChange` 이력을 추가합니다. 검토 저장·기준 지정/교체/해제·새 평가 접수는
같은 데이터셋 기준 행을 먼저 잠급니다. 파일 검증은 잠금 밖에서 수행하고 DB 안에서 버전·검토·원본
완료 상태를 다시 확인합니다. 접수를 커밋한 뒤 Prefect에 전송하므로 외부 HTTP를 DB 잠금 안에서 실행하지 않습니다.

- 실행에 `baseline_version`·`baseline_review_id`를 고정하고, 기존 `reference_config`의 UUID·캡처/자료
  해시와 실행기 스냅샷 계약은 유지합니다. 이미 접수된 요청의 재전송은 당시 명세를 유지합니다.
- 철회가 먼저 커밋되면 옛 버전으로 새 접수를 거절하고, 접수가 먼저 커밋되면 이후 철회에도 해당 실행의
  기준이 유지됩니다. 최초 기준 지정 경합도 데이터셋 PK와 잠금으로 직렬화합니다.
- 검토 GET은 현재 `baseline_version`과 `baseline_history`를 반환합니다. 이력에는 이전/새 검토와 실행,
  캡처/자료 해시, 버전, 수행자, 시각, 사유가 있습니다. 지정 사유는 승인된 검토 의견이며 새 검토에 따른
  자동 해제도 이력으로 남습니다. 중복 지정/해제 재전송은 같은 변경으로 처리합니다.
- 기존 기준은 버전 1과 기존 지정 시각·검토자 그대로 이관합니다. 이전 교체 이력·당시 자료 해시는
  추정해 채우지 않으며, 과거 평가의 승인 버전도 소급 생성하지 않습니다.

현재 배포 순서는 `Ops 이미지 빌드 → migration 0008까지 적용 → Ops API·ops-sync 갱신 → React 갱신`입니다.
루트 README 대신 이 문서와 [LLMOps 운영 문서](../../infrastructure/llmops/README.md)에 계약을 기록합니다.

## 실행 상태의 백그라운드 확인

`python manage.py sync_evaluations --watch`는 화면 방문과 독립적으로 미완료 실행을 확인합니다.
`LLMOPS_SCHEDULES_ENABLED=true`일 때만 아래의 승인된 정기 계획도 같은 루프에서 접수합니다.
기본값 `false`에서는 기존 상태 동기화만 수행합니다.
기본 대기 간격은 10초, 배치 크기는 25건이며 `--interval`(2~300초), `--batch-size`(1~100)로 조절합니다.
옵션 없이 실행하면 한 배치만 처리합니다. LLMOps Compose의 `ops-sync`가 같은 Django 이미지 구성으로 실행합니다.
단독 Ops/루트 Compose에는 Prefect가 없으므로 자동 실행하지 않습니다. 별도 실행 시 DB·Prefect·결과 경로를 동일하게 지정합니다.
Kubernetes는 연결 설정을 갖춘 뒤 `opsSync.enabled=true`를 선택하면 API와 같은 Pod에 동기화 컨테이너를 추가합니다.
이미지·DB·Secret을 API와 공유하며 기본값은 비활성화입니다. Prefect·실행기·결과 저장소는 Compose에 유지합니다.
[활성화 조건과 실제 연결 검증](../../infrastructure/gitops/docs/ops-runtime.md#kubernetes-ops-상태-동기화)을 참고하세요.

### 종료일이 있는 일별 정기 평가

React `/ops/evaluations`의 **정기 평가 계획**에서 기존 Core 관리자 세션으로 등록·조회·중지합니다.
흐름은 `React 승인 → Django 계획 저장 → ops-sync 시각 확인 → 기존 submit_run의 검토·명세·예산 검사
→ Prefect → 평가 실행기 → 결과/점수 → Ops 상태 동기화`입니다. 추가 실행 서비스는 없습니다.

- `GET /api/v1/ops/schedules?page=1`: 25개씩 조회하며 각 계획의 최대 31개 날짜 기록과 실행 링크를 반환합니다.
- `POST /api/v1/ops/schedules`: 요청 UUID, 자료, 검토 기준 ID·버전, live 설정·profile 해시,
  `confirm_paid_run=true`, 서울 `daily_at=HH:MM`, `starts_on`, `ends_on`, 승인 사유가 필요합니다.
  오늘부터 30일 안에 시작하며 양 끝 날짜를 포함해 최대 31일입니다. 계획 저장은 모델을 호출하거나 예산을 예약하지 않습니다.
- `POST /api/v1/ops/schedules/{id}/pause`: UUID와 사유로 새 접수를 중지하고 인증된 중지자를 기록합니다.
  같은 transaction에서 이 계획의 아직 실행에 연결되지 않은 `PENDING` 날짜 기록을
  `BLOCKED / SCHEDULE_CLOSED`로 종료합니다. 실행기가 중단돼 있어도 대기 기록이 남지 않습니다.
  동일 관리자·UUID·사유의 재시도는 중지 감사 정보를 유지하며 구버전이 남긴 대기 기록도 종료합니다.
  다른 요청의 재시도는 409로 거부하고 기존 차단 사유·이미 접수된 실행과 예산은 보존합니다.
  이미 접수된 실행은 별도로 취소합니다. 중지한 계획은 재개하지 않으며 변경 조건은 새 계획으로 승인합니다.
  자료별 미중지 계획은 DB에서 한 개로 제한하므로 기간이 끝난 계획도 중지 후 교체합니다.

전제는 `LLMOPS_SCHEDULES_ENABLED`, `LLMOPS_LIVE_ENABLED`와 RAG인 경우 `LLMOPS_RAG_LIVE_ENABLED`,
사람 검토·품질 판정을 통과한 현재 기준, 유효한 누적 입력 한도와 일별 한도입니다. 등록 시 현재 한도로
한 번의 최대 호출량을 수용할 수 있는지 확인하고, 각 날짜 접수에서도 다시 검사·예약합니다.
계획 전체 금액이나 기간 전체 토큰을 선결제·예약하는 기능이 아닙니다. 화면은 기간 전체 최대 호출·토큰도 표시합니다.
승인 당시의 모델·자료·기준 버전을 고정하며 변경된 모델이나 새 기준을 자동으로 따라가지 않습니다.

서울 날짜와 계획 UUID로 평가 요청 UUID를 정해 DB의 날짜별 unique 제약과 Prefect 멱등 키를 함께 사용합니다.
예정 시각 후 당일에 한 번 접수하며, 과거 날짜를 몰아서 실행하지 않습니다. 접수 전 재시작은 같은 당일 요청을
복구하고, 지난 날짜의 미완료 접수는 `MISSED_SCHEDULE_DAY`로 차단합니다. 자정 사이에 검증·예약이 걸쳐도
예약 시각이 승인 날짜와 다르면 전체 접수를 롤백합니다. Prefect 응답 유실 후에는 기존 요청 상태 동기화가 복구합니다.

기준 철회·설정 변경·예산 부족·이전 실행 미완료·사용량 미확정은 `BLOCKED`와 안정적인 사유 코드로 남기며,
차단된 당일 계획을 자동 재시도하지 않습니다. 일별 한도 해제도 정기 접수를 차단하지만 기존 사용량을 지우지 않습니다.
계획은 등록 당시 관리자가 승인한 유한 기간의 작업이며, 매번 브라우저 세션을 재사용하지 않습니다.
등록자의 Django 계정 비활성화도 신규 접수를 차단합니다. Core 역할 변경을 예약에 실시간 전파하는 기능은 없으므로
권한 회수 시 해당 계획을 함께 중지해야 합니다.

이번 구현의 기본 상태는 정기 접수 비활성·계획 0건입니다. 외부 알림, 월별/금액 한도,
자동 품질 합격·기준 승격, 유료 정기 실행의 운영 검증은 포함하지 않습니다.

- Migration `0006_evaluationrun_sync_attempted_at`을 먼저 적용합니다. 기존 행·결과 파일은 유지합니다.
- 목록·상세 응답의 `synced_at`은 마지막 성공 확인, `sync_attempted_at`은 마지막 시도입니다.
  미완료 상태의 성공 확인이 60초 이상 지연되면 `status_stale=true`입니다.
- Prefect 장애는 마지막 상태를 유지하고 `PREFECT_STATUS_UNAVAILABLE`을 표시합니다.
  확인 시도를 기록해 반복 실패가 다른 실행을 밀어내지 않게 합니다.
- flow ID 없는 접수는 UUID idempotency key로 조회하고 저장된 인자까지 대조합니다.
  조회 결과가 없거나 불일치하면 자동 실행을 생성하지 않습니다. 기존 관리자의 명시적인 접수 재확인은 유지합니다.
- 조건부 DB 갱신으로 늦은 상태 응답이 최신 완료 결과를 되돌리지 못하게 합니다.
- 목록 API는 DB만 읽으며 React가 5초마다 갱신합니다. 결과 오류는 재확인하지만 이미 완료된 모든 파일을
  주기적으로 전수 검사하지는 않습니다. 파일 훼손은 상세·보고서 조회에서도 확인합니다.

호출 흐름: `ops-sync → Prefect 기존 실행 조회 → 결과 파일 검증 → Ops MySQL → React 목록`.
새 모델 실행·자동 후처리 복구·평가 스케줄 기능은 이 명령에 포함하지 않습니다.

## 실패한 후처리 복구

`POST /api/v1/ops/evaluations/{원본 UUID}/recover`에 새로운 `request_id` UUID만 보냅니다.
완료된 응답과 fixture·비교 기준의 해시가 검증된 `FAILED / CRASHED / CANCELLED / RESULT_ERROR`
실행을 복구합니다. Core 관리자 인증·CSRF가 필요하며 접수 불확실 시 같은 UUID로 재확인합니다.
진행 중이거나 정상 완료한 실행, 불완전한 응답, 누락·변조된 입력은 거절합니다.

- 새 `EvaluationRun`의 `execution_mode`는 `recovery`, `source_run`은 원본입니다. 원본 상태와 파일을
  덮어쓰지 않으며 복구 시도마다 별도 UUID와 Prefect 실행·결과 폴더를 사용합니다.
- 접수 시 `recovery_config`에 원본 요청·후보 응답·비교 기준·fixture의 SHA-256을 고정합니다.
  실행기는 다시 검증한 바이트를 자기 폴더에 복사한 뒤 기존 평가 함수를 호출합니다.
- 복구는 응답 생성 함수로 진입하지 않으며 `model_api_calls=0`은 **이 복구의 추가 호출 수**입니다.
  원본 유료 실행의 호출 횟수는 원본 이력·캡처에 보존합니다. 유료 실행을 꺼도 복구할 수 있습니다.
- 원본 행의 DB 잠금으로 같은 원본에 진행 중인 복구를 하나만 허용합니다. 전송은 transaction 밖에서
  수행하며 요청 UUID와 Prefect idempotency key를 재사용합니다. 다른 관리자가 같은 UUID를 재사용할 수 없습니다.
- 상세 응답의 `source_run_id`는 원본 링크입니다. 상세 전용 `postprocessing`에는 입력 검증 여부,
  마지막 보고서/등록 단계, 복구 가능 여부·사유, 기존 복구 이력을 반환합니다.
- 보고서가 나중에 누락·훼손되면 상세 조회에서 `RESULT_ERROR`로 전환합니다. 입력은 온전해야 복구할 수 있습니다.
- 입력 검증 완료 전 중단되어 manifest에 입력 해시가 없는 실행은 복구할 수 없습니다. 부분 응답을
  이어 생성하는 기능, 자동 복구 스케줄, 모델 재호출은 포함하지 않습니다.

Migration `0005_evaluationrun_recovery`는 원본 FK와 복구 명세를 추가합니다. 기존 행은 null/빈 명세로
유지합니다. Ops와 평가 실행기를 함께 갱신해 Prefect deployment에 `recovery_config` 인자를 반영해야 합니다.
Django는 공통 입력 검증 코드만 사용하고 pandas·Pandera·Evidently SDK는 실행기에만 유지합니다.

호출 흐름: `React 복구 요청 → Django 입력/접수 검증 → Prefect → 입력 스냅샷 → pandas/Pandera → Evidently·Langfuse`.

## 빠른 시작 — Docker

아래 명령은 모노레포 루트에서 `cd backend/ops-service`로 이동한 뒤 실행합니다.
전체 로컬 스택의 실행 방법은 [루트 README](../../README.md)를 참고합니다.
단독 Ops Compose와 통합 Compose를 동시에 실행하면 포트가 충돌할 수 있습니다.

Docker Desktop의 Linux 컨테이너 엔진이 실행되어 있어야 합니다.

PowerShell:

```powershell
Copy-Item .env.example .env
docker compose build ops-service
docker compose up --detach --wait --wait-timeout 180 ops-mysql
docker compose run --rm --no-deps ops-service python manage.py migrate_deployment
docker compose up --detach --wait --wait-timeout 180 ops-service
```

Linux/macOS에서는 첫 명령을 `cp .env.example .env`로 실행합니다. 이미 `.env`를 설정했다면 복사 단계는 건너뜁니다.

- 실행 확인: [http://127.0.0.1:8001/api/v1/health](http://127.0.0.1:8001/api/v1/health)
- DB 연결·스키마 준비 확인: [http://127.0.0.1:8001/api/v1/health/ready](http://127.0.0.1:8001/api/v1/health/ready)
- MySQL: `127.0.0.1:3308`, DB/사용자 `govbiz4`
- Compose 프로젝트: `govbiz-ops` (컨테이너 `govbiz-ops-ops-service-1`, `govbiz-ops-ops-mysql-1`)
- 데이터 볼륨: 이 프로젝트의 `mysql-data`

Core·AI의 컨테이너·네트워크·DB 볼륨과 분리됩니다. DB 스키마·사용자 `govbiz4`는 컨테이너 이름과 별개이며 이번에 변경하지 않습니다. 이전 데이터는 자동 이전되지 않으므로 [전환 안내](../../docs/ops-monorepo-migration.md)를 따르세요. `config/`, `apps/`, `manage.py`를 컨테이너에 연결하므로 Python 코드 변경은 개발 서버에 반영됩니다. 의존성을 변경하면 이미지를 다시 빌드합니다.

```powershell
docker compose logs --follow ops-service
docker compose down
```

`down`은 데이터 볼륨을 유지합니다. 로컬 Compose만 이미지의 기본 명령을
`manage.py runserver`로 재정의하여 소스 변경을 자동 반영합니다. Kubernetes 등에서
이미지를 직접 실행하면 자동 재시작 개발 서버가 아닌 Gunicorn이 실행됩니다.

빈 DB는 연결할 수 있어도 readiness가 실패합니다. 앱 시작 전에 migration을 명시적으로 실행합니다.
`migrate_deployment`는 MySQL 세션 잠금 아래 전진 migration과 스키마 준비를 확인하고,
동시 실행이나 미완료 스키마를 오류로 반환합니다. 기존 migration을 고치거나 DB를 되돌리지 않습니다.
Kubernetes는 같은 이미지의 PreSync Job을 사용합니다.
[Ops migration 운영·복구 경계](../../infrastructure/gitops/docs/ops-migration.md)를 확인하세요.

[로컬 Argo 자동 배포](../../infrastructure/gitops/docs/local-auto-sync.md)는 `local_release prepare` hook에서
접수를 중지하고 진행 중인 평가가 없을 때 migration을 실행합니다. 모든 앱이 Healthy가 된 뒤
`local_release resume` hook이 평가 연결을 확인하고 자기 접수 중지만 복구합니다.
관리자의 기존 중지·이후 상태 변경은 보존하며, migration·배포 실패 시 접수를 자동 재개하지 않습니다.
[EKS Argo 배포](../../infrastructure/eks/argo-cd.md)는 같은 보호 로직의 `argo_release` 명령과
`govbiz-eks/*` 태그를 사용합니다. 기존 `local_release` 명령은 호환 진입점으로 유지합니다.

## Python을 호스트에서 실행

이 절의 명령도 `backend/ops-service`에서 실행합니다.

[uv 공식 설치 안내](https://docs.astral.sh/uv/getting-started/installation/)에 따라 uv 0.12.5와 Python 3.12를 준비합니다. 기존 uv는 요구 버전에 맞춥니다.

```powershell
Copy-Item .env.example .env
uv sync --locked
docker compose up --detach ops-mysql --wait
uv run --locked python manage.py check
uv run --locked python manage.py migrate_deployment
uv run --locked python manage.py runserver 127.0.0.1:8001
```

호스트에서 실행할 때는 Compose의 `ops-service`를 동시에 실행하지 않습니다. 이미 켜져 있다면 `docker compose stop ops-service`를 먼저 실행합니다. Linux에서 mysqlclient 빌드 도구가 없다면 `default-libmysqlclient-dev`, `build-essential`, `pkg-config`를 설치하거나 Docker 실행 경로를 사용합니다.

## 평가 배포 환경 진단

관리자 전용 `GET /api/v1/ops/runtime`은 평가 자료 해시·결과 디렉터리 접근·Prefect deployment 등록을
읽기 전용으로 확인합니다. `?run_id=<완료된 실행 UUID>`를 지정하면 해당 실행의 결과 무결성도 검사합니다.
실패 시 503을 반환하며, 미인증·비관리자·Core 장애의 접근 제한은 기존 Ops API와 같습니다.
Kubernetes liveness/readiness와 분리되어 있으며, 결과에는 검사 범위와 미검증 항목을 명시합니다.

`python manage.py check_evaluation_runtime [--run-id <UUID>]`로 같은 진단을 실행할 수 있습니다.
진단은 평가를 시작하거나 디렉터리를 생성하지 않습니다. `status: PASS`를 실행기 생존·공유 volume·
새 평가 성공으로 해석하지 않습니다. [Compose 연결 계약과 진단 응답](../../infrastructure/gitops/docs/ops-runtime.md)을 참고하세요.

## API

| 경로 | 성공 응답 | 실패 동작 |
| --- | --- | --- |
| `GET /api/v1/health` | `200`, `status: UP` | DB를 호출하지 않음 |
| `GET /api/v1/health/ready` | `200`, `database: UP, schema: UP` | DB 실패는 `database: DOWN`, 미적용 migration·이력 불일치·실제 테이블/컬럼 누락은 `schema: DOWN`으로 `503`; 내부 정보 비노출 |
| `GET /api/v1/ops/runtime` | `200`, 설정 검사 PASS와 검증 범위 | 구성·자료·Prefect·선택한 결과 검증 실패 `503`; 잘못된 run_id `400`; 관리자 인증 필수 |
| `GET /api/v1/ops/evaluations/live-readiness` | `200`, 선택 자료의 최대 예약량·잔여 한도·차단/주의 사유 | `dataset_id`, `execution_profile` 필수; 입력 오류 `400`, 미인증 `401`, 비관리자 `403`, 설정 변경 `409`, 계획 확인 실패 `503`; 조회만 수행 |
| `GET /api/v1/ops/session` | `200`, `user`(쿠키가 없으면 null), `csrf_token`, 허용 자료 목록, `search_traces_url` | 만료 `401`, 비관리자 `403`, Core 장애 `503` |
| `GET /api/v1/ops/traces` | Langfuse의 실행 시작 단계 목록; `name`, `from_time`, `to_time`, `cursor` 조회 조건 | 인증·권한 오류 `401/403`, 조회 조건 `400`, 추적 서버 장애·설정 누락 `503` |
| `GET /api/v1/ops/traces/{trace_id}` | 같은 trace ID의 단계·입출력·사용량; `cursor`로 다음 페이지 조회 | 인증·권한 오류 `401/403`, 없음 `404`, 추적 서버 장애 `503` |
| `GET /api/v1/ops/evaluations/{UUID}/report` | `200`, CSP sandbox가 적용된 HTML | 미인증 `401`, 비관리자 `403`, Core 장애 `503`, 없거나 훼손된 보고서 `404` |
| `POST /api/v1/ops/evaluations` | 최초 `202`, 재전송 `200`; 실행 메타데이터 | 자료/UUID 오류 `400`, 미인증 `401`, 권한·CSRF `403`, 요청 충돌 `409`, 인증 서버 장애·접수 미확인 `503` |
| `GET /api/v1/ops/evaluations` | `200`, 25건 페이지 (`count`, `next`, `previous`, `results`) | 미인증 `401`, 비관리자 `403`, Core 장애 `503` |
| `GET /api/v1/ops/evaluations/{UUID}` | `200`, 최신 상태와 요약·상세 링크 | 미인증 `401`, 비관리자 `403`, Core 장애 `503`, 없는 실행 `404`; Prefect 장애는 `error_code`로 구별 |

로그인·로그아웃은 기존 Core `/api/v1/auth/login`, `/api/v1/auth/logout`을 사용합니다.
별도 `/api/v1/ops/login`, `/logout`은 제공하지 않습니다. 먼저 Ops session API에서
CSRF 쿠키와 `csrf_token`을 받고 평가 POST의 `X-CSRFToken`에 넣습니다.
React는 쓰기 전 세션을 조회해 최신 토큰을 사용합니다. 세션·평가 응답은 캐시하지 않습니다.
Vite는 `/api/v1/ops`를 Core보다 먼저 라우팅하고 Host와 Origin을 보존합니다. Host를 바꾸는
별도 프록시에서는 실제 웹 Origin을 `DJANGO_CSRF_TRUSTED_ORIGINS`에 명시해야 합니다.
기존 `/api/v1/evaluations`는 `/api/v1/ops/evaluations`로 이동했습니다.

가상 6건 재현은 `request_id`, `dataset_id: "target-coverage-20260907-v1"`와 해당 자료의
`execution_profiles.replay` 값을 `execution_profile`로 전송합니다.
프롬프트 변경 비교 요청은 다음과 같습니다. 선택 가능한 자료·사례·캡처 목록은 session 응답의 `datasets`에 있습니다.

```json
{
  "request_id": "<새 UUID>",
  "dataset_id": "fixed-context-e01-v1",
  "reference_capture_id": "fixed-context-20260906-diagnostic-v1",
  "candidate_capture_id": "fixed-context-20260907-index-v1",
  "execution_profile": "<session에서 확인한 해당 자료의 execution_profiles.replay>"
}
```

비교 응답에는 지표별 기준·후보·차이, 사례별 상태·인용, 모델·프롬프트·실행기·캡처 해시가 있습니다.
두 캡처의 원본 사례는 각각 1건·4건이며 명시한 공통 E01 한 건만 비교합니다. 다른 자료의 조합은 `400`,
같은 UUID의 기준·후보 변경은 `409`입니다. 토큰 연결 정보가 없는 과거 기록과 의미 충실도는 미측정입니다.
`0002_evaluationrun_comparison` migration은 기존 행을 가상 6건 재현으로 유지하며 이전 결과의
`comparison`은 `null`입니다. 기존 보고서는 계속 열 수 있고, 새 실행부터 비교 상세가 저장됩니다.
통신 재시도에는 UUID와 선택 대상을 유지하고, 사용자가 의도적으로 새 평가를 시작할 때만 새 UUID를 발급합니다.
미확정 접수를 복구할 때도 같은 POST를 사용합니다. 요청이 이미 접수됐을 수 있으므로 새 UUID로 바꾸지 않습니다.

URL 끝에 슬래시를 붙이지 않습니다. 상태 확인 경로는 쓰기 요청을 받지 않습니다.

상태 확인 흐름은 `HTTP → Django URL → DRF View → JSON`이며, readiness는 MySQL에서
`SELECT 1`을 실행합니다. Ops에서 외부 모델 API를 호출하지 않습니다.

## 검증

로컬 MySQL을 실행한 뒤 다음 명령을 사용합니다.

```powershell
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python manage.py check
uv run --locked python manage.py makemigrations --check --dry-run
uv run --locked python manage.py test --noinput
```

Docker 안에서도 테스트할 수 있습니다.

```powershell
docker compose exec -T --env OPS_TEST_BUDGET_CLIENT_PATH=/evaluation-data/budget_client.py ops-service python manage.py test --noinput
```

사용량 증거의 실행기→Ops 계약 테스트는 기본적으로 `LLMOPS_EVIDENCE_DIR/budget_client.py`의
실제 실행기 코드를 읽습니다. 로컬 기본값은 저장소의 `evaluation/support-program-evidence`이며,
단독·루트 Compose는 같은 디렉터리를 `/evaluation-data`에 읽기 전용으로 연결합니다.
격리 이미지 테스트는 테스트 전용 `OPS_TEST_BUDGET_CLIENT_PATH`로 실제 소스의 절대 경로를
지정할 수 있습니다. 위 명령은 기존 `/evaluation-data` 마운트를 사용하며, 소스가 없거나 경로가
잘못되면 테스트를 생략하지 않고 실패합니다. 이 변수는 운영 설정이 아닙니다.
`/app/apps/evaluations`의 부모 깊이로 저장소 루트를 추정하지 않습니다.
DB가 필요 없는 서명·파일 검증은 `apps.evaluations.test_usage_correction.UsageReceiptTests`,
격리된 MySQL 8.4의 보정·경합 검증은 `apps.evaluations.test_usage_correction`으로 선택합니다.

테스트 러너는 별도 `test_govbiz4` DB를 생성·삭제합니다. Compose의 최초 DB 초기화 SQL은 개발 사용자에게 그 DB의 권한만 추가로 부여합니다. 테스트는 실제 MySQL 연결, DB 장애 시 503 응답, liveness의 DB 비의존성, HTTP 메서드 제한, 허용 호스트를 확인합니다.

GitHub Actions는 모노레포 루트의
[`ops-ci.yml`](../../.github/workflows/ops-ci.yml)에서 Ruff·Django 검사·실제 MySQL 테스트를
수행합니다. Docker job은 `infrastructure/scripts/check-compose.py --smoke`로 통합 Compose의
경로·환경 분리를 검사하고, 격리된 Django·MySQL만 빌드·실행하여 상태 확인과 테스트를
수행합니다. Core API·AI Service나 외부 AI API는 기동·호출하지 않습니다.
`python3 -B backend/ops-service/scripts/check-image.py`는 모노레포 루트에서 기본 Gunicorn
이미지를 별도로 검증합니다. 네트워크·DB·실제 환경 파일을 연결하지 않고 non-root,
읽기 전용 파일시스템, 정상 liveness, DB 장애 readiness, Host 거절, SIGTERM 종료를
확인합니다. Ops 소스 마운트 없이 이미지 자체의 `/app` 테스트를 실행하고, 실행기의
`budget_client.py` 한 파일만 테스트 입력으로 읽기 전용 마운트합니다. DB 없이 사용량 증거의
생성·서명·변조·심볼릭 링크 검증과 입력 누락 시 명시적 실패를 확인합니다. 운영 이미지에
평가 코드·SDK를 추가하지 않으며 이번 실행의 임시 컨테이너와 이미지 태그만 정리합니다.
실제 GitHub CI 실행은 파일을 원격 저장소에 올린 뒤 확인할 수 있습니다.

`scripts/check-schema.py --legacy-evaluations`는 CI의 별도 빈 MySQL 8.4 DB에서
`0017_input_token_budget` 스키마와 합성 이력을 만든 뒤 최신 migration까지 전진 적용합니다.
10개 모델의 기존 컬럼·11개 행, 한글·JSON·NULL·검토/예산 감사 관계를 대조하고 readiness의
실패→성공, 접수 중지 후 새 평가 거절, migration·동일 UUID의 중지 요청 재실행을 검증합니다.
`GITHUB_ACTIONS=true`와 `OPS_SCHEMA_TEST_ONLY=true`가 모두 필요하며, 기존 테이블이 있는 DB나
역방향 migration은 거부합니다. 기존 빈 DB→최신 배포 검사도 계속 별도로 수행합니다.
실행 보호 테스트는 `scripts/test_check_schema.py`에 두고 CI에서
`python -B -m unittest discover -s scripts -p 'test_*.py'`로 별도 실행합니다.
런타임 이미지에 포함되지 않는 CI 스크립트를 앱 테스트에서 참조하지 않습니다.
이 명령은 개인 DB 갱신 도구가 아닙니다. Core 인증은 주입하고 Prefect 호출은 대역으로 확인하므로
실제 로그인·새 평가 성공·개인 백업 복원을 증명하지 않습니다. 최초 전환의 쓰기 중지와 접수 제어
경계는 [Ops 갱신 절차](../../docs/ops-upgrade-runbook.md)를 따릅니다.

## 디렉터리

```text
config/                  Django 설정·URL·WSGI·ASGI
apps/health/             실행/DB 연결 상태 API 및 테스트
apps/evaluations/        Core 관리자 인증·평가 API·모델·migration·Prefect HTTP 연동·테스트
infrastructure/mysql/    개발용 테스트 DB 초기화
manage.py                관리 명령 진입점
pyproject.toml           Python 의존성과 개발 도구 설정
uv.lock                  확정된 의존성
Dockerfile               Gunicorn 기본 실행 이미지
compose.yaml             Django·MySQL 로컬 환경
scripts/check-image.py   배포 이미지 기본 명령·격리·상태 확인 검증
.env.example             로컬 환경변수 예시
```

## 환경변수와 다른 서비스 연결

`.env`는 Git/Docker 빌드 컨텍스트에서 제외됩니다. `.env.example`의 비밀번호와 비밀 키는 로컬 개발용입니다. 실제 환경변수가 `.env`보다 우선합니다.

- `DJANGO_SECRET_KEY`, `DB_PASSWORD`: 필수
- `DJANGO_DEBUG`: 기본 `false`; 예시 파일은 로컬 개발용 `true`
- `DJANGO_ALLOWED_HOSTS`: 쉼표로 구분하는 허용 호스트
- `DB_HOST`, `DB_PORT`: 호스트 실행 기본값 `127.0.0.1:3308`
- `API_PORT`, `MYSQL_PORT`: Compose가 호스트에 공개하는 포트
- `MYSQL_ROOT_PASSWORD`: 개발용 MySQL 초기화 비밀번호
- `CORE_API_URL`: Django에서 접근하는 Core 주소; 호스트 기본 `http://127.0.0.1:8080`
- `OPS_CORE_API_URL`: Compose에서 위 주소를 지정; 기본 `http://host.docker.internal:8080`
- `OPS_WEB_URL`: 이전 Django 화면 주소의 React 이동 대상; 기본 `http://localhost:5173`
- `PREFECT_API_URL`: Django에서 접근하는 Prefect API; 기본 `http://127.0.0.1:14200/api`
- `PREFECT_UI_URL`, `LANGFUSE_PROJECT_URL`: Prefect 상세·Langfuse 점수 등 원본 도구의 브라우저 링크
- `LANGFUSE_BASE_URL`: Django에서 접근하는 Langfuse HTTP(S) origin. Compose는 `http://langfuse-web:3000`, Kubernetes는 내부 Service 주소
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`: 조회 대상 프로젝트의 API 키. Ops 서버 Secret에만 주입하며 브라우저에 전달하지 않음
- `LLMOPS_RESULTS_DIR`: 실행기 결과를 읽는 디렉터리; 기본 저장소 `work/llmops-ops`
- `DJANGO_COOKIE_SECURE`: 기본값은 `not DJANGO_DEBUG`. 로컬 HTTP 개발에서만 `false`

컨테이너 간 연결 주소와 브라우저 링크 주소는 다릅니다. 전용 Compose는 API에 `prefect:4200`,
브라우저 링크에 `localhost:14200`을 사용합니다. Core 세션 쿠키 `govbiz_session`은 동일 웹 origin의
Core·Ops API에서 공유하고, Ops CSRF 쿠키는 `govbiz_ops_csrf`로 구별합니다. `localhost`와
`127.0.0.1`을 브라우저 주소에서 혼용하지 않습니다. `govbiz_ops_session`은 인증 근거로 사용하지 않습니다.
관리자의 **AI 실행 추적**은 같은 React 앱의 `/ops/traces`로 연결됩니다. 관리자 세션의
`search_traces_url`과 평가의 사례별 추적 링크도 `OPS_WEB_URL` 아래의 이 화면을 사용합니다.
흐름은 `React → Ops → Core 관리자 세션 확인 → 내부 Langfuse Observations v2 API`입니다.
매 요청마다 현재 Core 관리자 권한을 확인하므로 IP 변경이나 별도 Langfuse 로그인 없이 읽을 수 있습니다.
비로그인 `401`, 비관리자 `403`, 인증 서버·추적 서버 장애 `503`을 구별하며 실패를 빈 목록으로 표시하지 않습니다.
추적 조회는 GET만 허용하고 응답을 저장 캐시하지 않습니다. 새 검색·모델 호출·추적 변경은 발생하지 않습니다.

목록은 기본 최근 7일, 최대 30일 기간의 **실행 시작 단계(logical root observation)**를 50개씩 읽습니다.
같은 trace에 서비스별 시작 단계가 여러 개일 수 있으므로 목록 건수를 고유 실행 수로 해석하지 않습니다.
`name`은 단계 이름의 정확한 일치 필터입니다. 다음 페이지는 응답의 `next_cursor`와 같은
`from_time`·`to_time`·`name`을 사용합니다. 상세는 해당 trace의 단계를 50개씩 조회하며
`next_cursor`가 있으면 아직 더 읽을 단계가 있습니다. 비용·사용량 미기록은 0으로 채우지 않습니다.
입출력은 원문 문자열이고 메타데이터는 Langfuse API의 기본 길이 제한이 적용됩니다.
API 응답은 최대 4 MiB이며 리디렉션·잘못된 응답은 거절합니다. 프로젝트 키로 접근 가능한 데이터만 읽습니다.

Langfuse 자체 UI와 기존 점수 링크는 여전히 별도 로그인·접근 정책을 사용합니다.
추적 범위·설정·실서버 검증 상태는 [검색 추적 안내](../../infrastructure/llmops/README.md#지원사업-ai-검색-추적)를 따릅니다.

Compose의 DB 이름/사용자는 `govbiz4`로 고정하여 테스트 초기화 SQL과 일치시킵니다. 포트를 변경하면 호스트 실행의 `DB_PORT`도 맞춰야 합니다.

향후 Django가 담당할 업무를 확정한 뒤 같은 모노레포의 React·Spring Boot·FastAPI와 HTTP 또는 메시지 계약으로 연결합니다. 같은 테이블을 Spring의 Flyway와 Django migration이 동시에 관리하지 않도록 데이터 소유권을 먼저 정합니다.

## 운영 배포 경계

회원·세션 테이블은 Core에 유지하고 관리자 확인 HTTP API로만 연동합니다.
운영 배포에는 같은 origin의 Core·Ops 프록시와 내부 `CORE_API_URL`, HTTPS 쿠키 설정이 필요합니다.
Kubernetes 매니페스트와 배포 이미지 버전은 같은 저장소의 `infrastructure/gitops/`에서 관리합니다.
이 이미지에는 클러스터 생성·Argo CD 설치·운영 데이터 변경 기능이 없습니다.

Mac 유지형 포트폴리오 배포는 [GitOps 안내](../../infrastructure/gitops/docs/portfolio-gitops.md)를 따릅니다.
기존 두 저장소 환경에서는 CI가 비공개 GHCR에 이미지를 발행하고, infra가 검증한 digest를 선택하면
Argo CD가 이 서비스의 Deployment를 동기화했습니다. 교육기관 통합본에서는 해당 자동 발행·promotion을
잠갔으며 개인 포크 연결은 별도입니다. 이미지 발행만으로 관리자 인증·업무 기능이 추가되는 것은 아닙니다.

- 이미지 기본 명령은 `gunicorn config.wsgi:application`, 내부 포트는 `8000`입니다.
  worker 2개, worker 응답 정지 제한 30초, 종료 유예 25초이며 stdout/stderr로 로그를 냅니다.
- UID/GID는 `10001:10001`입니다. Kubernetes에서 `runAsNonRoot: true`,
  `readOnlyRootFilesystem: true`를 사용하고 `/tmp`에 쓰기 가능한 작은 `emptyDir`를
  마운트합니다. Gunicorn heartbeat 임시 파일이 필요하므로 `/tmp`까지 읽기 전용이면
  기동하지 못합니다. Pod 종료 유예는 Gunicorn의 25초보다 길게 설정합니다.
- `DJANGO_DEBUG=false`, 별도 무작위 `DJANGO_SECRET_KEY` 및 DB 비밀번호를 Secret으로
  주입합니다. DB 주소는 Ops 전용 DB이며 Core API의 DB 자격증명을 재사용하지 않습니다.
- `DJANGO_ALLOWED_HOSTS`에는 접근할 Service DNS/호스트만 지정합니다. HTTP probe는
  `/api/v1/health`와 `/api/v1/health/ready`를 사용하며 허용된 `Host` 헤더가 필요합니다.
  liveness/startup은 DB를 보지 않고 readiness만 DB를 확인합니다.
- `python manage.py migrate --noinput`은 별도 배포 작업으로 한 번 실행합니다.
  Pod마다 동시에 migration을 실행하는 시작 명령은 넣지 않습니다. Django auth·session과
  `evaluations/0001_initial.py`를 함께 적용해야 운영자 화면을 사용할 수 있습니다.
- 공개 운영 전에는 TLS/신뢰 프록시, 인증·권한, DB TLS/백업을 별도 구성하고 실제 배포
  환경에서 `python manage.py check --deploy`를 점검해야 합니다. 이 작업은 개발용
  `runserver`를 대체했을 뿐, 해당 보안·업무 구성을 모두 완료한 것은 아닙니다.

설정 근거: [Django Gunicorn 배포](https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/gunicorn/),
[Gunicorn 설정](https://gunicorn.org/reference/settings/),
[Django 배포 체크리스트](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/).

### 내부 HTTP 평가 저장소

`LLMOPS_ARTIFACT_URL`이 비어 있으면 기존 파일 저장소를 사용한다. URL과 별도
`LLMOPS_ARTIFACT_TOKEN`을 지정하면 결과·평가 자료·사용량 증거를 인증된 내부 HTTP로 읽는다.
호출 흐름은 `Ops API·동기화 → 결과 HTTP 서버 → Compose 결과 볼륨·평가 자료`다.
보고서·비교·검토·복구 입력의 기존 무결성 검증은 유지하며 원격 장애 시 파일 방식으로 대체하지 않는다.
결과 서버는 같은 이미지에서 `gunicorn 'apps.evaluations.artifact_server:create_app()'`로 실행하고,
Django 설정·DB·평가 SDK·모델 키를 필요로 하지 않는다. 호스트 포트는 공개하지 않는다.

[Compose 실행 방법](../../infrastructure/llmops/README.md#내부-http로-결과-조회)과
[Kubernetes 연결 조건](../../infrastructure/gitops/docs/ops-runtime.md)을 참고한다.
진단 응답의 `storage_transport`로 실제 선택한 방식을 확인한다. `results_directory`는 호환성을 위해
HTTP 모드에서도 유지하며 인증된 원격 저장소 상태를 검사한다. 일반 결과는 파일당 8 MiB,
사용량 증거는 별도 `/v1/usage-receipts/{run UUID}/{sequence}` 경로에서 8 KiB로 제한한다.
일반 `/v1/results` 경로로 사용량 증거를 조회할 수 없다. 서명 원본은 내부 CLI 소비자만 읽고
관리자 API·브라우저에는 기존 보정 요약만 제공한다.
HTTP 보정을 사용하려면 artifact 서버와 Ops 소비자를 함께 갱신한다. 서버를 먼저 갱신해도
기존 결과 API는 유지되며, 구형 서버의 404는 정상 보정으로 처리하지 않는다.
