# Kubernetes 내부 연결과 기존 데이터 사용

Compose의 호스트 주소·공유 볼륨을 배포 설정에 가져오지 않고, 기존 Helm Chart를 Kubernetes
Service와 복원된 PVC에 연결하는 추가 values다. 실제 클러스터·Secret·PVC를 만들거나 데이터를
이전하는 도구가 아니며, 기존 Argo Application이나 개발 환경에 자동 적용되지 않는다.

## 서비스 연결

| 구성 | Kubernetes 연결 |
| --- | --- |
| 정적 웹 | `govbiz-msa`의 `web:8080` → 같은 namespace의 `core-service:8080`, `ops-service:8000` |
| Core·Catalog·AI | 기존 서비스별 DB·Catalog·Qdrant·Elasticsearch·Redis Service 사용 |
| Ops API·sync | `core-service.govbiz-msa`로 관리자 인증, `prefect.govbiz-evaluation`로 실행 관리, `ops-artifacts.govbiz-evaluation`로 결과 조회 |
| 평가 실행기 | 같은 namespace의 Prefect·결과 PVC, `ops-service.govbiz-msa` 예산 API, `langfuse-web.govbiz-observability` 추적 |
| Core·AI 추적 | `langfuse-web.govbiz-observability.svc.cluster.local:3000` |
| Ops 관리자 추적 조회 | 같은 내부 Langfuse 주소의 Observations v2 API. GovBiz 관리자 세션으로 조회하며 별도 Langfuse 로그인 불필요 |
| 평가 결과·벡터 캐시 | 실행기와 결과 서버가 같은 결과 PVC를 사용. Ops는 인증된 HTTP로 조회 |
| Langfuse | 기존 `govbiz-observability` Chart의 PostgreSQL·ClickHouse·Redis·MinIO Service/PVC 사용 |

`ops-service.yaml`은 API와 같은 이미지·환경의 `ops-sync`를 켠다. `LLMOPS_LIVE_ENABLED`,
`LLMOPS_RAG_LIVE_ENABLED`, `LLMOPS_SCHEDULES_ENABLED`는 모두 `false`다.
`evaluation-runner.yaml`은 내부 주소만 고정하고 replica 0을 유지한다. 기존 실행기 Chart도
유료 호출·정기 실행을 끄며 OpenAI 키를 주입하지 않는다. 이 설정으로 유료 RAG가 활성화되지는 않는다.

AI의 실제 모델 주소와 외부 수집·메일·큐 실행 여부는 원래 환경의 명시적 설정을 따른다.
`local-msa`를 기반으로 렌더링하면 무료 OpenAI 대역·비활성 수집 설정이 유지된다. 실제 API 키나
호스트 `.env`를 이 디렉터리에 복사하지 않는다.

## 적용할 values와 이미지

서비스별로 **기본 values → 이 디렉터리의 같은 이름 파일 → 검증된 이미지·환경별 values** 순서로
합친다. Core·Catalog·AI·Ops·웹은 독립 release를 유지한다. 이미지 repository/digest를 입력하기
전에는 렌더링이 실패한다. 예전 발행본이나 임의의 digest를 예시값으로 배포하지 않는다.

아래는 클러스터에 적용하지 않는 Ops 렌더링 예시다. `GOVBIZ_OPS_VALUES`는 기존 발행·검증 절차로
확보한 이미지 repository/digest와 환경별 설정을 담은 파일의 경로다. 비밀값은 담지 않는다.

```bash
helm template ops-service infrastructure/gitops/charts/govbiz-service \
  --namespace govbiz-msa \
  -f infrastructure/gitops/environments/local-msa/ops-service.yaml \
  -f infrastructure/gitops/environments/in-cluster/ops-service.yaml \
  -f "${GOVBIZ_OPS_VALUES:?검증된 Ops 이미지·환경 values 경로를 지정하세요}"
```

