# GovBiz AI Service

FastAPI, OpenAI 임베딩, Qdrant로 전체 공고에서 관련 후보를 찾고 LangChain으로 후보를
점수화하고 원문 근거 답변을 생성하는 내부 RAG 서비스입니다. 브라우저에 직접 공개하지 않고 Spring Core API만 호출합니다.

## 관리자 Gov 에이전트 경로 선택

`POST /internal/v1/gov-agent/decide`는 `GovAgentSupervisor → 기존 LangChain 호출 → OpenAI → strict action 검증`으로
`SEARCH`, `EVIDENCE`, `APPLICATION`, `COMBINATION_REVIEW`, `PARTNERS`, `UNSUPPORTED` 중 하나를 반환합니다. 실제 검색 조건 해석·원문 RAG는 Core의 기존 Service가 실행합니다.
`APPLICATION`은 선택 공고의 신청 준비 화면을 대화 안에 연결하는 경로입니다. 양식 분석·준비 건 생성은 사용자의 버튼 실행 뒤 기존 API가 처리하며,
supervisor가 직접 신청서·작업을 생성하지 않습니다. 제출 서류에 관한 원문 질문은 `EVIDENCE`, 기관 제출·삭제·일괄 실행은 `UNSUPPORTED`입니다.
`COMBINATION_REVIEW`는 두 공고의 동시 지원·수혜 검토 입력 화면을 연결하며, 선택 공고 없이도 분류합니다. 사용자가 두 공고와 상황을 확인하고 실행해야 기존 검토 API가 분석을 접수합니다.
`PARTNERS`이면 같은 응답의 `partnerConditions`에 사용자가 이번 말에서 직접 밝힌 찾는 역할·지역(17개 짧은 시·도 이름)·분야 말(최대 3개)·"이 공고" 근거를 담고, 다른 경로에서는 null입니다(추가 호출 없음). 각 값의 근거 문구는 Core가 원문과 다시 대조하고, 모집글 추천은 Core가 AI 없이 계산합니다. 제안 발송·모집글 작성은 실행하지 않습니다.
현재 메시지의 작업 의도를 이전 검색어·보류 질문보다 우선합니다. 공고 미선택은 검색으로 전환할 이유가 아니며,
신청 준비 요청은 `APPLICATION`으로 분류한 뒤 Core가 공고 선택을 안내합니다. 검색 질문에 대한 짧은 답변에는 기존 검색 문맥을 사용합니다.
한 턴에 한 기능을 위임하는 초기 supervisor이며 A2A, 새 프레임워크, 자유로운 도구 호출 루프는 추가하지 않습니다.
기존 `OPENAI_ASSISTANT_MODEL`과 `OPENAI_ASSISTANT_REASONING_EFFORT`(기본 `low`)를 사용하고,
한 번의 모델 호출·추론 포함 출력 1,200토큰·최대 20초·재시도 없음·`store=false`를 적용합니다.
선택 여부와 검색 문맥만 받고 사용자 계정·역할·공고 원문·도구 주소는 받지 않습니다.
잘못된 action은 503, 시간 초과는 504로 반환하며 검색 성공으로 대체하지 않습니다.
내부 API는 Core에서만 호출하며 공개 API의 관리자 권한·사용량·복합 식별자·인용 검증은 Core가 소유합니다.

## AI 대화 검색·상세 질의응답의 LangChain RAG

- 조건 해석: Core → Conversation Service → Agent → LangChain 프롬프트 체인 → OpenAI Responses API → 조건 패치 검증.
- 공고 추천: 질문 임베딩 → Qdrant 후보 검색 + Elasticsearch 어휘 검색 → Core RRF 병합·현재 공고 검증 → Ranking Service → Agent → LangChain → OpenAI → 후보별 자격·인용 검증.
- 상세 질의응답: 질문 임베딩 → Qdrant 원문 청크 검색 → Core의 ID·내용 해시·문서 검증 및 text 복원 → Answer Service → Agent → LangChain → OpenAI → 인용 번호를 원래 청크 ID로 복원·검증.

세 Agent는 `support_program_llm.py`의 `ChatPromptTemplate | ChatOpenAI.bind(...)` 체인을 비동기로 실행합니다.
추천과 상세 답변은 검색된 공식 공고/청크를 프롬프트의 근거로 사용하며, 조건 해석은 검색 전에 실행하는 별도 단계입니다.
검색과 생성 사이의 Core 검증 경계를 유지하므로 Qdrant를 생성 Agent가 다시 조회하지 않습니다.
Qdrant 클라이언트·OpenAI 임베딩의 원시 응답 검증, 컬렉션 이름과 현재 버전 필터는 그대로이며 데이터 재색인이 필요 없습니다.

기존 `langchain-core`·`langchain-openai` 의존성을 사용합니다. 요청별 strict JSON Schema를 지정하고,
완료 상태와 전체 응답 JSON을 Pydantic strict 모드로 검증합니다. 잘린 JSON을 복구하거나 문자열 인용 번호를 숫자로 바꾸지 않습니다.
모델별 설정·토큰 상한·타임아웃·`store=false`·재시도 없음은 유지하고 LangSmith 추적도 비활성화합니다.
후보 수·점수 기준·기업 조건·HTTP 계약은 변경하지 않습니다.

