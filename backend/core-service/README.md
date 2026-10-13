# GovBiz Core Service

맞춤 리포트 앱 푸시는 기존 생성 큐와 별도 MyBatis 발송 기록을 사용합니다. 서버 공통 시각 이후 READY 리포트를
Expo Push Service로 보내고 FCM/APNs receipt를 확인합니다. `DAILY_REPORT_PUSH_ENABLED`는 기본 꺼짐입니다.
설정·HTTP 계약·세션 경계는 [모바일 리포트 푸시](../../docs/mobile-report-push.md)에 정리했습니다.

소스 디렉터리와 Compose 서비스·내부 DNS는 `core-service`, ECR 이미지 경로는 `govbiz/core-service`입니다.
Gradle·Spring 애플리케이션 이름과 health 응답은 `govbiz-core-service`로 통일했습니다.
현재 운영 환경은 없으며, 이전 런타임 이름으로의 별칭은 제공하지 않습니다.

## 공고 카탈로그 독립 서비스 전환

루트 Compose의 기본 분리 경로에서 `backend/catalog-service`가 공고 원본 DB·제공처 수집·색인 게시를 소유합니다.
Core는 내부 HTTP로 받은 완전한 snapshot을 자신의 읽기 projection에 반영하여 기존 공개 API와
관심 공고·파트너 FK를 유지합니다. `CATALOG_PROJECTION_ENABLED=true`이면 Core의 기존 수집·색인
writer는 조립되지 않습니다. 직접 실행 시 기본값 false는 기존 embedded 실행·AWS 호환을 위한 임시 경로이며,
루트 Compose에서는 true로 고정합니다. 기존 데이터 재사용 전에는 대조·전환 확인이 필요합니다.

아래 기존 수집 설명은 embedded 모드 기준입니다. 새로운 코드·DB·실행 경계, V41 migration,
격리 검증과 아직 수행하지 않은 운영 이전은 [Catalog 서비스 분리](../../docs/catalog-service-extraction.md)를 따릅니다.
V51은 Catalog snapshot의 공식 문의처(`contact_department`·`contact_phone_number`·`contact_text`), K-Startup 우대 사항
(`preference_description`)·주관 기관 유형(`supervising_institution_type`) 열을 추가합니다. 이 값은 projection 해시에
들어가므로 V51은 checkpoint `revision`만 0으로 되돌려 다음 수신 때 같은 snapshot을 한 번 다시 UPSERT하게 합니다.
embedded 수집기는 이 필드를 채우지 않아 해당 모드의 상세 응답에서는 null입니다.
계정·기업·신청·리포트 등의 업무는 이번 단계에서 다른 서비스로 이동하지 않습니다.

AWS 초기 운영 설정은 [별도 Compose 및 배포 안내](../../docs/deployment-aws-vercel.md)에 있습니다.
private RDS TLS 검증, Secure 쿠키, 개발 로그인 비활성화, Nginx 고정 IP만 신뢰하는 전달 헤더 설정을 사용합니다.
로컬 기본 `server.forward-headers-strategy=none`과 개발 실행 방식은 유지합니다. 실제 RDS/CloudFront 연결 검증은 배포 시 필요합니다.

브라우저에 공개하는 Spring Boot API입니다. 기업마당·K-Startup·과기정통부·충청남도 수출입공지 수집기를 제공하며, Elasticsearch 키워드·Qdrant 벡터 색인을 준비한 뒤 MySQL에
공개하고, 저장된 공고의 검색·상세 조회와 기업마당·K-Startup 공식 원문 근거 질문을 담당합니다.