기존 Argo 환경에서는 같은 순서의 `valueFiles` 또는 검토한 `valuesObject`로 반영하며,
같은 Deployment를 별도 Helm 명령으로 동시에 관리하지 않는다. Ops와 평가 실행기·결과 서버는
동일 소스의 실행 release가 일치해야 한다. 실행기 overlay는 [평가 발행 계획](../../docs/evaluation-kubernetes.md)의
검증된 values 위에 합치고 `check_evaluation.py`로 세 release를 함께 검증한다.
Langfuse는 [관측 Chart](../../charts/govbiz-observability/README.md)를 사용한다.

필수 Secret 참조는 다음과 같다. `secretKeys`는 Helm에서 배열 전체가 교체되므로 기존 환경의
메일·소셜 로그인 등 추가 키도 최종 values에 함께 유지한다.

| Secret | 기존 값에 추가·보존할 키 |
| --- | --- |
| `ops-runtime` (`govbiz-msa`) | Django·DB 키, `LLMOPS_ARTIFACT_TOKEN`, `LLMOPS_BUDGET_TOKEN` |
| `llmops-artifacts` (`govbiz-evaluation`) | Ops와 같은 `LLMOPS_ARTIFACT_TOKEN` |
| `llmops-runner` (`govbiz-evaluation`) | Ops와 같은 예산 토큰, Langfuse 프로젝트의 public/secret key |
| `core-runtime`, `ai-runtime` (`govbiz-msa`) | 기존 서비스별 키를 보존하고 프로젝트의 `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` 추가 |
| `ops-langfuse` (`govbiz-msa`) | 기존 Langfuse 프로젝트의 `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`를 별도로 등록. Ops 관리자 추적 조회용 |
| `core-mysql-runtime`, `catalog-mysql-runtime`, `ops-mysql-runtime` (`govbiz-msa`) | 복원 DB와 일치하는 `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`; 앱 DB 비밀번호와 대응 |

Ops의 `opsTraces.enabled=true`는 API·sync·migration에 `ops-langfuse`의 두 키만 주입한다.
두 키를 `ops-runtime`에 추가하지 않는다. 기존 암호화 백업의 DB·인증·평가 토큰 범위는 그대로이며,
다른 클러스터에서 추적 조회를 켤 때는 해당 환경의 Langfuse 프로젝트 키를 별도 준비한다.

브라우저용 기본 주소는 `http://localhost:18173`이다. Core의 허용 Origin·OAuth 반환 주소·리포트 링크와
Ops 웹 주소를 함께 맞췄다. 서비스 간 통신에 이 loopback 주소를 사용하지 않는다.
Ops의 허용 호스트에는 실행기가 사용하는 Service FQDN을 포함한다.
외부 HTTPS로 배포할 때는 실제 웹 origin, 쿠키 Secure, OAuth 등록 주소·TLS 프록시 설정을 함께
변경한다. [정적 웹 배포](../../docs/web-kubernetes.md)의 이미지·프록시 검증을 따른다.

`PREFECT_UI_URL`은 브라우저 링크 주소일 뿐 UI 활성화 설정은 아니다. 기존 평가 Chart의 Prefect UI는
비활성화되어 있으며, 이 프로필도 이를 바꾸지 않는다. Langfuse 화면의 port-forward와 프로젝트 링크도
실제 배포 환경에서 별도로 지정한다.

## MySQL·검색·큐의 기존 PVC 연결

기존 `govbiz-local-data` Chart에 외부 PVC 연결 모드를 추가했다. Chart 이름은 기존 사용처와의
호환을 위해 유지하며, 단일 노드용 구성이다. 기본값만으로 실행할 수는 없다.

- 무료 테스트: 기존 `allowDisposableData=true`가 새 PVC를 만든다.
- 데이터 이전: `allowDisposableData=false`와 `existingClaims`에 **복원이 확인된 PVC**를 모두 지정한다.
  이 모드는 PVC·PV·Secret이나 `volumeClaimTemplates`를 생성하지 않고 지정한 볼륨만 연결한다.