구현 API는 [LangChain ChatOpenAI 문서](https://docs.langchain.com/oss/python/integrations/chat/openai)를 참고합니다.

프로젝트 전체 기술 구성은 [기술 문서](../../docs/technology.md), 기능별 완료 범위와 남은 작업은
[구현 현황](../../docs/implementation-status.md)을 참고하세요. 이 문서는 AI Service 실행·설정·내부 처리 규칙을 다룹니다.
모듈의 책임과 객체 조립은 [아키텍처 README](../../docs/architecture/README.md#ai-service-기능별-모듈과-객체-조립)에 정리했습니다.

## 책임

중복 지원 검토는 `app/combination_review`의 `Router → Service → 구체 Agent → LangChain ChatOpenAI → OpenAI Responses API → 검증된 응답` 경로를 사용합니다.
기존 `OPENAI_MODEL`과 중복 검토 전용 `60s` 모델·`70s` 실행 제한을 사용합니다. 도구·handoff·LangGraph 없이 strict structured output 한 번을 요청하며
재시도 없음, 출력 최대 6,000 tokens, `store=False`, LangSmith tracing 비활성화를 적용합니다.
Agent 안에서 API 전송 스키마의 판별 union을 `anyOf`로 변환하고 기존 Pydantic 출력 검증을 유지합니다.
거절·미완료 응답·파싱 실패는 503, 모델·전체 실행 시간 초과는 504로 반환합니다. Service의 업무 검증과 Core HTTP 계약은 유지합니다.
입력은 최대 512블록·120,000자이며 이미지에 이미 포함된 cl100k_base로 계산한 JSON 입력이 100,000 tokens를 넘으면 거절합니다.
모델 컨텍스트에 맞추려고 본문·각주·붙임을 조용히 잘라내지 않습니다. 이 경로는 임베딩/Qdrant를 사용하지 않습니다.
원문은 글머리·번호 항목 단위의 정확한 인용 선택지(800자 이하, 더 긴 항목은 줄바꿈·공백에서 나눔)로 나누고 모델은 선택지 번호만
반환합니다. 선택지마다 가장 가까운 상위 제목을 `heading`으로 함께 보내지만 맥락용이며 인용문에는 넣지 않습니다. 선택지가
2,048개를 넘으면 모델 호출 전에 `CONTEXT_TOO_LARGE`로 거절합니다. 근거 ID와 인용문은 코드가 원문에서
복원하므로 모델이 공백·문장부호를 바꾼 인용을 생성하지 않습니다. 다른 사업쌍의 선택지, 범위 밖 번호, 사업쌍 누락·단계 중복,
기관 확인이 필요한 확정 판단은 기술 오류로 거절합니다.
같은 `analyze` 경로는 요청의 `contractVersion`으로 여섯 단계를 판단하는 `combination-review-v2`와 세 질문(APPLY 신청,
CONCURRENT 동시 수행, SAME_SUBJECT 같은 과제·비용)에 다섯 판정(ALLOWED·CONDITIONAL·NOT_ALLOWED·NO_RULE·ASK_INSTITUTION)으로
답하는 `combination-review-v3`를 함께 받습니다. v3는 사업별 상태(NOT_APPLIED·APPLIED·ACTIVE·FINISHED, 모르면 UNKNOWN)와 두 사업 관계(sameProject·sameCost)를
선택 입력으로 받고, 프롬프트와 버전 hash가 v2와 다르며 `GET .../configuration?contractVersion=combination-review-v3`로 조회합니다(쿼리가 없으면 v2).
질문 누락·중복·순서 오류, 판정별 인용·조건 규칙 위반, 인용 없는 조건부 답·조치는 같은 503 기술 오류입니다.
Core가 새 실행의 기본 계약을 v3로 바꾼 뒤 v2 분석 경로를 지웁니다.
구조화 출력의 형태 준수와 실제 판단 품질은 다르며 [공식 안내](https://developers.openai.com/api/docs/guides/structured-outputs)를 참고합니다.
[실행·원문 관리 계약](../../docs/duplicate-support-review-design.md)과 [무료 검증](../../evaluation/combination-review/README.md)에 범위를 정리했습니다.

신청 문서 기능은 `app/application_preparation`에서 양식 발견·입력 해석·초안 작성·원본 문서 배치를 수행합니다.
호출 흐름은 `Router → Service → ApplicationPreparationAgent → LangChain ChatOpenAI → OpenAI Responses API`입니다.
각 호출은 strict JSON Schema로 결과를 검증하고, 응답 거절·불완전 응답·파싱 실패를 오류로 처리합니다.
기존 토큰 한도(해석 2,500, 발견·초안 5,000, 배치 10,000)와 모델·실행 시간 제한을 유지하며 자동 재시도·응답 저장·LangSmith 추적을 비활성화합니다.
양식 발견 Agent는 Core가 공식 PDF/HWP/HWPX에서 추출한 위치 포함 블록만 받아 작성 대상 문서와 문항을 제안하고, 모든 필드는
허용된 블록의 정확한 원문 인용을 가져야 합니다. 모델이 원문의 줄바꿈을 공백으로 표현한 경우에만 실제 원문 구간으로
정규화하며, 같은 문서·문항 식별자가 반복되면 데이터 손실 없이 안전한 고유 키로 바꿉니다. 입력 해석 Agent는 선택된 문항 필드와 현재 사용자 확인 사실, 이번 답변만
전달받으며 두 Agent 모두 Qdrant나 외부 원문을 직접 조회하지 않습니다. 입력 해석 Agent는 이번 답변의
정확한 부분 문자열을 근거로 `PROVIDED` 또는 명시적인 `UNKNOWN` 제안과 다음 질문을 반환합니다. Service는 허용 필드,
중복, 정확 인용, 필수 미입력 순서를 검증하며 제안을 사용자 확인 사실로 표시하거나 저장하지 않습니다.

`POST /internal/v1/application-preparations/draft`는 `application-preparation-draft-v1` 계약의 공식 문항·작성 안내와
사용자가 확인한 사실만 받아 문항 초안을 생성합니다. 필수 필드의 미입력은 422로 거절하며, 명시적으로 확인한 UNKNOWN은 허용합니다.
`GET /internal/v1/application-preparations/draft/configuration`으로 모델·프롬프트 hash를 조회합니다. 초안 Agent는
기존 모델·실행 제한을 사용하고 `max_turns=1`, 출력 5,000 tokens, `store=False`, tracing 비활성화와 도구 없음으로 실행합니다.
모든 PROVIDED 필드가 `usedFieldKeys`에 한 번씩 들어있는지 검증하고 UNKNOWN은 Service가 `항목명: 미정`으로 덧붙입니다.
응답은 문안·사용 사실 키·입력 식별자·모델·프롬프트 hash이며 실패는 503, 시간 초과는 504입니다.
필드 참조 검증은 문장의 사실 정확성 보장이 아니며 실제 문안 품질은 별도의 사용자 검토가 필요합니다.

AI Service가 하는 일:

- 사용자의 자연어 질문과 Core가 검증한 공고 후보를 함께 읽음
- Core가 보낸 공고 검색 문서를 OpenAI로 임베딩하고 Qdrant에 색인
- 현재 MySQL 공고 ID·내용 해시 목록 안에서 의미가 가까운 후보를 최대 20개 검색
- 버전된 검색 관련도 100점 기준으로 모든 후보를 점수화하고 자격 판정은 별도로 표시
- 지원대상·지역의 명백한 자격 불일치를 제외하고 의미 관련성 최소 기준을 통과한 공고만 0~5개로 반환
- AI가 자격 판정·관련도 항목·추천 이유를 strict structured output으로 생성하고 Service가 관련도를 정규화해 반환
- Core가 준비한 공고 상세 원문 청크를 별도 Qdrant collection에 색인하고, 지정된 현재 청크 안에서 근거를 최대 5개 검색
- 검색된 공고 상세 근거만 사용해 한국어 답변과 인용 청크 ID를 strict structured output으로 반환
- 새 메시지와 작은 검색 상태를 해석해 사용자 확인 전 조건 변경 패치 또는 확인 질문을 반환
- 도우미 자유 질문을 여섯 의도 중 하나로 분류하고, 사용법 답은 Core가 보낸 도움말 항목만 인용해 반환 (`govbiz-assistant-v1`)
- 도우미 도구 에이전트: 분류 뒤 자료가 필요한 의도(모집글 매칭·내 상태·관심 공고)는 LangGraph로 Core 내부 도구를 최대 3회 부르고 답·카드를 반환 (`govbiz-assistant-agent-v1`)
- Core가 보낸 정확히 2개 사업의 전체 근거·참여 사실을 단일 Agent로 대조하고 한 사업쌍의 여섯 단계 판단·질문·정확한 인용을 반환 (`combination-review-v2`)
  또는 세 질문의 판정·확인할 조건·걸리면 생기는 일·정확한 인용을 반환 (`combination-review-v3`)

AI Service가 하지 않는 일:

- 기업마당 API 호출 또는 MySQL 원본 공고 저장
- 접수 상태 계산과 공식 URL 검증
- 존재하지 않는 공고 추가
- 최종 HTTP 공개 DTO 조립
- 점수 결과 영속화
- 공고 상세 페이지 수집, HTML 정제, 청크 분할 또는 상세 원문 영속화

## 내부 API

```http
GET /internal/v1/health
GET /internal/v1/combination-reviews/configuration
POST /internal/v1/combination-reviews/analyze
GET /internal/v1/application-preparations/configuration
POST /internal/v1/application-preparations/interpret
GET /internal/v1/application-preparations/discovery/configuration
POST /internal/v1/application-preparations/discovery
POST /internal/v1/support-program-rankings/rank
PUT /internal/v1/support-program-index/batch
POST /internal/v1/support-program-index/prune
POST /internal/v1/support-program-index/search
PUT /internal/v1/support-program-evidence/chunks
POST /internal/v1/support-program-evidence/search
POST /internal/v1/support-program-evidence/answers
POST /internal/v1/support-program-conversation/interpret
POST /internal/v1/assistant/answers
POST /internal/v1/assistant/agent
```

점수화 요청은 최대 20개 후보와 상위 결과 개수 1~5개를 받습니다. 응답 `rankings`는 적격 공고가
없을 수 있으므로 0개부터 `resultLimit`개까지입니다. 계약 예시는
[지원사업 검색·추천 HTTP 계약](../../docs/support-program-search-contract.md)에 있습니다.

점수화 요청에는 선택적으로 `companyConditions`를 포함할 수 있습니다.
선택 foundedYear는 등록 기업의 설립연도(1900~referenceDate의 연도)를 보존하며 establishedOn과 동시에 지정할 수 없습니다.
연도 전체가 공고의 명확한 업력 요건을 충족하면 판단에 활용하고, 경계에 걸릴 때만 정확한 설립일이 필요합니다.
판정 설명은 확인된 사용자 조건과 남은 필수 요건을 구분하며, 본문에 없는 조건이나 우대 사항을 필수로 추가하지 않습니다.
`region`(현재 소재지, 최대 50자), `industry`(업종, 최대 100자), `establishedOn`(설립일),
`supportPurpose`(지원 목적, 최대 100자)는 생략·null을 허용합니다. 텍스트는 제어문자를 원본에서 먼저
거부하고 앞뒤 공백 제거 후 빈 값은 null입니다. 설립일은 빈 문자열·ASCII 공백뿐인 값만 null이며,
탭·줄바꿈·NBSP와 입력된 날짜 주변의 공백은 허용하지 않습니다. 조건 객체가 있으면 Core가 서울 기준으로 정한 `referenceDate`가 필수입니다.
날짜는 실제 존재하는 `YYYY-MM-DD`이며 설립일은 `1900-01-01`부터 `referenceDate`까지입니다. AI Service는 Core 기준일을
자체 현재 날짜로 바꾸지 않습니다.

회사 조건이 있는 요청에만 기존 Agent의 지침을 보완해 같은 한 번의 모델 호출로 평가합니다.
명시적 적용 조건이 `originalQuery`와 충돌하면 조건을 우선하며, null·미입력은 확인 안 됨이지
자격 충족이 아닙니다. 현재 소재지를 이전 예정지로 추정하거나 설립일만으로 공고별 업력 기준일·예외를
확정하지 않습니다. 조건이 없거나 `companyConditions: null`이면 Agent 입력에서 필드를 생략하고
회사 조건 전용 프롬프트를 추가하지 않습니다. 원문 우선 자격 검증은 회사 조건 유무와 관계없이 적용하며,
v5에서는 자격 확인 여부와 검색 관련도 점수를 분리합니다.

Health 응답은 프로세스의 HTTP 응답 여부만 확인합니다. OpenAI 모델 호출 성공이나 Qdrant 연결·색인
완료 여부를 검사하는 readiness 검사는 아닙니다. `/internal` 경로 자체에 인증 기능은 없으며,
기본 Compose에서는 AI Service 포트를 호스트에 공개하지 않습니다.

## 확인 전 조건 변경 해석 (C02)

`POST /internal/v1/support-program-conversation/interpret`는
`govbiz-support-program-conversation-v1` 계약을 사용합니다.
입력은 `schemaVersion`, `message`, `context`, 선택적 `pendingClarification`/`pendingProposal`/`lastSearch`,
Core 서울 날짜 `referenceDate`입니다. pendingClarification과 pendingProposal은 동시에 보낼 수 없습니다.
lastSearch는 최근 성공 검색의 context와 0 이상의 엄격한 정수 resultCount이며 결과 설명에만 참고합니다.
context의 query·acceptingOnly·companyConditions 및 기존 네 조건 필드는 모두 필수이고 미입력은 null입니다.
foundedYear는 이전 클라이언트와 호환되는 선택 정수입니다. 등록 기업에서 읽은 연도는 보존하고 월·일을 만들어내지 않습니다.
명시된 연도는 FOUNDED_YEAR SET으로 변경하며, ESTABLISHED_ON과 FOUNDED_YEAR 중 하나를 설정·해제하면 다른 정밀도 값은 제거합니다.
updates의 최대 개수는 7개이고 연도 SET도 현재 메시지의 정확한 연도 인용과 범위를 검증합니다.
응답은 `schemaVersion`, `status`, `updates`, `clarificationQuestion`, `answer`이며 전체 상태를 재작성하지 않습니다.
CLARIFICATION_REQUIRED에는 질문을 고른 종류 코드 `clarificationKind`(모델 출력의 7개 코드 그대로)를 더하고, 다른 상태에서는
이 키를 내지 않습니다. 화면은 이 코드로 질문에 맞는 빠른 답변을 고르며 문구는 계속 Service가 정합니다.
ANSWERED는 비어 있지 않은 answer와 빈 updates, null 질문을 반환합니다. 다른 상태에서는 answer가 null입니다.
모델 내부 출력은 자유 문장 대신 `answerKind`·`clarificationKind` 코드만 사용합니다. Service가 허용된 존댓말 안내와
확인 질문을 작성하며, 검색 건수는 요청의 엄격하게 검증된 정수만 반영합니다. 사용자 입력·모델 문장·미확정 조건을
안내 문구에 삽입하지 않습니다. 범위 밖 요청은 지원사업 탐색 안내만 반환하며, 잘못된 코드·추가 자유문자 필드·모델 장애는
기존 오류로 처리합니다. OpenAI 호출이 실패했을 때 안내로 대신하는 fallback은 없습니다.
이는 C02 안내·확인 질문의 자유문장 노출을 제한하는 조치입니다. 조건 값의 의미 정확도나 별도 추천·근거 답변의
정확성을 보장하지 않으므로 기존 제안 확인과 근거 검증은 계속 필요합니다.
정확한 공개/내부 예시는 [C02 계약](../../docs/conversation-condition-update.md)을 참고하세요.

`HTTP API → SupportProgramConversationService → SupportProgramConversationAgent → OpenAI → 코드·조건 패치 검증 → 서버 안내문 → Response`로
한 번의 typed structured 호출만 실행합니다. 기존 client/model, store=false, tracing 비활성을 공유하며
이 역할의 모델·HTTP 25초/전체 실행 30초 제한과 최대 출력 2,000 tokens를 유지합니다.

## 도우미 자유 질문 분류 (C2)

`POST /internal/v1/assistant/answers`는 `govbiz-assistant-v1` 계약을 사용합니다. 화면 오른쪽 아래 도우미에
사용자가 자유롭게 쓴 한 마디를 받아 의도 하나를 고르고, 그 의도에 필요한 필드만 채웁니다. 실제 기능 실행과
화면 이동은 분류 결과를 받은 Core가 하며 모델은 도구를 호출하지 않습니다.
입력은 `schemaVersion`, `message`(1~500자), 최근 대화 `history`(최대 6개, USER/ASSISTANT), `session`
(`authenticated`, `hasCompany`), `context`(`route`, 공고 상세처럼 원문 질문이 가능한 화면인지 `programSelected`),
`helpEntries`(1~40개, id 고유)입니다. 도움말 항목은 프런트 `helpContent`와 같은 필드
(`id`·`title`·`question`·`summary`·`body`·`limitation`·`audience`·`status`·`action`)이며 AI Service는 사본을 갖지 않습니다.
응답 `intent`와 함께 채워야 하는 필드는 아래와 같고 나머지는 null 또는 빈 배열입니다.

분류·인용 회귀는 [도우미 의도 분류 평가](../../evaluation/assistant/README.md)의 가상 질문 47문항으로 확인합니다. 기본 실행은 모델을 부르지 않고, `--live` 첫 측정(2026-09-13, 당시 50문항)은 의도 50/50·인용 30/30·기권 10/10이었습니다.

| intent | 채우는 필드 | 뜻 |
|---|---|---|
| `PRODUCT_HELP` | `answer`, `citations`(요청 helpEntries의 id 1~3개) | 사용법·화면·정책 질문 |
| `ACCOUNT_STATE` | `accountTopic`(`SAVED_PROGRAMS`/`RECEIVED_PROPOSALS`/`COMPANY_PROFILE`) | 내 상태 질문. 숫자는 Core가 붙임 |
| `SEARCH` | `searchQuery` | 지원사업을 찾아 달라는 말 |
| `PROGRAM_QUESTION` | 없음 | 특정 공고 내용 질문. 원문 근거 경로로 위임 |
| `OUT_OF_SCOPE` | `answer` | 할 수 없는 일임을 알리고 가장 가까운 기능 안내 |
| `UNCLEAR` | `clarificationQuestion` | 종류를 정할 수 없어 한 번 되묻기 |

Service는 의도별 필드 조합과 인용 id가 요청의 도움말 항목에 있는지 검증하고 위반이면 503으로 거절합니다.
`HTTP API → AssistantService → AssistantAgent → OpenAI → Response`로 한 번의 typed structured 호출만 실행하며
C02와 같은 모델·HTTP 25초/전체 실행 30초 제한, 최대 출력 1,200 tokens, store=false, tracing 비활성을 씁니다.
로그에는 결과·소요 시간·토큰 수만 남기고 메시지·답변 본문은 남기지 않습니다.
세션·전체 대화 이력·영속성·추가 provider는 없습니다.

## 도우미 도구 에이전트 (LangGraph)

`POST /internal/v1/assistant/agent`는 `govbiz-assistant-agent-v1` 계약을 사용합니다. 요청은 `answers`와 같은 본문에
`principal`(`accountId`, `toolToken`, `hasCompany`; 비로그인은 `null`)과, 관심 공고 묶음 질문의 두 번째 호출에만
`savedProgramDocuments[]`(최대 10건 × 청크 `{id, contentHash}` 50개, 청크가 비면 원문 미수집)·`resumeIntent`를 더한 것이고, 응답은 위 표의 필드에
`cards[]`(최대 5장, `kind` RECRUITMENT/PROGRAM, `id`, `title`, `subtitle`, `reason`, `quote`, `to`), `navigation`(`label`, `to`),
`toolCalls[]`(`name`, `ms`, `ok`), `needsDocuments`를 더한 것입니다. 이 경로만 LangGraph를 쓰며 대화 검색·공고 추천·상세 질의응답·중복 지원 검토·신청 문서는 LangChain, 도우미 자유 질문 분류는 Agents SDK를 사용합니다.

관심 공고와 PROGRAM 카드의 식별자는 일반 공고 API와 같은 `sourceCode:sourceProgramId` 계약을 사용합니다.
제공처 코드는 최대 64자, 원본 ID는 최대 255개 Unicode 코드 포인트이며 한글·콜론·내부 공백을 보존합니다.
원본 ID의 앞뒤 공백과 Unicode Other 문자는 허용하지 않습니다. 카드의 상세 경로에는 원본 ID를 URL 인코딩하며,
도구 결과를 정제할 때도 유효한 식별자를 중간에서 자르지 않습니다. RECRUITMENT 카드 ID는 양의 정수 문자열입니다.

```
classify(nano, 구조화) ─┬─ PRODUCT_HELP·SEARCH·PROGRAM_QUESTION·OUT_OF_SCOPE·UNCLEAR·(제안함) ─► finalize
                       └─ PARTNER_MATCH·ACCOUNT_STATE·SAVED_PROGRAMS_QUESTION + principal ─► plan(luna, bind_tools)
                                                                                           ⇅ tools(Core GET, 병렬, ≤3회)
                                                                                           answer(luna, 구조화) ─► verify ─► finalize
```

- 도구는 `app/assistant_agent/tools.py`의 세 개(`get_my_company_profile`, `search_partner_recruitments`, `list_saved_programs`)이며
  Core `GET /internal/v1/assistant/tools/*`를 `X-Internal-Token`(공유 비밀)과 `X-Assistant-Tool-Token`(계정 묶음 단기 토큰)으로 부릅니다.
  전부 읽기 전용이고 결과는 개인정보·URL을 다시 가리고 600자로 잘라 `<data>`로만 씁니다. 도구 실패는 예외가 아니라 `toolCalls[].ok=false`와
  강등된 문장("지금은 자료를 확인하지 못했어요")입니다.
- `plan`은 같은 도구·같은 인자 반복과 모르는 도구를 버리고 질문당 최대 3회(`ASSISTANT_AGENT_MAX_TOOL_CALLS`)만 실행합니다.
  실패한 도구 뒤나 상한에 닿으면 다시 계획하지 않고 지금 자료로 답합니다.
- `answer`는 카드의 `kind`·`id`·`reason`만 내고, 제목·부제·경로는 `verify`가 도구 결과에서 채웁니다. 도구 결과에 없는 id가 하나라도 있으면
  답을 한 번 다시 만들고, 그래도 실패하면 카드 없이 문장만 남깁니다. `navigation`은 허용 목록(`/app/partners`, `/app/saved-programs`,
  `/app/proposals`, `/app/profile`, `/app/chat`)에서만 고릅니다.
- `principal`이 없으면 도구 경로가 막혀 분류 결과만 돌아가고 Core가 로그인 안내를 붙입니다. 기업 미등록 회원의 모집글 매칭은
  모델 없이 "기업 등록이 먼저" 문장과 프로필 이동을 돌려줍니다.
- 모델 호출은 질문당 최대 5회(분류 1, 계획 ≤3, 답 ≤2)이고 전체 제한 시간은 `ASSISTANT_AGENT_TIMEOUT_SECONDS`(기본 15초)입니다.
  넘으면 504, 그 밖의 장애·계약 위반은 503입니다. 체크포인터·서버 대화 세션은 없습니다.
- `assistant_agent_run` 로그는 결과·의도·모델 호출 수·도구 호출 수·실패 수·토큰 수·시간만 남깁니다.
  요청별 [사용량 집계기](app/assistant_agent/usage.py)가 채팅 모델 시작·응답을 기록하므로, 뒤 노드가 실패하거나
  시간 초과·취소돼도 이미 받은 사용량을 보존합니다. SDK가 출력 검증 중 실패하면 오류에 첨부한 HTTP 200
  Responses 응답의 사용량도 확인합니다. 질문·답·도구 결과·외부 예외 원문은 집계기에 저장하거나 로그로 남기지 않습니다.
- 관심 공고 묶음 질문(`SAVED_PROGRAMS_QUESTION`)은 도구 루프 대신 서브그래프 `retrieve → map → reduce → verify`
  (`app/assistant_agent/subgraphs/saved_programs_question.py`)를 씁니다. 첫 호출에 청크 허용 목록이 없으면 `needsDocuments=true`로 끝나고,
  Core가 원문을 준비해 `resumeIntent`로 다시 부르면 분류를 건너뜁니다. `retrieve`는 기존 근거 컬렉션을 허용 청크 id로 좁혀 질문과 가까운 청크를
  공고당 4개까지 읽고(`SupportProgramEvidenceService.search_documents`, 색인 때부터 payload에 청크 원문을 함께 저장), `map`은 공고마다 분류 모델(nano)이
  `{verdict, value, quote, confidence}`를 병렬로 내며, `reduce`는 판단 결과만 보고 답 모델(luna)이 문장·카드 순서를 정합니다. `verify`는 카드의
  문서 id가 관심 공고 안에 있는지와 인용이 검색 청크 원문에 글자 그대로 있는지를 보고, 대조에 실패한 인용은 카드에서 뺍니다.
- 단위 테스트(`tests/assistant_agent`)는 대본대로 답하는 채팅 모델과 httpx 대역 Core로 분기·상한·재시도·강등을 검증하고,
  `infrastructure/stubs/openai/server.py`는 `govbiz-assistant-agent-v1` 입력의 분류·도구 호출·답 픽스처를 갖습니다.

도우미 사용량 로그는 다음과 같이 읽습니다. HTTP 호출 흐름은 `API → Service → LangGraph → ChatOpenAI → 응답`이며,
Service는 내부 `astream(values)`로 마지막 완료 상태를 보존합니다. HTTP 응답 스트리밍을 추가한 것은 아닙니다.

| 필드 | 의미 |
|---|---|
| `model_calls` | 요청 내 시작된 LangChain 채팅 모델 호출 수. 응답이 없는 호출도 포함하며 공급자의 청구 확정 건수는 아님 |
| `input_tokens`, `output_tokens` | 해당 토큰 수를 모든 호출에서 확인했을 때의 합계. 하나라도 미확인이면 해당 필드는 `None` |
| `observed_input_tokens`, `observed_output_tokens` | 확인한 값만 더한 부분 합계. 전체 사용량·비용으로 해석하지 않음 |
| `usage_unknown_calls` | 입력 또는 출력 사용량을 확인하지 못한 호출 수. 미응답·사용량 누락은 0토큰으로 추정하지 않음 |
| `intent`, `tool_calls`, `tool_failures`, `answer_attempts` | 마지막으로 완료된 상위 그래프 상태. 실행 중인 노드·도구의 완료를 추정하지 않음 |

예를 들어 분류에서 입력 200·출력 20을 받은 뒤 다음 모델 호출이 시간 초과되면 `model_calls=2`,
`input_tokens=None output_tokens=None observed_input_tokens=200 observed_output_tokens=20 usage_unknown_calls=1`입니다.
명시적으로 받은 0토큰과 모델 호출을 시작하지 않은 경우의 0은 유지합니다. 서브그래프의 병렬 map도 같은 요청에서
집계하며, 동시 HTTP 요청끼리는 집계기를 공유하지 않습니다. 처리된 map 오류가 있어 `outcome=completed`인 경우에도
`usage_unknown_calls`가 남을 수 있습니다. 그래프 내부의 기존 누적 필드는 최종 운영 로그의 집계 근거로 사용하지 않습니다.

사용량 집계 범위는 도우미의 채팅 모델입니다. 검색 임베딩 비용·전체 서비스 예산 장부는 포함하지 않습니다.
SDK가 사용량을 제공하지 않고 읽을 수 있는 수신 응답도 없으면 미확인으로 유지합니다.
`tests/assistant_agent/test_usage.py`는 실제 LangGraph와 ChatOpenAI Responses SDK에 무료 HTTP 대역을 연결해
출력 검증 실패·누락·취소·시간 초과·병렬 map·동시 요청 격리를 검증합니다.

### 도우미 단계별 Langfuse 추적

`LANGFUSE_ENABLED=true`이면 bootstrap이 검색·근거 답변과 같은 `LLMTracing`을 도우미 Service와
두 그래프에 주입합니다. 직접 Service·그래프를 생성하는 평가·검증 실행기도 같은 객체를 전달합니다.
새 provider·실행 계층·모델 호출은 추가하지 않습니다.

호출 흐름은 `Core AssistantMessageService → AiAssistantClient → AI HTTP API → AssistantAgentService → LangGraph → Core 도구 / 근거 검색 / 채팅 모델 → 응답`입니다.
AI Service를 직접 생성하는 검증 경로도 유지합니다. 내부 `/assistant/agent`는 유효한 sampled W3C v00 `traceparent`의
trace ID·부모 span ID만 전달받아 `assistant.agent`를 연결합니다. 없거나 잘못된 헤더는 새 독립 trace로 처리하며
`baggage`·공개 응답 JSON 계약은 추가하지 않습니다. Core는 공개 요청의 trace ID를 받아들이지 않고 새 루트를 생성합니다.
Langfuse에서 `assistant-agent` trace 이름으로 필터하거나 `assistant_agent_run` 로그의 `trace_id`로 찾습니다.
Ops 화면의 **AI 실행 추적** 링크에서도 같은 프로젝트로 이동할 수 있습니다. Langfuse 로그인은 별도입니다.

```text
assistant.agent
├─ assistant.classify 또는 assistant.resume
├─ assistant.plan → assistant.tools → assistant.tool (병렬)
├─ assistant.answer → assistant.verify (필요 시 기존 답변 재생성)
├─ assistant.saved_programs (관심 공고 질문 분기)
│  ├─ assistant.saved.retrieve
│  ├─ assistant.saved.map → assistant.saved.judge (공고별 병렬)
│  ├─ assistant.saved.reduce
│  └─ assistant.saved.verify
└─ assistant.finalize
```

위 노드는 일반 처리 기록(`SPAN`, `record_kind=processing`)입니다. 모델을 쓰는 노드에는
`configured_model`·프롬프트 SHA-256을 남기고, 실제 채팅 모델 호출마다 그 노드 아래에
`assistant.model`(`GENERATION`, `record_kind=model_call`)을 하나씩 기록합니다.
병렬 `assistant.saved.judge` 호출은 각각 분리하며, `map` 자체를 모델 호출로 세지 않습니다.
기존 검색·근거 답변의 생성 기록도 `GENERATION`, 임베딩 호출은 `EMBEDDING`으로 구분합니다.

Langfuse에서 **모델 호출 횟수·토큰·비용**을 볼 때는 관측 유형을 `GENERATION`·`EMBEDDING`으로
필터하고, **처리 단계**를 볼 때는 `SPAN`을 선택합니다. 전체 이벤트를 모델별로 묶은 차트의
`n/a`에는 모델 없는 일반 처리 기록이 포함되므로 그 건수를 유료 호출 횟수로 해석하지 않습니다.
이전 기록은 소급해서 바뀌지 않습니다. 모델명·사용량이 누락된 모델 호출은 별도 점검 대상입니다.

루트는 계약 버전과
허용 문서 메타데이터·청크 해시 목록의 `document_manifest_sha256`, 문서 수를 남깁니다.
질문·답변·원문·도움말·문서 식별자·계정·도구 인자와 결과·인증 토큰·외부 예외 원문은 전송하지 않습니다.
문서 해시는 검토된 평가셋이나 사람 정답 버전을 뜻하지 않습니다.

예외가 전파되면 해당 단계에 `ERROR`와 `failed`·`timeout`·`cancelled`를 기록합니다. 기존 정책으로 처리된
검색·도구·map 실패와 검증 실패는 해당 노드에 `WARNING`, `result_status=degraded`를 남깁니다.
요청의 `outcome=completed`는 응답 완료이며 모든 하위 단계의 성공·답변 품질 합격을 뜻하지 않습니다.
시간 제한에 의해 취소된 하위 노드는 `cancelled`, 이를 시간 초과로 변환한 요청 루트는 `timeout`입니다.

루트의 `usage_input_tokens`, `usage_output_tokens`, `usage_observed_*`, `usage_unknown_calls`,
`usage_complete`는 위 요청별 사용량 집계기를 사용합니다. 미확정 합계는 숫자 0으로 채우지 않으며,
일부 값만 확인된 실행은 `usage_complete=false`로 식별합니다. 추적 전송 실패로 업무·모델을 재실행하지 않습니다.
각 `assistant.model`에도 제공자가 반환한 입력·출력 토큰 수와 `usage_reported`를 남깁니다.
실패·취소된 호출의 사용량이 없으면 0으로 채우지 않으며, 응답 검증 실패라도 받은 사용량은 보존합니다.
Langfuse의 토큰 기반 비용은 추정치이며 실제 청구액 확인은 제공자 비용 기록과 대조해야 합니다.

무료 검증은 `tests/assistant_agent/test_tracing.py`에서 실제 LangGraph와 메모리 exporter로 수행합니다.
기존 LLMOps `smoke.py`에도 정상·map 일부 실패·시간 초과의 Langfuse 저장·재조회 검사를 추가했습니다.
Core 도우미의 첫 호출·자료 준비·재호출과 부모 연결도 구현했습니다.
[실제 Core 도우미 연결 검사](../../infrastructure/llmops/README.md#core-도우미-분산-추적-검증)에서 로컬 선택 검증과 CI 서버 검증 범위를 구분합니다.
상세 공고 RAG의 전체 단계, Ops 평가 지표·점수 등록은 후속 범위입니다.

모델은 상태·패치·질문 또는 결과 설명을 출력하고 Service가 검증 후 계약 버전을 붙입니다. 검색/임베딩/랭킹은 호출하지 않습니다.

Service는 현재 message의 연속 부분 문자열 evidence(NFC·서식 문자 제거·연속 공백 하나·소문자로 맞춰 비교),
중복 없는 0~6개 SET/CLEAR, 명시된 완전한 설립일을 검증합니다. 날짜 evidence는 ISO, `YYYY년 M월 D일` 또는
마침표 숫자 날짜(`2021.3.15`, `2021. 3. 15.`) 자체만 인용하며 ISO로 정규화한 value와 같아야 합니다. 상대 업력에서 날짜를 계산하지 않습니다. pendingClarification의 draftContext → pendingProposal
→ context 순서로 병합 기준을 정하고 부재 필드는 그대로 보존합니다. READY는 병합 후 query가 필수입니다.
CLEAR는 문자열을 null, acceptingOnly를 true로 복원합니다. 모호한 값은 유지하고 확인 질문을 제안합니다.

새 계약만 길이를 UTF-16 코드 단위로 검증합니다(message/query 500, region 50, industry/supportPurpose 100,
날짜 10, question/evidence 160, answer 1,000). null 외 텍스트는 원본을 보존하고 공백뿐인 값을 거부합니다.
query/answer는 LF/CR/tab을 허용하지만 그 외 Unicode C는 거부하며 조건·질문·인용은 모든 C를 거부합니다.
message는 여기에 더해 이모지 결합 문자 같은 서식 문자(Cf)와 새 이모지(Cn)를 받고, 양방향 제어·비문자·대리 쌍·
사용자 정의 문자와 서식 문자만 있는 값은 거부합니다.
boolean 강제 변환은 하지 않습니다. 날짜는 실제 달력 날짜이고 설립일은 1900-01-01~referenceDate입니다.
내부 입력 오류는 기존 FastAPI 422, 모델 장애·잘못된 패치·허위 인용·잘못된 READY는 안전한 503입니다.
모델·HTTP·전체 실행 시간 초과는 `SupportProgramConversationTimeoutError`로 구분해 내부 504로 반환합니다.
Core는 기존 계약대로 공개 `504 AI_SERVICE_TIMEOUT` 또는 `503 AI_SERVICE_UNAVAILABLE`로 변환하고,
화면은 시간 초과와 일시 이용 불가를 구분해 수동 재시도를 안내합니다. 제한 시간을 늘리거나 자동 재시도하지 않습니다.
실패 로그에는 `failure_kind`(timeout/execution), 오류 클래스명, `elapsed_ms`만 기록합니다.
메시지·기업 조건·모델 응답·원문 예외·traceback은 기록하지 않습니다. 공개 입력 오류는 기존 Core 400이며,
오류를 확인 질문이나 검색 0건으로 숨기지 않습니다.

사용자 확인 전에는 적용 조건을 바꾸거나 검색하지 않습니다. 인용의 문자 일치는 value의 의미 정확도까지
보증하지 않으므로 모든 READY 결과에 확인이 필요합니다. 기존 query에서 옛 지역을 제거하고 구조 조건 중복을
줄이는 것은 프롬프트 지시이며, 고정 모델 응답 회귀는 실제 한국어 모델의 의미 정확도 평가가 아닙니다.
Compose OpenAI 대역도 정해진 C02 smoke 문구만 처리하고 미지원 문구는 오류를 반환합니다.
`대구로`, `설정해` 같은 후속 발화는 직전 제안·질문의 명확한 대상을 이어 해석하고 불필요한 확인 반복을 피하도록
지시합니다. `왜 못찾아?`에는 lastSearch의 확인 가능한 결과만 설명하며 공고 부재·마감 등 원인을 창작하거나
조건을 자동 완화하지 않습니다. 요약이 없으면 결과를 모른다고 안내합니다. ANSWERED는 조건 적용·검색 완료를 뜻하지 않습니다.
선택 필드 생략 호환과 내부 v1은 유지하지만 확장 계약은 Frontend·Core API·AI Service에 함께 반영해야 합니다.

기존 검색이 `사업화 지원`일 때 `지원금 위주`는 `사업화 지원금`으로 지원 형태만 좁히며 핵심 활동을
보존하도록 지시합니다. `사업화 말고 수출 지원으로 바꿔줘`는 명시적 활동 전환으로 처리하고,
SUPPORT_PURPOSE에 옛 활동이 남아 있으면 함께 정리합니다. 명시적 전체 초기화는 별도 CLEAR 흐름입니다.
이 예시의 일반/pending 두 경로·병합·입력 불변성은 고정 모델 응답으로 검증하며, 실제 모델의 의미 보존
성능은 별도 실측이 필요합니다. 특정 단어를 찾아 production에서 query를 강제 교체하는 규칙은 추가하지 않습니다.

## 전체 공고 의미 검색

공고의 제목·요약·지원대상 등을 포함한 검색 문서는 Core가 구성합니다. `id`는
`BIZINFO:PBLN_123`처럼 제공처를 포함하고, `contentHash`는 전달된 `text`의 UTF-8 SHA-256입니다.
Qdrant point ID는 이 두 값에서 결정되므로 같은 문서를 반복 처리해도 중복되지 않습니다.

| 요청 | 입력 | 응답 |
|---|---|---|
| `PUT .../batch` | `documents: [{id, contentHash, text}]`, 1~50개, text 최대 12,000자 | `{indexedCount}`: 기존 색인 포함 요청 건수 |
| `POST .../prune` | `sourceCode`, `documents: [{id, contentHash}]`, 최대 20,000개 | `{retainedCount}` |
| `POST .../search` | `query`: 앞뒤 공백 제거 후 1~1,000자, `eligibleDocuments: [{id, contentHash}]` 최대 20,000개, `limit`: 1~20 | `{query, matches: [{id, contentHash, score}]}` |

내부 의미 검색의 1,000자 상한은 Core가 원래 질문과 회사 조건을 합성하는 공간입니다.
공개 검색 질문과 점수화의 `originalQuery`는 기존 500자 상한을 유지합니다.

```text
Core의 기업마당 동기화: 시작 세대 발급 → 전체 수집·검증
→ HTTP batch API → SupportProgramIndexService
→ Qdrant에서 동일 ID·해시 존재 여부 확인
→ 누락·변경 문서만 OpenAI Embeddings API 호출
→ 차원·유한 숫자·응답 인덱스·건수 검증 → Qdrant UPSERT → Response
→ 모든 batch 성공 후 Core가 최신 시작 세대인지 확인 → 해당 세대만 MySQL에 공개

Core의 별도 색인 스케줄러 (기본 PT1M)
→ 이미 공개된 MySQL 공고 조회 → 같은 batch API로 누락 벡터 복구 (prune 호출 없음)

사용자 검색 → Core가 현재 검색 가능한 MySQL 공고 ID·해시 전달
→ HTTP search API → SupportProgramIndexService
→ 요청한 모든 현재 버전이 색인됐는지 정확한 count 검증
→ 정확히 같은 질의의 검증된 임베딩 재사용, 없으면 OpenAI 호출
→ Qdrant HasId 필터로 해당 ID·해시만 검색 → 관련 후보 Response
→ 기존 HTTP ranking API → Service의 정확일치 응답 캐시, 없으면 Agent → OpenAI → 검증 → Response
```

Qdrant는 ID·해시·제공처와 벡터만 보관합니다. 공식 공고 내용과 접수 상태의 기준은 MySQL이며,
닫힌 공고나 미노출 공고를 제외할 책임은 Core에 있습니다. 매 검색마다 Core가 현재 MySQL 공고·접수 상태를
확인하고 AI가 collection 존재·모든 ID/해시의 색인·Qdrant 후보를 다시 검증합니다. 질의 임베딩만
서비스 인스턴스별 최대 **256개·300초** 재사용하며, 준비 검증 이전에는 캐시도 유료 임베딩도 사용하지 않습니다.

색인이 없거나 현재 공고 중 하나라도 아직 색인되지 않았다면 `503`과
`{"detail":{"code":"INDEX_NOT_READY"}}`를 반환합니다. 부분 색인이나 최신 20개 조회로 대체하지
않습니다. Qdrant·OpenAI 장애, 임베딩 검증 실패는 `INDEX_UNAVAILABLE`로 구분합니다. 빈 검색
가능 목록은 외부 호출 없이 빈 `matches`를 반환합니다.

모델·차원·문서 처리 버전은 collection 이름에 반영합니다. 모델 또는 차원을 바꾸면 새 collection에
전체 재색인이 필요하며, 기존 collection은 자동 삭제하지 않습니다. Core는 MySQL의 시작 세대로
카탈로그 공개 순서를 확인하고, 전체 벡터가 준비된 최신 시작 세대만 공개합니다. 이미 공개된 공고의
누락 벡터를 복구하는 별도 스케줄러도 벡터를 삭제하지 않습니다.

내부 `prune` API는 남아 있지만 현재 Core 동기화·복구 경로에서는 호출하지 않습니다. 정확한 현재
ID·해시 필터가 오래된 벡터를 검색에서 제외하므로 새 스냅샷 준비 중인 벡터를 삭제할 필요가 없습니다.
이전 버전·미공개 세대·이전 모델 collection의 저장 공간 정리는 후속 과제입니다. 진행 중인 작업과
검색을 보호하는 보존·삭제 수명주기가 필요하며, 현재 `prune` API 자체가 다중 인스턴스나 동시 실행에
안전한 것은 아닙니다.

공고 단위 후보 검색의 벡터 유사도는 신청 자격 충족률이나 선정 확률이 아닙니다.

공고와 상세 근거의 임베딩 입력은 [공유 전처리](app/support_program_embedding.py)에서 토큰 상한을 맞춥니다.
토크나이저 준비뿐 아니라 인코딩·잘라내기·재검사 전체를 작업 스레드에서 수행하므로, 큰 색인 배치의 CPU 작업이
HTTP 이벤트 루프를 막지 않습니다. 기존 입력 순서·8,191 토큰 상한·32개 API 배치·내용 해시 규칙은 유지합니다.

## 공고 상세 근거 RAG

상세 화면의 질문 답변은 Core가 공식 공고 상세 원문을 정제·분할한 청크만 사용합니다. 이 기능은 현재
Core가 제공하는 기업마당 상세 공고를 대상으로 하지만, AI Service 내부 식별자는
`sourceCode:sourceProgramId` 형식이므로 다른 제공처에도 같은 계약을 사용할 수 있습니다.

| 요청 | 입력 | 응답 |
|---|---|---|
| `PUT .../chunks` | `chunks: [{id, contentHash, documentId, order, text}]`, 1~50개. `id`·`contentHash`는 소문자 SHA-256, text는 UTF-8 SHA-256과 일치하며 최대 12,000자 | `{indexedCount}` |
| `POST .../search` | `question`: 앞뒤 공백 제거 후 1~500자, `eligibleChunks: [{id, contentHash, documentId, order}]` 1~50개, `limit`: 1~5 | `{question, matches: [{id, contentHash, documentId, order, score}]}` |
| `POST .../answers` | `question`, `chunks: [{id, documentId, order, text}]` 1~5개 | `{answer, answerStatus, citationChunkIds}` |

`documentId`는 최대 320자의 정규 `sourceCode:sourceProgramId`입니다. 첫 번째 콜론만 제공처 코드와 원본
공고 ID를 나누므로 원본 ID에 추가 콜론이 있어도 됩니다. `order`는 0 이상의 정수이고, 같은 요청 안의
청크 ID는 중복될 수 없습니다.

LLM이 긴 해시를 잘못 복사하는 오류를 막기 위해, Agent는 이번 요청 배열의 짧은 `index`만 선택하게 합니다.
모델 전용 결과는 `SupportProgramEvidenceAnswerSelection`의 `citationChunkIndexes`이며, 범위·중복·상태를
검증한 뒤 요청의 원래 64자리 ID로 복원합니다. 원문 `order`와 요청 배열 `index`는 다릅니다.
공개/내부 HTTP 응답은 기존 `citationChunkIds`를 유지하고, 잘못된 선택을 자동 보정하지 않습니다.

```text
Core의 상세 공고 준비
→ 공식 상세 원문 정제·고정 크기 청크화 → 각 청크 ID·text SHA-256 검증
→ PUT /support-program-evidence/chunks
→ SupportProgramEvidenceService
→ 별도 Qdrant collection에서 현재 ID·해시·documentId·order 검증 후 OpenAI Embeddings API 호출·UPSERT

사용자 상세 질문
→ Core가 해당 공고의 현재 eligibleChunks 전달
→ POST /support-program-evidence/search
→ 모든 청크가 현재 collection에 존재하는지 확인 → HasId filter로 지정 청크만 유사도 검색
→ 최대 5개의 match 반환
→ Core가 match의 공식 text만 포함해 POST /support-program-evidence/answers 호출
→ SupportProgramEvidenceAnswerAgent → LangChain (LLM 1회)
→ OpenAI가 이번 요청의 citationChunkIndexes 선택 → 번호 검증 후 원래 ID 복원
→ 출력 상태·중복 인용·입력 밖 citationChunkIds 재검증 → 한국어 답변 반환
```

상세 근거 collection은 공고 단위 검색 collection과 이름·point ID가 다릅니다. point ID는 청크 ID와
내용 해시에서 결정되고, payload의 `documentId`와 `order`까지 다시 비교합니다. 따라서 다른 공고의
청크를 같은 청크 ID·해시로 재사용하거나, 검색 결과에 요청하지 않은 공고 청크가 섞이는 경우 정상 답변으로
대체하지 않고 오류로 처리합니다. 이전 청크 버전은 현재 `eligibleChunks`의 ID·해시 필터에 없으므로
검색 결과에서 제외됩니다.

근거 질문 임베딩은 모델·차원·전처리가 고정된 Service 인스턴스에서 최대 256개/300초 재사용하며,
같은 질문의 동시 요청을 병합합니다. 준비 검증은 캐시 적중 시에도 먼저 실행하고 오류는 저장하지 않습니다.
같은 내용의 청크 벡터도 텍스트 해시 기준 최대 128개/300초 재사용합니다. 원문 버전이 바뀌어 청크 ID가
달라져도 내용이 같으면 임베딩을 생략할 수 있으며, 새 point의 ID·내용 해시·문서 ID·순서는 그대로 저장·검증합니다.
캐시는 메모리에만 있고 재시작하면 비워집니다. 기존 Qdrant 벡터 재사용과 현재 청크 검증은 유지하며,
최종 답변을 질문만으로 캐시하거나 다른 공고의 검색 결과를 재사용하지 않습니다.

검색 요청에 지정한 청크가 하나라도 색인되지 않았거나 Qdrant가 기대한 개수의 결과를 반환하지 않으면
`503`과 `{"detail":{"code":"EVIDENCE_NOT_READY"}}`를 반환합니다. 임베딩·Qdrant·Agent 장애,
payload 불일치, 검증 실패는 `EVIDENCE_UNAVAILABLE`입니다. 부분 검색, 다른 공고 청크, 일반 지식으로
대체하지 않습니다.

답변 Agent는 청크 원문의 지시를 따르지 않고 데이터로만 취급합니다. 제공된 text에서 직접 확인 가능한
내용만 한국어로 답하며, 충분한 근거가 있으면 `ANSWERED`와 하나 이상의 `citationChunkIds`를 반환합니다.
근거가 부족하면 `INSUFFICIENT_EVIDENCE`와 빈 인용 배열을 반환합니다. AI Service는 인용 ID가 요청에
전달된 청크 집합의 부분집합인지도 다시 확인합니다.

대상 조건 요약에서는 사업개요를 포함한 제공 근거의 관련 규모·업종·지역·자격·제외/예외를 보존하도록
지시합니다. 필수·우대·선택 조건을 구분하고 원문의 AND/OR 관계를 임의로 바꾸거나 없는 제한을 만들지
않도록 했으며, 조건이 흩어져 있으면 해당 청크들을 함께 인용하도록 했습니다.
이는 프롬프트 지침이지 모든 조건을 코드로 판정하는 규칙 엔진이 아닙니다.
[추가 실제 검증](../../evaluation/support-program-evidence/runs/official-flow-20260907-v2/README.md)에서
가상 6건·공식 6건의 답변을 대조했고, H01의 누락 보완을 관찰했습니다. 단회 AI-only 결과이며 일반적인
정확도나 반복 실험으로 입증한 개선을 뜻하지 않습니다.

## 평가 기준

`govbiz-support-program-ranking-v5`는 검색 관련성을 두 항목으로 판단합니다.

| 항목 | 배점 |
|---|---:|
| 질문과 공고의 의미적 관련성 | 40 |
| 원하는 지원 유형 적합성 | 10 |

`totalScore = 2 × (semanticRelevance + supportTypeFit)`로 0~100점에 정규화합니다.
이 점수는 검색 관련도이며 신청 가능성·선정 확률이 아닙니다. 기업 정보 부족으로 인한 `UNKNOWN`은
관련도 감점이나 후순위 정렬 사유가 아닙니다. 대상·지역 자격은 상태·본문 인용·설명으로 별도 반환합니다.
접수 상태는 Core의 기존 접수 필터와 공고 표시로 유지하며 AI 총점에 다시 가산하지 않습니다.

LLM에 전달할 평가 지시는 [prompt.py](app/support_program_ranking/prompt.py)에 둡니다.
[models.py](app/support_program_ranking/models.py)는 복원된 평가 값 `SupportProgramAssessment`, Agent가 검증된 ID를 붙인
내부 항목 `AssessedSupportProgram`, 검증된 HTTP 응답 `ScoredSupportProgram`을 구분합니다.
AI는 관련도 두 항목과 자격·근거를 판단하되 `totalScore`와 값 안의 `programId`는 출력하지 않습니다.
[service.py](app/support_program_ranking/service.py)가 모든 후보의 본문 인용을 검증하고 관련도를 계산한 뒤
최소 추천 기준을 적용합니다. 지역·업종 사전이나 규칙 기반 LLM fallback은 추가하지 않습니다.
Core도 같은 HTTP 계약을 재검증합니다. 새 계약에서는 `targetFit`, `regionFit`, `applicationStatusFit`과
assessment의 `score`를 제거하고, 총점 60점 컷과 MATCH 그룹 절대 우선 정렬도 제거했습니다.
`scoringVersion`을 v5로 분리하며 과거 v3·v4 평가 캡처·실행 기록은 변경하지 않습니다.
과거 총점은 다른 산식이므로 현재 관련도와 직접 비교하거나 현행 품질 검증으로 재해석하지 않습니다.

후보 `summary`는 최대 6,000자, `targetDescription`은 최대 2,000자입니다. Core가 실제 본문을 잘랐으면
`sourceTextTruncated: true`를 보내며 기본값은 false입니다. true인 후보는 잘린 부분의 제한·예외를 알 수 없어
대상·지역 모두 UNKNOWN만 허용합니다. 입력은 공식 API 요약이지 첨부 PDF/HWP 전체 원문이 아닙니다.
읽지 않은 부분의 조건 충족이나 최종 신청 자격을 확정하지 않습니다.
Agent의 단일 LLM 호출을 유지하고 출력 토큰 상한만 10,000으로 늘렸습니다.
순위화 시간 제한은 아래 설정 절의 별도 기본값을 사용하며, 20개 후보의 실제 모델 응답시간·품질은
별도 승인된 실호출 검증이 필요합니다.

### 추천 반환 최소 기준

Agent는 후보를 빠짐없이 점수화하고 각 후보의 `targetAssessment`·`regionAssessment`에는
`eligibility`, `evidence`, `explanation`만 반환합니다. 자격별 점수는 생성하지 않습니다.
Service는 이를 HTTP의 `targetEligibility`, `regionEligibility`, `targetEvidence`, `targetExplanation`,
`regionEvidence`, `regionExplanation`으로 옮깁니다.
각 evidence는 `[{field: "SUMMARY" | "TARGET_DESCRIPTION", quote: "..."}]` 형태로 최대 1개이며,
quote는 원문 그대로 1~240 Unicode code point, explanation은 1~160자입니다. 둘 다 원본 길이를 검사하고
공백뿐인 값과 Unicode 제어·형식 문자를 거부하며 trim 등으로 변형하지 않습니다. MATCH·INCOMPATIBLE에는
인용 1개가 필수이고 UNKNOWN은 0~1개와 확인할 조건을 적은 설명이 필요합니다.
Service는 제외·점수 미달 후보까지 모두 해당 후보의 지정 본문 필드에 exact substring 인용이 존재하는지 검사합니다.
다른 후보·제목·기관·지역 태그의 인용이나 허위 인용은 정상 빈 목록으로 숨기지 않고 503 오류를 반환합니다.
`regions`는 검색용 태그이며 자격 증거가 아닙니다. 전국 태그와 지역 제한 본문이 충돌하면 본문을 우선하고,
서울 기업이 경북 이전 확약 조건을 확인하지 않았다면 지역 자격은 UNKNOWN입니다.
조건부 이전·확장 확약 신청 가능 문구를 전국 기업의 무조건 허용이나 경북 기존 소재 기업만의 허용으로
바꾸지 않습니다. 필수 요건·예외 관계가 모호하면 UNKNOWN이고, 일반 대상 라벨보다 본문의 구체적인 산업 요건을 확인합니다.
실제 보고된 '지원기간 내 경상북도 지역으로 사업장 이전(또는 확장) 확약기업 신청 가능' 문구는
조건 유무 두 경로의 LangChain·HTTP 스텁 회귀로 전달·인용·UNKNOWN 보존을 검증합니다. 모델의 의미 판단 정확도 보장은 아닙니다.
인용 존재 검증은 인용의 논리적 충분성까지 보장하지 않습니다. 자격의 의미 판단은 여전히 모델이 수행합니다.

지역 판정 지침과 내부 `regionAssessment` schema 설명은 먼저 제한 주체를 일반 회사·특정 사업장·개인으로
구분합니다. 회사 `region`을 본점·공장 각각의 주소나 대표자 거주지로 대입하지 않습니다. 예를 들어 서울 회사라는
정보만으로 `대구지역 여성` 조건과의 충돌을 확정할 수 없으므로 개인 지역 자격은 UNKNOWN입니다.
같은 주체의 확인된 주소끼리 비교할 때는 소재지 범위의 포함 방향을 적용합니다.
서울만 확인됐는데 서초구 한정이면 UNKNOWN, 서초구 소재가 확인되고 서울 전체 대상이면 MATCH,
다른 구로 확인됐고 예외 없이 서초구만 허용하면 INCOMPATIBLE입니다. 하위 주소 미확인 규칙은
공고 제한 지역이 확인된 회사 지역 **내부**에 있을 때만 적용합니다. 서울 기업과 안산 관내 기업 한정은
주소 상세도의 차이가 아니라 지역 충돌이므로 INCOMPATIBLE입니다. 원문에 없는 지점·이전 경로를
가정하지 않고, 본문이 실제 허용한 대안은 구분합니다. `서울 소재 또는 서울 이전 예정`이라면 서울 기업은
이전 의사 확인 없이 지역 MATCH이고, 타 지역 기업의 이전 의사가 미확인인 경우는 UNKNOWN입니다.
`본점·지점·공장 중 하나`가 허용된 경우에도 회사 소재지 하나만으로 다른 사업장의 부재를 단정하지 않습니다.
충족 경로 없이 미확인 경로가 남으면 UNKNOWN이며, 모든 허용 경로의 불충족을 확인해야 INCOMPATIBLE입니다.
실제 지역 허용·제한을 표현하는
구절을 선택해야 하며, 전국 태그·기관 주소·행사 장소·일반 대상 문구만으로 지역을 확정하지 않습니다.
본문의 전국 무제한 신청은 구분하여 MATCH를 허용하고 이전 확약 미확인은 UNKNOWN을 유지합니다.
이는 모델 지침이며 서버의 독립적인 행정구역 증명 규칙은 아닙니다.
[지역 범위·근거 개선 기록](../../docs/region-eligibility-scope-fix.md)은 이전 검증을 보존하며,
후속 지침·schema 전제 보완과 Fast 설정은 [지역 충돌·Fast 기록](../../docs/region-conflict-fast-20260908.md)을 참고하세요.

LLM 내부에서는 인용 문구를 생성하지 않고 후보별 `evidenceOptions`의 번호만 선택합니다.
Agent가 전체 `summary`·`targetDescription`을 그대로 전달하면서 두 필드의 원문 조각을
`[{index: 0, field: "SUMMARY", quote: "..."}, ...]`로 추가합니다. 모델의 assessment.evidence는 `[0]`처럼
번호 배열이며 최대 1개입니다. 후보별 동적 스키마가 `0..선택지 수-1`의 정수만 허용하고 Agent가 다시
범위를 검증한 뒤 해당 후보의 원래 field/quote를 복원합니다. 이 원문 복원 방식은 v5에서도 유지합니다.
출력 스키마도 MATCH·UNKNOWN·INCOMPATIBLE을 각각 나눠 MATCH·INCOMPATIBLE의 근거 번호 1개를
필수로 하고 UNKNOWN만 0~1개를 허용합니다. 추천 이유의 각 항목에도 1~120자 제한을 선언하여
생성 형식은 통과했지만 서버 검증에서 거부되는 간극을 줄입니다. 원문 인용·자격 검증은 그대로 유지합니다.
사용하는 중첩 `anyOf`와 배열 길이 제약은 [OpenAI Structured Outputs 문서](https://developers.openai.com/api/docs/guides/structured-outputs)를 따릅니다.
원본 식별자를 분해하지 않으며 서로 다른 후보의 같은 번호는 각자의 원문에만 대응합니다.

조각은 Unicode code point 기준 최대 240자이며 긴 연속 구간 안에서 최소 60자 겹침으로 끝까지 만듭니다. 가능한 경우
창의 후반부에서 문장·단어 경계를 선택하며 정규화·생략 부호·문자 접합은 하지 않습니다.
Unicode C 문자는 제거해 앞뒤를 붙이지 않고 경계로 분리합니다. 공백뿐인 구간은 인용으로 만들지 않지만
전체 본문은 그대로 제공하며 조각 수 상한으로 뒷부분을 버리지 않습니다. 인용 가능한 조각이 없으면
UNKNOWN과 빈 evidence만 유효합니다. 선택지는 복사 오류 방지용이며 모델은 전체 본문의 필수 요건·예외로
판단해야 합니다. 번호 선택이 의미 적합성이나 운영 응답시간을 보장하지는 않습니다.
제어문자와 짧은 글자가 번갈아 반복되는 극단 입력에서는 선택지 수와 직렬화된 입력 크기가 크게 늘어날 수
있습니다. 이번 변경은 뒤쪽 자격 예외를 누락시키는 임의 선택지 상한이나 UNKNOWN 보정을 추가하지 않습니다.
Agent에 전달하는 strict output schema의 `rankings`는 배열이 아닌 객체입니다. 요청 후보의 ID 20개가 있다면
그 ID 20개 자체를 모두 `required` 속성 키로 선언하고 `additionalProperties=false`로 다른 키를 금지합니다.
배열 길이만 맞추고 특정 공고를 중복 평가하는 실패를 막기 위한 구조이며, 적합하지 않은 후보도 평가한 뒤
Service에서 제외합니다. Agent가 검증된 키를 `programId`로 붙여 입력 후보 순서의 내부 목록으로 변환합니다.
요청별 LangChain 모델 바인딩에만 이 스키마를 적용하므로 서로 다른 후보의 요청이 공통 설정을 바꾸지 않습니다.
내부 목록 중복 검증과 Service의 후보 ID 집합 검증도 유지합니다.
자격 값은 `MATCH`(제공된 정보와 일치), `INCOMPATIBLE`(명백한 조건 불일치), `UNKNOWN`(정보 부족) 중 하나입니다.
`UNKNOWN`은 자동 탈락이나 자격 충족 확정을 뜻하지 않습니다. Service는 아래 조건을 모두 충족한 공고만 추천으로
반환합니다.

후보의 `id`와 응답의 `programId`는 `sourceCode:sourceProgramId` 형태의 같은 정규 식별자입니다. 제공처가
다르면 원본 공고 ID가 같아도 서로 다른 후보로 취급하며, 키에서 내부 항목으로 옮길 때 입력값을 그대로 유지합니다.

- `targetEligibility`와 `regionEligibility` 어느 쪽도 `INCOMPATIBLE`이 아님
- `semanticRelevance >= 20`: 40점인 핵심 관련성 항목에서 절반 이상

자격 불일치는 높은 총점으로 상쇄할 수 없습니다. 지역·접수 상태만 맞는 공고가 추천되는 것을 막기 위해
의미 관련성 조건도 별도로 둡니다. 하나라도 충족하지 못하면 최종 결과에서 제외합니다.
MATCH와 UNKNOWN을 합쳐 검색 관련도 총점 내림차순으로 정렬하고 동점은 입력 순서를 유지합니다.
합계 최대 resultLimit(5)개를 반환하며 UNKNOWN의 확인 필요 상태는 그대로 표시합니다.
의미 관련성 20·지원 유형 0인 공고도 총점 40으로 반환할 수 있습니다. 총점 60점 컷은 없습니다.
적격 공고가 없으면 빈 `rankings`를 정상 `200` 응답으로
반환합니다. 응답의 `exclusionCounts`(`lowRelevance`·`target`·`region`)는 위 기준으로 추천에서 뺀 후보 수이며 한 후보는
먼저 걸린 사유(관련도 → 지원 대상 → 지역) 하나로만 셉니다. 선택 로그와 같은 값을 실을 뿐 프롬프트·모델 출력은 바꾸지 않고,
Core가 결과가 없을 때 사유와 조건 빼기를 안내하는 데 씁니다. 이 값은 실제 검색 평가 데이터가 쌓이면 조정할 초기 정책입니다. Core도 내부 HTTP 응답이 이
정책을 어기지 않았는지 다시 검증하지만, 키워드 사전이나 항목별 가중치를 Kotlin에 구현하지 않습니다.

관련성은 검색문의 핵심 활동과 확인된 업종·지원 목적을 함께 해석합니다. `지원금`이라는 지원 형태가
기존 `사업화` 목적을 지우지 않으며, UNKNOWN을 사용자가 다른 산업 활동도 한다는 가정으로 확장하지 않습니다.
영화 제작비·행사 참가비처럼 돈을 지원한다는 점만 같은 공고를 소프트웨어 사업화 지원으로 일반화하지 않도록
지시합니다. 반대로 업종 제한 없는 사업화 자금은 소프트웨어라는 단어가 없다는 이유만으로 제외하지 않습니다.
이는 프롬프트 기준과 고정 모델 응답 회귀이며 산업·공고명 제외 목록이나 서버 규칙 fallback을 추가한 것이 아닙니다.

4단계 2차에서는 `semanticRelevance`를 같은 분야의 키워드보다 **실제 요청한 서비스·비용·결과의 제공 여부**로
판단하도록 프롬프트를 보완했습니다. 행사에 딸린 부대 지원을 독립적인 지원으로 확대하지 않고,
현재 단계와 요청 활동을 구별합니다. 부분적으로 직접 제공하는 지원은 인정하며 모든 질문 단어 일치나
미확인 자격의 자동 탈락을 요구하지 않습니다. 지역·업종·공고 ID별 하드코딩은 추가하지 않았습니다.
당시 공개 점수 계약 v3와 임계값은 유지하고 측정 파일의 프롬프트 SHA-256으로 전후 버전을 구별했습니다.
실제 고정 후보 전후 32회 비교에서 dev의 알려진 무관 추천은 6→4건, 관련 추천은 15→16건이었으나
heldout 오추천은 줄지 않았고 평균 API 응답시간은 약 1.82초 늘었습니다.
[측정 조건·결과·재현 방법](../../evaluation/support-program-search/runs/support-program-catalog-20260906-v1/stage4-v2/README.md)에 한계를 함께 기록했습니다.

포괄적인 분야별 창업지원 검색(예: AI 창업지원)은 AI 전용 공고로만 제한하지 않습니다. 다른 산업에만 한정되지 않고
창업기업의 사업화·보육·창업 교육·입주 공간·지식재산 활용을 실제 지원하는 공고도 관련성 평가에 포함합니다.
특정 활동·비용을 명시한 요청의 직접 지원 요건은 유지하며, 설립연도·인증 등 자격 조건은 관련성 점수와 분리합니다.
이 지침이 실제 모델의 판단 일관성을 보장하는 것은 아니며, 결과는 별도 실검색으로 확인해야 합니다.

## 수직 호출 흐름

```text
Core API
→ POST /internal/v1/support-program-rankings/rank
→ support_program_ranking/router.py
   → SupportProgramRankingRequest로 요청 검증
→ SupportProgramRankingService.rank()
   ├→ 전체 입력이 같은 검증된 캐시 응답이면 복사 반환
   └→ 캐시가 없으면 같은 진행 요청에 합류하거나 아래 평가 실행
→ SupportProgramRecommendationAgent.rank()
→ LangChain ChatPromptTemplate → ChatOpenAI → OpenAI Responses API (1회)
   ├→ prompt.py의 평가 기준 사용
   ├→ 후보 문장을 지시가 아닌 데이터로 취급
   └→ 요청별 필수 ID 키 rankings 객체로 세부 점수·자격·인용 번호 선택 (총점 없음)
→ Agent가 모든 후보의 인용 번호를 원문 field/quote로 복원하고 ID 키를 붙여 SupportProgramRankingOutput으로 변환
→ Service가 입력 후보 ID exact set을 재검증
→ Service가 2 × (의미 관련성 + 지원 유형) 계산 → v5 ScoredSupportProgram으로 변환·검증
→ 총점 내림차순 정렬
→ 자격 INCOMPATIBLE 제외 + semanticRelevance 20점 기준 필터 (UNKNOWN 감점·후순위 없음)
→ 적격 공고를 resultLimit까지 선택(0개 가능)
→ SupportProgramRankingResponse
→ Core API
```

랭킹 응답은 서비스 인스턴스별 최대 **128개·300초** 보관합니다. 질의·회사 조건·기준일·전체 후보의
본문/메타데이터/순서·개수·결과 제한·scoringVersion을 함께 해시하므로 하나라도 달라지면 다시 평가합니다.
모델·프롬프트·임베딩 전처리는 인스턴스 수명 동안 고정되며 두 캐시는 다른 프로세스와 공유하지 않습니다.
둘 다 성공 검증 후부터 TTL을 계산하고 오래 사용하지 않은 항목부터 제거하며 반환값을 복사합니다.
TTL은 재사용 기한으로, 만료 즉시 메모리에서 물리 삭제됨을 보장하지 않습니다. 전체 검색 결과 캐시는
아니므로 현재 DB·Qdrant 검증과 후보 선택은 매번 실행합니다. 후보·배점·모델·시간 상한은 유지합니다.
동일 입력의 동시 요청은 합류합니다. 랭킹은 한 대기자의 취소로 공유 작업을 중단하지 않고 마지막 대기자가
취소하면 작업도 취소합니다. 임베딩 수행 요청이 취소되면 남은 대기자가 다시 실행합니다. 실패는 캐시하지
않고 기존 오류를 전달합니다. 세부 검증은 [검색 지연 개선 기록](../../docs/search-latency-20260908.md)에 있습니다.

예를 들어 Core가 두 공고를 보내고 `resultLimit=1`을 지정하면 Agent는 두 후보를 모두 점수화합니다.
Service는 누락·추가·중복 ID를 거부한 뒤 최소 기준을 통과한 공고 중 가장 높은 한 건만 Core에 반환합니다.
두 공고가 모두 기준을 통과하지 못하면 빈 목록을 반환합니다.

## 파일별 책임

```text
app/
├── main.py                         # FastAPI, router, lifespan
├── config.py                       # 모델과 timeout 환경설정
├── bootstrap.py                    # OpenAI client/model/agent/service 조립
├── health/                         # 공통 Health 수직 기능
│   ├── router.py                   # 내부 Health HTTP 경계
│   └── models.py                   # Health 응답 계약
├── support_program_index/          # 공고 임베딩·Qdrant 후보 검색
│   ├── router.py                   # batch/prune/search 내부 HTTP 경계
│   ├── models.py                   # ID·해시·본문·검색 계약 검증
│   └── service.py                  # OpenAI 임베딩·Qdrant 색인과 검색
├── support_program_evidence/        # 상세 원문 근거 검색·답변
│   ├── router.py                   # chunks/search/answers 내부 HTTP 경계
│   ├── models.py                   # 청크·근거 검색·답변 strict 계약
│   ├── service.py                  # 별도 Qdrant collection 색인·현재 청크 검색
│   ├── prompt.py                   # 근거 외 지식 금지 한국어 답변 지시
│   ├── agent.py                    # LangChain 프롬프트 체인·strict 출력 검증
│   ├── answer_service.py           # 인용 청크 집합 재검증
│   └── errors.py                   # 안전한 기능 실패
└── support_program_ranking/         # 지원사업 점수화 수직 기능
    ├── router.py                   # 내부 HTTP 경계
    ├── models.py                   # 요청·출력·응답 Pydantic 계약
    ├── prompt.py                   # 버전된 100점 평가 기준
    ├── agent.py                    # LangChain과 OpenAI 실행
    ├── service.py                  # 후보 ID 검증·총점 합산·HTTP 변환·정렬·최소 기준 필터
    └── errors.py                   # 안전한 기능 실패
```

의존성 방향은 `router → service → agent → LangChain → OpenAI`입니다. 근거 색인은 Agent 없이
`router → service → OpenAI Embeddings/Qdrant`로 처리하고, 답변만 단일 typed Agent를 사용합니다.
`bootstrap.py`만 구체 OpenAI client와 model을 생성하고, 요청마다 Agent를 새로 만들지 않습니다.

## 실패 흐름

```text
요청 형식 오류
→ FastAPI/Pydantic 422

순위화 모델·HTTP·전체 실행 timeout
→ AgentTimeoutError (AgentExecutionError 하위 타입)
→ 상세정보 없는 내부 HTTP 504

OpenAI 거부·기타 SDK 오류·structured output 오류
→ AgentExecutionError
→ 상세정보 없는 내부 HTTP 503

후보 ID 누락·추가·중복
→ AgentExecutionError
→ 상세정보 없는 내부 HTTP 503

의미 검색의 전체 실행·임베딩·Qdrant 전송 timeout
→ SupportProgramIndexError(INDEX_TIMEOUT)
→ 내부 HTTP 504

상세 근거 청크 누락·Qdrant/임베딩 오류·payload 불일치
→ SupportProgramEvidenceError(EVIDENCE_NOT_READY 또는 EVIDENCE_UNAVAILABLE)
→ 상세정보 없는 내부 HTTP 503

상세 답변의 입력 밖 인용 ID·중복 인용·상태와 인용 배열 불일치
→ SupportProgramEvidenceError(EVIDENCE_UNAVAILABLE)
→ 상세정보 없는 내부 HTTP 503
```

사용자 질문, 공고 원문, API key와 OpenAI 원문 오류를 실패 응답에 포함하지 않습니다. Core는 다시
내부 응답의 ID·점수 범위·점수 합계·순서를 검증합니다. 부적합·정보 부족 판정을 `MATCH`로 바꾸거나
유효하지 않은 AI 출력을 정상 결과로 보정하지 않습니다. 재시도·fallback은 추가하지 않습니다.
순위화 실패 로그에는 `failure_kind`, 고정 `reason_code`, 오류 클래스명, 후보 수, 경과 시간만 기록합니다.
질문·기업 조건·프롬프트·응답 본문·API key·원문 예외 메시지와 traceback은 기록하지 않습니다.
`app` INFO 로그에는 의미 검색의 준비·임베딩·Qdrant 시간, 랭킹의 준비·모델·검증 시간과 캐시 상태·후보 수·
총시간을 남깁니다. 상세 근거 색인·검색 단계 시간과 캐시 사용량, 대화 해석·근거 답변의 모델 처리 시간,
SDK가 제공한 입력·출력·캐시 입력·추론 토큰 수도 기록합니다. 사용량을 받지 못한 실패의 토큰 수를 추정하지 않으며,
질문·회사 정보·원문·응답 본문·캐시 키는 기록하지 않습니다.
순위화의 `support_program_ranking_selection` 로그는 후보 수, 통과 수, 반환 수, 제외 사유별 건수와 반환 결과의
대상·지역 UNKNOWN 건수를 기록합니다. 제외 사유는 관련성 미달 → 대상 불일치 → 지역 불일치 순으로 한 번만
집계하므로 후보 수는 통과 수와 제외 세 건수의 합입니다. 모델 평가를 새로 수행한 경우만 기록하며 캐시 적중에는
기존 캐시 상태 로그를 사용합니다. 이 건수는 AI 판정 결과이며 사람이 검토한 정답이나 품질 지표가 아닙니다. lifespan이 기존 app/root handler를 재사용하거나 stderr
handler 하나를 추가하므로 기본 Uvicorn에서도 출력되며, OpenAI·HTTP 라이브러리 로그 수준은 바꾸지 않습니다.
조건 해석도 시간 초과는 내부 504, 그 외 실패는 503으로 구분합니다. 의미 검색은 확인된 시간초과만
`INDEX_TIMEOUT` 504로 반환하며 미준비·연결 오류 등은 기존 503을 유지합니다. 실패·취소 로그에는
`stage`(readiness/embedding/vector_search), 고정 코드와 경과 시간을 남깁니다. 상세 근거 답변과
색인 저장·prune의 오류 정책은 유지합니다.
`reason_code`는 후보 집합 불일치 `CANDIDATE_SET_MISMATCH`, 절단 본문의 확정 판정
`TRUNCATED_SOURCE_KNOWN_ELIGIBILITY`, 확정 판정 근거 누락 `MISSING_KNOWN_EVIDENCE`, 지정 본문
인용 불일치 `EXACT_QUOTE_MISMATCH`, 예상 밖 Agent 출력 타입 `UNEXPECTED_OUTPUT_TYPE`을 구분합니다.
번호 복원 단계의 범위·출력 검증 오류는 `INVALID_EVIDENCE_SELECTION`입니다.
SDK의 JSON 출력 검증 실패는 `MODEL_OUTPUT_INVALID_JSON`, 스키마·서버 검증 실패는
`MODEL_OUTPUT_SCHEMA_MISMATCH`로 구분하고 허용 목록의 검증 유형·필드명만 기록합니다. 후보 ID,
입력값, 임의 필드명이나 Pydantic 원문 오류는 기록하지 않습니다. 완성되지 않은 모델 응답처럼 출력
검증 이전에 발생한 그 밖의 실행 실패는 `EXECUTION_FAILED`이며 timeout 여부는 기존 `failure_kind`로
구분합니다. 이 로그만으로 이전 `ModelBehaviorError`의 세부 원인을 소급 확정할 수는 없습니다.
이 진단 코드는 HTTP 응답에 노출하지 않으며, 검증 기준이나 부적합 후보 처리 방식을 바꾸지 않습니다.

## 검색·근거 답변 LLMOps

검색 추적은 `Core 검색 → Elasticsearch/Qdrant 후보 조회 → 후보 병합 → AI 랭킹 → 최종 선정`을
같은 trace ID로 연결합니다. Core가 내부 HTTP의 `traceparent`를 만들고 Python이 검증된 ID만 이어받습니다.
`app/tracing.py`의 `LLMTracing`을 검색과 근거 답변이 공유하며 LangChain 자동 본문 수집은 켜지 않습니다.
검색 단계·캐시 상태·실제 모델/질의 임베딩 호출·제공된 사용량·프롬프트 해시와 최종 선택·제외 건수를 기록합니다.
허용된 공고 ID만 metadata로 수집하고 질문·기업 조건·공고 원문·프롬프트/응답 본문·예외 원문은 제외합니다.
캐시 적중과 동시 공유 요청은 모델 span을 중복 만들지 않습니다. 공유 랭킹의 `shared_source_trace_id`는
실제 호출을 시작한 요청을 가리킵니다. `usage_reported=false`는 미확정 사용량이며 0원이라는 뜻이 아닙니다.

Core와 AI 모두 같은 Langfuse 프로젝트로 활성화해야 전체 검색 경로가 연결됩니다. 단계 목록·설정·
Ops 화면의 **AI 실행 추적 ↗** 링크 사용법과 검증 범위는
[검색 추적 안내](../../infrastructure/llmops/README.md#지원사업-ai-검색-추적)를 따릅니다.

`LANGFUSE_ENABLED=true`일 때 상세 근거의 색인은 `evidence.index` 아래 준비·임베딩·upsert,
검색은 `evidence.search` 아래 준비·질의 임베딩·벡터 검색·결과 검증으로 기록합니다.
기존 point를 재사용하면 색인 임베딩·upsert span을 만들지 않으며, 질의 임베딩의 캐시 상태는 별도로 남깁니다.
`/chunks`, `/search`, `/answers` 세 HTTP 경로가 sampled W3C v00 `traceparent`를 검증해 Core 부모에 연결됩니다.
헤더가 없거나 잘못되면 새 trace를 만들고 `baggage`는 전달하지 않습니다. Core가 시작한 상세 답변은
`support-program-evidence`로 찾습니다. Core 외의 독립 호출은 해당 AI 관측 이름으로 찾습니다.

답변 Service의 `evidence.answer` 아래에는 LangChain 호출 `evidence.model`, 모델 출력·인용 번호 검증
`evidence.validate_selection`, Service 인용 검증 `evidence.validate_response`가 있습니다.
실패한 시점 이후의 단계는 생성하지 않으며 제공받지 못한 사용량은 `usage_reported=false`로 표시합니다.
HTTP 경로와 평가 실행기 모두 같은 추적 객체를 사용합니다. 고정 문맥 평가기는 색인·검색을 실행하지 않습니다.
질문·답변·청크 본문·예외 원문은 수집하지 않으며 전송 실패로 모델을 재실행하지 않습니다.
기본값은 비활성화이고 URL·키가 없는 활성화 설정은 시작 오류입니다.
기존 근거 API의 상세정보 없는 503 계약은 유지합니다. 새 trace를 품질 점수나 사람 검토로 취급하지 않습니다.
[상세 RAG 검증 범위](../../infrastructure/llmops/README.md#상세-공고-rag-추적-검증)를 참고하세요.

`langfuse`는 런타임 의존성입니다. pandas·Pandera·Evidently·Prefect는 `evaluation` 의존성 그룹으로 분리하고
AI API 이미지에 설치하지 않습니다. 저장 캡처로 다섯 도구를 연결하는 무료 배치와 실제 개발 서버 검증은
[LLMOps 실행 안내](../../infrastructure/llmops/README.md)를 따릅니다.

## 요청별 OpenAI 사용량 헤더

모든 OpenAI 호출(LangChain·openai-agents·임베딩)은 같은 OpenAI HTTP 클라이언트(`app.openai_usage.usage_http_client`)를 거칩니다.
그 응답 훅이 성공한 Responses·Chat Completions·Embeddings 응답의 `usage`를 지금 요청 목록에 더하고, `OpenAIUsageMiddleware`가 응답 머리에
`X-GovBiz-OpenAI-Usage`를 붙입니다. 값은 (모델, 처리 등급)별 합계의 JSON 배열
`[{"model","serviceTier","calls","inputTokens","cachedInputTokens","outputTokens"}]`이며 입력은 캐시를, 출력은 추론 토큰을 포함합니다.
처리 등급이 없는 응답(임베딩)은 `default`, Fast 모드는 OpenAI가 `priority`로 돌려줍니다. OpenAI를 부르지 않은 요청에는 헤더가 없고,
사용량을 읽지 못한 응답은 건너뛰고 경고만 남깁니다. 비용 계산과 저장은 Core(`aiusage`)가 맡습니다. 스트리밍 호출이 없어 응답 본문을
훅에서 먼저 읽어도 SDK가 같은 본문을 씁니다.

## 설정

```dotenv
OPENAI_API_KEY=필수
OPENAI_MODEL=gpt-6-luna
# 랭킹도 Luna로 비용을 낮추되 기존 추론 low와 Fast 옵션은 유지합니다.
OPENAI_RANKING_MODEL=gpt-6-luna
OPENAI_RANKING_REASONING_EFFORT=low
OPENAI_RANKING_SERVICE_TIER=priority
OPENAI_ASSISTANT_MODEL=gpt-5-nano
OPENAI_ASSISTANT_REASONING_EFFORT=low
OPENAI_ASSISTANT_AGENT_MODEL=gpt-6-luna
OPENAI_ASSISTANT_AGENT_REASONING_EFFORT=none
ASSISTANT_TOOLS_BASE_URL=http://127.0.0.1:8080
ASSISTANT_TOOLS_TOKEN=
ASSISTANT_AGENT_MAX_TOOL_CALLS=3
ASSISTANT_AGENT_TIMEOUT_SECONDS=15
ASSISTANT_TOOL_TIMEOUT_SECONDS=3
LLM_MODEL_TIMEOUT_SECONDS=25.0
LLM_RUN_TIMEOUT_SECONDS=30.0
LLM_COMBINATION_REVIEW_MODEL_TIMEOUT_SECONDS=60.0
LLM_COMBINATION_REVIEW_RUN_TIMEOUT_SECONDS=70.0
LLM_RANKING_MODEL_TIMEOUT_SECONDS=45.0
LLM_RANKING_RUN_TIMEOUT_SECONDS=50.0
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_TIMEOUT_SECONDS=5
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
OPENAI_EMBEDDING_REQUEST_TOKEN_LIMIT=262112
EMBEDDING_TIMEOUT_SECONDS=15
```

`OPENAI_MODEL`은 조건 해석·RAG 근거 답변의 모델입니다. 랭킹만 `OPENAI_RANKING_MODEL`로
별도 지정하며, 미입력·빈 값이면 기존 `OPENAI_MODEL`을 상속합니다. 랭킹 추론 수준은
`OPENAI_RANKING_REASONING_EFFORT`로 `none` 또는 `low`를 지정합니다. 미입력 기본값은 `none`이며
지원하지 않는 값은 기동 오류로 거부합니다. 공통 모델과 도우미 계획·답 모델 기본값은 `gpt-6-luna`이며,
위 예제와 루트 `.env.example`의 랭킹 모델도 같은 모델을 사용합니다. 기존 랭킹 추론은 예제에서 `low`,
미설정 실행에서 `none`을 유지합니다. 공식 API ID는 `gpt-6-luna`이며 `gpt-6.0-luna`를 사용하지 않습니다.
모델 변경만으로 토큰 수·응답시간 감소나 검색 정확도 유지를 보장하지 않습니다.
GPT-6 Luna의 Responses·구조화 출력·`none`/`low` 지원은 [OpenAI 공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-6-luna)를
기준으로 확인했습니다. 무료 스텁 테스트는 요청·출력 계약 검증이며 실제 검색 품질 측정이 아닙니다.
직접 생성하는 `SupportProgramRecommendationAgent`의 추론 기본값도 `none`으로 유지합니다.

도우미 자유 질문 분류(`app/assistant`)만 `OPENAI_ASSISTANT_MODEL`(기본 `gpt-5-nano`)과
`OPENAI_ASSISTANT_REASONING_EFFORT`(기본 `low`, `none`·`minimal` 허용)를 따로 씁니다. [의도 분류 평가](../../evaluation/assistant/README.md)
50문항에서 nano/low는 48개(luna/none 50개, nano/minimal 28개)를 맞혀 비용이 절반인 nano/low를 기본으로 두었습니다.
조건 해석·근거 답변·랭킹 모델은 바뀌지 않습니다.
도우미 도구 에이전트(`app/assistant_agent`)는 분류에 같은 nano/low를 쓰고, 계획·답에는 `OPENAI_ASSISTANT_AGENT_MODEL`
(기본 `gpt-6-luna`)과 `OPENAI_ASSISTANT_AGENT_REASONING_EFFORT`(기본 `none`, `low` 허용)를 씁니다. Core 내부 도구 API 주소는
`ASSISTANT_TOOLS_BASE_URL`(Compose는 `http://core-service:8080`), 공유 비밀은 Core와 같은 `ASSISTANT_TOOLS_TOKEN`(32자 이상)입니다.
비밀이 비어 있으면 도구 호출이 전부 실패로 기록되고 답이 강등되므로, 에이전트를 켤 때는 Core와 AI Service에 같은 값을 넣습니다.
이는 시작 시 선택하는 명시적 설정이며, 장애 시 다른 모델로 재시도하는 fallback이 아닙니다.
출력 축약은 미채택이며 기존 후보 ID·필드명·출력 계약을 유지합니다. 실험 구현은 평가 경로에만 보존합니다.
`OPENAI_RANKING_SERVICE_TIER` 미설정 시 코드·Compose 기본값은 `default`입니다. 위 예제와 루트
`.env.example`은 사용자 승인에 따른 Fast 상시 사용 프로필인 `priority`를 명시합니다.
Fast는 일반 처리보다 추가 요금이 있으며, 모델별 지원 범위와 단가는 공식 문서에서 확인해야 합니다.
[OpenAI 공식 Fast 문서](https://developers.openai.com/api/docs/guides/fast-mode)를 참고하세요.
이 설정은 랭킹 요청에만 적용하며 대화 해석·RAG 답변·임베딩 설정은 바꾸지 않습니다.
추론·후보 수·배점·출력/시간 상한·HTTP 계약도 유지합니다. 일반 처리로 돌아가려면
`default`를 명시하고 AI Service를 재시작하거나 Compose 컨테이너를 재생성합니다.
이전 Sol 프로필의 배포·실측은 [지역 충돌·Fast 기록](../../docs/region-conflict-fast-20260908.md)에 보존하며,
그 결과를 현재 GPT-6 Luna 프로필의 품질·속도 측정값으로 사용하지 않습니다. 기존 `.env`는 예제 변경으로 갱신되지 않으므로
`OPENAI_MODEL`, `OPENAI_RANKING_MODEL`, `OPENAI_ASSISTANT_AGENT_MODEL`을 `gpt-6-luna`로 반영하고
AI Service 이미지를 다시 빌드·실행해야 합니다. 과거 캡처·보고서·Langfuse 점수는 당시 모델 정보를 유지합니다.
Ops의 저장 캡처 재계산도 원래 모델명을 표시하며 새 모델의 품질 평가를 실행하지 않습니다.

순위화만 모델·HTTP `45s` < 전체 Agent `50s` < Core 순위화 읽기 `55s`의 별도 기본 제한을 사용합니다.
두 `LLM_RANKING_*` 값은 유한한 0초 초과·60초 이하이며 모델 제한이 전체 제한보다 작아야 합니다.
잘못된 값은 기동 오류로 거부하고 기본값으로 조용히 대체하지 않습니다. 변경 시 Core 읽기 제한과
상위 요청 제한도 함께 맞춰야 하며 AI 설정은 다른 서비스의 제한까지 자동 검증하지 않습니다.
같은 OpenAI client를 공유하되 역할별 모델을 사용하며, 순위화의 `ModelSettings.extra_args.timeout`으로 HTTP 제한을
요청별로 덮어씁니다. 이는 HTTP 옵션이며 OpenAI JSON 요청 본문에 추가되는 필드가 아닙니다.
중복 지원 검토는 긴 공식 원문과 최대 6,000 token 구조화 출력을 위해 모델·HTTP `60s` < 전체 Agent `70s` <
Core 전용 읽기 `75s`를 사용합니다. 두 `LLM_COMBINATION_REVIEW_*` 값은 유한한 0초 초과·120초 이하이며
모델 제한이 전체 제한보다 작아야 합니다. timeout은 내부 HTTP 504 `COMBINATION_REVIEW_TIMEOUT`과
민감한 원문·오류 메시지를 제외한 `failure_kind`, 오류 클래스, 사업·근거 수, `elapsed_ms` 로그로 구분합니다.
조건 해석·원문 근거 답변은 기존 모델·HTTP `25s`, 전체 Agent `30s`, Core 읽기 `35s`를 유지합니다.
기존 비순위화 timeout 환경변수는 0초 초과·30초 이하 이외의 값에 기존 기본값 대체 정책을 유지합니다.
시간 제한 분리에서는 모델·후보 20개·출력 상한 10,000 tokens·프롬프트·자격 검증을 변경하지 않았습니다.
후속 인용 번호 선택 변경은 LLM 내부 출력 형식과 관련 프롬프트만 바꾸며 배점·자격 검증은 유지합니다.
시간 제한 확장은 응답 성공이나 부하·운영 안정성을 보장하지 않으며 실제 검색 검증은 별도입니다.
색인·의미 검색은 별도 Core 읽기 제한을 사용합니다. AI batch/search 전체 제한은 `25s`, prune은
`15s`이고 Core 색인·검색 읽기 제한 기본값은 `30s`입니다. 이 구현은 임베딩을 재시도 없이 호출하며
한 문서 최대 8,191 tokens, 임베딩 API 요청당 최대 32개로 나눕니다. 긴 문서의 뒷부분은 이 단계의 후보
검색에서 제외될 수 있습니다. 토큰 계산은 두 지원 모델 공통 `cl100k_base`를 사용합니다.
Docker 이미지는 빌드 시 토크나이저 파일을 받아 런타임에 별도 다운로드가 필요하지 않습니다.

`OPENAI_EMBEDDING_REQUEST_TOKEN_LIMIT`은 전송 문자열 기준 **요청별** 토큰 상한이며 기본값은
262,112(32 × 8,191), 허용 범위는 1~262,112입니다. 낮추면 원문 순서를 유지하며 더 작은 배치로 나눕니다.
빈 문자열 또는 기존 8,191 토큰 절단 후에도 설정 상한을 넘는 단일 입력이 있으면 전체 입력 사전 검사에서
첫 OpenAI 호출 전에 오류를 반환합니다. 이 상한 때문에 문서를 추가로 자르지는 않습니다.
흐름은 `Core → AI Service → 입력 준비·토큰별 배치 → OpenAI → 사용량·벡터 검증 → Qdrant`입니다.
두 임베딩 서비스에 같은 검사를 적용하고 설정 변경은 서비스 재시작 시 반영합니다.

응답 `usage.prompt_tokens`와 `usage.total_tokens`는 bool·문자열·소수가 아닌 동일한 비음수 정수여야 하며
요청 상한 이하여야 합니다. 누락·불일치·상한 초과는 기존 오류 계약으로 반환하고 새 벡터를 캐시에
넣거나 Qdrant에 저장하지 않습니다. 로컬 토큰 추정과 제공자가 보고한 사용량은 구분합니다.
실패 직전까지 이미 보고된 사용량이 사라지거나 미보고 사용량이 0으로 바뀌면 안 됩니다.

근거 RAG에는 실제 HTTP 배치마다 `evidence.embedding.request` 관측을 남깁니다. 부모는
`evidence.index.embedding` 또는 `evidence.search.embedding`이며 모델·배치 순서/크기·추정 입력 토큰·상한과
보고 사용량을 기록합니다. 응답 유실·잘못된 사용량은 `usage_state=unknown`으로 남고, 캐시 재사용은
새 임베딩 관측을 만들지 않습니다. 원문·질문·API 키는 관측에 포함하지 않습니다.
이는 요청 제한과 사용량 관측이며 **Ops 누적 입력 예약·금액 한도·전체 RAG 예산 통제가 아닙니다.**
전체 RAG live 접수는 후속 승인·정산 연결 전까지 활성화하지 않습니다.

API의 입력·배치 한도와 사용량 필드는 2026-09-30 확인한
[OpenAI Embeddings API 문서](https://developers.openai.com/api/reference/python/resources/embeddings/methods/create),
토크나이저는 [임베딩 가이드](https://developers.openai.com/api/docs/guides/embeddings)를 기준으로 합니다.
현재 프로젝트의 보수적인 8,191/262,112 한도를 유지합니다.

`OPENAI_EMBEDDING_MODEL`은 `text-embedding-3-small`과 `text-embedding-3-large`를 지원합니다.
차원은 small 최대 1,536, large 최대 3,072로 검증합니다. 기존 순위화 OpenAI client를 공유하며
애플리케이션 종료 시 OpenAI와 Qdrant client를 모두 닫습니다.

## 설치와 실행

Python은 로컬·CI·Docker·평가 환경 모두 3.12를 사용하며 지원 범위는 `>=3.12,<3.13`입니다. 아래 명령은
`backend/ai-service`에서 실행합니다. 색인·의미 검색에는 `QDRANT_URL`에 Qdrant가 실행 중이어야 합니다.
`.python-version`을 기준으로 `uv sync`가 Python 3.12 가상환경을 구성합니다. 기존 3.11 가상환경도
다음 동기화 때 3.12로 다시 생성되므로 전역 Python을 변경할 필요는 없습니다.

Docker의 마지막 설치 단계는 `--reinstall-package govbiz-ai-service`로 현재 애플리케이션을
다시 빌드·설치합니다. [uv의 로컬 패키지 캐시](https://docs.astral.sh/uv/concepts/cache/#dynamic-metadata)가
소스 변경을 놓쳐 `/app/app`은 최신인데 `site-packages/app`은 구버전으로 남는 문제를 막고,
외부 의존성 캐시는 유지합니다. 재빌드 후에는 두 위치의 Python 파일 해시가 같은지 확인하고,
`python -I -B`로 작업 디렉터리·`PYTHONPATH`에 기대지 않는 설치본 import도 검증해야 합니다.

문서 도구의 npm 의존성 설치는 BuildKit 캐시와 `--prefer-offline`을 사용합니다. 캐시는 같은
빌더에서 받은 패키지를 재사용하며, 새 CI 실행기에 캐시가 없더라도 잠금 파일 기반으로 설치합니다.
`document-tools/npm-network-retry.sh`는 연결 끊김·DNS 일시 오류·시간 초과·일시적인 HTTP 오류에만
최대 3회 시도하고 2초·4초 간격으로 재시도합니다. 요청별 다운로드 제한은 60초이며 npm 내부의
중첩 재시도는 끕니다. 잠금 파일·인증·의존성·무결성 오류와 `npm run build` 실패는 재시도하지 않고,
네트워크 오류도 계속되면 원래 종료 코드로 실패해 이미지 발행·배포를 차단합니다.

```bash
uv sync --locked --extra dev
OPENAI_API_KEY=발급받은_키 \
uv run --locked --extra dev python -m uvicorn app.main:create_app --factory --reload --port 8000
```

## 검증

```bash
uv lock --check
uv sync --locked --extra dev
uv pip check --python .venv/bin/python
uv run --locked --extra dev python -m pytest
QDRANT_TEST_URL=http://localhost:6333 uv run --locked --extra dev python -m pytest tests/support_program_index
QDRANT_TEST_URL=http://localhost:6333 uv run --locked --extra dev python -m pytest tests/support_program_evidence
uv build
```

검색·상세 답변 테스트는 실제 LangChain 체인과 HTTP mock transport를 사용하므로 실제 OpenAI 네트워크를
호출하지 않습니다. 도우미 분류 테스트는 Agents SDK의 ScriptedModel을 사용합니다. 색인 테스트는 기본적으로 실제 Qdrant client의 로컬 메모리 모드를 사용합니다.
`QDRANT_TEST_URL`을 지정하면 같은 테스트를 실제 Qdrant 서버에서 실행하며, 테스트마다 독립적인
collection을 만들고 정리합니다. 현재 운영 collection은 테스트가 사용하지 않습니다.

최신 20개 밖의 관련 공고 조회, 재색인 중복 방지, 현재 해시와 검색 가능 목록 필터, 부분 실패 시
prune 차단, 다른 제공처 보존, 비정상 임베딩 거부를 검증합니다. 상세 근거 기능은 현재 청크 전체 색인,
공고 간 청크 ID 재사용 거부, 현재 내용 해시 필터, 입력 밖 Agent 인용 거부, 근거 부족 상태를 검증합니다.
테스트 임베딩은 HTTP mock으로 고정한 벡터이므로 실제 한국어 검색 정확도나 답변 품질을 측정한 결과로
해석하면 안 됩니다.

총점 합산·자격·필수 ID 키 출력 계약 수정 후 전체 테스트 185개가 통과했습니다. 실제 실패 산식의 합산,
부적합 양수 점수 거부, 20개 중 15개 ID만 고유했던 실패 패턴, 요청별 필수 ID 키·누락·추가 거부,
실제 SDK 요청의 strict schema, `UNKNOWN` 보존과
오류의 503 변환을 포함합니다. 이는 코드 회귀 검증이며 실제 검색 품질 평가 완료를 뜻하지 않습니다.

Agent 확장 원칙은 [AI Agent 모듈 구조](docs/agent-structure.md)를 참고하세요.

캐시 회귀는 전체 입력 변경·TTL 경계·LRU·반환값 변경 방어·동시 요청·취소·실패 재시도와 캐시가 있어도
현재 Qdrant를 다시 확인하는지 검증합니다. 별도 프로세스의 Uvicorn 설정으로 실제 stderr 출력·handler
중복 방지·라이브러리 INFO 비활성도 확인합니다. 이 검증은 실제 모델 품질·운영 부하 측정과 구분합니다.
과거 실행 수치와 실호출 범위는 [C02 기록](../../docs/conversation-condition-update.md),
[순위화 timeout·인용 기록](../../docs/support-program-ranking-timeout-fix.md),
[지역 자격 기록](../../docs/region-eligibility-scope-fix.md)을 참고하세요.

## 신청 원본 문서의 기입 위치 선택

`POST /internal/v1/application-preparations/document`는 `application-document-v1` 계약입니다.
Core가 보내는 확인 답변, 원본 문단·셀의 ID/문맥 또는 PDF 페이지 이미지를 단일 typed Agent가 대조합니다.
결과는 `placements(factId, targetId, box)`, `unmappedFactIds`, `clearExampleTargetIds`이며 답변 문안을 변경하거나 파일을 만들지 않습니다.
HWP/HWPX의 `exampleText`는 파란 글씨 후보입니다. 행·열 문맥과 의미로 기입란의 예시·작성 힌트를 구분하여 삭제 대상 ID를 선택하고, 제목·항목명은 보존합니다. 예시 후보가 있는 기입 대상은 명시적인 삭제 선택 없이는 거절합니다. 삭제 ID는 중복 없이 실제 예시 후보에 한정하며 PDF 삭제 요청은 거절합니다.

HWP/HWPX의 모든 파란 문구 후보는 답변 유무와 관계없이 `clearExampleTargetIds`(예시·작성 힌트 삭제) 또는 `preserveExampleTargetIds`(제목·항목명·필수 안내 보존)에 정확히 한 번 포함되어야 합니다. AI Service와 Core API 양쪽에서 누락·중복·교집합·알 수 없는 ID를 거절합니다. 체크박스 답변을 Core가 모두 처리한 경우에도 예시 후보가 있으면 빈 facts로 분류를 요청합니다. 파일 편집 후 삭제 대상으로 선택한 문단에 파란 문구가 남았는지 다시 검사합니다. 의미 분류의 정확도와 실제 한글 조판 품질은 별도 검수가 필요하며, PDF의 기존 문구 삭제는 지원하지 않습니다.
HWP/HWPX는 구조 ID, PDF는 페이지 영상의 왼쪽 위 기준 정규화 좌표를 사용합니다.
모든 사실은 정확히 한 번 포함해야 하며 미지원 ID, 중복/누락, PDF 영역 겹침·경계 초과를 거절합니다.
미매핑 항목은 Core에서 파일 생성 오류로 처리합니다. 실제 파일 쓰기와 소유자별 보관은 Core 책임입니다.
OpenAI 외 대체 경로나 성공 fallback은 없습니다. store와 tracing을 끄고 호출하며 오류는 503/504로 반환합니다.
HWP/HWPX 위치 응답이 서로 다른 답변을 같은 텍스트 칸에 배치한 경우에만 칸마다 첫 답변과 충돌하지 않은 배치를 고정하고,
나머지 충돌 답변을 고정된 대상을 금지한 한 번의 교정 요청으로 다시 배치합니다. 첫 응답과 교정 응답의 예시 분류가 모두
유효하지 않으면 facts 없는 분류 전용 요청을 한 번 사용합니다.
결합 결과도 전체 계약으로 다시 검증하며 여전히 중복되거나 미매핑이면 성공으로 보정하지 않고 실패합니다.
공유 계약 fixture와 ScriptedModel 테스트는 실제 양식의 위치 선택 품질을 보장하지 않습니다.
문서 생성 실패 로그에는 모델 호출/응답 검증 단계, 예외 종류, 고정 검증 사유, 입력 개수와 소요 시간만 기록합니다. 답변·문서 본문·외부 예외 메시지는 기록하지 않습니다.
기입 대상의 `kind`는 `TEXT` 또는 `CHECKBOX`이며, `groupId`는 선택 그룹입니다. 정확히 일치하는 유일한 체크박스 값은 Core에서 직접 처리하므로 AI 요청에는 남은 답변만 포함될 수 있습니다. 서로 다른 답변을 같은 HWP/HWPX 문단에 넣는 응답은 거절합니다.

## 신청 양식 발견 전용 timeout

신청 양식 발견만 `APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS`(기본 210초),
`APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS`(기본 240초)를 사용합니다. model < run을 기동 시 검증하며,
실제 OpenAI 요청에 전용 timeout을 전달합니다. 입력 해석·초안 작성·최종 문서 배치의 전역 timeout은 유지합니다.
Discovery configuration 응답은 두 값을 Core에 알려 Core read timeout(기본 270초)보다 작은지 검증하게 합니다.
실행 로그에는 공고 식별자, durationMs, AI_MODEL / AI_RUN timeoutStage를 기록하고 504 응답에도 단계를 제공합니다.
[운영값의 근거와 상태·재시도 정책](../../docs/application-form-availability.md)을 참고하세요.


공개 Google Form 질문 조회는 `skn-31`의 내부 읽기 전용 경로입니다. 별도 단기 stdio MCP를 사용하며 `DOCUMENT_INTERNAL_TOKEN`으로 Core ↔ AI 인증을 재사용합니다. 자세한 경계와 제한은 `docs/architecture.md`를 참고합니다.