프로젝트 전체 설명은 [메인 README](../../README.md), 계층·Facade·DI 설계는
[아키텍처 README](../../docs/architecture/README.md#core-api-업무-흐름과-외부-경계), 기술 선택과 구현 범위는
[기술 구성](../../docs/technology.md)과 [구현 현황](../../docs/implementation-status.md),
실제 실행 순서는 [호출·데이터 흐름](../../docs/architecture.md)을 참고하세요.

## 카카오 탈퇴 연결 해제

탈퇴와 `V28` 연결 해제 작업을 같은 MySQL transaction에 저장합니다. 성공 전까지 이전 카카오 identity를 유지해
같은 공급자 계정의 재가입을 막고, OAuth 콜백은 `unlink-pending`으로 안내합니다.
`AccountOAuthUnlinkScheduler → QueueClient → RabbitMQ → Consumer → Service → KakaoOAuthClient`로 처리하며,
큐 없는 환경은 스케줄러가 동일 Service를 직접 호출합니다. HTTP는 DB transaction 밖에서 실행합니다.
`ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED`는 직접 Core false / Compose true, 전체 실행 스위치 `ACCOUNT_OAUTH_UNLINK_ENABLED`는 true입니다.
불명확한 응답·중단은 UNKNOWN으로 남기며 자동 재호출하지 않습니다. 대화 기록 삭제는 기존 탈퇴 transaction 안에서 유지합니다.
[상태·DB 차단·설정·운영자 확인·검증](../../docs/rabbitmq-account-oauth-unlink.md)을 참고하세요.

## 관리자 Gov 에이전트

`POST /api/v1/gov-agent/messages`는 `AdminPrincipal`의 서버 세션·관리자 권한 검사를 거칩니다.
요청은 기존 조건 해석 계약인 `conversation`과 선택한 공고의 복합 식별자 `selectedProgram`(nullable)입니다.
`Controller → GovAgentService → AiGovAgentClient → AI supervisor`에서 경로를 선택한 뒤
동일 Service가 기존 `SupportProgramConversationService` 또는 `SupportProgramEvidenceService`를 실행합니다.
응답 `outcome`은 `SEARCH`(interpretation), `EVIDENCE`(program·evidence), `APPLICATION`(program·message),
`COMBINATION_REVIEW`(nullable program·message), `PARTNERS`(message), `NEEDS_PROGRAM` 또는 `UNSUPPORTED`(message)입니다.

검색은 조건 제안까지만 반환하며 확인 후 기존 검색 API가 `AI_SEARCH` 사용량을 집행합니다.
원문 답변은 기존 `PlanUsageService.consume(EVIDENCE_QUESTION)`에서 처리하므로 실패 시 사용량 반환도 유지합니다.
공유 요청 제한을 적용하고 응답은 `no-store`입니다. AI에 계정 ID·권한·임의 도구 URL을 전달하지 않으며,
분류용 문장의 개인 식별 정보는 기존 마스킹을 재사용합니다. 알 수 없는 AI action과 upstream 오류는 명시적인 오류입니다.
`APPLICATION`은 사용자가 선택한 복합 식별자와 신청 준비 안내만 반환합니다. 선택이 없으면 `NEEDS_PROGRAM`이며 양식 분석·준비 건 생성·사용량 차감은 하지 않습니다.
웹의 신청 준비 카드가 기존 `application-preparations` API를 재사용합니다. 분석·작성은 버튼으로 명시적으로 실행하며 기존 소유권·작업 큐·사용량 경계를 유지합니다.
준비 건 생성 후 웹은 반환된 `preparationId`를 기존 대화 JSON에 선택 필드로 저장하고, 같은 대화에서 답변 편집·문서 생성·다운로드를 이어갑니다.
이 ID는 권한이나 실행 승인이 아니며, 기존 신청 준비 API가 매번 계정 소유권과 현재 revision·작업 상태를 검증합니다. Gov 에이전트 응답 계약에는 준비 건 ID를 추가하지 않습니다.
`COMBINATION_REVIEW`는 선택한 공고가 있으면 그 복합 식별자를 첫 공고 후보로 반환하고, 없어도 검토 준비 안내를 반환합니다.
웹은 기존 중복 검토 입력 화면에서 두 공고·참여 상태·사업 관계를 확인합니다. 저장과 분석은 명시적 버튼으로 기존 `combination-reviews` API를 호출하며, 기존 소유권·revision·요청 키·사용량·작업 큐 경계를 유지합니다.
`PARTNERS`는 `program`이 null이고, 경로 선택과 같은 호출에서 받은 `partnerConditions`(찾는 역할·지역·분야 말·"이 공고")를 근거 문구가 사용자 말에 있는지 확인한 뒤 돌려줍니다. 화면은 이 조건으로 `GET /api/v1/partners/recruitments/recommended`를 조회하며, 제안 발송·모집글 작성은 실행하지 않습니다.
두 경로의 Gov 응답 자체는 검토 생성·분석·사용량 차감을 하지 않습니다. 새 DB·migration·실행 서비스는 필요하지 않습니다.
외부 기관 제출, 제안 발송, 모집글 자동 작성, 저장·삭제와 여러 작업 자동 실행은 `UNSUPPORTED`입니다.

## 계정별 대화 기록

`ai.govbiz.core.chathistory`는 로그인 회원 본인의 대화 스냅샷을 보관합니다. `V19__create_chat_conversation.sql`로
기존 MySQL에 테이블을 추가하며 기존 migration·공고 데이터는 수정하지 않습니다.

| API | 동작 |
|---|---|
| `GET /api/v1/me/chat-conversations?before=123` | 본인 기록 요약 최대 30개와 `nextCursor`. 생성 ID 내림차순, 스냅샷 본문 제외 |
| `GET /api/v1/me/chat-conversations/{id}` | 본인 기록의 요약·버전·스냅샷 조회 |
| `PUT /api/v1/me/chat-conversations/{id}` | `{expectedVersion, snapshot}` 저장. 최초 버전 0, 이후 읽은 버전으로 갱신 |
| `DELETE /api/v1/me/chat-conversations/{id}` | 본인 대화의 제목·스냅샷 삭제. 본문 없는 204, 반복 요청도 동일 |

모든 요청은 세션 쿠키와 `X-Chat-Account`(화면 계정 이메일의 URL 인코딩 값)를 보냅니다. 소유자는 세션의 account ID로만
정하고, 헤더는 다른 탭에서 계정이 바뀐 경우 요청을 차단하는 사전조건입니다. 비로그인·계정 불일치는 401, 타인 기록은
조회 시 404, 허용 Origin 없는 상태 변경은 403입니다. 삭제는 기록의 존재 여부를 노출하지 않고 본인 범위에서만 204를
반환하므로 다른 계정의 같은 ID 기록에는 영향이 없습니다. 관리자도 타인의 개인 대화를 조회·삭제할 수 없으며 응답 캐시는 `no-store`입니다.

스냅샷 `schemaVersion=1`, 첫 사용자 메시지 ID와 경로 ID 일치, 메시지 200개·UTF-8 JSON 2,000,000바이트 이하를 검증합니다.
제목은 첫 질문에서 유니코드 문자 최대 80개로 만듭니다. 이것은 회원이 보관하는 화면 데이터로, 서버가 보증한 검색 결과나
AI 입력의 신뢰 근거로 사용하지 않습니다. 프론트엔드는 복원 시 DTO·공식 원문 링크 등을 별도로 검증합니다.
저장 transaction에서 계정 행을 잠그고 버전을 검사합니다. 오래된 다른 내용은 409이며 같은 JSON의 재전송은 멱등입니다.
`V21__add_chat_conversation_deletion.sql`은 `deleted_at`을 추가합니다. 삭제는 제목을 빈 문자열, 스냅샷을 `{}`로
비우고 최소 식별 정보·삭제 표시만 남깁니다. 목록·상세에서 제외하며 복구 기능은 없습니다. 최초 저장보다 삭제가 먼저
도착해도 같은 계정 잠금 아래 삭제 표시를 기록하고, 이후 모든 버전의 저장을 409로 거절해 자동 저장·다른 탭의 재생성을 막습니다.
삭제 응답 유실 시 같은 DELETE를 재시도할 수 있습니다. 계정 탈퇴 이벤트는 같은 transaction에서 삭제 표시까지 제거합니다.
저장·조회·삭제에는 외부 API·OpenAI 호출이 없습니다.

### V19 병합 충돌과 기존 DB 업그레이드

마이그레이션 순서는 `V19__create_chat_conversation.sql` → `V20__add_account_admin_management.sql` →
`V21__add_chat_conversation_deletion.sql`입니다. 관리자 기능 브랜치의 중복 V19는 SQL 내용을 바꾸지 않고 V20으로
이동했습니다. 이미 적용된 대화용 V19의 파일·체크섬·적용 이력은 유지하며, 빈 DB와 대화용 V19 적용 DB는 정상 기동으로
남은 버전을 순서대로 적용합니다. 데이터 초기화나 `flyway repair`는 필요하지 않습니다.

업그레이드 전에는 대상 DB의 `flyway_schema_history`에서 `version`, `script`, `checksum`, `success`를 확인하세요.
**관리자용 `V19__add_account_admin_management.sql`을 먼저 적용한 별도 DB는 바로 재기동하지 마세요.** 해당 DB는
대화용 V19 적용 DB와 이력이 다릅니다. 전체 백업과 관리자 스키마·SQL 체크섬 검증 후, DBA와 함께 관리자 이력의 버전·파일명을
V20에 맞추고 미적용 대화용 V19를 한 번만 out-of-order로 적용하는 별도 이력 정합화가 필요합니다. 기존 설치 순서·체크섬·
적용 시각은 보존해야 하며 이 저장소가 다른 DB의 이력을 자동 수정하지 않습니다. 무조건적인 `repair`, 이력 삭제,
`validate-on-migrate=false`, 볼륨 초기화로 충돌을 숨기지 마세요.

## 관리자 접속기록과 권한 변경

개인정보의 안전성 확보조치 기준 제8조(접속기록)·제5조(권한 부여·변경·말소 기록)를 위해 `V49__create_admin_access_log.sql`이
`admin_access_log`를 만들고 `account_admin_action`의 조치 종류에 `ADMIN_GRANT`·`ADMIN_REVOKE`를 더합니다.

- **남기는 요청:** 회원 목록·상세 조회, 정지·정지 해제·강제 로그아웃·권한 변경, 감사 기록 조회가 요청 하나에 한 행입니다.
  요약 수치·큐 운영·`/admin/session`과 없는 계정(404)·거절된 조치는 개인정보를 돌려주지 않아 남기지 않습니다.
- **칸:** 처리자 계정 ID, 수행업무(`action`), 처리한 회원 ID(목록은 null), 요청 요약, 접속 주소, User-Agent(255자), 시각(서울).
  요약에는 검색어 원문을 넣지 않고 `keywordLength=…, status=…, returned=…`처럼 조건 이름·건수·조치 기록 번호만 넣습니다.
- **접속 주소:** 다른 기능의 요청 제한과 같은 `HttpServletRequest.remoteAddr`입니다. 운영에서는 Tomcat이 Compose의 Nginx 한 주소만
  신뢰해 반영한 값이고, 클라이언트가 보낸 전달 헤더를 따로 읽지 않습니다.
- **흐름:** 조회는 `Controller → Service → Repository(조회) → AdminAccessLogService → AdminAccessLogRepository → MyBatis → MySQL`
  순서로 결과를 돌려주기 전에 기록하고, 조치는 상태 변경·사유 기록과 같은 transaction에서 기록합니다. 기록하지 못하면
  503 `ADMIN_ACCESS_LOG_UNAVAILABLE`이며 조회 결과를 내주지 않고 조치도 되돌립니다(기록되지 않은 개인정보 처리 금지).
- **보존·변경 방지:** 계정 ID에 외래 키를 걸지 않아 계정 행을 지워도 기록이 지워지거나(CASCADE) 대상이 비워지지(SET NULL)
  않습니다. Mapper에는 INSERT·SELECT만 있어 보존 기간(접속기록 2년·권한 기록 3년)보다 오래 남으며, 기간이 지난 기록의 파기
  작업은 아직 없습니다. DB 계정 권한 분리·별도 백업 같은 운영 보호와 월 1회 점검은 배포 환경에서 정합니다.
- **권한 변경:** `POST /api/v1/admin/accounts/{id}/role`은 처리자와 대상 계정 행을 ID 순서로 잠근 뒤 처리자가 아직 활성
  관리자인지 다시 확인하므로, 두 관리자가 서로의 권한을 동시에 내려도 관리자가 모두 사라지지 않습니다.

## 관심 공고 마감 알림

`ai.govbiz.core.notification`은 로그인 회원의 알림 설정과 관심 공고 마감 알림을 담당합니다. V50이
`account_notification_setting`과 `deadline_reminder` 발송 기록을 추가하고, V52가 발송 기록 고유 키를
`(account_id, source_code, source_program_id, kind, due_date, days_before)`로 바꿉니다. 메일·앱 알림은 맞춤 리포트의 `DailyReportMailClient`·`DailyReportPushClient`와
기기 등록을 그대로 쓰며 새 큐·외부 서비스는 없습니다. 스케줄러 `DEADLINE_REMINDER_ENABLED`는 기본 꺼짐이고,
`DEADLINE_REMINDER_SEND_HOUR`(기본 9) 이후 마감 7·3·1일 전 공고를 일수마다 예약해 채널별로 한 번씩 보냅니다.
[조건·상태·설정·검증](../../docs/deadline-reminders.md)을 참고하세요.

| 알림 설정 API | 동작 |
|---|---|
| `GET /api/v1/me/notification-settings` | 본인 마감 알림 설정(`enabled`, `email`, `push`), 알림 일수 `reminderDaysBefore`(`[7,3,1]`)와 수신 주소 확인·발송 가능·기기 등록·스케줄러 상태. no-store |
| `PUT /api/v1/me/notification-settings` | `{deadlineReminder: {enabled, email, push}}` 저장(예전 `daysBefore`는 무시). 필드 누락·채널 없음 400, 수신 주소 미확인 409, 발송 미설정 503 |

## 요금제 사용량 한도

`ai.govbiz.core.planusage`는 요금제별 AI 기능 사용 횟수를 세고 막습니다. 결제 연동 전이라 모든 회원은 FREE에서 시작하고,
V54 `account_plan`에 운영자가 배정한 계정만 PLUS·PREMIUM입니다. 유료는 30일 이용권이라 `assigned_at`부터 V59 `ends_at`까지 쓰고,
`ends_at`이 없는 배정(운영자·검증 계정)은 30일마다 새 이용 기간이 시작됩니다(domain `AccountPlan`). 한도 숫자는 domain `PlanCode`에 있고
모든 요금제에 숫자가 있습니다. 로컬 개발용으로 `app.plan-usage.unlimited-account-emails`(`PLAN_USAGE_UNLIMITED_ACCOUNT_EMAILS`, 쉼표 구분,
기본 빈 값)에 적은 계정은 사용량만 세고 막지 않으며(`limit: null`), 로컬 Compose는 데모 시드 계정 6개를 넣고 운영은 비웁니다.
출시 전 무료 체험은 `PlanTrialController → PlanUsageService.startTrial(TransactionTemplate, 계정 행 잠금) → PlanUsageRepository → MyBatis → MySQL`
순서로 V60 `plan_trial`에 (계정, 요금제)마다 한 번 기록하고 `account_plan`에 `source = TRIAL`, 14일 이용권을 배정합니다.
탈퇴할 때 `AccountProfileService → WithdrawalMarkService.record → WithdrawalMarkRepository → MyBatis → MySQL` 순서로 이메일·소셜 연결·사업자등록번호의
HMAC-SHA256을 V62 `account_withdrawal_mark`에 1년 남깁니다. 1년 안에 같은 식별자로 이메일·소셜 가입하거나 기업을 등록하면 계정·기업을 만드는
transaction에서 `WithdrawalMarkService.inherit → PlanUsageService.inherit`가 탈퇴 계정의 체험 기록과 무료 기준 오늘·이번 달 사용량을 새 계정에
이어 적용하고 표식을 사용 처리합니다(탈퇴 계정마다 한 번). 만료 표식은 `WithdrawalMarkPurgeScheduler`가 매일 서울 04:30에 지웁니다.
배정 SQL과 판단 근거는 [요금제 사용량 한도](../../docs/plan-usage-limits.md)를 참고하세요.

| 기능 | 로그인 전 | FREE | PLUS | PREMIUM | 세는 방법 |
|---|---|---|---|---|---|
| AI 대화 검색(`AI_SEARCH`) | 하루 2회 | 하루 10회 | 이용 기간 500회 | 이용 기간 1,500회 | 검색어가 있는 검색 요청마다 AI 호출 전에 1을 더하고 실패하면 되돌림 |
| 공고 원문 질문(`EVIDENCE_QUESTION`) | 로그인 필요 | 하루 10회 | 이용 기간 500회 | 이용 기간 1,500회 | 같음 |
| 신청 문서 초안(`APPLICATION_DRAFT`) | 로그인 필요 | 월 3건 | 이용 기간 5건 | 이용 기간 20건 | 이번 기간 양식 분석·문서 생성·문항별 AI 실행 중 실패하지 않은 것과 만든 문서 파일·공고 기록의 공고 수(같은 공고는 한 건) |
| 중복 검토(`COMBINATION_REVIEW`) | 로그인 필요 | 월 3회 | 이용 기간 10회 | 이용 기간 40회 | 이번 기간 시작한 실행 중 실패하지 않은 것(대기·실행·결과 불명 포함) |

- **기간:** FREE는 서울 날짜(AI 검색·원문 질문)와 서울 달력의 달(신청 문서·중복 검토), 유료는 네 기능 모두 이용 기간(30일)입니다.
  이용 기간 키는 기간이 시작한 서울 시각(`P20261020T153000`, V59부터 허용)입니다. 기간 키가 바뀌면 새 행을 쓰므로 초기화 작업이 없고,
  이용권이 끝나면 그때부터 FREE 기준으로 셉니다.
- **요청마다 세는 기능:** V56 `plan_usage_counter`의 행을 만들거나 잠근 뒤 조건부 UPDATE 한 문장으로 한도 안에서만 더합니다.
  로그인 전 체험은 접속 주소를 SHA-256으로만 넣은 Redis 키에 다음 서울 자정까지 둡니다. 컨트롤러가 분당 요청 제한을 통과한 요청만 셉니다.
- **작업으로 세는 기능:** 각 기능이 새 작업을 만든 같은 transaction(계정 행 잠금)에서 그 작업까지 센 이번 기간 사용량을 확인하고,
  넘으면 작업을 남기지 않습니다. 실패·만료로 끝난 작업은 별도 처리 없이 빠지고, 신청 문서·중복 검토를 지우면 그 기간에 쓴 횟수를
  `plan_usage_counter`(V57부터 달 키 허용)에 남겨 삭제로 한도가 다시 늘지 않게 합니다. 로컬 목업(`demo_seed_key`)은 세지 않습니다.
- **작업 표가 없는 신청 문서 경로:** 이전 동기 양식 분석(`POST .../forms/discover`)·문서 생성과 문항별 해석·초안은 AI 전에 계정 행을
  잠근 짧은 transaction에서 그 공고가 이번 기간 처음이면 한도를 확인하고 V58 `plan_usage_draft_program`에 기록합니다. AI는
  transaction 밖에서 부르고, 실패하면 그 기록만 지웁니다.
- **응답:** 한도 초과는 `429 PLAN_QUOTA_EXCEEDED`(`feature`·`period`·`plan`·`limit`·`used`·`resetsAt`·`retryAfterSeconds`,
  `period`=`DAY`·`MONTH`·`PLAN`, `Retry-After`=이번 기간이 끝날 때까지 초)이고 분당 제한 `SUPPORT_PROGRAM_RATE_LIMITED`와 구분합니다. 사용량 저장소(MySQL·Redis)를
  읽거나 쓰지 못하면 유료 기능을 실행하지 않고 `503 QUOTA_UNAVAILABLE`입니다.
- **로그인:** 공고 원문 질문(`POST /api/v1/support-programs/detail/answers`)과 도우미 자유 질문(`POST /api/v1/assistant/messages`)은
  로그인한 회원만 씁니다(없으면 401 `AUTHENTICATION_REQUIRED`). 기업 맞춤 리포트의 내부 검색·원문 답변은 리포트 예산으로만 셉니다.
- **문항별 AI:** 화면에서 쓰지 않는 문항별 해석·초안 API도 위 기록으로 신청 문서 한도를 지키고 계정별 분당 요청 제한을 받습니다.

| 사용량 API | 동작 |
|---|---|
| `POST /api/v1/plan-trials` | 로그인·이메일 인증 회원의 출시 전 무료 체험 시작 `{plan: PLUS\|PREMIUM}`. 지금부터 14일 이용권을 배정하고 201과 `plan-usage` 본문. 이미 체험한 요금제 409 `PLAN_TRIAL_USED`, 운영자 배정 중이거나 더 높지 않은 요금제 409 `PLAN_TRIAL_UNAVAILABLE`, 이메일 미인증 403 `PLAN_TRIAL_EMAIL_UNVERIFIED`. no-store |
| `GET /api/v1/plan-usage` | 현재 요금제, 배정 출처 `planSource`(`OPERATOR`·`TRIAL`, 무료는 null), 지금 시작할 수 있는 체험 `trialsAvailable`, 이용권이 끝나는 때 `planEndsAt`(무료·끝나는 때가 없는 배정은 null)과 기능별 `feature`·`period`(`DAY`·`MONTH`·`PLAN`)·`limit`·`used`·`resetsAt`(이번 기간이 끝나는 때, +09:00). 로그인 전에는 `plan: null`과 접속 주소의 AI 대화 검색 체험만. 작업으로 세는 기능의 `used`에는 진행 중인 작업이 포함돼 한도를 넘을 수 있음. no-store |

호출 흐름: 요청마다 세는 기능은 `Controller → PlanUsageService.consume → PlanUsageRepository → MyBatis → MySQL`(회원) 또는
`GuestPlanUsageRepository → Redis`(로그인 전) 뒤 기존 검색·원문 답변 Service, 작업으로 세는 기능은
`기능 Service(TransactionTemplate) → 기능 Repository.reserve → PlanUsageService.requireMonthlyCapacity → PlanUsageRepository → MyBatis → MySQL`,
작업 표가 없는 신청 문서 경로는 `기능 Service → PlanUsageService.consumeDraftProgram(TransactionTemplate) → PlanUsageRepository → MyBatis → MySQL`
뒤 기존 AI 호출입니다.

관리자는 계정 상세에서 요금제·이번 기간 사용량·쓴 체험·이어받은 탈퇴 계정·이번 달 AI 사용을 조회만 합니다. 이용권 배정은 아직
화면에 두지 않고 [요금제 사용량 한도](../../docs/plan-usage-limits.md)의 운영 SQL로 합니다.

## AI 사용량과 비용

`ai.govbiz.core.aiusage`는 앱의 회원·기능별 기록과 OpenAI 조직 사용량을 별도로 저장합니다. `/ops/usage`와 관리자 AI 비용 화면의
주 비교는 **같은 UTC 날짜·동기화에서 가져온 OpenAI 사용량 추정과 실제 비용**이며, 앱 기록을 이 합계에 다시 더하지 않습니다.

- **앱 기록:** `ai-service OpenAI 응답 → X-GovBiz-OpenAI-Usage → Core AiUsageRecordingInterceptor → AiUsageService.record(REQUIRES_NEW)
  → AiUsageRepository → MyBatis → ai_usage_record`입니다. 회원·기능은 `AiUsageContextHelper`로 전달합니다.
  AI 응답 헤더를 받기 전에 연결이 끊기거나 기록에 실패하면 앱 장부에 남지 않을 수 있습니다.
- **Core 밖 호출:** `AiCostSyncService → OpenAiUsageClient → OpenAI organization/usage/completions + organization/usage/embeddings`에서
  조직·프로젝트 전체의 UTC 일별 모델·처리 등급·Batch 여부·토큰을 조회해 V65 `ai_provider_usage_daily`에 저장합니다.
  Catalog 색인·평가·직접 호출도 같은 범위에 속하면 포함됩니다. 개별 호출의 회원·기능·trace로 소급 연결하지는 않습니다.
  `OPENAI_PROJECT_ID`를 설정하면 두 Usage API와 Costs API 모두 같은 프로젝트로 제한하고, 비우면 조직 전체입니다.
- **캐시 비용:** 입력 총량에는 캐시 읽기와 쓰기가 포함되므로
  `(입력 − 읽기 − 30분 쓰기 − 12시간 쓰기) × 입력가 + 읽기 × 읽기가 + 30분 쓰기 × 쓰기가 + 12시간 쓰기 × 12시간 쓰기가 + 출력 × 출력가`를
  100만으로 나눕니다. V65는 기존 가격의 입력·출력 값을 보존하면서 GPT-5.6/6 계열의 확인된 30분 쓰기 단가(해당 입력가의 1.25배)를 보완합니다.
  12시간 단가는 확인되지 않아 비워 두며, 양수 쓰기에 필요한 가격 또는 사용량이 없으면 비용을 미확정으로 남깁니다.
  과거 앱 기록의 쓰기 토큰을 0으로 채우거나 기존 비용을 재작성하지 않습니다. GPT-5-nano 등의 개별 응답에 쓰기 계수가 없으면 앱 기록은
  미확정일 수 있으며, Usage API가 명시적으로 0을 보고하는 조직 장부는 계산할 수 있습니다.
- **동기화:** 기존 `OPENAI_ADMIN_KEY`로 매일 서울 10:10 또는 관리자 요청 때 최근 35일(`app.ai-cost.sync-days`)을 가져옵니다.
  `OpenAiCostsClient`의 실제 비용과 두 Usage API의 모든 페이지·UTC 하루 경계·빈 날짜를 검증한 뒤 Repository의 짧은 transaction에서
  `ai_provider_usage_daily`, `ai_cost_daily`, `ai_cost_sync_day`를 함께 교체합니다. 일부 조회·저장이 실패하면 기존 전체 기록을 유지합니다.
  `ai_cost_sync_state` 행을 잠가 저장을 직렬화하고, 먼저 시작한 수집이 늦게 완료되면 최신 결과를 덮지 못하게 거절합니다.
  0건인 날도 조회 완료를 저장하므로 미조회와 $0를 구분합니다. 조회 자체는 모델을 호출하지 않습니다.
- **비교 기준:** 필터와 앱·조직 일별 표 모두 UTC 하루(서울 오전 9시~다음 날 오전 9시)입니다. 회원 상세의 이번 달 합계는 기존 서울 기준입니다.
  `comparison.status`는 `not-synced`·`incomplete`·`ready`이고, 필요한 날짜가 빠지면 전체 합계는 null입니다.
  `fetchedAt`은 UTC `Z` 시각이며, 여러 수집 시점이 섞인 기간은 가장 오래된 수집 시각을 표시합니다.
  `ready`는 조회 범위가 채워졌다는 뜻이며 최종 청구 확정은 아닙니다. 진행 중인 날과 OpenAI 지연 집계는 이후 동기화로 바뀔 수 있습니다.
  미등록 가격·미확정 토큰이 있으면 화면은 차액 계산을 숨깁니다. Batch·미지원 처리 등급은 사용량을 저장하되 가격이 없으면 미확정입니다.
  긴 문맥·지역 처리 할증과 텍스트/임베딩 외 API 비용은 추정 범위에 포함되지 않아 실제 비용과 차이가 남을 수 있습니다.
- **가격 적용:** 시작일은 UTC 기준입니다. 새 앱 요청에는 당시 가격을 저장하고, 조직 사용량은 동기화할 때 해당 사용일의 가격으로 다시 계산합니다.
  배포 후 V65 적용과 사용량·비용 동기화가 필요합니다. 기존 실제 비용만 저장된 날짜를 조회 완료로 간주하지 않습니다.

| 관리자 AI 비용 API | 동작 |
|---|---|
| `GET /api/v1/admin/ai-costs?from&to` | UTC 날짜 기간(최대 92일), 앱 기록 `totals`·기능·모델·회원별 합계와 조직 비교 `comparison`. 회원 이메일 접근은 `AI_COST_VIEW` 감사 기록. no-store |
| `GET /api/v1/admin/ai-costs/prices`, `POST .../prices` | 가격표 조회·시작일별 추가. 캐시 쓰기 `cacheWriteInputUsdPerMillion`과 `cacheWrite12hInputUsdPerMillion`은 nullable |
| `POST /api/v1/admin/ai-costs/sync` | 같은 UTC 범위의 사용량·비용을 함께 가져옴. 관리자 키 없음 503, 권한 거절·잘못된 응답·조회 장애 502 |

공식 계약: [캐시 토큰·단가](https://developers.openai.com/api/docs/guides/prompt-caching),
[조직 사용량](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions).

## 실행

기업 맞춤 리포트는 `ai.govbiz.core.dailyreport`에서 저장된 기업 조건·지원 목적을 기존 검색과 HTML 근거 답변에
연결합니다. `V12`는 수신 설정, 날짜별 리포트와 일일 생성 예산을 저장합니다. 수신 주소 확인·동의 후 SMTP로
발송하며 자동 발송은 기본 비활성화입니다. [API·설정·장애 경계와 사용 순서](../../docs/daily-reports.md)를 참고하세요.
관련도는 선정 확률이 아니며 PDF/HWP 전체 분석·뉴스 브리핑은 포함하지 않습니다.

정기 생성은 `V23`의 `daily_report_generation_job`에 리포트·예산과 함께 예약한 뒤 RabbitMQ로 전달합니다.
`DailyReportOutboxScheduler → DailyReportQueueClient → RabbitMQ → DailyReportGenerationConsumer → DailyReportService`이며,
Core 내부 소비자 1개가 기존 AI 경로를 재사용합니다. 웹 미리보기는 기존 동기 계약을 유지합니다.
정기 예약은 `dailyReportTaskScheduler`의 전용 단일 스레드에서 시작 1분 후, 이전 실행 완료 후 5분 간격으로 수행합니다.
공고 수집용 기본 스케줄러와 분리하며 `DAILY_REPORT_ENABLED=false`이면 예약 스케줄러 Bean도 생성하지 않습니다.
V27부터 발송 큐를 켜면 `DailyReportScheduler → Repository`가 기존 리포트 행에 발송 대기를 저장하고,
`DailyReportDeliveryOutboxScheduler → DailyReportDeliveryQueueClient → RabbitMQ → DailyReportDeliveryConsumer → DailyReportService → DailyReportMailClient`
에서 SMTP를 실행합니다. `DAILY_REPORT_DELIVERY_QUEUE_ENABLED`는 직접 실행 false / Compose true이며,
false면 기존 직접 SMTP 경로를 유지합니다. 기존 대기 작업은 정기 예약이 꺼져도 메일 설정이 있으면 전송될 수 있습니다.
[발송 상태·UNKNOWN·V27·설정·검증 상세](../../docs/rabbitmq-daily-report-delivery.md)를 참고하세요.
직접 Core를 실행할 때 큐는 기본 비활성입니다. 정기 실행에는 `DAILY_REPORT_ENABLED=true`와
`DAILY_REPORT_QUEUE_ENABLED=true` 모두 필요하며, 큐가 꺼진 정기 실행 설정은 시작 시 거부합니다.
브로커는 `RABBITMQ_HOST`/`RABBITMQ_PORT`/`RABBITMQ_USERNAME`/`RABBITMQ_PASSWORD`/`RABBITMQ_VHOST`로 연결합니다.
Compose에서는 큐만 기본 활성이고 새 정기 작업 예약·메일은 기본 비활성입니다. 기존 작업이 있다면 큐만 켜도 처리됩니다.
[Outbox·중복 처리·실행 불명·설정·검증 상세](../../docs/rabbitmq-daily-report-generation.md)를 참고하세요.

중복 지원 검토는 `ai.govbiz.core.combinationreview`에 세션 인증 기반 생성·목록·상세·입력 수정·삭제 API를 구현했습니다.
V10은 검토 입력, V11은 실행 스냅샷·원본 파일 이력을 저장합니다. V53은 검토 단위 선택 입력인 사업쌍 관계
(`same_project`·`same_cost`, `UNKNOWN`/`YES`/`NO`, 기본 `UNKNOWN`)를 추가합니다. 공식 첨부 자동 수집·PDF/HWP/HWPX 파싱과
단일 Agent 분석을 사용자 화면에 연결했습니다.
[기능 설계와 구현 경계](../../docs/duplicate-support-review-design.md)를 참고하세요.

| 중복 지원 검토 API | 동작 |
|---|---|
| `POST /api/v1/combination-reviews` | 제목·정확히 2개 사업의 현재 입력과 선택 `relation`(`sameProject`·`sameCost`, 생략 시 `UNKNOWN`) 생성. 201과 상세 본문·Location 반환 |
| `GET /api/v1/combination-reviews?size=20&beforeId=123` | 본인 목록, 생성 ID 내림차순. size 1~50, beforeId 생략 가능. 각 항목의 `latestRun`은 가장 최근 실행 요약(실행 목록 항목과 같은 형식)이며 실행 전이면 null |
| `GET /api/v1/combination-reviews/{id}` | 본인 상세 입력(`relation` 포함)·버전 조회 |
| `DELETE /api/v1/combination-reviews/{id}` | 본인 검토와 선택 공고·실행 이력·보관 원문 삭제. 성공 시 204. 대기·분석 중·결과 불명 실행이 있으면 409 `COMBINATION_REVIEW_DELETE_CONFLICT`, 기록 보존 |
| `PUT /api/v1/combination-reviews/{id}/inputs` | 제목·사업 목록 전체 교체. `relation`을 보내면 함께 교체하고 생략하면 저장된 관계를 유지(명시적 null은 400). expectedRevision 일치 시 204, 충돌 시 409 |
| `POST /api/v1/combination-reviews/{id}/runs` | expectedRevision·requestKey·선택적 additionalFacts로 비동기 분석 접수. 신규 202 QUEUED, 동일 요청 재조회 200 |
| `GET /api/v1/combination-reviews/{id}/runs` | 본인 실행 목록, size/beforeId 커서 |
| `GET /api/v1/combination-reviews/{id}/runs/{runId}` | 당시 입력(`relation` 포함, 이전 실행은 `UNKNOWN`)·근거·설정·결과 또는 실패 조회. 사업쌍 결과는 `configuration.contractVersion`이 v2면 `stages`, v3면 세 질문 `answers`를 채우고 다른 쪽은 빈 배열. 근거 문서는 공식 공고 상세 `sourcePageUrl`과 수집 첨부 `sourceUrl`을 구분해 반환 |
| `GET /api/v1/combination-reviews/{id}/runs/{runId}/sources/{documentIndex}` | 실행 당시 원본 파일 다운로드. documentIndex는 0부터 시작 |

소유자는 기존 세션 쿠키를 검증한 Account로 결정하며, 관리자도 타인 검토를 조회·수정할 수 없습니다.

V25부터 실행 행이 Outbox이며 `CombinationReviewOutboxScheduler → CombinationReviewQueueClient → RabbitMQ →
CombinationReviewRunConsumer → CombinationReviewRunService`로 기존 수집·파싱·AI를 실행합니다.
`COMBINATION_REVIEW_QUEUE_ENABLED`는 직접 실행 false / Compose true이며, false일 때 새 분석은 503으로 거절하고
동기 실행으로 우회하지 않습니다. 상태는 QUEUED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/INTERRUPTED입니다.
UNKNOWN은 같은 검토의 새 실행도 차단하고, `app.combination-review.unknown-ttl`(`COMBINATION_REVIEW_UNKNOWN_TTL`, 기본 PT30M, 최소 PT20M)이
지나면 AI를 다시 부르지 않고 `RUN_OUTCOME_UNKNOWN_EXPIRED`로 FAILED 처리해 검토 슬롯과 계정 한도(3건)를 돌려줍니다. [한도·만료·재발행·배포·검증 상세](../../docs/rabbitmq-combination-review.md)를 참고하세요.
새 실행의 AI 계약은 `COMBINATION_REVIEW_CONTRACT_VERSION`(`v3` 세 질문 기본 | `v2` 여섯 단계, 되돌릴 때만)으로 고르며 다른 값이면 시작에 실패합니다.
v3는 `configuration?contractVersion=combination-review-v3`로 설정을 확인하고, 참여 사실 6칸 대신 사업별 상태 4값(+`UNKNOWN`)과 관계를 보냅니다.
상태 4값은 shared `participationToReviewStatus`와 같은 규칙으로 Domain(`ProgramParticipation.reviewStatus`)이 계산하며,
응답은 Facade에서 v2와 같은 인용 검사와 판정별 조건·인용·기관 확인 문장 규칙으로 검증합니다. 지난 v2 결과는 그대로 읽습니다.
없는 검토와 타인 검토는 같은 404를 반환합니다. 성공 응답은 `Cache-Control: no-store`이며 시각은 `+09:00`입니다.
쓰기 요청의 기존 Origin 방어를 유지하고 CORS에서 PUT·DELETE를 허용합니다. 상세 JSON·오류 코드는 위 설계 문서에 있습니다.

신청 문서 작성 도우미는 `ai.govbiz.core.applicationpreparation`에 구현합니다. V15는 로그인 계정이
소유한 신청 준비 건의 공고·양식 버전·분야·입력 revision을 저장합니다. V28은 문서 입력과 분리된 진행 단계·revision·변경 시각을 추가합니다. V18 이후 사용자가 선택한 네 제공처 공고의
공식 PDF/HWP/HWPX에서 발견한 신청 문서와 문항을 파일 hash·파서·모델·프롬프트 버전이 고정된 양식 스냅샷으로 저장합니다. 큰 문서 지도 JSON이 포함된 양식 조회는 DB에서 정렬하지 않고 Repository에서 ID 순서를 유지하므로 MySQL 전역 정렬 버퍼 증설을 요구하지 않습니다.
HWPX discovery 요청에는 원본 `sourceBase64`·`sourceSha256`을 내부 AI 계약으로 전달합니다. AI가 실제 표 구조를 읽은 뒤 문항을 추출하며 바이너리는 OpenAI로 전달하거나 양식 JSON에 추가 저장하지 않습니다. 새 필드를 받는 AI를 먼저 배포한 뒤 Core를 배포합니다.
기존 혁신바우처 manifest는 검수 기준과 기존 준비 건 복원을 위해 유지합니다.

로컬 데모 적재는 V35의 신청 준비와 V37의 중복 검토 nullable `demo_seed_key`로 목업과 일반 사용자 작업을 구분합니다.
두 기능 모두 계정별 목업 키만 유일하고 일반 API가 만드는 NULL 키 행은 계속 추가할 수 있습니다. 기본 시연 계정 admin·member마다 독립된 parent/child 행을 만들며
공개 API의 `owner_account_id` 계약은 바꾸지 않습니다. 자동 적재 흐름은 [인프라 데모 데이터](../../infrastructure/README.md#데모-데이터)를 따릅니다.

| 신청 준비 API | 동작 |
|---|---|
| `GET /api/v1/application-preparations/forms` | DB에서 AVAILABLE 공고의 양식·분야·문항 조회. AI 호출 없음 |
| `GET /api/v1/application-preparations/forms/availability?sourceCode=...&sourceProgramId=...` | 공고별 분석 상태·사유·마지막 분석 안내(`state.warnings`)와 활성 snapshot 전체 조회. 현재 작성 화면의 시작 경로 |
| `GET /api/v1/application-preparations/google-form?sourceCode=...&sourceProgramId=...` | 신청 경로가 구글 설문인 공고의 공개 설문 응답 주소와 문항(`entryId`·유형·원문 선택지·기타 허용). 화면이 답을 담은 미리 채운 링크를 만들며 답은 받지 않음. 로그인 전용·마감·문항 없음·비구글 경로는 422(`APPLICATION_ONLINE_FORM_LOGIN_REQUIRED`·`_CLOSED`·`_NO_QUESTIONS`·`_UNSUPPORTED`), 읽기 서비스 장애는 503. AI 호출 없음 |
| `POST /api/v1/application-preparations/forms/discovery-jobs` | UUID requestKey·공고 식별자로 V26 계정별 수동 작업 접수. 기존 API이며 현재 작성 화면에서는 호출하지 않음 |
| `GET /api/v1/application-preparations/forms/discovery-jobs` | 본인의 최근 20개 분석 작업을 공고명·공식 원문 URL과 함께 요약 |
| `GET /api/v1/application-preparations/forms/discovery-jobs/{id}` | 본인 작업의 공고명·공식 원문 URL·상태·결과 조회 |
| `DELETE /api/v1/application-preparations/forms/discovery-jobs/{id}` | 본인의 끝난 분석(SUCCEEDED·FAILED)을 신청 문서 작성 목록에서 지움(V64 `dismissed_at`, 확인한 것으로도 표시). 기록은 남아 목록 응답의 `dismissed`만 true가 되고 최근 분석 판단·사용량에는 그대로 쓰임. 진행 중·결과 불명은 409, 204·멱등 |
| `POST /api/v1/application-preparations` | 공고·양식 버전·지원 분야를 검증해 본인 준비 건 생성. 201·Location·상세 반환 |
| `GET /api/v1/application-preparations?size=20&beforeId=123&status=in_progress` | 본인 준비 건 목록을 생성 ID 내림차순으로 조회. 각 항목에 필수 문항 중 저장된 답변 수(`answeredRequired`/`requiredTotal`), 현재 입력 버전의 문서 유무(`hasCurrentDocument`), 카탈로그의 접수 기간·마감일(`applicationPeriod`/`applicationEndDate`, 공고가 없으면 null)을 더한다. `status=in_progress|done`은 현재 버전 문서 유무로 서버에서 거르고, 다른 값은 400 |
| `GET /api/v1/application-preparations/{id}` | 본인 준비 건과 선택한 버전의 양식 문항 조회. 타인 건과 없는 건은 같은 404 |
| `PUT /api/v1/application-preparations/{id}/progress-stage` | 본인 준비 건의 진행 단계 변경. 독립된 진행 revision 충돌은 409 |
| `DELETE /api/v1/application-preparations/{id}` | 본인 준비 건 삭제. QUEUED·RUNNING·UNKNOWN 문서 생성 작업이 있으면 409 `APPLICATION_PREPARATION_RUN_CONFLICT`로 삭제를 차단하고 준비 건·작업 기록을 보존. 활성 작업이 없으면 확인 사실·AI 실행 기록은 FK cascade 삭제하고 공용 양식 스냅샷은 유지 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/messages` | 현재 입력 revision과 요청 키로 사용자 답변을 AI가 해석해 확인 전 사실·미정 제안 반환 |
| `PUT /api/v1/application-preparations/{id}/sections/{sectionKey}/inputs` | 사용자가 확인한 문항 사실 전체 스냅샷 저장. revision 충돌은 409 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/drafts` | 필수 답변 확인 후 문항 초안 생성. `expectedRevision`, nullable `expectedVersionId`, UUID `requestKey` |
| `PUT /api/v1/application-preparations/{id}/sections/{sectionKey}/content` | `expectedRevision`, `expectedVersionId`, `content`로 새 사용자 수정본 저장 |
| `POST /api/v1/application-preparations/{id}/sections/{sectionKey}/confirmations` | `expectedRevision`, `expectedVersionId`에 해당하는 최신 작성본을 사용자 확인 |

현재 화면은 아래 문서 API를 사용합니다. 위 문항별 텍스트 생성·수정·확인 API는 현재 UI에서 호출하지 않는 기존 계약입니다.

| 문서 API | 동작 |
|---|---|
| `GET /api/v1/application-preparations/{id}/documents` | 현재 입력 revision의 생성 파일 메타데이터 목록 |
| `POST /api/v1/application-preparations/{id}/documents` | `expectedRevision`으로 원본 양식 기입 및 같은 형식 파일 저장(동기 경로, 현재 웹은 호출하지 않음) |
| `POST /api/v1/application-preparations/{id}/documents/jobs` | UUID `requestKey`·`expectedRevision`으로 V45 계정별 생성 작업 접수(202·Location). 같은 키는 같은 작업, 준비 건에 진행 중·결과 불명 작업이 있으면 409, 계정당 3개 초과는 422 `APPLICATION_DOCUMENT_JOB_CAPACITY`, 답변 버전이 다르면 409. `APPLICATION_DOCUMENT_JOBS_ENABLED=false`이면 새 작업은 저장 전에 503 `APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE`로 거절하며 이미 접수된 같은 대상·버전의 키는 기존 작업 반환 |
| `GET /api/v1/application-preparations/{id}/documents/jobs/{jobId}` | 본인 작업의 상태(QUEUED·RUNNING·SUCCEEDED·FAILED·UNKNOWN)·단계(PREPARING·MAPPING·WRITING·SAVING)·파일 ID·실패 코드/문구·입력 위치 변경 안내 |
| `GET /api/v1/application-preparations/{id}/documents/jobs` | 그 준비 건의 최근 5개 작업(변경 안내 제외). 화면이 진행 중 작업을 이어받을 때 읽음 |
| `GET /api/v1/application-preparations/documents/jobs` | 계정의 최근 20개 작업(준비 건 구분 없음, 변경 안내 제외). 목록 화면이 초안을 만드는 중·결과 확인 중·실패한 준비 건을 표시할 때 읽음. 각 작업의 `seen`은 끝난 결과를 확인했는지 |
| `POST /api/v1/application-preparations/{id}/documents/jobs/seen` | 그 준비 건의 끝난 생성 결과를 확인한 것으로 표시(V47 `seen_at`, 204). 화면이 초안 화면을 열 때 호출 |
| `POST /api/v1/application-preparations/forms/discovery-jobs/seen` | `sourceCode`·`sourceProgramId`의 끝난 분석 결과를 확인한 것으로 표시(204). 화면이 그 공고의 새 문서 화면을 열 때 호출 |
| `GET /api/v1/application-preparations/{id}/documents/{fileId}/download` | 소유자 확인 후 binary attachment·no-store 반환 |
| `POST /api/v1/application-preparations/{id}/documents/{fileId}/download-link` | 쿠키/Bearer 세션·파일 소유권 확인 후 `{preparationId, fileId, downloadPath, expiresAt}` 반환. `downloadPath`는 같은 API의 상대 경로이며 선택한 파일만 허용하는 2분 ticket 포함. 응답 no-store |
| `GET /api/v1/application-preparations/{id}/documents/{fileId}/download?ticket=...` | 모바일 시스템 브라우저용 attachment. 로그인 헤더 없이 파일 전용 ticket·만료·현재 계정 상태·소유권을 확인. 원래 MIME·UTF-8 파일명·binary 반환, no-store·no-referrer. 유효하지 않거나 만료·계정 정지/삭제·문서 삭제된 링크는 410 `APPLICATION_DOCUMENT_DOWNLOAD_LINK_INVALID` |
| `GET /api/v1/application-preparations/{id}/documents/archive?revision=N` | 그 답변 버전의 저장 파일을 한 번에 반환. 파일이 하나면 그 파일 그대로, 여럿이면 UTF-8 이름의 zip(`application/zip`, `X-Archive-File-Count`). 새 파일을 저장하지 않으며 없는 버전·타인 건은 404 |

웹·앱 결과 화면은 파일 카드마다 `초안 다운로드` 하나만 제공하며 archive API는 호출하지 않습니다. 웹은 기존 인증 binary 다운로드를 사용합니다. 모바일은 링크 발급 POST 후 응답 경로·문서 ID를 검증해 시스템 브라우저에 전달합니다. `ApplicationDocumentController → ApplicationDocumentDownloadLinkService → 기존 파일/계정 Repository`로 소유권을 확인하며, 링크는 기존 Redis에 ticket의 SHA-256 키와 소유자·파일 식별자·만료만 2분 보관합니다. JWT·답변·파일 본문은 링크 또는 Redis grant에 넣지 않습니다. Redis 장애·잘못된 저장 내용은 만료 성공 응답으로 숨기지 않습니다.

ticket은 브라우저 HEAD·다운로드 재시도를 위해 만료 전 재사용할 수 있는 파일 전용 권한입니다. 발급 뒤 로그아웃해도 이미 전달한 링크는 2분 동안 유효할 수 있으며 계정 정지/삭제·문서 삭제는 다운로드마다 다시 확인합니다. 공개 HTTPS API origin, 해당 Core 코드와 Redis, 쿼리를 전달하고 캐시하지 않는 배포 프록시가 필요합니다. 앱이 브라우저를 열었다는 것은 다운로드 완료 확인을 뜻하지 않으며 OS/브라우저별 실제 저장 흐름은 기기에서 검증해야 합니다.

V45 `application_document_generation_job`은 생성 작업을 보관하며 `ApplicationDocumentGenerationJobWorker`가 같은 프로세스에서 2초마다 QUEUED 행을 claim해 실행합니다(`app.application-document.jobs.enabled`·`concurrency`·`poll-ms`). QUEUED 1시간은 만료, RUNNING 30분은 유료 AI 호출 전이면 실패(`RUN_INTERRUPTED`)·호출 뒤면 결과 불명, 결과 불명은 `unknown-outcome-lock-ttl` 뒤 실패로 내려 준비 건의 활성 슬롯을 비웁니다. V32은 원본 SHA-256·기입 위치 JSON·결과 binary를 준비 건/revision별로 보관합니다. 입력 변경 중 생성된 파일은 409로 저장을 거절하며 준비 건 삭제 시 cascade 삭제됩니다. HWP는 hwplib 1.1.11, HWPX는 ZIP/XML, PDF는 PDFBox의 편집 가능한 AcroForm과 OFL NanumGothic을 사용합니다. 원본 첨부는 기존 공식 제공처 Client로 재수집하고 해시를 대조합니다. 임의 URL을 받지 않습니다.

생성 작업의 `ai_started_at`은 최초 매핑 또는 답변 기입 요청 직전에 한 번 기록합니다. 매핑 캐시를 재사용하면 답변 기입 요청에서 기록하며, 저장된 파일 재사용과 답변 없는 원본 초안 저장에는 기록하지 않습니다. 기록 저장에 실패하면 AI 요청을 보내지 않습니다. 이 시각은 AI 호출 시도와 비용 발생 가능성을 추적하는 값이며 실제 청구액을 뜻하지 않습니다. 최초 매핑 뒤의 알 수 없는 실패도 UNKNOWN으로 남기고, 실행이 끊겨도 기존 만료 처리에서 호출 전 실패와 구분합니다.

HWP/HWPX의 파란 글씨는 `exampleText` 후보로 AI에 전달합니다. AI가 기입란의 예시·작성 힌트로 선택한 `clearExampleTargetIds`만 제거하고, 검은 항목명과 선택하지 않은 제목은 유지한 뒤 답변을 검은 글씨로 기입합니다. 색상만으로 모든 파란 글씨를 삭제하지 않습니다. 범위 주석이 있는 HWP 문단의 예시 삭제는 지원하지 않으며 명시적인 오류를 반환합니다. PDF의 기존 예시 제거는 지원하지 않습니다.
AI가 서로 다른 답변을 같은 HWP/HWPX 텍스트 칸에 배치하면 AI Service가 칸마다 첫 답변과 충돌하지 않은 위치를 고정하고, 나머지 충돌 답변을 고정된 칸을 금지한 한 번의 요청으로 다시 배치합니다. 첫 응답과 교정 응답의 예시 삭제 분류가 모두 유효하지 않으면 답변 없는 분류 요청으로 분리한 뒤 전체 위치 계약을 다시 검증합니다. 교정 뒤에도 안전한 고유 위치가 없으면 Core는 파일을 저장하지 않고 명시적인 생성 오류를 반환합니다.

HWP/HWPX의 모든 파란 문구 후보는 답변 유무와 관계없이 `clearExampleTargetIds`(예시·작성 힌트 삭제) 또는 `preserveExampleTargetIds`(제목·항목명·필수 안내 보존)에 정확히 한 번 포함되어야 합니다. AI Service와 Core API 양쪽에서 누락·중복·교집합·알 수 없는 ID를 거절합니다. 체크박스 답변을 Core가 모두 처리한 경우에도 예시 후보가 있으면 빈 facts로 분류를 요청합니다. 파일 편집 후 삭제 대상으로 선택한 문단에 파란 문구가 남았는지 다시 검사합니다. 의미 분류의 정확도와 실제 한글 조판 품질은 별도 검수가 필요하며, PDF의 기존 문구 삭제는 지원하지 않습니다.
V33은 생성기 버전을 고유키에 추가합니다. 다른 생성기 버전의 결과는 재사용하지 않으며, 기존 파일을 삭제하지 않고 같은 답변 revision으로 새 파일을 생성합니다. 이전 파일 ID의 소유자 다운로드는 유지됩니다.

팀 main의 V29(가입 이메일 인증)·V30(신청 진행 관리)과의 번호 충돌을 해결하기 위해 신청 문서 migration은 V31(텍스트 작성본)·V32(파일)·V33(생성기 버전)으로 이동했습니다. SQL 내용은 변경하지 않았습니다. 이전 skn-140의 V29~V31을 이미 적용한 개발 DB는 번호 변경만으로 재기동할 수 없습니다. 해당 DB는 백업 및 `flyway_schema_history`의 script/checksum과 실제 스키마를 확인한 별도 이력 이관이 필요합니다. 단순 `repair`나 데이터 볼륨 삭제로 처리하지 않으며, 신규 DB 또는 팀 main의 V30까지 적용된 DB가 이 migration 순서의 기준입니다.

현재 생성기 버전은 5입니다. 이전 버전의 파일을 재사용하지 않고 새로 생성하며 기존 다운로드는 유지합니다. HWP의 실제 체크박스/라디오 컨트롤을 `CHECKBOX` 대상으로 읽고, 값과 유일하게 일치하는 선택지는 Core가 직접 연결합니다. 나머지 위치는 AI가 선택합니다. 같은 선택 그룹의 기존 체크를 해제하고 해당 옵션만 선택하며, 서로 다른 답변을 같은 문단에 합치지 않습니다. HWP/HWPX의 밑줄 빈칸은 제자리 치환하고, 빈 문단·콜론으로 끝나는 항목명 외의 검은 본문에는 답변을 덧붙이지 않습니다.
HWP에서 표가 있는 섹션의 표 밖 빈 문단은 기입 후보에서 제외합니다. 예시 삭제 후 표 밖 문단이 비어도 답변 기입을 거절하며, 표 안의 빈 문단과 표가 없는 섹션의 입력란은 유지합니다.
HWP는 답변을 앞 글자의 글꼴·크기·장평·자간에 검은색·꾸밈 없음으로 쓰고(선택 표시 `■`·`√`·`○`는 인쇄된 모양 유지), 원본 문단에 저장된 줄 높이·간격으로 줄 배치 레코드를 재작성합니다. 셀은 답으로 늘어난 줄만큼만 같은 행과 이를 걸치는 셀 높이를 함께 늘립니다(한 줄 답은 행 높이 유지). 이는 한글의 전체 페이지 조판 엔진을 대체하지 않으므로 복잡한 개체·페이지 배치는 실제 한글에서 확인해야 합니다. `UNKNOWN`과 미입력 값은 임의 칸에 ‘미정’으로 쓰지 않고 결과 화면에서 미기입 항목으로 안내합니다.

V31는 기존 텍스트 초안 실행과 작성본 버전을 저장합니다. 상세 응답 `contents`는 최신 ID부터 모든 작성본의 내용·종류·입력 revision·
생성 시간·사용자 확인 시간·`stale`을 반환합니다. 같은 요청 키의 성공한 초안 실행은 다시 호출하지 않고 현재 상세를 반환하며,
같은 키의 다른 요청 또는 미완료·실패 실행은 409입니다. 실패 후 새 요청 키로 명시적으로 재시도합니다.
초안 실행 중 입력이나 작성본이 변경되면 결과를 현재 작성본에 적용하지 않고 409를 반환합니다. DB transaction에는 AI 호출을 넣지 않습니다.
사용자 수정은 원본 사실 스냅샷을 유지하므로 이전 입력 기준의 문안을 수정하는 것만으로 현재 입력 확인 상태가 되지 않습니다.
입력이 변경된 문항은 현재 답변으로 새 초안을 생성한 뒤 필요한 수정과 확인을 진행합니다. 작성본 내용은 최대 15,000자이며
확인·수정·조회는 AI를 호출하지 않습니다. 준비 건 삭제 시 작성본과 초안 실행도 cascade 삭제됩니다.

`ApplicationFormDiscoveryOutboxScheduler → ApplicationFormDiscoveryQueueClient → RabbitMQ → ApplicationFormDiscoveryJobConsumer`
가 MySQL 실행권을 선점하고 기존 수집·추출 Service를 실행합니다. V26 작업 행이 Outbox이며 UNKNOWN은 새 분석도 차단합니다.
UNKNOWN은 같은 공고의 양식 가용성이 AI 시작 이후에 확정되면 `RUN_OUTCOME_SETTLED`로, 아니면 `app.application-form-discovery.unknown-ttl`
(`APPLICATION_FORM_DISCOVERY_UNKNOWN_TTL`, 기본 PT30M, 최소 PT20M)이 지나면 `RUN_OUTCOME_UNKNOWN_EXPIRED`로 FAILED 처리해 계정 활성 한도(3건)에서 뺍니다. 두 경우 모두 AI를 다시 부르지 않습니다.
AI Service가 원문 근거 검증 실패를 `422 / APPLICATION_FORM_AI_INVALID_RESPONSE`로 확정하면 FAILED로 종료해 공고 재선택 후 새 요청을 허용합니다. 통신 유실·시간 초과는 UNKNOWN을 유지하며 자동 재호출하지 않습니다.
`APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED`는 Compose에서 true, Core 단독 기본 false입니다. 새 API는 비활성 시 503입니다.
구형 동기 `POST .../forms/discover`는 큐 비활성 환경에서만 남기며, 큐 활성 환경은 409로 차단합니다.
관리자 전용 `GET /api/v1/admin/queues`는 생성·발송·중복 검토·공식 문서 분석·카카오 연결 해제 다섯 큐의 DB 상태·대기 메시지·소비자·DLQ를 읽기 전용으로 확인합니다.
[API·화면·한도·장애·운영 조회·V26 배포 상세](../../docs/rabbitmq-application-form-discovery.md)를 참고하세요.

목록·상세와 화면 진입은 AI Service·OpenAI·Qdrant를 호출하지 않습니다. 양식 발견과 생성은 각각 사용자의 명시적 POST와
허용된 Origin에서만 수행합니다. 공식 출처 확인과 AI 문항 추출은 기관 검수·선정 가능성 판단을 뜻하지 않습니다.
V16은 문항별 확인 사실과 AI 해석 실행의 요청 키·입력/출력 스냅샷·상태를 저장합니다. AI 호출은 DB transaction 밖에서
`Controller → Service → AI Facade → Client → AI Service`로 실행하고, 제안은 PUT 전까지 사실로 저장하지 않습니다.
[기능 범위와 후속 경계](../../docs/application-preparation-design.md)를 참고하세요.

신청 문서 자동 수집은 BIZINFO의 숫자형 `PBLN_...` 공고와 KSTARTUP·MSIT·CNTRADE_NOTICE의 숫자형 공고를 지원합니다.
각 제공처의 공식 상세에 직접 연결된 PDF/HWP/HWPX/DOCX/XLSX만 읽고 제공처와 원문 호스트·공고 ID가 일치하는지 다시 검증합니다.
K-Startup은 API의 `detl_pg_url`과 같은 공고 ID의 모집중·마감 상세만, 충남은 API 제목·본문과 단 하나로 일치하는 공식 게시판
상세만 사용합니다. 사용자 임의 URL·스캔 PDF/OCR·ZIP 내부 탐색·암호화 문서는 지원하지 않습니다.
PDF는 글자가 10자 미만인데 그림이 있는 쪽(스캔일 수 있음)이 있으면 그 파일을 읽지 않고, 그림도 없는 빈 쪽·짧은 구분 쪽은
건너뛰거나 그대로 읽습니다(내용 스트림이 없는 빈 쪽도 쪽 번호를 원본대로 유지).
같은 공고에 읽을 수 있는 공식 문서가 있으면 크기 제한을 넘거나 텍스트를 추출할 수 없는 첨부는 제외 사유와 파일명을
`coverageWarnings`에 남기고 분석을 계속합니다. 공고 하나의 모든 지원 형식 첨부가 제외되면 기존처럼 기술 실패로 종료합니다.
`coverageWarnings`에는 실제로 빠진 범위(건너뛴·읽지 못한 첨부)만 담습니다. 제공처 수집기의 "직접 연결한 첨부만 수집" 같은 고정 안내는
`SupportProgramAttachments.collectionNotice`로 따로 두어, 모든 첨부를 읽은 실행이 누락 경고를 띄우거나 AI에 누락으로 전달되지 않게 합니다.
양식 찾기 화면은 이 안내를 경고 목록 앞에 그대로 보여 줍니다.
중복 지원 검토 한 실행에서 보존하는 원본은 최대 12개이며, 초과 조합은 일부만 분석하지 않고 `SOURCE_TOO_LARGE`로 종료합니다.
원문·입력·결과는 실행마다 보존하며 기존 검색 Qdrant 색인과 분리됩니다. 공식 공고 상세 주소와 실제로 수집한 첨부 주소도
구분해 보존하고, 자동 수집 근거를 사람 검수 완료로 표시하지 않습니다.
같은 요청 키는 AI를 재호출하지 않습니다. 새 접수는 계정 식별자로 기존 공개 요청 제한을 공유하며,
검토별 활성 실행 1개·계정별 활성 작업 3개를 제한합니다. 검토 큐는 소비자 1개로 처리하고,
worker도 기존 검색·AI 기능의 공유 동시 실행 슬롯을 사용합니다.

`CombinationReviewRunService`는 실행 순서와 저장을, `AiCombinationReviewFacade`는 AI 호출·계약 검증 경계를 담당합니다.
중복 지원 검토는 네 제공처 공고를 자동 분석하며, 현재 카탈로그의 공식 상세와 공고 식별자를 다시 검증한 뒤 첨부를 수집합니다.
두 기능이 함께 쓰는 공식 첨부 수집·파싱은 제공처별 `BizInfoAttachmentClient`·`MsitAttachmentClient`·
`KStartupAttachmentClient`·`CnTradeNoticeAttachmentClient`와
`supportprogram/client/document/SupportProgramDocumentParser`에 두고, AI DTO 변환은 `AiCombinationReviewMapper`가 담당합니다.
중복 검토는 근거용 `parseEvidence`(`EVIDENCE_VERSION`)를 씁니다. PDF는 `helper/SupportProgramEvidenceLayoutHelper`가 글자 좌표로
오른쪽 끝까지 찬 줄만 잇고(줄 끝 공백 글자로 띄어쓰기 판단) 칸이 벌어진 줄을 표 행(`칸 | 칸`)으로 나누며 쪽 머리·꼬리 띠의 쪽 번호와 반복 줄을 지웁니다. HWPX는 표를 행 단위로,
1칸 상자·1열 표는 본문처럼 뽑습니다. 양식 분석은 기존 `parse`와 `VERSION`(재사용 키)을 그대로 써서 다시 분석하지 않습니다.
신청 양식 발견은 같은 서식의 형식별 사본 중 읽힌 사본 하나를 `_common/helper/AttachmentCopyHelper`로 남기고, 파싱한 첨부를
`applicationpreparation/domain/ApplicationAttachmentRole`의 파일명 규칙으로 걸러 위원용·공고문 같은 비신청 문서를 AI 호출 전에
제외합니다(남는 문서가 없으면 전부 분석). 이름이 신청서·양식이 아니고 본문에 서식 신호도 없는 첨부는 유료 분석을 보내지 않으며
(공고문 이름의 첨부는 서식명 언급이 아니라 별지 번호·서명 칸 같은 구조 신호가 필요), 신청서로 보이는 문서부터 공고당 최대 8개를
3개씩 동시에 추출합니다. 기업마당 수집은 형식별 사본을 한 문서로 세고 다른 형식 사본도 받아 두어, 우선 사본이 크기 제한에 걸리거나
읽히지 않으면 다음 사본을 씁니다. 분석 안내는 수집 실패를 포함해 V48 `analysis_warnings`에 저장하고 `forms/availability` 응답의
`state.warnings`로 보여 줍니다.
양식은 찾았으나 입력칸 매핑만 실패하면 `RETRY_WAITING`으로 두어 3회까지 다시 시도합니다.
AI Service가 HWPX native 입력 대상 한도 초과를 413(`APPLICATION_DOCUMENT_LIMIT_EXCEEDED`)으로 확정하면 그 첨부만 제외하고, 남는 문서가 없으면 `TOO_LARGE`로 닫습니다.
업무 실패는 `domain/exception`, 외부 시스템 실패는 `client/exception`에 두어 Repository·Client가 Service에 역으로 의존하지 않습니다.
이는 프로젝트의 기능 중심 레이어드 구조이며 범용 port/interface나 전달만 하는 Facade를 추가한 구조는 아닙니다.

JDK 21과 MySQL 8.4가 필요합니다. 실제 공고 동기화·자연어 검색에는 Nori가 설치된 Elasticsearch와 실행 중인 AI Service·Qdrant도
필요합니다. 전체 서비스를 함께 실행하는 방법은 [인프라 README](../../infrastructure/README.md)를 참고하세요.

저장소 루트에서 다음 명령으로 실행합니다. 네이티브 실행은 루트 `.env`를 자동으로 읽지 않으므로
필요한 환경변수를 현재 프로세스에 설정해야 합니다.
Core를 호스트에서 직접 실행할 때 `ELASTICSEARCH_BASE_URL`은 **호스트에서 접근 가능한 Nori 설치 ES**를
가리켜야 합니다. 기본 Compose의 ES는 9200을 호스트에 공개하지 않으므로 `bootRun`만으로 그 컨테이너에
연결되지는 않습니다. 전체 Compose 실행을 우선 사용하고, 별도 ES를 쓰는 경우 주소·인증·Nori 설정을 명시합니다.

```bash
cd backend/core-service
./gradlew bootRun
```

기본 주소는 `http://127.0.0.1:8080`입니다. 실행 시 Flyway가 MySQL 스키마를 적용합니다.
`DATA_GO_KR_SERVICE_KEY`가 비어 있으면 수집 작업은 실패를 기록하며 다음 주기에 다시 시도합니다.
빈 검색어 목록은 이미 공개된 제공처의 DB 스냅샷에서 최신 공고를 반환하며, 상세 조회와 함께 이후
제공처별 색인 장애에도 사용할 수 있습니다. 검색어가 있는 검색은 AI Service와 해당 공고 버전의
색인이 있어야 성공합니다. 새 카탈로그 공개에도 색인 준비가 필수이므로 기업마당 키만으로 동기화가
완료되지는 않습니다.

## 검색 품질 평가 fixture 내보내기와 캡처

### 실제 공고 fixture 초안 내보내기

실데이터 평가의 시작점은 `evaluation-fixture-export` 프로필입니다. 이 비웹 프로필은 현재 MySQL에서
색인 준비가 확인된 제공처의 공개 공고 중 지정한 `referenceDate` 기준 `OPEN` 공고만 읽고, 운영 색인과 같은 `SupportProgramIndexDocumentMapper.fromCatalog`로
`id`·`contentHash`·`text`를 만듭니다. 공고 수와 카탈로그 지문을 포함한 전체 fixture 초안을 기록하므로,
이후 캡처 결과가 같은 공고 스냅샷에서 나왔는지 확인할 수 있습니다.

이 프로필은 웹 서버·기업마당/K-Startup 동기화·누락 색인 복구를 끄며 Qdrant, AI Service, OpenAI를 호출하지 않습니다.
`name`, `reference-date`, `output-path`는 반드시 지정해야 합니다. 기준 날짜는 실행 시점의 오늘이 아니라
저장된 신청 시작·종료일로 접수 상태를 다시 계산하는 기준입니다.

```bash
cd backend/core-service
./gradlew bootJar

SPRING_PROFILES_ACTIVE=evaluation-fixture-export \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_NAME=support-program-catalog-20260905-v1 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_REFERENCE_DATE=2026-09-05 \
APP_SUPPORT_PROGRAM_SEARCH_FIXTURE_EXPORT_OUTPUT_PATH=/absolute/path/support-program-fixture.json \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

생성 파일의 `cases`는 빈 배열(`[]`)입니다. 질문의 `id`·`query`·`split`을 고정하고, 평가 전에 선택한
AI-only·혼합·사람 검토 방식으로 `relevantIds`와 판정 출처를 확정합니다. 미확정 항목을 무관으로
바꾸지 않으며 현재 공유 실행은 AI-only 기준입니다. 질문 묶음의 `name`과 각 `cases`의 `id`·`query`·`split`은
fixture와 순서·내용까지 같아야 합니다. 내보내기는 빈 적격 카탈로그, 누락된 정렬 시각, 중복 검색 문서 ID 등
검증에 실패하면 기존 출력 파일을 바꾸지 않으며, 모든 검증이 끝난 결과만 원자적으로 교체합니다.

### 상세 공고 RAG의 실제 청킹 사전 점검

`preflightEvidenceEvaluation`은 저장된 공식 RAG fixture의 원문을 **실제
SupportProgramEvidenceChunker**에 전달하고 기존 참조 구절이 어느 청크에 포함되는지 기록합니다.
Spring 서버·DB·원문 수집·AI Service·OpenAI는 시작하지 않습니다. 검색 상한도 실제 Facade의
값을 사용하며 청킹 알고리즘을 평가 도구에 복제하지 않습니다.

```bash
cd backend/core-service
mkdir -p build/reports
./gradlew preflightEvidenceEvaluation --no-daemon \
  -PevidenceFixture=../../evaluation/support-program-evidence/runs/official-rag-20261006-v2/fixture.json \
  -PevidenceReport=build/reports/core-evidence-preflight.json
```

출력 폴더는 미리 준비하며 기존 파일은 덮어쓰지 않습니다. 보고서에는 입력 파일·청커 class의
SHA-256, 실제 청크·원문 참조, 질문별 참조 매핑, 검색 상한보다 많은 후보가 있는 사례 수를 저장합니다.
원문 해시 불일치·중복 ID·알 수 없는 공고 참조는 오류입니다. 구절이 청킹 후 없거나 여러 청크에
중복되면 `referenceRemappingRequired=true`로 기록하며 새 정답을 만들지 않습니다.

`rankingSelectionCoverage=INSUFFICIENT`는 후보가 적어 **순위로 근거를 고르는 능력을 측정할
자료가 부족하다**는 뜻입니다. `AVAILABLE`도 검색 성공·모델 품질 합격이 아닙니다. 실제 Core HTTP,
원문 재수집·첨부·모델 실행 및 사람 검토는 별도이며 `baselineEligible=false`를 유지합니다.

### 실제 검색 흐름 캡처

fixture와 같은 질문 묶음을 준비한 뒤에는 공개 API를 반복 호출하지 않고
`evaluation-capture` 프로필을 실행합니다. 이 프로필은 웹 서버·기업마당/K-Startup 동기화·누락 색인 복구를 끈 뒤,
질문 묶음의 각 항목을 현재 `SupportProgramSearchService`에 전달합니다. 따라서 MySQL의 적격 공고 선정,
Qdrant·키워드 순위를 결합한 후보 최대 20개, AI 최종 추천 최대 5개라는 운영 검색 흐름에서 나온 ID를
그대로 JSON 파일에 기록합니다. fixture와 capture는 모두 `findSearchablePresent`로 준비된 제공처의
공고만 읽습니다. 기존 고정 평가 자료는 당시 스냅샷·실행 조건의 기록이며 이번 조회 범위로 다시 해석하지 않습니다.

질문 파일은 [예시](../../evaluation/support-program-search/query-set.example.json)를 복사해 준비합니다.
fixture 내보내기는 지정한 기준 날짜의 `OPEN` 공고만 담으므로, 캡처도 기본값인 `acceptingOnly=true`와
**같은 기준 날짜**로 실행해야 합니다.
실행 환경의 MySQL·Elasticsearch·AI Service·Qdrant는 실제 검색과 같은 상태여야 하며, AI 점수화 호출 비용이 발생할 수
있으므로 기본 실행이나 CI에는 포함하지 않습니다.

```bash
cd backend/core-service
./gradlew bootJar
SPRING_PROFILES_ACTIVE=evaluation-capture \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_QUERY_SET_PATH=/absolute/path/query-set.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_OUTPUT_PATH=/absolute/path/capture.json \
APP_SUPPORT_PROGRAM_SEARCH_CAPTURE_REFERENCE_DATE=2026-09-05 \
java -jar build/libs/govbiz-core-service-0.0.1-SNAPSHOT.jar
```

질문은 최대 100개이며, 하나라도 실패하거나 실행 중 카탈로그가 바뀌면 결과 파일을 쓰지 않습니다.
성공한 v2 캡처에는 기준 날짜·공고 수·카탈로그 지문·후보 ID·최종 추천 ID가 포함됩니다. 평가기는 fixture와
capture의 기준 날짜가 다르면 점수 계산을 거부합니다. 실제 공고의 검색 문서가 들어갈 수 있는 파일은
[평가 실행 보관 폴더](../../evaluation/support-program-search/runs/README.md)에서 관리합니다.
비밀정보를 제외한 고정 공유 실행의 스냅샷·판정·캡처·보고서는 Git에 포함하며, 새 실행과 임시 출력은
기본적으로 제외합니다. 선택한 판정 출처의 fixture와 비교해 지표를 계산하는 방법은
[검색 평가 자료](../../evaluation/support-program-search/README.md)를 참고하세요.

## 공개 API

검색, 대화 조건 해석, 공고별 근거 답변은 한 Core 프로세스에서 요청량·동시 실행 한도를 공유합니다.
기본값은 접속 주소별 최근 60초 6건, 전체 60건, 동시 4건이며, 초과 시 DB·AI 호출 전에
`429 SUPPORT_PROGRAM_RATE_LIMITED` 또는 `503 SUPPORT_PROGRAM_BUSY`로 거절합니다.
`Retry-After`·`retryAfterSeconds`를 반환하고 실제 작업 종료 시 동시 슬롯을 해제합니다.
Controller의 `SupportProgramRequestAdmissionService.execute`가 공개 요청 입장을 담당하고
기존 Search/Evidence Service의 업무 흐름은 유지합니다. 구현은 `supportprogram/service/admission`,
설정은 그 아래 `config`, 거절 예외는 `exception`에 둡니다.
설정·프록시/NAT 공유·비웹 평가 제외·다중 서버 한계는 [요청 제한 안내](../../docs/support-program-request-limits.md)에 있습니다.

| 메서드·경로 | 용도 |
|---|---|
| `GET /api/v1/health` | Core API 자체 생존 상태 |
| `GET /api/v1/health/ai-service` | AI Service의 내부 Health 응답 확인 |
| `GET /api/v1/support-programs/readiness` | 공개 공고 스냅샷·검색 색인·최근 동기화 결과 상태 |
| `GET /api/v1/support-programs/catalog` | AI 없이 키워드·지역·분야·접수 상태로 공고 목록을 필터링·정렬·페이지 조회 |
| `GET /api/v1/support-programs/search` | 현재 MySQL 공고 카탈로그 검색 또는 최신 목록(비로그인 2개·로그인 최대 5개). 검색어가 있으면 AI 대화 검색 횟수를 씀 |
| `POST /api/v1/support-programs/search` | 이번 검색에만 기업 조건을 반영한 자연어 검색(비로그인 2개·로그인 최대 5개). 검색어가 있으면 AI 대화 검색 횟수를 씀(로그인 전 하루 2회) |
| `POST /api/v1/support-programs/search/results` | 로그인 후 기존 검색 결과와 조건 복원(검색·모델 재호출 없음) |
| `POST /api/v1/support-programs/conversation/interpret` | 현재 발화로 조건 변경 초안을 만들며 사용자 확인 전에는 검색하지 않음 |
| `POST /api/v1/assistant/messages` | 도우미 자유 질문 한 건의 의도 분류·답변. 로그인 필요(401), 세션 계정의 관심 공고함·받은 제안함·기업 상태로 답함. 프런트 `VITE_ASSISTANT_AI_ENABLED=true`일 때만 호출됨 |
| `GET /api/v1/support-programs/detail` | 제공처 코드와 원본 ID로 현재 공고 상세 조회. `sourceUrl`은 공고 상세, `applicationRoute`는 공식 신청방법·URL·경로 분류, `contact`(담당 부서·제공처 원문 전화번호·문의처 원문, 없으면 null)·`preferenceDescription`·`supervisingInstitutionType`은 공식 API 값을 반환 |
| `POST /api/v1/support-programs/detail/answers` | 특정 공고의 공식 원문 근거 질문·답변. 로그인 필요(401), 요금제 하루 질문 횟수를 씀(429 `PLAN_QUOTA_EXCEEDED`) |
| `GET /api/v1/plan-usage` | 현재 요금제와 기능별 남은 사용량. 로그인 전에는 AI 대화 검색 체험만 |
| `POST /api/v1/plan-trials` | 출시 전 플러스·프리미엄 14일 무료 체험 시작(요금제마다 한 번) |
| `GET /api/v1/support-programs/detail/attachments` | 공고 원문이 직접 연결한 첨부 목록(이미지 제외, 최대 30개). 원본 주소 없이 `index`·`fileName`·`extension`만 반환하고, 원문에서 읽은 목록은 Redis에 6시간 보관. 원문을 읽지 못하면 503 `SUPPORT_PROGRAM_ATTACHMENTS_UNAVAILABLE` |
| `GET /api/v1/support-programs/detail/attachments/download` | 목록의 `index` 첨부를 Core가 원본에서 받아 그대로 흘려보냄. 화면에서 읽은 이름을 UTF-8 `filename*`로 다시 붙이고 항상 `application/octet-stream`. 100MB 초과는 413 `SUPPORT_PROGRAM_ATTACHMENT_TOO_LARGE`, 목록에 없는 순번은 404 `SUPPORT_PROGRAM_ATTACHMENT_NOT_FOUND` |
| `POST /api/v1/sample-items/prepare` | 계층 연결 학습용 예제 |
| `POST /api/v1/auth/signup` | 이메일·비밀번호 회원가입(201). 계정을 만들고 바로 브라우저 세션 쿠키 발급, 중복 이메일은 409 |
| `POST /api/v1/auth/login` | 이메일·비밀번호 로그인. 세션 JWT를 HttpOnly 쿠키로만 내려줌 |
| `POST /api/v1/auth/logout` | 세션 행 삭제와 쿠키 만료 |
| `POST /api/v1/auth/mobile/login`, `POST …/signup` | 앱 이메일 로그인·가입. 웹과 같은 입력, `{ accessToken, tokenType: "Bearer", expiresAt, account }` 응답, 쿠키 미발급 |
| `POST /api/v1/auth/mobile/logout` | Authorization Bearer 세션 폐기, 쿠키 미발급 |
| `GET /api/v1/auth/mobile/oauth/{provider}/authorize`, `POST …/exchange` | 앱 Google·Kakao 시스템 브라우저 로그인 시작과 PKCE 일회용 코드 교환. 아래 모바일 인증 계약 참고 |
| `GET /api/v1/auth/me` | 세션 쿠키 또는 Bearer로 현재 계정·권한 단계 조회 |
| `PUT /api/v1/me/onboarding` | 최초 로그인 환영 화면의 답 저장. `accountType`(INDIVIDUAL·BUSINESS, 필수). 다시 부르면 유형을 바꿈. 시드 계정은 미리 채워짐(관리자 개인, 회원 기업) |
| `PUT /api/v1/me/password` | 로그인 세션으로 본인을 확인해 새 비밀번호만 받아 변경. 요청한 세션만 남기고 다른 기기 세션 종료 |
| `POST /api/v1/auth/password-reset`, `POST …/verify`, `POST …/confirm` | 로그인 없이 가입 이메일로 10분짜리 6자리 인증번호 요청(이메일 가입 계정은 204, 미가입 이메일은 404, 소셜 전용 계정은 409), 인증번호 확인으로 30분 통행 토큰 발급, 통행 토큰으로 새 비밀번호 저장(모든 세션 종료) |
| `GET /api/v1/me/deletion-preview`, `DELETE /api/v1/me` | 삭제 시 닫히는 모집글·제안 수 미리 보기와 계정 삭제(탈퇴 표식·제안 철회·모집글 마감·기업 삭제·세션 삭제·`deleted_at`) |
| `GET /api/v1/auth/oauth/providers` | 키가 설정된 소셜 로그인 공급자(카카오·Google)와 시작 주소. 설정 확인용이며 화면은 이 목록을 기다리지 않고 두 버튼을 바로 그림 |
| `GET /api/v1/auth/oauth/{provider}/authorize`, `GET …/callback` | 소셜 로그인 시작(서명한 state 쿠키와 함께 공급자로 302)과 콜백(코드 교환·ID 토큰 확인 뒤 `sub`로 로그인 또는 가입, 세션 쿠키와 함께 프런트로 302). 같은 이메일의 기존 계정에는 자동 연결하지 않음 |
| `POST /api/v1/auth/dev-login` | `ACCOUNT_DEV_LOGIN_ENABLED=true`일 때만 등록되는 개발용 시드 로그인 |
| `GET /api/v1/admin/session` | 기존 `AdminPrincipal`로 세션·현재 관리자 권한을 검증. `accountId`, `email`, `role`만 반환하고 `Cache-Control: no-store` 적용. Django Ops가 `govbiz_session` 쿠키를 전달해 사용. 미인증·만료 401, 비관리자·정지 403 |
| `GET /api/v1/admin/accounts/summary`, `GET /api/v1/admin/accounts` | 관리자 전용(`AdminPrincipal`: 세션 없으면 401, 관리자가 아니면 403). 요약 수치와 계정 목록(검색·상태·역할·로그인 방법·정렬·페이지). 삭제된 계정 제외 |
| `GET /api/v1/admin/accounts/{id}` | 관리자 전용. 계정·기업·활동 수·최근 조치 기록 20건. 목록·상세는 응답 전에 `admin_access_log`에 기록하고, 기록하지 못하면 503 `ADMIN_ACCESS_LOG_UNAVAILABLE` |
| `POST /api/v1/admin/accounts/{id}/suspend` `/unsuspend` `/sessions/revoke` | 관리자 전용. 사유(1~500자) 필수. 정지는 모든 세션 삭제, 자기 계정 422 `ADMIN_SELF_ACTION`, 다른 관리자 422 `ADMIN_TARGET_PROTECTED`, 이미 그 상태면 409. `account_admin_action`과 접속기록을 같은 transaction에 기록 |
| `POST /api/v1/admin/accounts/{id}/role` | 관리자 전용. `{ "role": "ADMIN"\|"USER", "reason" }`. 자기 계정 422 `ADMIN_SELF_ACTION`, 같은 역할·정지 계정 승격 409, 마지막 활성 관리자 해제 422 `ADMIN_LAST_ACTIVE_ADMIN`, 처리자 권한이 먼저 내려갔으면 403. `ADMIN_GRANT`·`ADMIN_REVOKE` 조치 기록과 접속기록을 함께 남김 |
| `GET /api/v1/admin/accounts/{id}` 의 `plan` | 상세 응답의 요금제 패널. 배정 그대로(`assigned*`), 지금 적용하는 요금제와 기능별 사용량, 쓴 체험, 이어받은 탈퇴 계정, 이번 달 AI 호출·추정 USD |
| `GET /api/v1/admin/audit-logs` | 관리자 전용 감사 기록. `actorAccountId` `targetAccountId` `action` `from`·`to`(서울 날짜, 끝 날 포함) `before`(커서) `limit`(1~50, 기본 50). 최신순 `records[]`(처리자 ID·이메일, 대상 ID, 요청 요약, 접속 주소, User-Agent, 시각)와 `nextCursor`, `no-store`. 이 조회도 기록 |
| `GET /api/v1/me/company/lookup` | 로그인한 회원이 사업자등록번호로 국세청 등록 여부·상호·사업자 상태를 미리 보기(Bizno) |
| `GET` `POST` `PUT /api/v1/me/company` | 내 기업 조회·등록(계속·휴업자만, 폐업자는 422, 201)·담당자 입력 항목 수정. 파트너 모집글·제안 쓰기는 계속사업자만(403 `ACTIVE_BUSINESS_REQUIRED`) |
| `GET` `POST` `DELETE /api/v1/me/saved-programs`, `GET …/status` | 관심 공고함. 로그인 회원이 현재 노출 중인 공고를 담고(같은 공고는 한 번) 빼며 최근 순서로 읽음. 없거나 숨겨진 공고는 404 `SUPPORT_PROGRAM_NOT_FOUND` |
| `GET` `PUT /api/v1/me/company/partner-profile` | 협업·파트너 설정(참여 역할·관심 분야·한 줄 소개·역량 태그) 조회·저장. 기업당 한 행 UPSERT |
| `GET /api/v1/partners/recruitments`, `GET .../{id}` | 파트너 모집글 목록(검색·찾는 역할·지역·내 글·정렬·페이지)과 상세. 세션 없이도 읽기 가능 |
| `GET /api/v1/partners/recruitments/recommended` | 로그인 회원의 맞춤 모집글(기본 3건, 최대 20). 회사 소재지·설립연도, 협업·파트너 설정, 관심 공고·신청 준비 공고, 보낸 제안으로 AI 없이 고르고 이유·확인할 점·조건 완화 건수·모집글 없는 관심 공고를 함께 돌려줌. `seekingRole`·`region`(짧은 시·도 이름)·`sourceCode`+`sourceProgramId`는 거르고 `keyword`(최대 3개)는 순서만 올림. 잘못된 조건은 400 `REQUEST_VALIDATION_FAILED` |
| `POST /api/v1/partners/recruitments` | 기업을 등록한 회원이 접수 중인 공고 하나에 모집글 작성(201). 공고당 하나 |
| `POST /api/v1/partners/recruitments/{id}/proposals` | 기업을 등록한 회원이 남의 모집글에 참여 제안 보내기(201). 모집글당 하나 |
| `GET /api/v1/partners/proposals/{id}`, `POST .../accept` `.../decline` `.../withdraw` | 당사자만 제안 조회, 작성자의 수락·거절, 제안자의 철회 |
| `GET /api/v1/me/proposals?box=received\|sent` | 받은·보낸 제안함과 대기 건수 |

### 모바일 인증 계약

`AccountMobileAuthController → 기존 AccountLoginService/AccountSignupService → AccountRepository → MyBatis → MySQL`
흐름으로 웹과 같은 계정·세션 정책을 사용합니다. 앱은 JSON 응답의 `accessToken`을 기기 보안 저장소에 보관하고
`Authorization: Bearer <accessToken>`으로 기존 업무 API를 호출합니다. `rememberMe`에 따른 절대 만료와 유휴 만료,
관리자 정지·세션 폐기·비밀번호 변경 정책을 그대로 적용합니다. refresh token은 발급하지 않으며 만료되면 다시 로그인합니다.
가입 전 인증번호 발송/확인은 기존 `/api/v1/auth/signup/email-code`, `/verify`를 사용합니다.

새 비밀번호(회원가입·변경·재설정)는 영문 대·소문자, 숫자, 특수문자(공백을 뺀 ASCII)만 8~72자입니다.
한글·이모지·공백이 들어가면 400 `REQUEST_VALIDATION_FAILED`로 거부하며, BCrypt의 UTF-8 72바이트 한도는 문자 규칙과 별개로 계속 검사합니다.
로그인·탈퇴에서 기존 비밀번호를 확인할 때는 과거 BCrypt 해시 호환성을 유지합니다.
재설정 토큰은 비밀번호 변경 transaction에서 잠가 같은 토큰의 동시 요청도 한 번만 성공합니다.

웹 `/auth/login`, `/auth/signup`의 응답에는 토큰이 들어가지 않고 HttpOnly 쿠키 계약을 유지합니다.
쿠키와 Bearer가 함께 오면 계정 resolver는 쿠키를 우선하며 쿠키 쓰기 요청의 Origin 검사를 생략하지 않습니다.
앱은 쿠키를 보내지 않습니다(`credentials: omit`). 잘못되거나 중복된 Authorization은 비로그인 상태로 숨기지 않고 401입니다.
무효·만료·로그아웃된 세션 쿠키(정지 계정 포함)는 응답에 같은 속성의 `Max-Age=0` 쿠키를 붙여 지웁니다. 이때 비로그인을 허용하는
`Account?` API(예: 공개 모집글 목록)는 손님으로 계속 처리하고, 로그인이 필요한 API와 `/auth/me`는 기존처럼 401(정지 403)입니다.
세션 저장소 조회 실패는 손님으로 바꾸지 않고 오류로 돌려줍니다.

앱 소셜 로그인은 다음 순서입니다.

1. 앱에서 무작위 `state`(43~128자 URL-safe)와 PKCE `codeVerifier`(43~128자 RFC 7636)를 만들고
   `codeChallenge=base64url(SHA256(codeVerifier))`(padding 없는 43자)를 계산합니다.
2. 시스템 브라우저에서 `/api/v1/auth/mobile/oauth/{google|kakao}/authorize`를 열며
   `redirectUri`, `state`, `codeChallenge`, 선택 `rememberMe`를 query로 전달합니다.
   `ACCOUNT_MOBILE_OAUTH_REDIRECT_URIS`에 등록된 URI와 정확히 같아야 합니다. 기본 빈 목록은 시작을 차단합니다.
   개발 예시는 `govbiz://oauth/complete`이며 운영 앱 링크가 있으면 해당 HTTPS URI를 명시 등록합니다.
3. `AccountMobileOAuthService → AccountOAuthService → GoogleOAuthClient/KakaoOAuthClient`가 기존 공급자 설정을
   사용합니다. 공급자 콘솔의 redirect URI는 여전히 기존 HTTPS 서버 `/api/v1/auth/oauth/{provider}/callback`입니다.
   서명한 HttpOnly state 쿠키로 시작 브라우저를 확인하고 V40 `mobile_oauth_transaction`에서 callback을 원자적으로
   선점합니다. 여러 서버나 중복 callback에서도 공급자 코드 교환은 한 번만 실행됩니다. 외부 호출은 DB transaction 밖입니다.
4. 앱 복귀 URI에는 `code`(60초·1회용 무작위 43자)와 원래 앱 `state`만 붙습니다. 실패는 `error`와 `state`입니다.
   JWT·공급자 토큰·client secret은 URL로 전달하지 않습니다. 앱은 복귀 URI와 `state`를 확인한 후
   `POST /api/v1/auth/mobile/oauth/exchange` 본문 `{ code, codeVerifier, redirectUri }`로 교환합니다.
5. DB의 코드 해시·PKCE S256 challenge·redirect URI·만료를 확인해 코드 소비와 세션 생성을 한 transaction으로
   처리합니다. 동시 교환에서는 한 요청만 성공하고 저장 실패는 소비도 rollback합니다. 응답은 이메일 로그인과 같습니다.

시작 요청이 허용되지 않으면 400 `MOBILE_OAUTH_REQUEST_INVALID`, 만료·재사용·잘못된 PKCE 교환은
401 `MOBILE_OAUTH_EXCHANGE_INVALID`입니다. 검증 DTO 형식 오류는 기존 400 `REQUEST_VALIDATION_FAILED`입니다.
OAuth 실패 `error` 값은 기존 웹과 같은 `cancelled`, `expired`, `unavailable`, `failed`, `email-required`,
`account-exists`, `unlink-pending`, `suspended`, `rate-limited`입니다. 쿠키가 없거나 만료된 공급자 callback은 기존
웹 로그인 실패 화면으로 돌아가므로 앱은 시스템 브라우저 취소 후 재시작할 수 있어야 합니다.
앱 로그인 시작과 교환도 기존 접속 주소당 로그인 요청 제한을 사용합니다(한 Core 프로세스 기준).
V40에는 평문 코드·JWT가 저장되지 않으며 하루 이상 지난 transaction은 후속 로그인 시작 시 최대 100개씩 정리합니다.
실제 공급자·실기기 로그인은 별도 설정과 검증이 필요합니다.

### 직접 조건으로 찾기

`SupportProgramCatalogController → SupportProgramCatalogService → SupportProgramRepository → MyBatis Mapper → MySQL`
흐름으로 이미 공개된 DB 공고를 읽습니다. 기존 `findPublishedPresent()`를 사용하며 AI Service·OpenAI·Qdrant·
기업마당·K-Startup 외부 API를 호출하지 않습니다. 이후 색인 장애와 무관하게 목록을 읽고, AI 요청량 제한 슬롯은 사용하지 않습니다.

`keyword`는 공고명 또는 기관명의 대소문자를 구분하지 않는 단순 포함 검색이며, `region`·`category`는 제공처
태그의 정확한 일치입니다. 필터는 AND로 결합합니다. 지역 선택은 자격 판정이 아니며 서울을 선택해도 전국 태그를
자동 포함하지 않습니다. `status` 기본값은 `OPEN`, `sort`는 `RECENT`, `page`는 1, `pageSize`는 12입니다.
접수 상태는 기존 Repository의 서울 기준 현재 날짜 계산을 그대로 사용합니다.

`sourceCode`로 전체(빈 값)/`BIZINFO`/`KSTARTUP`/`MSIT`/`CNTRADE_NOTICE`를 구분하고, `KSTARTUP` 선택 시 `startupStage`·`applicantType`·
`founderAge`를 추가할 수 있습니다. 공고의 원본 분류를 정확히 비교하며 자격을 추정하지 않습니다.
응답의 `startupStages`·`applicantTypes`·`founderAges`는 전체 공개 K-Startup 스냅샷의 선택지입니다.

현재는 한 번 읽은 공개 스냅샷을 Service에서 필터링·정렬·페이지 분할합니다. 응답에는 총건수와 전체 스냅샷의
지역·분야 선택지도 함께 포함하며, 목록에 AI 추천 이유·점수·자격 검토를 붙이지 않습니다. 목록 요청의 페이지 크기는
최대 50입니다. 요청·응답·정렬 및 확장 시 고려사항은 [직접 조건 검색 계약](../../docs/support-program-catalog.md)에 있습니다.

### 도우미 자유 질문

`AssistantMessageController → AssistantMessageService → AiAssistantClient` 흐름으로 내부
`/internal/v1/assistant/answers`를 한 번 호출합니다. 요청은 질문(최대 500자), 최근 대화 6개, 현재 화면 경로와 공고 선택 여부,
프런트 도움말 항목 전량(1~40개)입니다. 도움말의 원본은 프런트 `helpContent.ts`이므로 Core는 사본을 두지 않고 요청에 실린 항목만 인용으로 인정합니다.
로그인한 회원만 물을 수 있고(비로그인 401), Core는 보내기 전에 사업자등록번호·전화·이메일·주민등록번호를 가리며, 요청량·동시 실행 한도는 검색·원문 질문과 같은 Bean을 공유합니다.
응답 의도는 `PRODUCT_HELP`(답+인용 1~3개, 첫 인용 항목의 이동 버튼)·`ACCOUNT_STATE`(`accountTopic`별로 Core가 관심 공고함·받은 제안함·기업을 읽어 답)·
`SEARCH`(`searchQuery`와 검색 화면 이동)·`PROGRAM_QUESTION`(원문 질문 화면 안내)·`OUT_OF_SCOPE`(기권 답)·`UNCLEAR`(확인 질문)입니다.
의도별 필드 조합·인용 id·스키마 버전이 어긋나면 답을 고치지 않고 502 `AI_SERVICE_INVALID_RESPONSE`로 끝냅니다.
이동 버튼의 경로는 Core 상수(`/app/chat`·`/app/saved-programs`·`/app/proposals`·`/app/profile`·`/app/partners`)와 요청에 실린 도움말 행동 경로만 씁니다.

`app.assistant.agent-enabled=true`(`ASSISTANT_AGENT_ENABLED`)면 `AiAssistantClient.agent`로 `/internal/v1/assistant/agent`를 대신 부릅니다.
로그인 회원이면 `AssistantToolTokenService`가 요청마다 계정 묶음 HMAC 토큰(`app.assistant.tool-token-ttl`, 기본 5분)을 발급해 `principal`로 싣고,
AI Service의 도구는 그 토큰과 공유 비밀(`app.assistant.tools-secret` = `ASSISTANT_TOOLS_TOKEN`, 32자 이상)로 `AssistantToolController`의
읽기 전용 내부 API(`GET /internal/v1/assistant/tools/company-profile|recruitments|saved-programs?accountId=`)를 되부릅니다.
`AssistantToolAuthInterceptor`가 비밀·토큰·계정 일치를 검사하고(401 `ASSISTANT_TOOL_UNAUTHORIZED`, 비밀이 없으면 503 `ASSISTANT_TOOLS_DISABLED`),
`AssistantToolService`는 연락처·사업자등록번호를 빼고 본문을 마스킹·절단해 돌려줍니다. 새 의도 `PARTNER_MATCH`·`SAVED_PROGRAMS_QUESTION`과
`ACCOUNT_STATE`의 답·카드(`cards[]`: 모집글 `/app/partners/detail?recruitmentId=`, 공고 `/app/support-programs/detail?sourceCode=&sourceProgramId=`)는
Core가 형식·경로·중복을 다시 검증하고, 관심 공고 묶음 질문은 첫 응답이 `needsDocuments`면 `AssistantSavedProgramDocumentService`가 관심 공고 최대 10건의
원문을 `SupportProgramEvidenceService.prepareChunks`로 확보·청킹하고 AI Service에 색인한 뒤(`app.assistant.document-prepare-timeout`, 기본 6초, 넘긴 공고는
청크 없이) `resumeIntent`로 한 번 더 불러 인용(`quote`)을 청크 원문과 대조합니다. 에이전트 경로는 주소당 분당 `app.assistant.agent-per-client-per-minute`(기본 3)의
추가 한도를 겁니다. `app.assistant.prefetch-queue-enabled=true`(`ASSISTANT_PREFETCH_QUEUE_ENABLED`, Compose 기본 켜짐)면 관심 공고를 담을 때
`saved_support_program.source_prefetch_*` outbox(V34)가 RabbitMQ 큐 `govbiz.saved-support-program.prefetch.v1`로 원문 수집·색인을 미리 돌리고
하루가 지나면 다시 갱신합니다.
대화 전문은 저장하지 않습니다.

도우미의 공고 카드도 공통 식별자 계약을 사용합니다. 제공처 코드 최대 64자·원본 ID 최대 255 Unicode
code point를 보존하며, 카드 상세 경로는 식별자를 쿼리 인코딩한 값과 정확히 일치해야 합니다.

### 후속 대화 조건 해석

`SupportProgramConversationController → SupportProgramConversationService → AiSupportProgramConversationClient`
흐름으로 내부 `/internal/v1/support-program-conversation/interpret`를 한 번 호출합니다.
대화 상태는 브라우저 메모리에만 두며 Core는 DB·검색·색인을 호출하거나 상태를 저장하지 않습니다.
새 메시지와 전체 키를 갖춘 확정 context, 선택적인 마지막 질문·미확정 draftContext 또는 pendingProposal,
최근 성공 검색 요약 lastSearch(context/resultCount)를 전달합니다. 두 미확정 상태는 동시에 받을 수 없습니다.
resultCount는 0 이상의 정수이며 검색 실패·취소는 결과 0건으로 전달하지 않습니다.
nullable 조건도 키 자체는 필수이며 미입력은 명시적 null입니다. boolean은 JSON boolean만 허용합니다.

Core가 서울 기준일과 `govbiz-support-program-conversation-v1`을 보내고, 응답의 최대 6개 SET/CLEAR 변경에서
중복 필드·현재 메시지의 정확한 근거 인용·실제 날짜·문자 및 길이 제한을 검증합니다. 새 계약은 UTF-16 기준으로
message/query 500, region 50, industry/supportPurpose 100, 날짜 10, 질문/근거 160입니다. 상대 업력으로 설립일을
생성할 수 없습니다. 근거 인용은 AI Service와 같은 규칙(NFC·서식 문자 제거·연속 공백 하나·소문자)으로 메시지와
비교하고, 설립일 근거는 ISO·`YYYY년 M월 D일`·마침표 숫자 날짜(`2021. 3. 15.`)를 받습니다. message는 다른 조건
문자열과 달리 이모지 결합 문자(ZWJ) 같은 서식 문자와 새 이모지를 받고 양방향 제어·비문자·서식 문자만 있는 값은
400으로 거부합니다(`controller/dto/SupportProgramConversationRequest`). 미변경 필드는 유지하고, 마지막 질문의 draftContext → pendingProposal → context 순서로
병합 기준을 정하되 changedFields는 확정 context와
비교해 계산합니다. REGION 변경이 확정 조건이나 병합 기준과 표기만 다른 같은 지역이면(`서울특별시`↔`서울`,
`서울시 강남구`↔`서울 강남구`) `_common/domain/RegionDictionary` 기준으로 기존 표기를 유지해 바뀐 조건으로 세지 않습니다.
공개 DTO·내부 AI DTO·도메인·검증 결과는 각 경계의 타입으로 분리합니다.

READY도 제안일 뿐이며 사용자가 확인한 뒤 기존 POST 검색을 별도로 호출합니다. 정보가 부족하면
CLARIFICATION_REQUIRED와 새 질문·초안을 반환합니다. 결과 설명은 ANSWERED와 answer로 반환하며
변경 updates는 없어야 합니다. answer는 UTF-16 1,000자 이내이고 LF/CR/tab 외 제어 문자를 허용하지 않습니다.
다른 상태의 answer는 null이어야 하며 기존 응답의 생략은 null로 처리합니다. 설명은 검색·조건 적용을 실행하지 않습니다.
추가 필드·ANSWERED를 사용하려면 세 서비스를 함께 반영합니다. 잘못된 AI 응답은 명시적 502 오류이며 질문이나
단문 검색으로 우회하지 않습니다. 해석과 확인 검색은 공유 요청 제한에서 각각 한 건입니다.
AI Service는 모델의 답변·질문 종류 코드를 허용된 존댓말 문구로 바꿔 전달합니다. Core가 받는
`answer`·`clarificationQuestion`과 공개 API 계약은 유지하며, ANSWERED로 조건 변경이나 검색을 실행하지 않습니다.
확인 질문의 `clarificationKind`는 7개 허용 코드만 `domain/SupportProgramConversationClarificationKind`로 받아 공개 응답에
전달하고, 다른 상태에 실리거나 모르는 코드면 502 계약 오류입니다. 종류가 없는 이전 AI 응답은 null로 전달합니다.
상세 계약과 상태 흐름은 [C02 안내](../../docs/conversation-condition-update.md)를 참고하세요.

### 검색·상세·근거 질문

키워드 색인 HTTP 경계는 `client/elasticsearch`, 공유 본문 구성은 `helper/SupportProgramIndexTextHelper`입니다.
`SupportProgramIndexSyncService`가 Elasticsearch → Qdrant를 준비한 뒤에만 제공처 스냅샷을 공개합니다.
기존 환경은 `V24`가 이전 준비 플래그를 재검증 대상으로 바꾸므로 **색인 복구 후** 자연어 검색이 가능합니다.
환경변수·장애 계약·테스트·업그레이드는 [Elasticsearch 적용 상세](../../docs/elasticsearch-lexical-search.md)를 참고하세요.
현재 v2는 지역명·업무 용어 사용자 사전과 검색 시 `여행사/여행업체` 동의어 확장을 사용합니다.
v1을 사용하던 환경은 **새 v2 인덱스 이름으로 전환하고 재색인**해야 합니다. 기존 공고·벡터·v1 색인은 삭제하지 않습니다.
줄임말·동의어를 넓힌 `elasticsearch/support-program-lexical-v3.json`(중기부·소진공·코트라·알앤디·정책자금 등)은 정의만 있고
클라이언트는 여전히 v2를 씁니다. 316문항 비교 전에는 전환·재색인하지 않으며 절차는 Elasticsearch 문서에 있습니다.

- GET 검색: 필수 `query`는 최대 500 UTF-16 코드 단위이며 빈 문자열을 허용합니다. 탭·줄바꿈·캐리지 리턴을 제외한
  Unicode C 범주 문자(예: NUL·제로폭 문자·단독 surrogate)는 DB·AI 호출 전에 400으로 거부합니다.
  `acceptingOnly`의 기본값은 `true`이고
  이때 `OPEN` 공고만 대상으로 삼습니다. 검색어가 있으면 검증된 의미 검색 상위 20개와 전체 적격 공고의
  키워드 상위 20개를 같은 가중치의 RRF(`1 / (60 + 순위)`)로 결합하고, 최대 20개를 AI가 점수화하여
  기준을 통과한 0~5개를 선정한 후 아래 로그인별 노출 정책을 적용합니다. 키워드는 Elasticsearch Nori(`discard`, 사용자 사전·검색용 동의어)·BM25로 정렬하고
  동점은 최신순·제공처 포함 ID순입니다. RRF 동점은 의미 검색 순위·제공처 포함 ID순입니다.
  적격 공고의 전체 값과 순서가 같으면 제한된 단일 불변 스냅샷에서 문서 해시·두 색인의 버전 참조를 재사용합니다.
  DB 조회·접수 상태 계산·현재 벡터 확인은 매 검색 수행하고, 질문·검색 결과·랭킹은 이 캐시에 보관하지 않습니다.
  내용·순서·접수 상태가 바뀌면 전처리를 다시 수행합니다. DB·후보 준비·의미/키워드 검색·랭킹·전체 처리의
  시간과 성공/실패를 기록하며 질문·기업 조건·공고 원문은 로그에 남기지 않습니다.
  의미 검색 실패는 오류로 반환합니다. 게시된 공고나 미복구 기존 공고가 있지만 준비된 색인이 하나도 없으면
  자연어 검색은 빈 결과가 아니라 503을 반환합니다. 최초 빈 DB와 준비된 제공처의 정상 0건은 구별합니다.
  빈 검색어는 AI를 호출하지 않고 이미 공개된 DB 스냅샷에서 최신순 최대 5개를 선정하므로 이후 Qdrant 장애에도
  목록을 유지합니다. 아직 공개 세대·지문이 없는 신규/미검증 제공처의 공고는 이 최신 목록에 포함하지 않습니다.
- POST 검색: JSON의 `query`는 비어 있지 않은 최대 500 UTF-16 코드 단위 문자열이고,
  `acceptingOnly`는 생략 시 `true`입니다. 명시한 값은 JSON 부울만 허용하며 `null`·문자열·숫자는 거부합니다.
  선택 객체 `companyConditions`에는 `region`(50), `industry`(100), `supportPurpose`(100),
  `establishedOn`(10) 또는 `foundedYear`(정수)를 넣을 수 있습니다. 설립연도는 1900부터 서울 기준 올해까지이며 정확한 설립일과 동시에 지정할 수 없습니다. 상한은 앞뒤 공백을 포함한 입력의 UTF-16 코드 단위입니다.
  조건 텍스트는 제어·제로폭 문자 등 Unicode C 범주를 거부한 뒤 trim하고 빈 값은 미입력으로 처리합니다.
  설립일은 실제 달력의 `YYYY-MM-DD`로 `1900-01-01`부터 서울 기준 오늘까지이며, 빈 문자열·ASCII 공백만
  있는 값은 미입력입니다. 공백이 붙은 날짜·timestamp·존재하지 않는 날짜는 400입니다.
  모든 조건이 미입력이면 기존 질의만 전송합니다. 조건이 있으면 `SupportProgramSearchService`가
  질의와 지역·업종·지원 목적의 값만 최대 1,000자 내부 검색문으로 만들어 후보 조회에 반영하고,
  `AiSupportProgramRankingFacade`는 원질의를 바꾸지 않고 별도의 `companyConditions`와 ISO `referenceDate`를
  점수화 요청에 전달합니다. 설립일·서울 기준일·표제는 후보 검색어에 넣지 않으며 사용자 질의의 날짜는 보존합니다.
  지역 정보가 없거나 다르다는 이유만으로 Core에서 후보를 제외하지 않습니다.
  조건은 계정·기업 DB에 저장하지 않으며, 공개 `query`는 trim한 원질의 그대로입니다. 로그인 복원을 위한
  임시 결과 스냅샷에는 이번 검색 조건을 함께 보관합니다.
  Web은 등록 기업이 있는 계정의 새 대화에서 기존 회사 조회 API로 소재지·업종·설립연도를 읽고 요청 조건에 포함합니다.
  Core 검색에서 계정 정보로 조건을 다시 덮어쓰지 않으므로 대화에서 명시적으로 수정·해제한 조건이 유지됩니다.
  대화 계약의 선택 foundedYear와 FOUNDED_YEAR 변경 필드를 지원하며 설립일/연도 변경·해제는 기존 반대 정밀도 값을 지웁니다.
  설립연도는 Ranking Facade가 AI에 그대로 전달하며 특정 월·일로 변환하지 않습니다.
  GET 검색·POST 검색·대화 조건 해석·원문 근거 질문은 같은 요청 제한을 공유합니다.
- 공개 검색 노출: GET·POST 모두 `Controller → SupportProgramSearchPreviewService → SupportProgramSearchService`로
  검색하며, 응답은 `{query, programs, totalCount, resultToken, expiresAt}`입니다. `totalCount`는 이번에 선정된
  최대 5개의 개수이며 전체 DB 공고 수가 아닙니다. 비로그인은 처음 2개만 받고, 일반 회원을 포함한 로그인 계정은
  최대 5개를 모두 받습니다. 숨겨진 공고의 ID·표제·URL·본문 등 실제 내용은 비로그인 응답에 포함하지 않습니다.
  비로그인 결과가 3개 이상일 때만 소문자 UUID `resultToken`과 UTC ISO-8601 `expiresAt`이 존재하고,
  나머지 경우 두 값은 `null`입니다. 기존 내부 검색과 일일 보고서·평가의 최대 5개 결과는 그대로 유지합니다.
- 로그인 결과 복원: 인증된 `POST /api/v1/support-programs/search/results`에 `{resultToken}`을 보냅니다.
  `Controller → SupportProgramSearchPreviewService → SupportProgramSearchResultRepository → Redis`에서
  보관된 원본 결과를 그대로 반환하며 검색·카탈로그 MySQL 조회·모델 호출을 다시 실행하지 않습니다.
  세션 인증은 기존 MySQL 경로를 유지합니다. 응답은 검색 응답에 `context: {query, acceptingOnly, companyConditions}`를 추가한
  형태이며, `resultToken`과 `expiresAt`은 `null`입니다. 조건 텍스트는 최초 검색에서 정규화한 값이고
  기업 조건 미입력 값은 `null`입니다. 빈 GET 검색은 응답 `query`가 `""`, 대화용 `context.query`가 `null`입니다.
  이 조회는 검색·해석·근거 질문의 AI 요청 제한을 소비하지 않습니다. 세션 쿠키가 있는 POST에는 기존과 같이
  허용된 `Origin` 또는 `Referer`가 필요합니다.
  최초 복원 시 토큰이 `account.id`에 귀속되며 같은 계정의 재시도는 동일 결과를 반환합니다. 미인증·유효하지 않은
  세션은 401, 다른 계정·만료·미존재 토큰은 모두 410 `SUPPORT_PROGRAM_SEARCH_RESULT_EXPIRED`입니다.
  결과와 조건은 Redis의 `govbiz:search-result:v1:{SHA-256(token)}` hash에 JSON으로 30분 보관합니다.
  TTL과 `expiresAt`은 Redis 시계 기준이며 조회·로그인으로 연장하지 않습니다. Lua로 최초 계정 연결을 원자적으로
  처리해 여러 Core 인스턴스의 동시 복원도 한 계정에만 귀속됩니다. 같은 Redis를 쓰면 Core 재시작 후에도 복원됩니다.
  기존 128건 조기 퇴거는 제거했습니다. Compose는 `128mb/noeviction`으로 메모리를 제한하고 개별 JSON은 최대 2MiB입니다.
  저장소 연결·타임아웃·용량·역직렬화 오류는 503 `SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE`로 반환하며,
  메모리 fallback이나 자동 재검색은 없습니다. 회원 검색 또는 2건 이하의 비회원 결과는 Redis를 사용하지 않습니다.
  대화 기록 원본·회원 세션·공고는 계속 MySQL에 저장합니다. 첫 검색의 AI 점수화 속도를 높이는 캐시 변경은 아닙니다.
  GET·POST 검색과 복원은 성공·오류 응답에 모두 `Cache-Control: no-store`를 사용합니다.

  Compose는 Redis 8.2.9와 `redis-data` AOF 볼륨을 추가합니다. `appendfsync everysec`이므로 비정상 종료 시
  최근 약 1초의 저장/계정 연결이 유실될 수 있고, 복제·자동 failover·강한 내구성을 제공하지 않습니다.
  TTL은 조회 가능한 기간입니다. 만료가 AOF·백업의 물리적 즉시 삭제를 보장하지 않으므로 디스크 접근 권한과 정리 정책도 관리해야 합니다.
  `SupportProgramSearchResultRedisConfig`는 Lettuce 전용 DNS 캐시를 최대 5초로 제한해 Redis 교체 후 IP 변경을
  재연결에서 반영합니다. JVM 전역 DNS나 외부 HTTP 클라이언트 설정은 바꾸지 않습니다.
  직접 Core를 실행할 때는 Redis를 별도로 준비하고 `REDIS_HOST`/`REDIS_PORT`를 지정합니다(기본 `127.0.0.1:6379`).
  연결/명령 제한은 `REDIS_CONNECT_TIMEOUT`/`REDIS_TIMEOUT`(기본 1초), 외부 운영 Redis의 인증·TLS는
  `REDIS_USERNAME`/`REDIS_PASSWORD`/`REDIS_SSL_ENABLED`로 주입합니다. 로컬 Compose의 Redis는 무인증 내부망 전용이며
  호스트 포트를 열지 않습니다. 운영에는 네트워크 격리·ACL·TLS·메모리/AOF 감시가 별도로 필요합니다.
- 자격 검토: 조건 유무와 관계없이 점수화 계약은 `govbiz-support-program-ranking-v5`입니다.
  저장된 공식 API 본문 `summary` 최대 6,000, 지원대상 `targetDescription` 최대 2,000 Unicode code point를
  AI에 전달합니다. 둘 중 하나라도 잘리면 `sourceTextTruncated=true`이며 대상·지역 모두 `UNKNOWN`만 허용합니다.
  태그의 지역·분야는 후보 검색 보조 정보이고 자격 충족 근거로 인용할 수 없습니다.
  AI 응답의 대상·지역 판정에는 설명(1~160자)과 근거 배열(0~1개)이 필요하며 `MATCH`는 근거 1개가 필수입니다.
  근거는 `SUMMARY` 또는 `TARGET_DESCRIPTION`에서 실제 전송된 문장의 정확한 부분 문자열(1~240자)만 인정합니다.
  설명·인용의 상한은 Unicode code point이고 제어·제로폭 문자 등 Unicode C 범주는 거부합니다.
  원문에 없는 인용·누락된 검토·불충족 `INCOMPATIBLE`·잘못된 정렬은 정상 추천으로 숨기지 않고 내부 계약 오류로 반환합니다.
  관련도는 `2 × (semanticRelevance + supportTypeFit)`로 계산하며 자격 `UNKNOWN`을 감점하지 않습니다.
  의미 관련성 20/40점 이상, 명백한 자격 불일치 제외 후 관련도순으로 최대 5개입니다. 기존 총점 60점 컷과 MATCH 우선은 제거했습니다.
  회사 소재지가 있으면 Search Service가 `_common/domain/RegionDictionary`(시·도 약칭·시군구·권역, 2026-10 행정구역)로
  전국이 아닌 공고 지역 태그와 회사 시·도가 겹치지 않는 공고를 빼지 않고 결과 뒤로 보내 `regionTagMismatch=true`로 표시합니다.
  본문 인용으로 지역을 확인(`MATCH`)한 공고·태그 없는 공고·해석할 수 없는 회사 지역은 옮기지 않습니다. 태그 기반 정렬·표시이며 자격 판정이 아닙니다.
  그보다 먼저 `domain/SupportProgramDuplicatePostings`가 랭킹 결과에서 서로 다른 제공처가 따로 올린 같은 공고
  (정규화 제목·기관·마감일이 모두 같고 제목 머리말 지역이 서로 다르지 않음)를 순위가 높은 한 칸으로 묶어 `alsoPostedBy`에 다른 게시물의 원문 주소를 담습니다.
  랭킹 입력 후보는 바꾸지 않고, 결과에 오르지 못한 같은 공고도 이번 검색 대상에서 찾아 붙이며, 빠진 칸은 채우지 않습니다.
  검색 결과·목록·저장 공고 응답의 `evidenceQuestionSupported`는 상세와 같은 기준(`SupportProgramEvidenceService.supportsQuestions`)입니다.
  검색 응답의 `exclusionCounts`는 Ranking Facade의 `rankWithExclusions`가 AI Service 응답의 사유별 제외 후보 수를 보낸 후보 수와
  맞춰 검증한 `domain/SupportProgramRankingExclusions`입니다(관련도 → 지원 대상 → 지역 순으로 한 사유만 셈). 검색어에 맞는 후보가
  없으면 순위 매기기를 부르지 않고 모두 0, 수를 모르면 `null`이며 웹·앱의 결과 없음 안내와 조건 빼기에 씁니다.
  자연어 검색 결과의 `eligibilityReview`는 전체 상태 `MATCH`/`REVIEW_REQUIRED`, 기준 `OFFICIAL_API_TEXT`,
  대상·지역별 `status`, `explanation`, `evidence[{field,quote}]`를 추천 이유와 별도로 반환합니다.
  이는 HTML을 정리한 **공식 API 본문 기준**의 검토이며 상세 페이지 전체·첨부 PDF/HWP를 확인했다는 뜻이 아닙니다.
  최신 목록·상세의 `eligibilityReview`는 `null`입니다. 자격 검토는 검색 결과에만 존재하며 DB에 저장하지 않습니다.
- 검색 준비 상태: `readiness`는 필수 `sources` 배열로 제공처별 저장 공고 수·색인 준비·동기화 성공/실패를
  반환합니다. 전체 공고 수는 검색 가능한 제공처의 합계이고 `indexReady`는 한 제공처 이상 준비되었는지입니다.
  `SEARCHABLE_WITH_PARTIAL_SOURCES`는 일부만 준비된 상태이며 검색은 준비된 범위에서 가능합니다.
  `SEARCHABLE`은 공고 수가 0인 성공 스냅샷도 포함하며,
  `SEARCHABLE_WITH_SYNC_FAILURE`은 이전 스냅샷은 검색 가능하지만 최신 수집·사전 색인 시도가 실패한 경우입니다.
  `PREPARING`은 공개 공고 없는 초기 상태 또는 결과가 아직 없는 첫 동기화이고, `UNAVAILABLE`은 현재
  공개 스냅샷의 색인 준비가 확인되지 않은 경우입니다. 상태 행 없는 현재 공고의 제공처도 `UNAVAILABLE`로
  표시합니다. 초기 빈 DB에는 `BIZINFO`와 각각 수집을 활성화한 `KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`를 포함합니다.
  시각은 `Asia/Seoul` 오프셋을 포함한 ISO-8601 문자열입니다.
- 상세: 필수 `sourceCode`는 `[A-Z][A-Z0-9_]{0,63}` 형식, `sourceProgramId`는 최대 255자이며 공백만 있는 값은 허용하지
  않습니다. 현재 노출된 행만 반환하며, 없는·미노출 공고는 404입니다. 검색 문맥이 없으므로 추천 이유는
  빈 배열, 추천 점수는 `null`입니다.
- 원문 근거 질문: `sourceCode`, `sourceProgramId`, 최대 500자의 `question`을 JSON body로 보냅니다. 현재 공개된
  `BIZINFO`·`KSTARTUP` 공고에만 제공하며(`SupportProgramEvidenceService.EVIDENCE_SOURCE_LABELS`가 지원 여부·
  인용 원문 이름의 단일 기준), 사용자가 이 endpoint를 호출했을 때만 공식 HTTPS 상세 HTML을 수집합니다.
  MySQL 원문 캐시가 같은 URL로 6시간 이내면 재사용하고, 아니면 읽기 가능한 텍스트를 검증·저장한 뒤 최대 50개
  결정적 청크를 별도 Qdrant evidence 컬렉션에서 검색합니다. 같은 공고 ID·검증된 내용 해시의 불변 청크는
  Core 인스턴스에서 최근 사용한 최대 32개 공고까지 재사용합니다. 원문 최신성·공개 상태와 AI 색인·검색 검증은
  계속 수행하며, 갱신 실패 시 이전 청크로 답하지 않습니다. 답변은 `ANSWERED`(공식 원문 인용 1개 이상) 또는
  `INSUFFICIENT_EVIDENCE`(인용 없음)와 최대 5개 인용 발췌·공식 URL·원문 이름(`sourceLabel`)·청크 순서를 반환합니다.
  첨부파일·PDF·OCR·과기정통부·충남 수출입공지 원문은 지원하지 않습니다. 공식 원문 수집 실패는 503(API 요약으로
  대신 답하지 않음), 지원하지 않는 현재 제공처는 422입니다.
  기업마당 상세 URL의 리디렉션은 매번 공식 HTTPS 호스트와 같은 `pblancId`인지 검증하며 최대 3회 따르고,
  `.support_project_detail`의 제목이 요청한 공고와 일치할 때 `.view_cont` 본문만 추출합니다.
  K-Startup은 `bizpbanc-ongoing.do`·`bizpbanc-deadline.do` 상세 URL과 같은 `pbancSn`만 허용하고, 마감 공고의
  진행 중 페이지가 `fullUrl`로 알려 주는 마감 페이지만 한 번 따라갑니다. `.app_notice_details-wrap`의 `#scrTitle h3`가
  공백·따옴표·문장부호를 무시하고 공고명과 일치할 때 공통 안내·첨부 목록·저작권·버튼을 뺀 상세 본문을 추출합니다.
  HTML은 jsoup `1.23.2`로 파싱합니다. 인용에는 검색된 청크 전체를 반환하며 청크당 최대 1,500 UTF-16 코드 단위입니다.
- 수집기는 `BIZINFO`·`KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`이며 기업마당 외 수집기는 명시적으로 켜야 합니다. 자연어 검색·평가 fixture/capture는
  `findSearchablePresent`의 제공처 상태 JOIN으로 `index_ready=true`인 공고만 읽고, 색인 복구는
  미준비 공고도 제공처별로 처리합니다. 최신 목록은 `findPublishedPresent`로 공개된 스냅샷만 읽되
  이후 색인 장애와 분리합니다. 내부 식별자 `sourceCode:sourceProgramId`로 같은 원본 ID를 구분합니다.
  K-Startup도 같은 벡터 색인과 자연어 추천·필터·상세 조회를 사용합니다. 공식 상세 HTML 원문 질문은 기업마당·K-Startup만 지원합니다.

제공처별 복구 실패 격리와 구현/미구현 범위는 [6단계 다중 제공처 준비](../../docs/support-program-multi-source-preparation.md)에 정리합니다.

요청·응답 JSON과 상세 오류 계약은 [지원사업 API 계약](../../docs/support-program-search-contract.md),
SampleItem 예제는 [별도 계약](../../docs/sample-item-contract.md)에 있습니다.

## 설정

### 과기정통부·충청남도 수출입공지

- `MsitSupportProgramCatalogSyncService`와 `CnTradeNoticeSupportProgramCatalogSyncService`는 각각의
  구체 Facade/Client에서 전체 페이지를 검증한 뒤 기존 `SupportProgramIndexSyncService`로 색인하고
  `SupportProgramRepository`에서 해당 출처만 공개합니다. 중간 수집·색인 실패는 기존 스냅샷을 유지합니다.
- `MSIT_SYNC_ENABLED`와 `CNTRADE_NOTICE_SYNC_ENABLED`는 기본 `false`입니다. 각각 활용 승인과 최초
  임베딩 비용을 확인한 뒤 켭니다. 전용 `MSIT_API_KEY`/`CNTRADE_NOTICE_API_KEY`를 생략하면
  `DATA_GO_KR_SERVICE_KEY`를 사용합니다. 같은 키라도 API 활용 승인은 각각 필요합니다.
- 두 출처의 `*_API_BASE_URL` 기본값은 `https://apis.data.go.kr`, 연결/응답 제한시간은 `2s`/`20s`,
  `*_SYNC_INITIAL_DELAY`/`*_SYNC_FIXED_DELAY`는 `PT0S`/`PT6H`입니다.
- MSIT는 `businessAnnouncMentList`의 공식 상세 URL에 있는 `nttSeqNo`를 ID로 사용합니다.
  실응답이 페이지 크기를 10건으로 제한하므로 전체 수집에 시간이 걸립니다. 별도 스케줄러로 기존 수집과 격리합니다.
  API가 본문·접수 기간·지역·분야를 제공하지 않아 제목·담당 부서 기반으로 검색하며 신청 자격은 원문 확인이 필요합니다.
- CNTRADE_NOTICE는 `getNotiList`의 `lbbNo`가 ID이며 API 본문을 보존합니다. 지원사업뿐 아니라
  일반 수출입 공지도 포함합니다. API에 개별 상세 URL이 없어 확인된 **공식 공지 목록**을 제공하며 제목으로 찾습니다.
- 두 출처 모두 게시일을 접수일로 간주하거나 기관명으로 지역을 추정하지 않습니다. 접수 상태는 `UNKNOWN`,
  지역·분야는 빈 배열입니다. 필터 검색은 `ALL`/`UNKNOWN`에서, AI 검색은 접수 중 제한을 해제한 경우에 조회할 수 있습니다.
  K-Startup 전용 필터와 기업마당·K-Startup 전용 원문 추가 질문은 확장하지 않습니다.
- 2026-09-09 실호출 확인: MSIT 1·2페이지 성공(전체 4,248건 메타데이터). CNTRADE_NOTICE는 HTTP 200의
  `04 HTTP_ERROR`를 반환해 실제 수집은 미확인입니다. 문서 기반 스텁 통과를 실제 제공처 정상 동작으로 간주하지 않습니다.

공식 명세: [과기정통부 사업공고](https://www.data.go.kr/data/15074634/openapi.do),
[충청남도 수출입공지](https://www.data.go.kr/data/15097093/openapi.do).

기본값의 기준은 [`application.properties`](src/main/resources/application.properties)입니다.
Compose는 일부 주소·CORS 값을 내부 네트워크에 맞게 덮어씁니다.

| 환경변수 | 기본값 | 용도 |
|---|---|---|
| `SPRING_DATASOURCE_URL` | `jdbc:mysql://127.0.0.1:3306/govbiz` | MySQL JDBC 주소 |
| `SPRING_DATASOURCE_USERNAME` | `govbiz` | MySQL 사용자 |
| `SPRING_DATASOURCE_PASSWORD` | `govbiz-local` | 로컬 개발용 MySQL 비밀번호 |
| `SUPPORT_PROGRAM_REQUEST_PER_CLIENT_PER_MINUTE` | `6` | 검색·대화 조건 해석·근거 답변의 접속 주소별 최근 60초 한도 |
| `SUPPORT_PROGRAM_REQUEST_GLOBAL_PER_MINUTE` | `60` | 한 Core 프로세스의 검색·근거 답변 최근 60초 한도 |
| `SUPPORT_PROGRAM_REQUEST_MAX_CONCURRENT` | `4` | 검색·근거 답변 동시 처리 한도 |
| `DATA_GO_KR_SERVICE_KEY` | 빈 값 | 기업마당 수집용 공공데이터포털 키 |
| `KSTARTUP_API_KEY` | 빈 값 | K-Startup 조회서비스 활용 승인을 받은 공공데이터포털 키 |
| `KSTARTUP_API_BASE_URL` | `https://apis.data.go.kr` | K-Startup API origin |
| `KSTARTUP_API_CONNECT_TIMEOUT` / `KSTARTUP_API_READ_TIMEOUT` | `2s` / `10s` | K-Startup 외부 호출 제한시간 |
| `KSTARTUP_SYNC_SCOPE` | `RECENT_YEAR` | API에 1년 전 날짜 조건 전달. `RECENT_THREE_MONTHS`는 3개월 전, `OPEN`은 API 모집 중 공고만. 실응답에는 장기 공고도 포함될 수 있음 |
| `KSTARTUP_SYNC_ENABLED` | `false` | 최초 임베딩 비용 확인 뒤 활성화 |
| `KSTARTUP_SYNC_INITIAL_DELAY` / `KSTARTUP_SYNC_FIXED_DELAY` | `PT0S` / `PT6H` | 첫 수집 지연 / 완료 후 다음 수집 지연 |
| `ACCOUNT_SESSION_TTL` | `P30D` | "로그인 상태 유지"를 켠 세션의 절대 만료 기간 |
| `ACCOUNT_SESSION_SHORT_TTL` | `PT12H` | "로그인 상태 유지"를 끈 세션의 절대 만료 기간. 쿠키는 브라우저 세션 쿠키 |
| `ACCOUNT_SESSION_IDLE_TTL` | `P7D` | 마지막 사용 뒤 세션을 끝내는 유휴 기간 |
| `ACCOUNT_JWT_SECRET` | 없음(필수) | 세션 JWT HS256 서명 비밀키(32자 이상). 코드에 기본값이 없어 비어 있으면 기동 실패. Compose·`.env.example`은 로컬 개발용 값을 넣음 |
| `ACCOUNT_IDENTITY_HMAC_KEY` | 빈 값 | 탈퇴 표식(이메일·소셜 연결·사업자등록번호) HMAC 키. 비어 있으면 `ACCOUNT_JWT_SECRET`을 씀. 따로 두면 JWT 비밀을 바꿔도 이전 표식이 계속 맞음 |
| `ACCOUNT_WITHDRAWAL_MARK_PURGE_ENABLED` | `true` | 보관 기간(1년)이 지난 탈퇴 표식을 매일 서울 04:30에 지우는 작업 |
| `OPENAI_ADMIN_KEY` | 빈 값 | OpenAI Usage·Costs API를 함께 가져오는 조직 관리자 키. 비우면 앱 기록만 보이고, 프로젝트 키로는 조회되지 않음 |
| `OPENAI_PROJECT_ID` | 빈 값 | 적으면 Usage·Costs API 모두 그 OpenAI 프로젝트로 제한. 비우면 조직 전체 |
| `AI_COST_SYNC_ENABLED` | `true` | 관리자 키가 있을 때 매일 서울 10:10에 최근 35일 사용량·실제 비용을 함께 가져오는 작업 |
| `AI_COST_KRW_PER_USD` | 빈 값 | 관리자 AI 비용 화면에 원화를 함께 보일 운영자 환율. 비우면 USD만 |
| `ACCOUNT_COOKIE_SECURE` | `true` | 세션 쿠키 `Secure` 속성. HTTPS가 없는 로컬 개발에서만 `false` |
| `ACCOUNT_DEV_LOGIN_ENABLED` | `false` | `true`이면 `POST /api/v1/auth/dev-login`이 등록되어 비밀번호 없이 시드 계정 세션 발급 |
| `ACCOUNT_DEV_LOGIN_EMAIL` | `admin@govbiz.local` | 개발용 관리자 시드 계정 이메일. 없으면 ADMIN 역할·이메일 인증 완료로 생성 |
| `ACCOUNT_DEV_LOGIN_MEMBER_EMAIL` | `member@govbiz.local` | `{"role":"USER"}`로 부를 때 쓰는 회원 시드 계정 이메일 |
| `ACCOUNT_DEV_LOGIN_PASSWORD` | `govbiz-admin1` | 시드 계정 생성 시 저장하는 비밀번호 |
| `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED` | `false` | 비밀번호 재설정 인증번호 메일 SMTP 전송. 꺼져 있으면 `ACCOUNT_DEV_LOGIN_ENABLED`가 켜진 환경에서만 인증번호를 WARN 로그로 남기고, 아니면 503 |
| `ACCOUNT_PASSWORD_RESET_FROM` | 빈 값 | 재설정 메일 발신 주소. 메일을 켜면 필수 |
| `ACCOUNT_PASSWORD_RESET_CODE_TTL` | `PT10M` | 6자리 인증번호 유효 시간(최대 1시간) |
| `ACCOUNT_PASSWORD_RESET_TOKEN_TTL` | `PT30M` | 인증번호를 맞힌 뒤 새 비밀번호를 저장해야 하는 시간(통행 토큰 유효 시간) |
| `ACCOUNT_PASSWORD_RESET_RESEND_COOLDOWN` | `PT1M` | 같은 계정으로 인증번호를 다시 보낼 수 있기까지의 대기 |
| `ACCOUNT_PASSWORD_RESET_MAX_REQUESTS_PER_HOUR` | `3` | 계정당 시간당 요청 한도 |
| `ACCOUNT_PASSWORD_RESET_MAX_ATTEMPTS` | `5` | 인증번호 하나에 허용하는 입력 시도 수 |
| `ACCOUNT_EMAIL_VERIFICATION_MAIL_ENABLED` | 재설정 메일 값 | 회원가입 인증번호 메일 SMTP 전송. 따로 주지 않으면 `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED`를 물려받고, 꺼져 있으면 개발용 로그인 환경에서만 인증번호를 WARN 로그로 남김 |
| `ACCOUNT_EMAIL_VERIFICATION_FROM` | 재설정 메일 값 | 인증번호 메일 발신 주소. 따로 주지 않으면 `ACCOUNT_PASSWORD_RESET_FROM` |
| `ACCOUNT_EMAIL_VERIFICATION_CODE_TTL` | `PT10M` | 6자리 인증번호 유효 시간(최대 1시간) |
| `ACCOUNT_EMAIL_VERIFICATION_PASS_TTL` | `PT30M` | 인증을 마친 뒤 가입을 끝내야 하는 시간 |
| `ACCOUNT_EMAIL_VERIFICATION_RESEND_COOLDOWN` | `PT1M` | 같은 이메일로 다시 보낼 수 있기까지의 대기 시간 |
| `ACCOUNT_EMAIL_VERIFICATION_SEND_WINDOW` / `_MAX_SENDS_PER_WINDOW` | `PT10M` / `3` | 발송 횟수를 세는 창과 그 안의 최대 발송 수 |
| `ACCOUNT_EMAIL_VERIFICATION_MAX_ATTEMPTS` | `5` | 인증번호 하나에 허용하는 입력 시도 수 |
| `ACCOUNT_OAUTH_CALLBACK_BASE_URL` | `http://127.0.0.1:5173` | 브라우저가 `/api`에 닿는 origin. 공급자 콘솔 Redirect URI = 이 값 + `/api/v1/auth/oauth/{kakao\|google}/callback` |
| `ACCOUNT_OAUTH_FRONTEND_BASE_URL` | `http://127.0.0.1:5173` | 소셜 로그인 뒤 돌아갈 프런트 origin(`/oauth/complete`, 실패는 `/login?oauthError=`) |
| `ACCOUNT_OAUTH_GOOGLE_CLIENT_ID` / `…_SECRET` | 빈 값 | Google 웹 애플리케이션 클라이언트. 둘 다 있어야 켜짐 |
| `ACCOUNT_OAUTH_KAKAO_CLIENT_ID` / `…_SECRET` | 빈 값 | 카카오 REST API 키·Client Secret. 둘 다 있어야 켜짐 |
| `ACCOUNT_OAUTH_KAKAO_ADMIN_KEY` | 빈 값 | 연결 해제 어드민 키. 없으면 FAILED를 기록하고 같은 카카오 계정 재가입 차단 유지 |
| `ACCOUNT_OAUTH_UNLINK_ENABLED` / `ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED` | true / false (Compose true / true) | DB 연결 해제 worker 실행 / RabbitMQ 전달 모드 |
| `ACCOUNT_OAUTH_CONNECT_TIMEOUT` / `ACCOUNT_OAUTH_READ_TIMEOUT` | `2s` / `10s` | 공급자 호출 제한시간 |
| `BIZNO_API_KEY` | 빈 값 | 기업 등록 시 사업자등록번호를 확인하는 Bizno API 키. 비어 있으면 조회·등록이 503 `BIZNO_NOT_CONFIGURED` |
| `BIZNO_URL` | `https://bizno.net/api/fapi` | Bizno 조회 endpoint |
| `BIZNO_API_CONNECT_TIMEOUT` / `BIZNO_API_READ_TIMEOUT` | `2s` / `10s` | Bizno 연결·응답 제한시간 |
| `BIZINFO_API_BASE_URL` | `https://apis.data.go.kr` | 기업마당 API 주소 |
| `BIZINFO_API_CONNECT_TIMEOUT` | `2s` | 기업마당 연결 제한시간 |
| `BIZINFO_API_READ_TIMEOUT` | `10s` | 기업마당 응답 제한시간 |
| `BIZINFO_SOURCE_DOCUMENT_BASE_URL` | `https://www.bizinfo.go.kr` | RestClient 기본 origin. 실제 요청은 검증된 공고 `sourceUrl`의 절대 URI를 사용하므로 이 값으로 요청 주소를 변경하지 않음 |
| `BIZINFO_SOURCE_DOCUMENT_CONNECT_TIMEOUT` | `2s` | 공식 원문 연결 제한시간 |
| `BIZINFO_SOURCE_DOCUMENT_READ_TIMEOUT` | `10s` | 공식 원문 응답 제한시간 |
| `BIZINFO_SYNC_ENABLED` | `true` | 기업마당 수집·색인 준비·DB 공개 작업 실행 여부 |
| `BIZINFO_SYNC_INITIAL_DELAY` | `PT0S` | 첫 수집 작업까지의 지연 |
| `BIZINFO_SYNC_FIXED_DELAY` | `PT6H` | 이전 수집 작업 종료 후 다음 실행까지의 지연 |
| `AI_SERVICE_BASE_URL` | `http://127.0.0.1:8000` | 내부 AI Service 주소 |
| `AI_SERVICE_CONNECT_TIMEOUT` | `1s` | AI Service 연결 제한시간 |
| `AI_SERVICE_READ_TIMEOUT` | `35s` | AI Health·대화 조건 해석·원문 근거 답변 응답 제한시간 |
| `AI_COMBINATION_REVIEW_READ_TIMEOUT` | `75s` | 중복 지원·수혜 분석 전용 응답 제한시간 |
| `COMBINATION_REVIEW_CONTRACT_VERSION` | `v3` | 중복 검토 새 실행의 AI 계약(`v3` 세 질문, `v2` 여섯 단계는 되돌릴 때만). 실행 시점 값을 쓰며 지난 실행은 저장된 계약으로 읽음 |
| `AI_RANKING_READ_TIMEOUT` | `55s` | 지원사업 최종 점수화 전용 응답 제한시간 |
| `AI_SEMANTIC_SEARCH_READ_TIMEOUT` | `30s` | 의미 검색·색인 응답 제한시간 |
| `ELASTICSEARCH_BASE_URL` | `http://127.0.0.1:9200` | 호스트 실행 시 키워드 색인·검색 주소. Compose는 `http://elasticsearch:9200`으로 고정 |
| `ELASTICSEARCH_INDEX_NAME` | `govbiz-support-program-lexical-v2` | 단일 키워드 인덱스 이름. v1에서 전환 시 새 인덱스·재색인 필요 |
| `ELASTICSEARCH_API_KEY` | 빈 값 | 선택 API Key. 개발 Compose는 인증 비활성이며 실제 키는 secret으로 주입 |
| `ELASTICSEARCH_CONNECT_TIMEOUT` / `ELASTICSEARCH_READ_TIMEOUT` | `2s` / `10s` | ES 연결·읽기 제한시간 |
| `SUPPORT_PROGRAM_INDEX_ENABLED` | `true` | 현재 공고의 Elasticsearch·Qdrant 확인·복구 여부. 새 공고 공개 전 필수 색인은 유지 |
| `SUPPORT_PROGRAM_INDEX_INITIAL_DELAY` | `PT0S` | 첫 키워드·벡터 색인 복구까지의 지연 |
| `SUPPORT_PROGRAM_INDEX_FIXED_DELAY` | `PT1M` | 이전 복구 작업 종료 후 다음 실행까지의 지연 |
| `APP_CORS_ALLOWED_ORIGIN` | `http://localhost:5173` | 허용할 Web origin |

추천 점수화만 AI 모델 `45s`·Agent 실행 `50s`·Core 읽기 `55s`로 제한합니다.
`AiServiceClientProperties.rankingReadTimeout`과 전용 `aiRankingRestClient`를 사용하며
`HttpAiSupportProgramRankingClient`에만 주입합니다. 공유 `aiServiceRestClient`의 `35s`와
의미 검색·색인의 `aiSemanticSearchRestClient` `30s`는 유지합니다. 대화 조건 해석·원문 근거 답변의
AI 모델·Agent 제한도 기존 `25s`·`30s`이며 Health와 함께 공유 Core 제한을 사용합니다.
중복 검토는 AI 모델 `60s`·Agent 실행 `70s`보다 긴 `aiCombinationReviewRestClient` `75s`를 사용합니다.
검색은 ES 키워드 검색 → 의미 검색 → 점수화를 순서대로 호출합니다. 각 Core 읽기 제한은
`10s`·`30s`·`55s`이며, 브라우저 제한은 기존 `90s`를 유지합니다. 따라서 모든 단계의 최대 대기시간을
보장하지 않으며 브라우저가 먼저 취소할 수 있습니다. 이 값은 요청 제한이며 응답시간 목표가 아닙니다.
AI의 HTTP 504나 Core 읽기 시간 초과는 기존대로 `TIMEOUT → 504 AI_SERVICE_TIMEOUT`으로 전달하며
빈 결과·일반 장애로 바꾸지 않습니다. 후보 수·모델·프롬프트·원문 자격 판단 계약은 바꾸지 않습니다.

`SUPPORT_PROGRAM_INDEX_ENABLED=false`는 별도 복구 스케줄러만 끕니다. 새 카탈로그 공개 전의 필수
색인은 계속 실행됩니다. 두 스케줄러는 각각 별도의 단일 스레드에서 실행되며 실패를 기록한 뒤
다음 주기에 다시 시도합니다. 현재 공개된 수동 동기화 HTTP API는 없습니다.

### 예산을 지정한 일회성 수집

`catalog-sync-once` 프로필은 HTTP 서버 없이 선택한 제공처를 한 번 수집하고 종료합니다. 일반 API 서버의
자동 수집/색인 복구 플래그는 계속 `false`로 유지합니다. 이 프로필에서는 초기화 단계에 모든 수집·복구·큐·메일
예약 작업과 Flyway를 강제로 끄므로, 이미 migration이 완료된 DB에만 실행해야 합니다.

```bash
java -Djdk.httpclient.disableRetryConnect=true -Djdk.httpclient.redirects.retrylimit=1 \
  -jar application.jar --spring.profiles.active=catalog-sync-once \
  --app.catalog-sync-once.sources=BIZINFO,KSTARTUP,MSIT \
  --app.catalog-sync-once.max-usd=1.00 \
  --app.catalog-sync-once.receipt-path=/persistent/catalog-initial.receipt
```

기본값은 **무료 사전 검사**(`apply=false`)입니다. 각 제공처 전체 페이지를 기존 Client/Facade로 검증하고,
실제 색인 입력의 UTF-8 바이트 수와 문서당 8,191 토큰 상한으로 보수적인 임베딩 비용 상한을 계산합니다.
`text-embedding-3-small`의 [공식 표준 입력 단가](https://developers.openai.com/api/docs/models/text-embedding-3-small)
$0.02/백만 토큰(2026-09-15 확인)을 사용하며, 허용 예산은
0 초과 $1 이하입니다. 실행 전 대상 AI Service가 이 모델·1536차원과 SDK `max_retries=0`을 사용하는지 확인해야 합니다.
다른 모델·요금 또는 별도 검색/답변 호출의 비용까지 제한하는 계정 전체 예산 기능은 아닙니다.
위 JVM 옵션은 [JDK HTTP Client의 자동 재전송](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/module-summary.html)을
막아 같은 임베딩 요청이 네트워크 장애로 중복 실행되지 않도록 합니다. 예산을 제한한 실행에서는 생략하지 않습니다.

승인된 적용은 같은 명령에 `--app.catalog-sync-once.apply=true`를 추가합니다. 모든 선택 제공처의 전체 수집과
합산 비용 검사가 끝나기 전에는 DB/색인을 변경하거나 유료 API를 호출하지 않습니다. 검사한 동일 스냅샷을
제공처별 `색인 → Repository의 원자적 공개` 순서로 반영하며, 중간 실패 시 실패한 제공처의 기존 공개 목록은 유지합니다.
먼저 성공한 제공처까지 되돌리지는 않습니다. 실패를 정상 완료로 숨기거나 자동 재시도하지 않습니다.

영속 디렉터리의 receipt를 **배타적으로 생성하고 디스크에 동기화한 뒤** 적용을 시작합니다. 완료·실패·강제 중단 모두
같은 기록 경로로 다시 실행할 수 없습니다. Docker에서는 호스트 디렉터리를 마운트하고 `--restart=no`를 사용합니다.
기록을 삭제하거나 새 경로로 재실행하면 추가 과금될 수 있으므로, 기존 지출 확인과 새 승인이 필요합니다.
자동 수집을 계속 꺼두면 신규·수정 공고는 다음 수동 수집 전까지 반영되지 않습니다.

기업마당 키는 Encoding·Decoding 형식 모두 받을 수 있으며 Client가 요청 전에 정규화합니다.
목록 DTO는 검색·저장에 사용하는 원본 필드만 디코딩합니다. 사용하지 않는 신청 방법
(`reqstMthPapersCn`) 필드는 무시하며, 실제 사용하는 필드와 페이지 완전성 검증은 유지합니다.
실제 인증키·운영 DB 비밀번호는 환경변수로 주입하고 Git에 기록하지 않습니다. OpenAI 키는
Core API가 아닌 AI Service에만 설정합니다.

## 코드 구조

기본 패키지는 `ai.govbiz.core`, Gradle 프로젝트명은 `govbiz-core-service`입니다.

```text
supportprogram/
├── controller            # 공개 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service/
│   ├── search             # DB 조회 → 의미·키워드 순위 결합 → AI 점수화
│   ├── conversation       # 대화 변경 인용 검증·초안 병합·확정 조건 대비 변경 계산
│   ├── detail             # 현재 공고 상세 조회
│   ├── saved              # 회원의 관심 공고함(담기·빼기·목록)
│   ├── readiness          # 제공처별 준비 상태와 전체 검색 범위 집계
│   ├── evidence           # 공식 원문 캐시·청킹 → 근거 검색·답변
│   ├── sync               # 수집·두 색인 준비·DB 공개와 별도 키워드/벡터 복구
│   ├── evaluation         # 비웹 fixture 내보내기·검색 품질 평가 캡처 프로필
│   └── dto                # 검증된 내부 실행 결과
├── facade                 # 기업마당 수집·제공처별 공식 원문·AI 응답 검증·도메인 변환
├── client/
│   ├── bizinfo            # 기업마당 HTTP·목록/공식 HTML 검증·외부 DTO 정규화
│   ├── kstartup           # K-Startup 페이지 검증·공식 상세 URL/HTML 검증·원문 대상·전용 분류 정규화
│   ├── elasticsearch      # Nori·BM25 색인/검색 HTTP, DTO·Mapper·설정·예외
│   └── ai                 # AI 내부 HTTP 계약·조건 해석·공고/원문 청크 색인과 답변
├── repository            # 도메인↔DB 행 변환·트랜잭션·저장·조회
│   └── mapper            # MyBatis Mapper, DbRow
├── domain                 # 업무 모델·서울 날짜 기준 접수 상태 규칙
└── helper                 # 지원사업 하위 흐름이 함께 쓰는 보조 작업
account/
├── controller            # 로그인·로그아웃·내 계정, 개발용 로그인, 기업 등록·수정 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service               # 회원가입, 로그인 검증·시도 제한, JWT 세션, 소셜 로그인, 비밀번호 변경·계정 삭제·탈퇴 표식, 기업 등록(사업자등록번호 조회)
├── client/bizno          # Bizno 사업자등록번호 조회 HTTP·오류 변환
│   └── mapper            # 원문 JSON 검증·정규화 → domain/RegisteredBusiness 변환
├── client/oauth          # 카카오·Google 인가 주소·코드 교환·ID 토큰 클레임 확인, 카카오 연결 끊기
├── repository            # 계정·세션·소셜 로그인 연결·기업·탈퇴 표식 저장과 조회, DbRow 변환
│   └── mapper            # MyBatis Mapper, DbRow
├── domain                # 계정·역할·세션·소셜 로그인 공급자·기업·등록 사업자 업무 모델
├── helper                # HS256 JWT 발급·검증·해시, 세션·소셜 로그인 상태 쿠키 발급·읽기, 이메일 정규화
├── web                   # Account 파라미터 resolver, Origin 검사 interceptor와 MVC 등록
└── config                # BCrypt, 세션·개발 로그인·소셜 로그인 설정
partner/
├── controller            # 파트너 모집글 목록·상세·작성, 제안 보내기·수락·거절·철회, 제안함 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약
├── service               # 작성·제안 조건(기업 등록·공고 접수 중·마감일·공고당 하나·당사자) 확인과 조회
├── repository            # 모집글·제안 저장, 기업·계정·공고 조인 조회, 검색·필터·정렬·페이지, 제안 수
│   └── mapper            # MyBatis Mapper, DbRow
└── domain                # 모집글·제안·역할 업무 모델, 조회 시점 모집·제안 상태 계산
planusage/
├── controller            # 남은 사용량 조회 HTTP 진입점
│   └── dto               # 공개 응답 계약
├── service               # 하루 한도 예약·되돌리기, 월 한도 확인, 삭제 시 사용량 보존, 기능별 사용량 조회
│   ├── dto               # 요금제·기능별 사용량 결과
│   └── exception         # 한도 초과 예외
├── repository            # 요금제·사용량 행(MySQL)과 로그인 전 체험 횟수(Redis), 월 한도 기능의 작업 집계
│   ├── mapper            # MyBatis Mapper, DbRow
│   └── exception         # 사용량 저장소 장애
└── domain                # 요금제별 한도(없으면 null), 기능·기간, 서울 기준 집계 기간
aiusage/
├── controller            # 관리자 AI 비용·가격표·실제 비용 가져오기 HTTP 진입점
│   └── dto               # 공개 요청·응답 계약(금액은 소수 6자리 USD 문자열)
├── service               # 사용량 기록(REQUIRES_NEW)·추정 비용·기간 합계, 실제 비용 동기화와 매일 작업
├── client                # ai-service 사용량 헤더 기록 인터셉터, OpenAI Costs API
│   ├── dto · mapper · exception
├── repository            # 사용 기록·가격표·실제 일별 비용(MySQL)
│   └── mapper            # MyBatis Mapper, DbRow
├── helper                # 지금 AI를 부르는 계정·기능 표시(ThreadLocal)
└── domain                # 가격 선택·비용 계산, 기간 합계
_health                    # Core API Health
_health_ai_service         # AI Service Health의 Controller → Service → Client
_sampleitem                # 학습 예제
_common                    # 실제 공유하는 HTTP·AI 설정·JSON·CORS·서울 기준 시계·오류 처리
```

외부 호출의 기본 흐름은 `Controller → Service → Facade → Client`입니다. Facade는 하위 호출·검증·변환을
묶을 때 사용하며, DB 접근은 `Service → Repository → MyBatis Mapper → Mapper XML → MySQL`입니다.
Facade와 Domain은 MyBatis Mapper를 직접 호출하지 않습니다.

| 타입 | 소유 위치·역할 |
|---|---|
| `Request`, `Response` | 공개 HTTP 계약은 해당 기능의 `controller/dto` |
| 외부 `Request`, `Payload` | 상대 시스템별 `client/dto` |
| `Result` | 검증된 실행 결과는 `service/dto` |
| 업무 모델 | 프레임워크에 의존하지 않는 `domain` |
| `DbRow` | `repository/mapper`의 DB 행 타입. Repository 밖으로 노출하지 않음 |
| `Helper` | 실제 반복 보조 작업. 특정 기능의 하위 흐름이 함께 쓰면 해당 기능의 `helper`, 둘 이상의 기능이 함께 쓰면 `_common/helper` |

SQL은 [`SupportProgramMapper.xml`](src/main/resources/mybatis/supportprogram/repository/SupportProgramMapper.xml)에
명시하며 JPA·JdbcClient·annotation SQL을 혼용하지 않습니다. Repository가 JSON 배열과 DbRow를
변환하고 `SupportProgramStatusResolver`를 호출합니다. 상세 규칙은 [AGENTS.md](../../AGENTS.md)를 따릅니다.

## 데이터 관리와 오류 처리

- Flyway [V1](src/main/resources/db/migration/V1__create_support_program.sql)은 공고 테이블,
  [V2](src/main/resources/db/migration/V2__add_support_program_sync_generation.sql)는 최신 수집 시작 세대,
  [V3](src/main/resources/db/migration/V3__create_support_program_source_document.sql)는 공고별 공식 원문
  테이블, [V4](src/main/resources/db/migration/V4__create_support_program_sync_status.sql)는 공개 스냅샷의
  세대·지문·공고 수·색인 준비와 최근 동기화 결과,
  [V5](src/main/resources/db/migration/V5__create_account.sql)는 계정과 세션 테이블,
  [V6](src/main/resources/db/migration/V6__create_company.sql)는 계정당 하나인 기업 테이블(사업자번호 UNIQUE),
  [V7](src/main/resources/db/migration/V7__add_support_program_startup_details.sql)은 K-Startup 전용 분류 JSON과 형식·제공처 제약,
  [V8](src/main/resources/db/migration/V8__create_partner_recruitment.sql)은 계정·기업·공고에 묶인 파트너 모집글 테이블,
  [V9](src/main/resources/db/migration/V9__create_partner_proposal.sql)은 모집글과 제안 계정·기업에 묶인 파트너 제안 테이블,
  [V10](src/main/resources/db/migration/V10__create_combination_review.sql)은 중복 검토 건과 선택 사업,
  [V11](src/main/resources/db/migration/V11__create_combination_review_run.sql)은 실행 스냅샷과 원본 파일 테이블,
  [V12](src/main/resources/db/migration/V12__create_daily_report.sql)는 일일 리포트 구독·발송 테이블,
  [V13](src/main/resources/db/migration/V13__create_company_partner_profile.sql)은 기업당 하나인 협업·파트너 설정 테이블,
  [V14](src/main/resources/db/migration/V14__create_account_password_reset.sql)는 비밀번호 재설정 토큰 해시 테이블([V42](src/main/resources/db/migration/V42__password_reset_email_code.sql)가 6자리 인증번호·시도 횟수·통행 토큰 열로 바꿈),
  [V17](src/main/resources/db/migration/V17__create_account_oauth_identity.sql)은 소셜 로그인 연결 테이블(`(provider, subject)`
  UNIQUE)을 만들고 소셜로만 가입한 계정을 위해 `account.password_hash`를 nullable로 바꿉니다.
  적용된 migration은 수정하지 않고 새 버전을 추가합니다.
- 전체 수집·검증·색인이 끝난 뒤 최신 시작 세대만 공개합니다. 해당 제공처 행 미노출 처리와 UPSERT를
  하나의 짧은 DB transaction으로 묶고, 같은 transaction에서 스냅샷 지문·공고 수·`indexReady=true`·성공
  시각을 기록합니다. 외부 HTTP 호출은 transaction 밖에서 수행합니다.
- 수집 또는 공개 전 필수 색인이 실패하면 현재 세대일 때만 실패 시각을 기록합니다. 이때 이전 공개 스냅샷의
  공고·색인 준비 상태는 바꾸지 않습니다. 별도 복구가 실패하면 자신이 읽어 색인한 세대·지문·공고 수와 상태 행이
  여전히 일치할 때만 `indexReady=false`로 바꿉니다. 복구 성공도 같은 조건에서만 준비 완료를 기록합니다.
- 복구는 제공처별로 벡터를 확인하고 상태를 갱신합니다. 한 제공처의 실패 이후에도 다른 제공처를 처리하고,
  전체 처리가 끝나면 실패를 오류로 전달합니다. 최신 수집 실패와 기존 공개 스냅샷 복구 실패는 서로 다른 상태입니다.
- Repository의 `findSearchablePresent()`는 공개 스냅샷과 색인 준비를 모두 요구하고, 최신 목록용
  `findPublishedPresent()`는 공개 스냅샷만 요구합니다. Mapper의 `findPublishedPresent(requireIndexReady)`가
  같은 SQL에서 색인 조건만 선택하며, 색인 복구용 전체 조회 `findPresent()`와 혼용하지 않습니다.
- V4 적용 전부터 있던 공고에는 공개 세대·검색 문서 지문·과거 색인 성공 여부가 없습니다. 다만 현재 공개된
  제공처별 공고가 1건 이상이고 해당 제공처 전체 색인 복구가 성공하면, 그때 읽어 색인한 지문·공고 수를 sentinel 세대 `0`과
  함께 한 번만 채택합니다. 빈 초기 DB는 `PREPARING`, 복구 전 legacy 공고는 `UNAVAILABLE`이며, 실제 새 스냅샷의 지문은 이
  bootstrap이 덮어쓰지 않습니다.
- 원본 ID 표기의 대소문자만 바뀌어도 UPSERT가 최신 표기를 저장하여 DB ID와 벡터 ID를 맞춥니다.
  DB 고유키의 비교는 `utf8mb4_0900_ai_ci` collation을 따릅니다.
- 접수 상태를 DB에 고정 저장하지 않습니다. 조회 시 날짜를 우선 적용하고, 날짜만으로 판단할 수
  없는 경우 원문 표현을 확인합니다. 명시적 종료 표현은 상시 접수 표현보다 우선합니다.
  수시 접수 표현은 `모집 완료 시`·`모집완료시`처럼 띄어쓰기만 다른 변형을 같게 보지만, 공백을 지운 부분 일치를 쓰지 않아
  `100개사 이상 시`·`접수 시`·`상시 근로자`·`접수 마감 시간`·`접수 마감 시 별도 안내`를 접수 중으로 읽지 않습니다
  (`접수·신청 마감 시`는 `까지`가 붙을 때만 수시 접수). 기업마당 기간에 날짜가 하나면
  날짜 바로 뒤의 `까지`·`부터`·`~`로 마감일·시작일을 정합니다(Catalog의 같은 매퍼·판정 규칙과 동일).
- 검색·색인 흐름은 [아키텍처](../../docs/architecture.md)에, 20,000건 상한·자동 벡터 삭제 미연결 등
  현재 제약은 [구현 현황](../../docs/implementation-status.md)에 정리합니다.

검색·AI 외부 경계의 실패는 `application/problem+json`으로 변환합니다. 내부 URL·라이브러리 예외는 공개하지 않습니다.

| 관측한 상황 | 공개 HTTP | `code` |
|---|---:|---|
| Elasticsearch 통신·시간 초과·부분 실패·문서 버전/가시성 검증 실패 | 503 | `SUPPORT_PROGRAM_SEARCH_INDEX_UNAVAILABLE` |
| AI 내부 503 또는 연결 불가, 기존 공고가 있지만 준비된 제공처가 없는 자연어 검색 | 503 | `AI_SERVICE_UNAVAILABLE` |
| 조건 해석·점수화·색인 API의 내부 408·504 또는 연결·읽기 시간 초과 | 504 | `AI_SERVICE_TIMEOUT` |
| 예상하지 않은 HTTP 상태 | 502 | `AI_SERVICE_UPSTREAM_ERROR` |
| 잘못된 JSON·빈 body·응답 계약 위반 | 502 | `AI_SERVICE_INVALID_RESPONSE` |
| 공식 원문 제공처 수집·HTML 검증 실패 | 503 | `SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE` |
| 현재 공고 제공처가 원문 근거 질문을 지원하지 않음 | 422 | `SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED` |

AI Service는 시간 초과 외 LLM 실행 실패와 색인 미준비·Qdrant 실패를 내부 503으로 반환하므로 일반적으로 공개 503이
됩니다. 조건 해석·점수화의 모델·HTTP·Agent 시간 초과는 내부 504 → 공개 `504 AI_SERVICE_TIMEOUT`으로
구분합니다. Health API의 내부 408·504는 점수화 API와 달리 `UPSTREAM_ERROR`로 분류합니다.
기업마당 수집 오류는 검색 요청에서 발생하는 오류가 아니라 백그라운드 작업의 실패로 기록됩니다.
Elasticsearch 실패는 AI 오류와 별도 경계이며 ES 직접 시간 초과도 위 503으로 반환합니다.
복구가 모든 제공처를 미준비로 기록한 뒤에는 검색의 사전 검사에서 `AI_SERVICE_UNAVAILABLE`이 나올 수 있습니다.
두 오류 모두 빈 검색 결과로 숨기지 않으며, 자세한 구분은 [키워드 색인 복구·장애 계약](../../docs/elasticsearch-lexical-search.md#동기화준비-상태복구)을 참고하세요.

## 검증

### AI 검색 Langfuse 추적

`SupportProgramSearchTracingHelper`는 `search.total` 아래 DB 조회·적격 후보 준비·문서 준비·
키워드 검색·의미 검색·후보 병합·랭킹 시간을 기록합니다. Core의 OpenTelemetry SDK/OTLP exporter는
Spring Boot BOM의 같은 버전을 사용하며 Java agent나 전역 자동 HTTP 본문 수집은 추가하지 않습니다.
두 AI HTTP Client가 현재 검색 span의 `traceparent`만 전달하고 Python의 임베딩·Qdrant·랭킹 span이
같은 trace에 이어집니다. 외부 요청의 부모 ID를 Core 검색 루트로 받아들이지 않습니다.
최종 후보/선택 ID와 건수를 기록하며 질문·기업 조건·공고 원문·예외 메시지는 수집하지 않습니다.

Core와 AI Service에 `LANGFUSE_ENABLED=true`, 같은 프로젝트의 `LANGFUSE_BASE_URL`,
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`를 설정합니다. 기본값은 비활성화이며
`LANGFUSE_ENVIRONMENT`는 `development`, `GIT_SHA`는 선택적인 빌드 SHA입니다.
업무 Compose가 두 서비스에 이 값을 전달합니다. Core는 최대 1,024 span의 비동기 큐와 2초 전송 제한을
사용하며 Langfuse 전송 실패로 검색·모델을 재실행하지 않습니다. 활성 검색의 로그 `trace_id`로 조회할 수 있습니다.
Ops 링크·단계 구조·전체 검증의 한계는 [LLMOps 실행 안내](../../infrastructure/llmops/README.md#지원사업-ai-검색-추적)를 참고하세요.

### 도우미 Core → AI 분산 추적

`LlmTracingConfig`가 검색·도우미·상세 근거 답변의 OTLP provider·비동기 전송 큐를 하나로 구성합니다.
기존 검색 전용 설정을 `_common/config`로 옮겼으며 환경변수·비활성화 기본값은 위와 같습니다.
`AssistantTracingHelper`는 각 `AssistantMessageService.answer` 호출을 새 `assistant.total` 루트로 시작합니다.
`assistant_request trace_id=...` 로그나 Langfuse의 `assistant-agent` 이름으로 조회합니다.

```text
assistant.total (Core)
├─ assistant.core.request → assistant.agent (AI) → 분류·도구·답변 단계
├─ assistant.core.validate
├─ assistant.core.documents (관심 공고 원문·청크 준비가 필요할 때)
├─ assistant.core.resume_request → assistant.agent (AI) → 관심 공고 RAG
└─ assistant.core.validate_resume
```

첫 호출과 재호출은 같은 trace의 서로 다른 부모 span을 사용합니다. 자료가 비면 재호출하지 않으며,
응답 계약·허용 카드·인용 검증과 503/504 처리도 유지합니다. 준비·검증 실패는 해당 Core 단계에 표시합니다.
질문·문서·계정·토큰·응답 본문·예외 원문은 추적에 넣지 않습니다. 외부 요청의 `traceparent`는 Core 루트로
채택하지 않고, 현재 도우미 문맥에서 만든 헤더만 내부 `/assistant/agent`에 전달합니다.
기존 분류 모드는 Core의 `assistant.core.classifier`까지만 기록하며 AI 분류기 내부 연결은 포함하지 않습니다.

로컬 선택 테스트는 `AssistantMessageTracingTest`, `AssistantTracingHelperTest`, 기존 도우미 Service·Client,
`LlmTracingConfigTest`, 검색 추적 회귀를 포함합니다. 실제 서버 저장·재조회는
[LLMOps 도우미 연결 검사](../../infrastructure/llmops/README.md#core-도우미-분산-추적-검증)를 따릅니다.

### 상세 공고 RAG 분산 추적

`SupportProgramEvidenceTracingHelper`가 상세 질문마다 새 `evidence.total`을 만들고,
Service의 공고 조회·원문 준비·청킹과 Facade의 색인·검색·답변·인용 검증을 연결합니다.
Langfuse의 `support-program-evidence` 이름 또는 `support_program_evidence trace_id=...` 로그로 조회합니다.

```text
evidence.total (Core)
├─ evidence.core.detail
├─ evidence.core.source       원문 캐시 hit/miss
├─ evidence.core.chunk        청킹 캐시 hit/miss·청크 수
├─ evidence.core.index  → evidence.index (AI) → readiness / embedding / upsert
├─ evidence.core.search → evidence.search (AI) → readiness / embedding / vector / validate
├─ evidence.core.answer → evidence.answer (AI) → model / validate_selection / validate_response
└─ evidence.core.validate     최종 답변·허용 인용 검증
```

세 내부 HTTP 호출은 각각의 Core 단계가 만든 부모 헤더를 사용합니다. 외부 부모 ID는 채택하지 않으며
질문·원문·답변·예외 본문은 기록하지 않습니다. 단독 `prepareChunks`·자료 선수집 경로는 별도 Core 근거
trace를 만들지 않습니다. 기존 문서 준비·캐시·DB 저장·응답 검증·오류 상태와 재시도 정책은 유지합니다.

무료 검증은 `SupportProgramEvidenceTracingTest`의 실제 Service→Facade→Client와 HTTP 대역,
AI 세 HTTP 경로 및 Langfuse 저장·재조회를 조합합니다. 실제 Core 서버→합성 원문의 MySQL snapshot→AI·Qdrant→
Langfuse를 거치는 여섯 사례는 기존 격리 CI에 `--evidence-traces-output`으로 추가했습니다.
정상·캐시·모델 오류·시간 초과·인용 오류·검색 실패를 확인하며 공식 원문 HTTP 수집은 포함하지 않습니다.
새 코드의 실제 전체 통과 여부는 최종 SHA의 CI로 판단합니다. 검색/답변 품질 점수와 Ops 평가 계약은 후속 범위입니다.
[검증 명령과 한계](../../infrastructure/llmops/README.md#상세-공고-rag-추적-검증)를 참고하세요.

### 기존 기능 검증

`backend/core-service` 디렉터리에서 JDK 21 환경으로 실행합니다. Repository 통합 테스트가 실제
`mysql:8.4` Testcontainers를 실행하므로 Docker가 필요합니다.

```bash
./gradlew clean test --no-daemon
```

테스트는 Controller 계약·Client/Facade 응답 검증·상태 계산·동기화 순서·공식 원문 HTML 검증·근거 청크/인용 계약과
MySQL의 JSON, 복합 식별자, UPSERT, rollback, 시작 세대에 따른 공개 제어, 공개 스냅샷 준비 상태 전이를 검증합니다. 전체 서비스 연결 검증은
[인프라 README](../../infrastructure/README.md)의 Compose 검증 절차를 참고하세요.

C02 회귀는 공개 HTTP의 nullable 필수 키·엄격한 타입·문자/날짜 경계, 내부 AI JSON의 누락 필드·오류 변환,
현재 발화 인용·미변경 조건 보존·직전 초안 병합·CLEAR 기본값·변경 목록 순서·기존 검색과의 공유 요청 제한을
검증합니다. `SupportProgramConversationServiceTest`, `SupportProgramConversationControllerTest`,
`AiSupportProgramConversationClientTest`는 외부 모델과 DB를 사용하지 않습니다.
`SupportProgramConversationEvaluationReplayTest`는 [대화 조건 해석 평가](../../evaluation/support-program-conversation/README.md)의
예시 재생 응답(`src/test/resources/support-program-conversation/`)을 실제 Client·Service로 받아 Core의 수락·거부와
지역 표기 유지를 확인합니다. 손 작성 예시이며 모델 품질 측정이 아닙니다.

2026-09-07 C02 검증은 Temurin JDK 21.0.12와 실제 MySQL 8.4.11(Testcontainers `mysql:8.4`)에서 전체
`clean test`를 실행해 47개 스위트·508개 테스트가 통과했습니다(실패·오류·건너뜀 0). 신규 C02 75개와
기존 433개를 모두 포함하며, 테스트 필터나 대체 DB·유료 모델 호출은 사용하지 않았습니다.

같은 날 랭킹 전용 timeout을 분리한 뒤에도 JDK 21.0.12·MySQL 8.4.11에서 필터 없이 전체
`./gradlew clean test --no-daemon`을 다시 실행해 47개 스위트·512개 테스트가 통과했습니다
(실패·오류·건너뜀 0). 설정 바인딩·전용 bean 주입·실제 HTTP 읽기 제한·공개 timeout 오류 매핑과
기존 MySQL 통합 43개를 포함하며, 개발 서비스 변경이나 유료 모델 호출 없이 검증했습니다.

`SupportProgramEvidenceIntegrationTest`는 실제 Core HTTP·MySQL과 고정한 공식 HTML 2건으로 RAG 경계를
통합 검증합니다. 기본 실행에서 원문/AI 외부 HTTP는 스텁이며 API 키를 사용하지 않습니다.
명시적으로 별도 로컬 AI 주소와 새 캡처 경로를 지정한 경우에만 실제 AI 경로를 호출할 수 있습니다.
실행 조건·범위·기록은 [RAG 평가 안내](../../evaluation/support-program-evidence/README.md)를 참고하세요.

HWP 체크박스의 FORM_OBJECT Caption은 주변 문항과 함께 별도 근거 블록으로 보존한다. 공식 신청 문항의 단일 선택지는 AI Service가 원문 인용에 포함된 `options`로 추출하고, Core API가 다시 검증한 뒤 양식 스냅샷과 공개 응답에 보존한다. Frontend는 선택지를 라디오 버튼으로 표시한다. 기존 스냅샷에서 `options`가 없으면 빈 목록으로 읽으며, 선택형 문항의 선택지를 확인하지 못한 경우 공식 원문 확인을 안내한다.

## 공고별 신청 양식 사전분석

신규·변경 공고의 상태와 시스템 분석 Outbox는 `application_form_availability`에 저장합니다. 공식 제공처 전체 동기화 성공 transaction에서 등록하고, 별도 Worker가 첨부 수집·파싱·AI 분석을 수행합니다. 성공 snapshot 저장과 AVAILABLE 활성화는 하나의 짧은 transaction입니다.

공식 첨부는 파일별 원문 길이 제한을 적용하고 AI 문항 추출도 첨부별로 실행합니다. 한 첨부의 원문·응답·입력 위치 매핑이 실패해도 다른 첨부를 계속 확인하며, 검증과 매핑을 통과한 양식이 하나라도 있으면 그 결과만 함께 저장합니다. 모든 후보가 실패하면 해당 실패 코드를 남깁니다.

사용자 작성 화면은 신청 양식 확인 시 availability API에서 활성 snapshot을 먼저 읽습니다. PENDING 또는 STALE이면 기존 계정별 Discovery Job으로 공식 첨부를 분석해 snapshot을 저장하고 결과를 표시합니다. 다른 실패 상태는 자동 재분석하지 않습니다. 새 작성은 활성 formVersionId만 허용하고, 기존 작성의 과거 버전과 최종 생성의 공식 원본 해시 대조는 유지합니다.

Discovery 전용 timeout은 model 210초 < AI run 240초 < Core read 270초 < Worker lease 1,800초입니다. 다른 신청 준비 기능의 전역 timeout은 변경하지 않습니다. [상태·재시도 정책](../../docs/application-form-availability.md)을 참고하세요.

## 신청 문서 MCP 파이프라인

DOCX는 공식 첨부를 Core에서 ZIP/XML로 추출하고, AI Service가 OOXML의 실제 문단·표·셀·내용 컨트롤 주소를 검사합니다. 확인된 단순 입력칸만 원본과 분리해 편집한 뒤 다시 열어 값과 표 구조·스타일을 검증합니다. 세로 병합, 불명확한 다중 문단 셀과 혼합 스타일 등은 자동 작성하지 않습니다. 단순 가로 gridSpan은 하나의 실제 셀 주소로 유지합니다.
DOCX의 `engineVersion`은 AI 설정 응답에서 확인하며 저장 지도와 생성 fingerprint에 반영합니다. DOCX 엔진이 바뀌면 해당 DOCX만 다시 매핑하고, 기존 HWP/HWPX/PDF의 공통 `pipelineVersion`과 생성 fingerprint는 유지합니다. Core는 DOCX 결과의 engineVersion·재열기·XML·스타일 검증 상태를 확인한 뒤 저장합니다.

질문·입력칸 대응에서 넣을 칸을 찾지 못한 문항은 필수 여부와 관계없이 `documentMap.unmappedFieldIds`로 받으며, 공개 양식 필드의 `documentWritable=false`로 UI에 전달하고 양식 분석 경고에 「양식명」의 직접 작성 문항 수를 남긴다. 칸이 확인된 문항은 그대로 자동 기입한다. 생성은 비어 있는 질문을 필수 여부와 관계없이 건너뛰며, 저장된 답변이 하나도 없으면 입력 위치 분석과 AI 호출 없이 공식 원본을 기입 수 0의 초안으로 저장한다. 저장된 답변은 binding 유무로 분리하고, binding이 있는 답변만 AI 문서 계획과 편집기로 전달한다. 미기입 답변의 식별자·표시명·당시 값·사유와 기입/미기입 답변 수는 생성 파일의 `placements_json.answerSummary`에 저장하므로 이후 답변 수정과 무관하게 목록 재조회에서 같은 값을 반환한다. 과거 파일에 이 정보가 없으면 현재 답변으로 추정하지 않는다. 저장된 답변이 있는데 자동 기입 가능한 답변이 하나도 없으면 `APPLICATION_DOCUMENT_NO_WRITABLE_INPUT`으로 원본 반환 없이 중단한다. 여러 표 열을 한 질문으로 묶은 이전 양식의 그 문항은 미매핑으로 남기고, 그런 문항만 있는 양식은 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`를 유지한다. Core의 원문·소유권·revision·빈칸·값·결과 검증은 유지한다.

지도와 캐시는 `mapVersion`을 포함한 AI `pipelineVersion`과 원본 SHA-256으로 비교한다. 버전이 달라 기존 양식을 다시 매핑할 때 이전 binding의 field ID·target ID·box 집합과 편집 scope가 새 결과와 같으면 MySQL `documentMapSnapshot`만 갱신하고 기존 답변·생성 파일은 보존한다. 주소 또는 scope가 달라지면 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`(422)로 자동 작성을 중단하고 이전 지도도 덮어쓰지 않는다. 해당 오류는 자동 재시도로 해결되지 않는다. 변경이 발생한 작성본의 생성 응답에는 비교 내용과 15분 승인 토큰이 포함된다. 사용자가 `POST /api/v1/application-preparations/{id}/documents/mapping-migration/confirm`으로 명시적으로 승인하면 해당 작성본만 참조하는 새 양식 스냅샷을 생성한다. 이전 답변·revision·파일과 다른 사용자의 지도는 유지하며, 새 초안 생성은 별도 액션이다.

변경 비교는 field ID·target ID·box, 기존 필드의 kind·page·widget/box 위치와 편집 scope를 기준으로 한다. heading 등 semantic metadata만 달라지면 승인 절차가 필요 없다. 승인안은 활성 MySQL 지도와 분리된 기존 Redis에 15분간 보관하며, 확인 요청은 소유자·원본 SHA-256·AI pipelineVersion·답변 revision·이전 지도 상태를 다시 검사한다. 승인 transaction은 해당 작성본만 참조하는 `approved-...` 양식 스냅샷을 기존 테이블에 복제하고 작성본의 formVersionId만 바꾼다. 승인 전·취소·stale 오류에서는 MySQL 기록을 바꾸지 않는다. 승인 후에는 `REGENERATION_REQUIRED`를 반환하고 기존 파일을 덮어쓰지 않는다. 이 전용 스냅샷은 다른 사용자에게 보이는 활성 양식·discovery cache에 포함하지 않는다.

생성 경로는 Core의 공식 첨부·소유권·revision 관리와 AI Service의 형식별 MCP 실행을 연결한다. HWP는 Core hwplib의 구조 검사·범위 편집·재열기, HWPX는 Hangeul 파일 모드, PDF는 MCP 정리 후 PDFBox AcroForm 처리이며, 기존 필드의 짧은 위젯은 최소 8pt 가독성을 유지하는 범위에서 크기를 맞추고 불가능하면 `OVERFLOW`로 거절한다. AcroForm은 모델이 선택한 field binding을 최소 편집 scope로 사용하고 저장 binding의 `set_field` 계획을 코드가 생성한다. Core는 원본의 유일한 display/export 대응 또는 위젯 caption으로 사용자 선택값을 native 값에 연결한다. 라디오 export label이 중복되면 원본 위젯 순서의 인덱스를 native 값으로 쓰며, 화면 문구와 인덱스의 대응 근거가 없으면 `APPLICATION_DOCUMENT_UNRESOLVED_OPTION`으로 중단한다. AI는 HWP의 hwpTargets를 받아 지도와 계획만 반환하며 Core가 원본·plan hash·revision·bindings/scope를 독립 검증한다. HWP에 Windows·한컴 한글·브리지 설정이 필요하지 않다. 과거 직접 HWPX 편집 경로는 현재 생성에서 사용하지 않는다. 부분 초안 정책 식별자를 포함한 새 fingerprint로 과거 생성 결과와 구분하고 다운로드 이력을 보존한다. 구현 범위와 미지원 구조·검증 상태는 [MCP 구조](../../docs/application-document-mcp-architecture.md), [설치](../../docs/application-document-mcp-setup.md), [검증 기록](../../docs/application-document-mcp-validation.md)를 확인한다.


### XLSX 신청 문서

XLSX 경로는 `공식 첨부 Client → Core ZIP/XML 문항 추출 → AI XlsxDocumentAdapter inspect → DocumentMap → OpenAI Mapping → WritePlan → native 셀 값 작성 → 재열기·보존 검증 → Core 저장·다운로드`입니다.
`.xlsx`만 지원하고 XLS/XLSM/ODS/CSV는 포함하지 않습니다. 공개 문항·Fact·binding·WritePlan DTO는 기존 계약을 재사용합니다. 별도 사용자 파일 업로드 API는 추가하지 않으며 공식 첨부 수집 경로의 확장자와 문서 실제 OOXML content type을 검사합니다.

AI의 `openpyxl==3.1.5`는 셀 타입·수식·병합·검증 규칙을 읽고 새 값을 직렬화합니다. 작성 대상 셀의 직렬화된 값만 원본 worksheet XML에 반영하며 다른 ZIP 파트는 바이트 그대로 보존합니다. 원본을 덮어쓰거나 행·열·시트 구조를 바꾸지 않습니다.
표시값은 Excel 렌더 결과가 아닌 raw 문자열이고 `numberFormat`을 함께 보존합니다. General 셀과 사업자번호·연락처·우편번호는 문자열로 작성합니다. 명시적인 숫자 형식은 유효한 15자리 이내 숫자, 날짜 형식은 ISO 날짜/시각, 비율 형식은 % 값만 받으며 불명확한 단위 변환을 하지 않습니다.

공통 `pipelineVersion`·`mapVersion`과 기존 4포맷 엔진은 유지합니다. `xlsx=govbiz/xlsx-native@2+openpyxl-3.1.5`만 지도와 생성 fingerprint에 반영합니다. 엔진 변경 시 XLSX만 재매핑하고 binding/scope 변경은 기존 migration 확인 경로를 사용합니다.
Core는 재열기·XML·스타일·수식·data validation·원본 파트 보존 증명이 통과한 XLSX만 저장하고 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` 및 `_초안_v{revision}.xlsx`로 다운로드합니다.

Frontend - Web: XLSX 목록 응답의 확장자·MIME 검증 및 인증된 native 다운로드를 지원합니다.
Frontend - Mobile: 변경 없음.

신청 문서 경계에서 MCP Client는 `ApplicationDocumentMcpException`만 던지고 실제 호출 Service가
`ApplicationDocumentException`으로 변환한다. 승인안은 Domain 업무 모델이며, 승인 Repository는
새 formVersionId 또는 stale을 뜻하는 null을 반환한다. 스냅샷 저장 뒤 stale이 발생하면 같은
transaction의 쓰기를 rollback한다. Service의 승인 결과·변경 안내는 `service/dto`로 전달하고
Controller와 ExceptionHandler가 기존 공개 응답·ProblemDetail로 변환한다.

공고별 양식 가용성의 `findActive`는 nullable 업무 모델을 반환하고, `ApplicationFormService`가
기존 미지원 예외로 변환한다. 명시적 재분석의 `claimRequested`는 획득·행 없음·충돌 결과를
반환하며, `ApplicationFormDiscoveryService`가 충돌을 기존 JOB_CONFLICT로 변환한다.
Repository의 행 잠금·실행권 갱신 transaction과 공개 오류 계약은 유지한다.

### 신청 문항 상위 매핑

`ApplicationFormManifest.fieldMappings(snapshot)`은 공식 `sectionKey:fieldKey` 문항과 FILE binding에서
`ApplicationFieldMapping`을 계산한다. `ApplicationDocumentService`는 이 업무 projection의 writable로
기입/미기입 답변을 분리하며 필수 binding 누락도 생성을 중단하지 않고 `INPUT_LOCATION_NOT_FOUND` 미기입 답변으로 알린다.
HWP·PDF는 AI 요청 전에 `ApplicationDocumentEditor.writableText`로 붙여 넣은 공백·탭·CR·서식 문자만 정리하고,
`unsupportedCharacterFactIds`가 그 형식에 쓸 수 없는 문자(HWP: hwplib이 깨뜨리는 보조 평면 문자·제어 문자, PDF: 입력란 글꼴
나눔고딕에 없는 한자·이모지·㈜·①·㎡ 등)가 남은 답을 골라 AI 요청에서 빼고 `UNSUPPORTED_CHARACTER`로 알립니다. 이 답 하나 때문에
문서 전체가 실패하지 않으며, 모든 답이 해당하면 매핑 AI 호출 전에 `APPLICATION_DOCUMENT_NO_WRITABLE_INPUT`으로 이유를 알립니다.
AI Service가 칸 규칙·넘침 검사로 남긴 답(`skippedFacts`)과 PDF 상자에 들어가지 않아 `fillPdfFitting`이 뺀 답은 나머지 답으로 만든
초안과 함께 미기입 답변(`reason`: `OVERFLOW`·`AMBIGUOUS_SLOT`·`SLOT_MISMATCH`·`UNSUPPORTED_CHARACTER`·`INPUT_LOCATION_NOT_FOUND`, 넘침이면 `capacity`)으로
저장·응답하고, HWP는 `applyHwpPlan`이 계획의 `skippedFacts`·`literal`을 함께 검증합니다. AI Service가 답이 없는 표·칸에 남긴
작성 예시의 칸 수(`remainingExampleCount`, 0..3000)는 파일 메타데이터 `answerSummary`에 저장해 문서 목록 응답으로 돌려주며, 이전 초안은 0입니다.
label/required/status와 targetId/box 참조만 전달하며 raw native 지도·버전·scope는 복제하거나 저장하지 않는다.
`DocumentMap`은 FILE native map이고 상위 업무 mapping과 동일한 계약이 아니다. FILE write authority는 기존
DocumentMap/bindings/scope/WritePlan에 있으며 이관 비교·승인 흐름과 DB 스키마는 유지한다.
ONLINE_FORM은 별도 FormMap의 읽기 전용 Service 검토 경로이며 외부 API·자동 제출은 없다.
[상위/파일 경계](../../docs/architecture.md#phase-5-1-신청-문항-상위-매핑-경계)와
[Phase 5 평가 기록](../../evaluation/application-map/runs/phase5-application-mapping-20260927-v1/README.md)을 참고한다.

## Phase 5-2: ONLINE_FORM 매핑 계약과 작성 능력

FILE의 DocumentMap과 ONLINE_FORM의 ApplicationOnlineFormMap은 서로 다른 계약이다.
공유하는 ApplicationFieldMapping은 공식 문항 identity, label, required, mapping 상태와 binding 참조를 투영한다.
mapped는 MAPPED 상태와 binding 존재, autoFillSupported는 현재 FILE 실행 경로의 지원 여부,
writable은 mapped && autoFillSupported다. MAPPED와 WRITABLE은 동일하지 않다.
FILE은 기존 targetId/box와 복수 binding을 유지하고 DocumentMap → bindings/scope → WritePlan →
native editor → verification의 권한 경계를 변경하지 않는다.

ApplicationOnlineFormMap(schemaVersion=1, formId, controls)은 확인된 fieldId/controlId/label/required만 담는다.
Phase 5-2의 Manifest + FormMap → ApplicationFieldMapping domain projection은 Phase 5-3에서 읽기 전용 Service에 연결했다. HTTP에는 노출하지 않는다.
공식 문항 순서·표시명·required는 Manifest를 따른다. 알 수 없는 fieldId, required 충돌, 빈 controlId,
중복 controlId 및 한 문항의 복수 control은 명시적으로 거절한다. 복수 control의 분할·선택·반복 의미는
확인되지 않았으므로 검토 후 후속 단계에서 결정한다. 누락된 필수 문항은 REQUIRED_MAPPING_MISSING,
선택 문항은 UNMAPPED다. ONLINE_FORM binding은 sourceType=ONLINE_FORM, referenceId=controlId, box=null이며
기존 FILE 호출 호환을 위해 저장 property 이름 targetId를 유지한다.

ONLINE_FORM은 source 기반 매핑 검토까지 구현됐으며 mapped=true여도 autoFillSupported=false, writable=false다.
실제 자동 작성·제출, 외부 Form API/OAuth, DOM/브라우저 자동화, persistence, DB migration,
public endpoint 및 document MCP format 확장은 없다. 사용자 Fact 값이나 사용자 검토 완료를 mapping 성공으로
추정하지 않는다. ApplicationDocumentService는 기존 FILE projection만 사용한다.
평가 fixture와 검증 범위는 [Phase 5-2 평가 보고서](../../evaluation/application-map/runs/phase5-online-form-map-20260927-v1/README.md)를 참고한다.

## Phase 5-3: ONLINE_FORM Source와 읽기 전용 검토

`ApplicationPreparationService.reviewOnlineFormMapping(account, preparationId, source)`는
`repository.findOwned(account.id, preparationId)`로 소유권을 확인하고 preparation의 고정
formVersionId에 해당하는 Manifest를 조회한다. 없는 preparation과 다른 계정의 preparation은
기존 ApplicationPreparationNotFoundException으로 처리하며 Manifest 조회도 수행하지 않는다.

흐름은 `ApplicationOnlineFormSource → Manifest.reviewOnlineForm → ApplicationOnlineFormMap
→ manifest.fieldMappings(formMap) → ApplicationOnlineFormMappingReviewResult`다.
Source는 schemaVersion=1, formId, formTitle, controls[{controlId, label, required}]만 소유한다.
중복 controlId, 빈 identity/label과 미지원 schema는 거절한다. DOM·locator·인증 정보는 없다.

매칭은 앞뒤 공백 제거 및 연속 whitespace(줄바꿈·탭 포함)를 한 칸으로 치환한 label의 정확한
일치만 사용한다. case·숫자·괄호·단어를 제거하거나 fuzzy/LLM 매칭하지 않는다.
Manifest와 source 양쪽에서 label이 유일하고 required가 동일해야 confirmed control이 된다.
동일 label의 복수 source 또는 Manifest 문항은 AMBIGUOUS_CONTROL, 필수 여부 충돌은
REQUIRED_FLAG_MISMATCH로 검토하며 FormMap에 넣지 않는다.
필수 문항의 후보가 없으면 REQUIRED_CONTROL_NOT_FOUND와 REQUIRED_MAPPING_MISSING,
선택 문항의 후보가 없으면 issue 없이 UNMAPPED다. Manifest label과 무관한 source control은
UNMATCHED_SOURCE_CONTROL로 표시하며 다른 정상 매핑은 유지한다.

Service Result는 source formId/formTitle, 기존 fieldMappings, 최소 issue context만 반환한다.
mappedCount는 매핑 문항 수, unmappedCount는 필수 누락을 포함한 미매핑 문항 수,
requiredMissingCount는 REQUIRED_MAPPING_MISSING 문항 수, reviewRequiredCount는 issue 수다.
충돌 후보는 해당 issue로 표시하고 unmatched로 중복 집계하지 않는다.
confirmed ONLINE_FORM도 mapped=true, autoFillSupported=false, writable=false다.
DB write·revision/Fact/snapshot 변경·schema/Flyway 변경은 없다.
외부 source collector, public HTTP, persistence, browser automation, auto fill, submit은 아직 없다.
기존 FILE DocumentMap/NativeTarget/WritePlan 및 5-format 실행 경로, AI/MCP 계약은 유지한다.

검증 범위와 결과는 [Phase 5-3 평가 보고서](../../evaluation/application-map/runs/phase5-online-form-source-review-20260927-v1/README.md)를 참고한다.

## Phase 5-4: ONLINE_FORM 외부 소스 접근 능력

도입 이전 판정은 PHASE5_EXTERNAL_SOURCE_PARTIAL이었으며 당시 지원 provider/collector는 없었다.
ApplicationOnlineFormSourceReference는 sourceUrl과 provider 문자열만 가진다.
HTTPS·host·길이·provider 형식을 검증하고 userinfo·명시적 port·fragment를 거절한다.
URL과 query는 toString 및 validation 오류에서 숨긴다. 이 검증은 SSRF 안전 판정이 아니다.

ApplicationPreparationService.checkOnlineFormSourceCapability는
findOwned → 고정 Manifest 조회 → provider/URL 계약 확인 → Capability Result로 이어진다.
이전에는 GOOGLE_FORMS의 edit/viewform 및 forms.gle 참조를 모두 REQUIRES_AUTH로 판정했다.
현재는 공개 responder viewform과 forms.gle short URL을 PUBLIC_READ_SUPPORTED 후보로,
edit URL을 REQUIRES_AUTH로, 나머지를 UNSUPPORTED_PROVIDER로 분류한다.
이 판정에는 외부 I/O가 없으므로 실제 공개 여부와 redirect destination은 inspection에서 확인한다.
responder ID를 공식 API formId로 추측하지 않는다.

Google forms.get은 OAuth scope와 접근 가능한 formId가 필요하다.
현재 Google 로그인은 openid email이며 Forms body scope, token 보관·갱신·소유권 연결이 없다.
응답자 URL만으로 공식 API 읽기 권한을 가정하지 않는다. 일반 HTML은 표준 form 계약이 있으나
이 프로젝트의 concrete target이 없어 generic scraper를 구현하지 않는다.
Capability check에는 외부 HTTP/DNS/redirect 요청이 없다. 별도 public reader의 SSRF·redirect·timeout·응답 크기 제한은 아래 읽기 경로에 적용한다.

기존 reviewOnlineFormMapping(account, preparationId, source)는 그대로 유지한다.
당시에는 외부 참조에서 Source로 이어지는 성공 경로가 없었다. DB write·Fact/revision/snapshot 변경,
public HTTP API·Frontend·자동 입력·제출·응답 조회·FILE/DB schema 변경은 없다.

[Phase 5-4 평가 기록](../../evaluation/application-map/runs/phase5-online-form-source-acquisition-20260928-v1/README.md)을 참고한다.

## Phase 5-5: Google Forms read/prefill Decision Gate

Google 로그인은 `openid email`만 요청하며 Forms 연결 endpoint는 아직 없다.
공식 read `forms.get`은 `forms.body.readonly`를 사용할 수 있다. 공식 Apps Script prefill에는
별도 `forms` scope, 동일 standard Cloud 프로젝트의 API executable 배포와 사용자 실행 권한이 필요하다.
현재 이 배포와 안전한 단기 token lifecycle 및 실제 smoke 대상이 확인되지 않아
Forms OAuth/collector/helper/client는 NOT_IMPLEMENTED다. 기존 Redis AOF나 서명 쿠키에
access token을 추가하지 않았으며 DB schema와 로그인 계약도 유지했다.

판정: PHASE5_GOOGLE_FORMS_PREFILL_BLOCKED. A/B/C 실제 read/prefill은 NOT_RUN,
public responder-only 권한은 UNKNOWN_NOT_VERIFIED다. Phase 5는 아직 종료하지 않는다.
자동 제출·비공식 파싱·entry ID 조립은 구현하지 않는다.
공식 근거와 재개 조건, 실제 검증 결과는
[Phase 5-5 평가 기록](../../evaluation/application-map/runs/phase5-google-forms-prefill-20260928-v1/README.md)에 기록한다.


## Phase 6-1: 저장 답변 입력 안내와 TXT 내보내기

`GET /api/v1/application-preparations/{id}/online-input-guide`는 세션 계정의 소유권을 확인한 뒤
고정 Manifest와 `listOwnedFacts()`의 현재 Fact만 읽는다. 호출은 Controller → ApplicationPreparationService
→ Preparation/Form/Input Repository이며 AI·MCP·외부 HTTP·DB 쓰기를 수행하지 않는다.
공개 DTO는 controller/dto, 내부 projection은 service/dto에 둔다.

기존 답변 입력 화면에 입력 안내와 개별·전체 저장 답변 복사, UTF-8 TXT 다운로드를 제공한다.
웹은 이 칸을 평소 숨기고, 초안 실패 카드의 [답변 모아 보기](`?helper=open`)로 들어올 때만 펼쳐 보여 준다.
현재 ONLINE_FORM Source/Map은 저장되지 않고 Manifest에는 외부 입력 타입이 없다.
FILE binding을 온라인 binding으로 취급하지 않으며 `inputMode=UNKNOWN`, `externalMappingVerified=false`다.
유효한 PROVIDED 답변은 READY/copyable=true, 값 없음/UNKNOWN은 MISSING, 공식 선택지 불일치는 NEEDS_REVIEW다.
READY는 복사 가능한 확정 답변 수이며 외부 control mapping 완료를 뜻하지 않는다.
DIRECT_INPUT은 신뢰할 타입 정보로 복사만으로 처리할 수 없음이 확인된 경우에만 사용하며 현재 projection에서는 생성하지 않는다.

사용자가 요청한 TXT 내보내기와 저장 답변 복사는 별도의 `savedAnswers`를 사용한다.
Manifest 순서의 PROVIDED Fact 중 공식 선택지와 일치하는 값만 포함하고 UNKNOWN·미응답·선택지 불일치는 제외한다.
이 텍스트를 외부 신청 화면에 그대로 제출해도 된다는 의미는 아니다. 직접 입력·선택·업로드와 최종 확인이 필요하다.
`sourceUrl`은 공고 원문이므로 신청처 URL로 대신 사용하지 않는다. 현재 officialApplicationUrl은 null이다.
웹 계약은 반환된 링크에 http/https만 허용한다. 기존 FILE 5포맷과 ONLINE_FORM 계약, DB schema는 유지한다.


공개 Google Form 질문 조회는 `skn-31`의 내부 읽기 전용 경로이며, 구글 설문 답변 미리 채우기(`GET /api/v1/application-preparations/google-form`)도 같은 reader를 씁니다. 별도 단기 stdio MCP를 사용하며 `DOCUMENT_INTERNAL_TOKEN`으로 Core ↔ AI 인증을 재사용합니다. 자세한 경계와 제한은 [아키텍처 문서](../../docs/architecture.md)를 참고합니다. `PUBLIC_READ_SUPPORTED`는 공개 reader 시도 대상이라는 사전 판정이며 실제 공개 Form 여부는 inspection 결과로 확인합니다. `/edit` URL은 `REQUIRES_AUTH`입니다.