- 각 저장소의 PVC는 서로 달라야 한다. 누락·오타·빈 이름·중복 PVC·두 모드 혼용을 거절한다.
- 데이터 형식과 호환되는 `image@sha256`를 모든 저장소에 지정한다. Elasticsearch의 Nori 플러그인도
  기존 이미지와 같아야 하며 `pullPolicy: Never`인 호스트 적재 이미지에 의존하지 않는다.

`data.yaml`의 빈 PVC 이름은 실제 복원 이름을 입력하라는 뜻이다. 다음 환경별 파일에는
`existingClaims` 여섯 항목, `mysqlImage`, `stores.redis.image`, `stores.qdrant.image`,
`stores.elasticsearch.image`와 필요 시 DB명·계정·저장소 설정을 넣는다.

```bash
helm template data infrastructure/gitops/charts/govbiz-local-data \
  --namespace govbiz-msa \
  -f infrastructure/gitops/environments/in-cluster/data.yaml \
  -f "${GOVBIZ_DATA_VALUES:?복원 PVC와 호환 이미지의 values 경로를 지정하세요}"
```

RabbitMQ를 쓰는 환경은 `rabbitmq.enabled=true`, `existingClaims.rabbitmq`, 고정 이미지와
`rabbitmq-runtime` Secret도 준비한다. 사용자·vhost·노드 이름과 Erlang cookie가 복원 자료와
일치해야 한다. 기존 Compose 노드의 데이터 디렉터리를 이름이 다른 노드에 그대로 연결하지 않는다.
Core는 이 프로필의 `rabbitmq.govbiz-msa.svc.cluster.local:5672`에 연결한다.
업무 큐를 켤 때는 환경별 Core values의 `secretKeys`에 기존 키들과 함께 `RABBITMQ_PASSWORD`를
포함하고, `core-runtime`에 RabbitMQ 계정과 일치하는 비밀번호를 주입한다. 큐별 활성화 플래그도
별도로 지정한다. 이 프로필의 기본값은 큐 소비·발송 기능을 켜지 않는다.

Helm의 오프라인 검증은 PVC의 존재·Bound 상태·접근 모드·노드 배치·복원 내용까지 확인하지 않는다.
실제 전환에서는 이를 확인하고 원본 쓰기를 중지한 뒤 일관된 백업·복원과 애플리케이션 검증을 수행한다.
MySQL 초기화 환경변수는 기존 DB의 사용자·비밀번호를 바꾸지 않으므로 복원 DB와 Secret이 같아야 한다.
기존 `volumeClaimTemplates` StatefulSet을 새 모드로 직접 upgrade하지 않는다. 별도 검증 환경에서
복원 후 전환하며, 기존 StatefulSet의 immutable 필드 오류를 삭제·재생성으로 자동 우회하지 않는다.

## 준비 순서와 검증 범위

1. 같은 소스의 필수 CI·이미지·Ops 실행 release를 검증한다.
2. `govbiz-msa`, `govbiz-evaluation`, `govbiz-observability`의 Secret과 복원 PVC를 준비한다.
3. 데이터 서비스와 Langfuse 저장소·웹·worker를 기동해 읽기·인증·보존을 확인한다.
4. Core·Catalog·AI와 Prefect·결과 서버를 연결한 뒤 Ops migration·API·sync를 반영한다.
5. 정적 웹의 로그인·Ops 조회를 검증하고, 실행기를 별도로 활성화해 무료 평가·보고서·추적을 확인한다.
6. 기존 Compose가 멈춘 상태에서도 같은 결과가 유지되는 것을 확인한 뒤 실제 이전 완료로 기록한다.

자동 검증 범위는 Helm 4.3.0 렌더링·PVC 연결·내부 주소·Secret 참조·비활성 기본값이다.
`scripts/test_in_cluster.py`는 Infra CI의 기존 전체 테스트 검색에 포함된다. 이 검증만으로 실제
데이터 이전·클러스터 배포·NetworkPolicy 집행·로그인·무료 평가·장애 복구 완료를 판단하지 않는다.

## 로컬 전환 확인 기록 — 2026-10-11

로컬 `govbiz-migration-20261011` 클러스터에 환경별 values와 Secret을 적용한 결과다.
이 디렉터리의 기본값을 적용하는 것만으로 같은 데이터·유료 실행 설정이 만들어지지는 않는다.

| 확인 대상 | 실제 확인 결과 |
| --- | --- |
| 독립 서비스 | AI·Catalog·Catalog MySQL·RabbitMQ를 기동하고 Core를 내부 Service DNS로 연결. 관련 Pod 21개 Ready, 실행 Pod가 사용하는 PVC 13개 Bound |
| 공고 보존 | 기존 Core DB의 공고 10,129건과 동기화 상태를 Catalog DB에 복사. 복사 시 모든 열의 해시 일치 확인, Core의 기존 공고 ID·원본 식별자·공개 여부 보존 |
| Catalog → Core | 기업마당 1,526건·K-Startup 4,143건·과기정통부 4,249건의 공개 공고를 반영하고 제공처별 checkpoint 저장. 미발행 CNTRADE는 전환 대상에서 제외 |
| 검색 색인 | 기존 Elasticsearch·Qdrant 데이터를 그대로 사용. 공고 전체 재색인·재임베딩 없이 검색 가능 상태 9,918건 확인 |
| 실제 검색 | Kubernetes 웹 → Core → Elasticsearch·AI → Qdrant·OpenAI 경로로 `스마트공장 지원` 1회 실행. HTTP 200, 약 38.2초, 후보 20건에서 5건 선정. 비회원 응답에는 기존 정책에 따라 2건 표시 |
| 호출·추적 | 질문 임베딩 1회(입력 8토큰), 순위 평가 1회(입력 27,633·출력 2,950토큰), 추가 유료 재시도 없음. Langfuse 추적 17개 모두 종료·오류 없음 확인 |
| RabbitMQ | 리포트 생성·전달, 중복 수혜 검토, 신청 양식 탐색의 큐 4개에 Core 소비자 연결. 존재하지 않는 작업 ID의 메시지 1건으로 발행·수신·ACK 검증, 업무 행 생성·모델 호출 없음 |
| 보존·백업 | 원래 Compose 볼륨 유지. 전환 전후 Core DB와 전환 후 Catalog DB·인증 설정의 암호화 백업 보관. 연결된 PV의 `Retain` 정책 확인 |

실제 검색은 공개 공고 최대 20건과 질문 임베딩·순위 평가 각 1회, 출력 최대 10,000토큰으로
사용자에게 승인받아 실행했다. 이 한 건의 성공을 전체 RAG 품질이나 모든 업무 기능의 검증으로
해석하지 않는다. 자동 수집·전체 색인 갱신·메일·푸시·Ops 유료 평가·정기 실행은 활성화하지 않았다.
관심 공고의 원문 자동 준비는 기존 `PENDING` 1건이 추가 임베딩 호출을 유발하므로 보류했다.
OAuth 연결 해제도 기존 비활성 설정을 유지했다. 큐 연결 검증은 실제 메일 발송이나 모델 작업
완료 검증과 구분한다.

환경별 적용 파일·백업·확인 결과는 Git에서 제외된
`.data/kubernetes-migration/20261011/expansion/`에 보관한다. 비밀값과 DB 덤프는 저장소에 추가하지
않는다. EKS는 아직 생성·배포하지 않았다. EKS로 옮길 때는 검증된 이미지의 레지스트리 발행,
EBS 등 새 PVC로의 복원, Secret 주입, 외부 HTTPS·로그인·네트워크 및 검색 경로를 별도로 검증해야 한다.
