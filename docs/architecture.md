# GovBiz 서비스 호출·데이터 흐름

[문서 목록](README.md) · [아키텍처 README](architecture/README.md)

신청 문서의 새 `pipelineVersion`에서 기존 저장 지도와 binding 주소·편집 scope가 달라지면 Core는 자동 작성을 `APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED`로 중단하고 비교·승인 토큰을 해당 작성본 소유자에게 전달한다. 승인하면 그 작성본만 새 양식 스냅샷을 참조하며 기존 답변·revision·파일과 다른 사용자의 지도는 유지한다. 같은 binding과 scope이면 새 지도만 갱신한다.

신청 문서의 입력칸별 질문 흐름은 공식 첨부 → OpenAI 질문 추출 → native 입력 영역 매핑 → Core 양식 스냅샷 → 질문 UI로 이어진다. 선택 문항의 미지원 위치는 공개 `fields[].documentWritable=false`로 표시한다. 문서 생성에서는 binding이 있는 저장 답변만 형식별 편집 경로로 전달하고, 미기입 답변은 생성 파일과 revision에 연결된 불변 스냅샷으로 목록·다운로드 화면에 표시한다. 포괄적인 이전 질문의 재분석은 기존 discovery-jobs API를 명시적인 클릭으로 호출하며 기존 작성본·답변을 유지한다. 세부 경계는 [신청 문서 MCP 구조](application-document-mcp-architecture.md)를 참고한다.

현재 production 코드의 서비스 경계와 실행 흐름을 설명합니다. 계층·DI·디자인 패턴은
[아키텍처 README](architecture/README.md), 기술·버전은 [기술 구성](technology.md),
완료 기능과 남은 제약은 [구현 현황](implementation-status.md), 환경 설정은
[인프라 README](../infrastructure/README.md)를 참고하세요.

## 웹·앱 공통 코드

`frontend/web`와 Expo React Native `frontend/mobile`은 `frontend/packages/shared`의 domain·유스케이스·DTO 검증을 가져옵니다.
모바일 발표 배포는 `모바일·shared 소스 → EAS Cloud Build → Android APK → Firebase App Distribution → 설치`로 진행합니다.
설치된 앱의 업무 호출은 기존 공개 HTTPS API·Core·AI 경로를 사용하며 Firebase는 회원 인증·업무 DB를 소유하지 않습니다.
프로젝트·환경변수·빌드·실기기 확인은 [Android APK 배포 안내](mobile-app-distribution.md)를 참고하세요.
색·모서리 디자인 토큰(`design/tokens.ts`)도 shared 한 곳에 두고, 웹은 이 값으로 만든 Tailwind `@theme` 파일을, 모바일은 값을 그대로 씁니다.
요금제 가격·혜택·출시 안내·FAQ는 shared `design/pricingContent.ts`에서 웹과 모바일이 함께 읽습니다.
화면 이름은 shared `design/screenTitles.ts`를 웹의 routes/screenTitles와 모바일 메뉴·Stack·도우미가 함께 읽습니다.
경로 매핑과 짧은 하단 탭명은 플랫폼이 소유하며, 도우미의 쿼리별 화면 이름은 앱 내부 표시 정보로만 사용하고 HTTP context에는 넣지 않습니다.
모바일은 `비로그인 요금제 탭 또는 메뉴 → PricingScreen → shared 표시 내용`으로 무료·플러스·프리미엄을 전환합니다.
비로그인은 플러스를 먼저 보여 주고 개인 이용량을 조회하지 않습니다. 로그인 회원은
`PricingRoute → usePlanUsage → shared PlanUsageUseCase → 모바일 Repository → apiRequest → GET /api/v1/plan-usage`
로 읽고 shared `planUsageSchema`로 검증한 현재 플랜·체험 출처·종료일을 화면에 전달합니다.
최초 응답은 현재 플랜을 선택하되 직접 고른 탭과 이후 갱신의 선택은 유지합니다. 계정이 바뀌면 선택을 초기화합니다.
현재 카드와 비교 목록은 "이용 중"·"체험 중"으로 강조하고 종료일은 shared `planEndsText`를 사용합니다. 30일 상품 가격과 체험 종료일은 구분합니다.
조회 중·실패·재시도를 표시하며 실패를 추천 플랜으로 대신하지 않습니다. 읽기 전용 이용량 바로가기는 기존 내 프로필으로 이동합니다.
`usePlanUsage`는 활성화·앱 전경 복귀·명시적 재조회와 가장 가까운 미래의 플랜/사용량 기간 종료에 다시 읽습니다.
요금제·내 프로필은 화면 포커스로 활성화를 제어하며 비활성화·백그라운드·계정 변경·언마운트 시 요청과 타이머를 취소합니다.
긴 타이머는 나누어 예약하고 같은 종료 시각의 자동 조회는 반복하지 않습니다. 기기 시각으로 플랜을 변경하지 않고 서버 응답을 따릅니다.
비로그인 `/pricing`과 로그인 후 메뉴 안의 `/all/pricing`은 같은 화면을 사용하고 결제·구독 API는 추가하지 않습니다.
공고 호출은 `웹/앱 화면 → 공통 유스케이스 → 플랫폼 Repository → 공통 공고 HTTP 클라이언트 → Core API`
로 이어집니다. 공통 클라이언트에는 공개 API 주소와 fetch만 주입하며 Vite/Expo 환경변수·브라우저 저장소·React를 참조하지 않습니다.
웹은 기존 쿠키 설정을 유지하고 앱의 세션 저장·네비게이션은 모바일 쪽에서 담당합니다.
모바일 비로그인 하단은 검색·협업·요금제·메뉴 4탭이며 공개 검색과 모집글·요금제 조회를 허용합니다. 메뉴는 모든 기능을 노출하되
개인 기능은 로그인 안내를 먼저 열고 확인된 인증 뒤 해당 라우트로 이동합니다. 확인된 로그인 뒤에는
검색·관심함·리포트·메뉴 4탭과 `app/(tabs)/all`의 기존 계정·기업·알림 설정·신청 준비·협업 화면으로 연결합니다.
모바일의 일반 계정 로그인은 메인 검색으로 이동하고, 공고 저장·결과 복원처럼 선택한 작업이 있는 로그인은 해당 작업을 이어갑니다.
협업 탭에서 로그인하면 기존 All Stack으로 이동하며 선택한 view·box·mine을 보존합니다. 메뉴는 모집글과 파트너 관리로 연결하며
파트너 관리 안의 받은/보낸 제안·내 모집글은 기존 제안함/모집글 Bearer API를 재사용합니다. 메뉴는 기존 화면·Bearer API·공통 DTO를 재사용하며 서버 계약은 바꾸지 않습니다.
협업 머리글의 연필은 모바일 `/partner/new`로 연결합니다. 작성은 `RecruitmentCreateScreen → mobile api/partners의 createRecruitment
→ shared CreatePartnerRecruitmentUseCase → 모바일 Bearer HTTP 요청 → 기존 Core 모집글 API`로 이어집니다.
API 경계에서 shared DTO 검증·Mapper를 사용하고, 등록 결과의 공고 복합 식별자·본인 글 여부를 확인한 뒤 기존 상세 화면으로 이동합니다.
본인 모집 중인 글의 수정은 `/partner/edit?id={id}`에서 같은 네이티브 폼을 사용합니다.
`RecruitmentCreateScreen(수정 모드) → mobile api/partners의 updateRecruitment → shared UpdatePartnerRecruitmentUseCase
→ 모바일 Bearer PUT /api/v1/partners/recruitments/{id} → 기존 Core PartnerRecruitmentController → PartnerRecruitmentService → Repository`
로 이어집니다. API 경계에서 DTO를 내부 모델로 변환하며 화면은 연결 공고를 고정하고 작성자·모집 상태를 확인합니다.
저장 성공·취소 후 앱 상세로 복귀하며 공개 HTTP·DB 계약은 변경하지 않습니다.
관심 공고 선택 시트는 기존 관심 공고 API를 사용하며, 접수 상태와 서울 기준 마감일은 작성 시 다시 확인합니다.
기존 웹의 domain/model 파일은 공통 구현을 재수출하므로 두 구현이 따로 변경되지 않습니다.
신청 문서 결과의 최신 생성 답변 버전 분류와 파일 형식 표시는 shared `ApplicationDocumentFiles`가 담당합니다. 웹·앱 모두 각 파일 카드의 `초안 다운로드` 하나로 선택한 파일을 원래 형식·파일명 그대로 받고 이전 버전은 접어 둡니다. 화면에 상단·하단 통합 다운로드나 ZIP 묶음 동작을 중복 제공하지 않습니다. 웹은 기존 인증 binary API와 브라우저 다운로드를 사용합니다. 모바일은 `화면 → mobile api/applicationPreparation의 링크 발급·DTO 검증 → Bearer POST → ApplicationDocumentController → ApplicationDocumentDownloadLinkService → 파일 Repository·Redis`로 2분 파일 전용 링크를 받고, 시스템 브라우저 GET에서 계정 Repository·파일 Repository로 현재 소유권을 다시 확인한 attachment를 내려받습니다. 상대 경로·식별자 검증과 URL 변환은 모바일 HTTP 경계, 공개 응답 경로 구성은 Core controller/dto가 소유합니다. TXT 공유의 기기 임시 파일·공유 화면은 모바일에 남깁니다.
모바일 기업·관심 공고·가입 이메일 인증의 HTTP 호출·응답 검증·DTO 변환은 `src/api` 경계가 담당하며 화면은 내부 모델을 받습니다. 문서의 실제 기입 가능 답변 판단은 shared `isWritableApplicationAnswer`를, 원본 저장·답변 기입·수동 작성 안내는 `applicationDraftMode`를 웹·앱에서 재사용합니다. 필수 답변 일부가 비어 있어도 저장된 답변으로 초안을 만들고, 전부 비어 있거나 미정이면 기존 Core 생성 규칙에 따라 AI 호출 없이 공식 원본을 저장합니다. 실제 수동 작성 답변만 있는 경우는 원본 반환으로 숨기지 않고 기존 서버 오류를 표시합니다.
모바일 기업의 협업 설정은 `CompanyScreen → CompanyPartnerProfileSection → mobile api/company → 기존 Core CompanyController → CompanyService → CompanyPartnerProfileRepository`로 조회·저장합니다.
API 경계에서 shared `CompanyDto`의 schema·Mapper로 내부 모델을 만들며, 저장 입력은 기존 `UpdateCompanyPartnerProfileUseCase`의 검증·정규화를 거칩니다.
편집 시트·취소 확인과 요청 수명은 해당 계정·기업으로 구분한 모바일 컴포넌트가 소유합니다. 서버 HTTP·DB 계약과 웹 구현은 변경하지 않습니다.
모바일 생성 결과의 수동 상태 확인은 `ApplicationDocumentScreen → ApplicationPreparationUseCase.documentJob → mobile api/applicationPreparation → 기존 Core 작업 GET`으로 연결합니다.
조회 실패에는 목록·기존 화면에서 확인한 UNKNOWN 상태를 유지하고 새 생성을 막습니다. 접수 미확인은 기존 보관 요청 키·답변 revision을 재사용하며 새 사용량·차감 정책은 추가하지 않습니다.
모바일 공고 상세는 `ProgramScreen → readProgramDetail → shared 공고 HTTP Client → Core`로 읽고 모바일 API 경계에서 shared Mapper로 내부 모델을 만듭니다.
원문 질문 예시는 입력만 채우고 명시적인 질문 전송에만 기존 answers API를 호출합니다. 답변 이력은 공고·계정별 화면 상태이며 서버에 새 대화 저장 계약을 추가하지 않습니다.
원문 질문의 닫기 확인·명시적 중지·입력 보존은 `ProgramScreen`이 소유합니다. `PartnerSheet`의 닫기·배경·기기 뒤로가기는
같은 확인 흐름으로 연결하며 중지 시 기존 HTTP 요청의 `AbortController`를 취소하고 늦은 응답을 버립니다.
계정·공고·새 요청의 수명이 바뀌면 이전 닫기 확인을 폐기합니다. 서버 작업 중단이나 비용 취소 API는 추가하지 않습니다.
모바일 관심함의 검색·다중 필터·정렬·달력은 검증된 관심 공고 모델을 로컬 화면에서 처리합니다. 공고 검색과 관심함의 조건은 한 시트에서 고르며
공고 검색의 `CatalogScreen`은 시트의 임시 선택과 적용 조건을 분리합니다. 시트에서 고른 조건은 `적용`을 눌렀을 때 기존 `BrowseSupportProgramsUseCase → 공통 공고 HTTP 클라이언트 → Core catalog API` 조회 경로로 전달합니다.
시트의 닫기·초기화는 적용 전 검색 결과를 바꾸지 않습니다. 관심함은 기존 로컬 필터를 사용합니다. 수신 설정의 보기/수정 분리는 기존 리포트 settings PUT과 주소 확인 POST를 그대로 사용하고,
알림 설정은 리포트 앱 알림에서 진입합니다. 공고 상세에서 준비 화면으로 이동할 때의 복귀 메타데이터는 모바일 내비게이션만 사용하며 HTTP·DB 계약에 전달하지 않습니다.
목록·진행 관리의 단계 변경은 기존 `ProgressStageSheet → updatePreparationProgress → Core progress-stage API`를
사용하며 문서별 진행 revision과 복합 공고 식별자를 검증합니다. 웹·공개 HTTP 계약과 shared DTO는 변경하지 않습니다.

모바일의 `auth/AppEntryGate`는 세션 복원과 기기 소개 기록을 확인하고 첫 실행 소개 또는 기존 화면으로 연결합니다.
기기 저장은 `auth/introductionStorage.ts`, 로그인 안내·폼·선택한 작업의 재개는 `auth/loginFlow.tsx`의 `LoginFlowProvider`가 소유합니다.
`MenuScreen`의 기능 소개 다시보기는 배포 앱에서도 `WelcomeScreen`을 모달로 재사용합니다. 가입·로그인 진입 대신 닫기를 제공하고 완료 기록·세션·메뉴 위치를 유지하며 앱 재로드나 기록 초기화를 하지 않습니다.
`screens/WelcomeScreen`은 진행 바의 5초 채움과 자동 전환, 가로 스와이프를 담당하며 마지막 장의 바까지 채운 뒤 멈춥니다. 이동 버튼·진행 표시 선택은 제공하지 않습니다.
드래그·백그라운드·진입 처리 중에는 채움과 전환을 함께 멈추고, 재개 시 현재 장의 5초를 다시 시작합니다.
`AppEntryGate`는 가입·로그인 시트가 열린 동안 자동 전환을 보류하고 취소 시 다시 시작합니다.
로그인은 기존 화면 위의 네이티브 모달이며 라우트 이동 없이 취소·복귀합니다. 소개 화면과 가입 후 회원 유형 온보딩은 별개입니다.
메뉴 상단 로그인도 기존 `MenuRoute → LoginFlowProvider` 경로를 사용하고 로그아웃은 `MenuScreen → auth.signOut → 기기 세션 정리 + 기존 mobile logout API`로 처리합니다. 서버 세션·푸시 연결 종료 실패는 메뉴에 표시합니다.
소개의 가입 버튼은 기존 가입 폼, 기존 계정 링크는 로그인 방법 시트를 엽니다. 시트와 인증 폼의 `auth/SocialLoginOptions`는
기존 설정·네이티브 빌드 조건과 공개 providers 응답을 모바일 API 경계에서 검증한 뒤 실제 카카오·Google 버튼을 같은 디자인으로 표시합니다.
공급자 조회 실패는 오류·수동 재시도로 안내하며 이메일 인증은 유지합니다. 소셜 인증은 두 화면에서 기존
`session.signInWithOAuth → oauth.openOAuthLogin → Core 모바일 OAuth authorize/exchange`를 사용합니다.
인증 실행 중에는 중복 실행·다른 인증 방법 진입·닫기를 막고 브라우저 취소는 보던 시트를 유지합니다.
선택한 작업 재개는 기존 `LoginFlowProvider`가 확인된 세션을 받은 뒤 한 번 실행하며 HTTP·세션 계약은 변경하지 않습니다.
소개 예시와 실제 AI 검색은 `components`의 조건·결과 카드 모양을 재사용하며
실제 검색의 상태·요청 수명은 `screens/ChatScreen`이 소유합니다. 로그인 전후 같은 UI를 사용하고 유료 요청 조건은 유지합니다.
대화 스크롤도 `ChatScreen`의 화면 상태로 관리하며 새 내용의 배치와 스크롤 영역 크기를 확인한 뒤 해당 영역의 시작으로 한 번 이동합니다.
`SearchScreen`은 AI 패널의 표시 여부를 전달해 숨겨진 패널의 이동을 보류하며 입력 수정·단순 복귀에서는 위치를 유지합니다.
선택한 공개 검색 결과는 `ChatScreen → shared RestoreSupportProgramSearchUseCase → mobile api/searchResults
→ shared 공고 HTTP 클라이언트 → Core 결과 복원 API`로 읽습니다. 모바일 API 경계에서 shared Mapper로 DTO를 내부 모델로 변환하고,
화면은 복원 결과·만료·조회 실패를 구분합니다. 취소·계정 변경은 이전 요청과 작업 재개를 폐기합니다.
Core HTTP·DB 계약과 shared 계약은 변경하지 않으며 로그인·화면 복귀만으로 검색이나 원문 질문을 다시 실행하지 않습니다.
[공동 관리와 검증 명령](mobile-monorepo.md)을 참고하세요.

모바일 검색의 재시도 대기와 오류 구분은 `shared supportProgramApi의 검증된 오류 → mobile api/client → ChatScreen`으로 전달합니다.
시간 초과·연결 종료로 결과가 미확인된 재전송은 사용자 확인을 거치며 자동 재호출하지 않습니다.
검색 성공 후 전체 결과 복원이 실패하면 기존 결과 토큰을 저장하고 `restoreSearchResults`만 재호출합니다.
게스트의 로그인·가입 뒤 결과 확인도 같은 복원 경로를 사용하며 새 검색·사용량 정책이나 공개 HTTP 계약을 추가하지 않습니다.
카드의 지역 안내는 shared 지역 정규화를 이용한 분류 비교이며 공고 제외나 신청 불가 판정에 사용하지 않습니다.

모바일 계정 관리는 `AccountScreen → mobile api/account의 DTO 검증·내부 모델 변환 → 기존 Core AccountProfileController → Service → Repository`로 연결합니다.
삭제 미리보기와 명시적인 삭제 확인을 구분하고 서버 삭제 성공 뒤 기존 `AuthProvider.invalidateSession`으로 기기 세션을 정리합니다.
비밀번호 찾기는 기존 공개 인증번호 발송·확인·재설정 API를 호출하며 재설정 통행 토큰은 가입 인증 타입과 구분합니다.

모바일 정책·도움말의 기존 연결은 `MenuScreen / AccountScreen → ServiceInformationSheet → content/serviceInformation`입니다.
현재 약관·처리방침은 미확정 초안이고 문의처도 미정이므로 skn-501에서 두 화면의 진입점·시트 연결을 주석 처리했습니다.
메뉴(비로그인·로그인·세션 복원 실패), 내 프로필, 회원가입 폼에서는 세 안내와 정책 초안 문구를 표시하지 않습니다.
본문·시트 구현은 모바일 소스에 보존하되 화면에서 가져오거나 호출하지 않습니다. 확정 후 복원 범위는 [모바일 README](../frontend/mobile/README.md#정책도움말문의-안내)를 참고하세요.

앱 이메일 인증은 `AccountMobileAuthController → 기존 로그인/가입 Service → AccountRepository → MyBatis → MySQL`이며,
네이티브에서 받은 Bearer JWT도 웹과 같은 DB 세션 만료·폐기 규칙을 사용합니다. 웹은 HttpOnly 쿠키를 유지하며,
쿠키와 Bearer가 함께 오면 쿠키를 우선하고 Origin 검사를 그대로 적용합니다.
소셜 로그인은 `앱 시스템 브라우저 → AccountMobileOAuthController → AccountMobileOAuthService → 기존 OAuthService/Client → 공급자`
를 거쳐 기존 HTTPS 서버 callback으로 돌아옵니다. 서명 state 쿠키와 V40 MySQL transaction의 일회용 선점이 콜백 재사용을 막습니다.
허용된 앱 URI에는 60초 일회용 코드만 전달하고, 앱의 PKCE S256 검증 뒤 코드 소비·세션 생성을 같은 DB transaction에서 처리합니다.
OAuth 외부 호출 중에는 DB transaction을 열지 않습니다. [정확한 인증 API와 설정](../backend/core-service/README.md#모바일-인증-계약)을 참고하세요.

## 서비스 경계

소스 폴더는 `backend/{core-service,catalog-service,ai-service,ops-service}`로 통일합니다.
Compose 서비스·내부 DNS는 `core-service`·`catalog-service`·`ai-service`·`ops-service`를 사용합니다.
Core ECR 경로는 `govbiz/core-service`, Ops Kubernetes 리소스명은 `ops-service`, Ops DB 서비스는 `ops-mysql`입니다.
health 응답은 각각 `govbiz-core-service`·`govbiz-ops-service`이며 현재 운영 환경은 없습니다.
아래의 Core API는 `core-service`가 제공하는 HTTP API를 뜻합니다.

저장소는 React·Core API·Catalog Service·AI Service·Django Ops를 함께 관리하는 모노레포입니다.
`frontend/web`의 React가 `/ops` 운영 화면을 제공하며 기존 Core 관리자 로그인과 세션 쿠키를 공유합니다.
`backend/ops-service`는 Python 3.12의 Django와 전용 MySQL로 인증·평가 실행·이력·보고서 API를 제공합니다.
`ops-sync`는 동일한 Django 이미지로 기존 Prefect 실행 상태를 주기적으로 확인해 Ops DB에 반영합니다.
React는 관리자별 탭 저장소에 접수 명세를 보관해 새로고침·재로그인 뒤 같은 UUID를 먼저 조회합니다.
Django는 데이터셋 기준 행 잠금으로 기준 변경과 접수를 직렬화하고 승인 버전·변경 이력을 보존합니다.
파일 검증은 잠금 밖에서 수행하고 버전·검토를 DB에서 재확인한 뒤 커밋 후 Prefect에 전송합니다.
사례 검토는 `React 판단·사유 → Django 관리자/CSRF·해시·검토 버전 확인 → MySQL 불변 이력`으로 저장합니다.
필수 사례 전체가 현재 검토 기준에서 적합이어야 전체 승인할 수 있으며, 승인은 사용한 사례 기록을 참조합니다.
사례 판단 변경은 실행의 검토 버전을 올리고 기존 승인 자격·활성 기준을 해제합니다. 이전 이력과 이미 접수한
평가의 기준 스냅샷은 보존합니다. 기존 전체 승인만 있는 기준은 재검토 전 새 접수에 사용할 수 없습니다.
React 목록은 DB 결과와 마지막 확인 시각을 읽으며 상세 방문 없이 갱신됩니다. 새 모델 실행을 생성하지 않습니다.

`운영자 → React → /api/v1/ops 프록시 → Django 인증·평가 Service → Prefect API → 상시 평가 실행기 → Langfuse / Evidently`로 연결하며,
평가는 HTTP 요청 밖에서 실행합니다. Django는 요청 UUID·기준/후보 캡처·실행 상태·요약·비교를 저장하고 상세 조회 때 Prefect 상태를 반영합니다.
Ops와 실행기가 공유하는 캡처 목록으로 가상 6건 재현 또는 과거 두 실행의 공통 E01 비교를 선택합니다.
원본 캡처를 먼저 검증한 뒤 지정된 같은 사례만 비교하고, 모델 호출 없이 지표 차이와 실행 정보를 React에 표시합니다.
새 응답 생성 모드는 `React 자료·예산 확인 → Django 관리자·CSRF·승인 조건 검증 → Prefect → 기존 평가 실행기 → Service → Agent → OpenAI`를 거칩니다.
생성한 캡처를 위 비교 파이프라인에 전달하고 모델 호출 시도 수·토큰·지연·사례별 Langfuse 추적 링크를 표시합니다.
두 서버의 `LLMOPS_LIVE_ENABLED`가 기본 false이며 키는 실행기에만 주입합니다. 질문당 최대 1회·출력 2,000토큰으로 제한하고 자동 모델 재호출은 없습니다.
요청 UUID의 결과 디렉터리를 배타 생성하므로 Prefect 수동 재실행도 기존 유료 실행을 반복하지 않습니다. 모델 호출 실패 시 부분 기록을 보존합니다.
평가 실행기와 Django는 결과 볼륨을 공유하며 Django에는 읽기 권한만 부여합니다.
Django는 매 요청 `govbiz_session` 쿠키를 Core `GET /api/v1/admin/session`에 전달합니다.
Core의 `AdminPrincipalArgumentResolver → AccountSessionService`가 세션·현재 `ADMIN` 권한을 확인하며
익명·만료는 401, 비관리자·정지는 403, Core 장애는 503으로 접근을 거절합니다.
회원 DB·JWT 서명 키는 Core만 소유하고 Django에는 실행 요청자 연결용 `core:{회원 ID}`를 저장합니다.
기존 `/login`에서 로그인 후 Ops로 복귀하고 Core 로그아웃도 공유합니다. Langfuse 자체 UI의 로그인은 별도입니다.
아래 AWS 운영 경로에는 Ops를 추가하지 않았습니다.
[소스 통합과 로컬 실행](ops-monorepo-migration.md)을 참고하세요.

루트 `compose.yaml`은 `infrastructure/compose.catalog.yaml`을 포함해 공고 카탈로그 분리를 기본 적용합니다.
Catalog는 별도 프로세스·DB로 네 제공처 수집, 정규화, 검색 색인과 공개 snapshot을 소유합니다.
기업마당 공식 API의 사업신청방법·사업신청URL과 K-Startup 공식 API의 신청방법 필드는 Catalog의 신청 경로로 정규화해 저장합니다.
`sourceUrl`은 공고 상세 주소로 유지하며 신청 URL이 없을 때 대체하지 않습니다. Catalog 내부 snapshot이
신청 경로를 Core projection에 전달하고 Core 상세 응답의 `applicationRoute`가 이를 노출합니다.
신청 준비의 온라인 입력 안내는 소유권과 공고의 `applicationRoute`를 확인합니다. 공식 경로가
`GOOGLE_FORMS`이면 `ApplicationPreparationService → ApplicationOnlineFormMcpClient → AI 공개 Form Reader MCP`로
실제 질문을 읽고, 검증된 payload를 Client의 Mapper에서 내부 Source로 변환합니다. 고정 Manifest의
결정적 review와 저장된 확정 Fact로 실제 질문 순서의 복사 안내를 만들며, MCP 외부 호출은 DB transaction 밖에서 수행합니다.
다른 경로는 기존 Manifest 기반 안내를 유지합니다. 답변 입력과 제출은 공식 신청 화면에서 사용자가 직접 수행합니다.
웹의 새 신청 문서 화면은 공식 경로가 `GOOGLE_FORMS`인 공고를 양식 조회·입력칸 분석(유료 AI) 없이 ②에서 구글 설문 답변
미리 채우기로 보여 줍니다. 호출 흐름은 `ApplicationGoogleFormController → ApplicationGoogleFormService →
ApplicationOnlineFormMcpClient → AI 공개 Form Reader MCP`이며 설문 주소는 요청이 아니라 공고의 공식 신청 경로에서만 가져옵니다.
화면은 응답 주소와 문항(`entry` 번호·유형·선택지)을 받아 기업 정보(기업명·사업자등록번호·소재지·업종·설립연도·홈페이지)와
계정 이메일로 채울 수 있는 단답·장문 칸을 먼저 채우고, 사용자가 고친 답으로 구글 설문의 미리 채워진 링크
(`viewform?usp=pp_url&entry.{번호}=값`)를 브라우저에서 만들어 새 창으로 엽니다. 답은 Core로 보내거나 저장하지 않으며 제출은
사용자가 구글 설문에서 직접 합니다. 날짜·파일 업로드처럼 링크로 채울 수 없는 문항은 구글 설문에서 직접 답하도록 표시합니다.
2026-10-01 접수 중(상시 포함) 구글 설문 공고 78건 기준 문항을 읽어 미리 채울 수 있는 설문은 35건(여러 페이지 설문 포함)이고,
35건 모두 테스트 답을 담은 링크를 구글이 그대로 받아들였습니다(제출 없이 응답 화면의 `partialResponse`로 확인).
구글 로그인이 필요해 익명으로 읽을 수 없는 설문은 38건, 마감 3건, 문항 없는 안내만 남은 설문 1건이었습니다.
읽지 못하면 이유와 함께 설문을 그대로 여는 링크만 둡니다.
공고 상세의 신청 문서 작성 줄은 구글 설문 공고에서 "구글 설문 답변 미리 채우기"로 바뀌고 설문 링크도 함께 둡니다.
공식 신청 주소가 있는 다른 공고는 원문 링크 옆에 "신청 사이트 열기" 링크를 둡니다.
이미 만든 신청 준비의 온라인 입력 안내와 확정 답변 TXT는 그대로 둡니다.
K-Startup은 2026-10-01 실제 공고 응답 200건으로 신청방법 필드(`aply_mthd_onli_rcpt_istc` 온라인,
`aply_mthd_eml_rcpt_istc` 이메일, `aply_mthd_vst_rcpt_istc` 방문, `aply_mthd_pssr_rcpt_istc` 우편,
`aply_mthd_fax_rcpt_istc` 팩스, `aply_mthd_etc_istc` 기타)를 확인했습니다. 온라인 값이 https 주소 하나면 신청 URL로,
나머지는 "이메일 접수: …"처럼 신청방법 문장으로 남기고 경로 분류는 기업마당과 같은 규칙을 씁니다. 안내 페이지인
`biz_gdnc_url`과 상세 `detl_pg_url`은 신청 URL로 쓰지 않습니다. MSIT·충남 공고는 대응 필드를 검증하지 못해 `UNKNOWN`입니다.
신청 경로는 검색 문서·임베딩에 넣지 않으며 URL 분류 중 외부 접속을 하지 않습니다.
같은 경로로 공식 문의처(K-Startup `biz_prch_dprt_nm`·`prch_cnpl_no`, 기업마당 `refrncNm`)와 K-Startup 우대 사항(`prfn_matr`)·
주관 기관 유형(`sprv_inst`)을 Catalog V3 → snapshot → Core V51 → 상세 응답의 `contact`·`preferenceDescription`·
`supervisingInstitutionType`으로 전달합니다. 2026-10-04 실제 응답 표본에서 전화번호는 하이픈 없는 숫자, `sprv_inst`는
공공기관·민간·교육기관·지자체 분류였고 `prfn_matr`는 최근 공고에서 비어 있었습니다. 전화번호 표시 형식과 `tel:` 연결은
화면의 shared 규칙이 정하며, 이 필드도 검색 문서·임베딩·공개 지문에 넣지 않습니다.
Core는 `CatalogProjectionScheduler → Service → 인증된 HTTP Client → Catalog`로 완전한 응답을 받은 뒤,
Service가 짧은 transaction을 시작한 뒤 `CatalogProjectionRepository → MyBatis → Core MySQL`로
조회용 복제본·신청서 분석 등록·checkpoint를 함께 갱신합니다. HTTP 수신은 transaction 밖입니다.
기존 관심 공고·파트너 모집의 FK와 공고 숫자 ID는 유지하며 서로의 DB에 직접 연결하지 않습니다.
Core 공개 API는 적용 완료된 복제본을 읽습니다. 인증·통신·검증 실패 시 기존 복제본을 유지하고 실패를 기록합니다.

이 모드에서 Core의 수집·색인 writer bean은 생성되지 않습니다. 기존 구현은 전환 호환성을 위해 남아 있으며,
`infrastructure/compose.yaml` 단독 실행과 AWS 재배포용 템플릿은 기존 embedded 모드입니다.
위 내용은 Catalog 분리 모드의 초기 도입 기록이며, 당시 변경에는 AWS 배포가 포함되지 않았습니다. 아래 기존 수집 흐름 설명은 embedded 모드를 기준으로 하며,
분리 모드의 계약·소유권·제약은 [Catalog 분리 안내](catalog-service-extraction.md)를 참고하세요.

현재 EKS 업무 API 진입 경로는 `Vercel routing middleware → CloudFront VPC origin → 내부 ALB → Nginx Gateway → Core·Ops Service`입니다.
GovBiz 사용자·Ops 화면은 Vercel에서 제공합니다. 미들웨어는 프록시 공유 비밀값·신뢰 IP를 추가하고,
Gateway가 경로별 인증·전달을 담당하며 업무/AI 실행은 백엔드 서비스가 맡습니다.
Argo 배포 관리 화면은 EKS의 `argocd` Namespace·observability 노드에 있는 `argocd-server` Pod에서 제공합니다.
관리자 브라우저는 `CloudFront HTTPS /argocd/ → 기존 내부 ALB → Gateway → argocd-server Service → Pod`로 접속합니다.
관리자 IPv4·전용 origin 비밀값·Argo 로그인을 확인하며, Gateway에서 Argo의 ClusterIP `8080`으로 연결할 때 서버 인증서를 검증합니다.
[현재 EKS 구성도](assets/architecture/README-aws-eks.md)와 [Argo 관리 웹 접속 안내](../infrastructure/eks/argocd-dashboard.md)를 참고하세요.
이전 Compose 운영 구성은 [기존 운영 설정 안내](deployment-aws-vercel.md)에 별도로 남겨 두었습니다.
구성도는 실시간 상태 확인이나 모든 운영 기능의 검증 완료를 의미하지 않습니다.

기존 계정별 수동 분석 API는 `ApplicationFormDiscoveryJobController → ApplicationFormDiscoveryJobService → Repository → MyBatis → MySQL`
로 V26 분석 작업과 Outbox를 함께 저장하고 202를 반환합니다.
`ApplicationFormDiscoveryOutboxScheduler → QueueClient → RabbitMQ → ApplicationFormDiscoveryJobConsumer → JobService`
가 공유 실행 슬롯·DB 실행권을 선점한 뒤, 기존 세션 Account가 명시적으로 요청한 네 제공처 공고를
`ApplicationFormDiscoveryService → 제공처별 AttachmentClient → 공식 첨부 → SupportProgramDocumentParser →
AiApplicationPreparationFacade → AI Service`로 분석합니다. 파싱한 첨부는 같은 파일이거나 같은 서식을 형식만 바꿔 올린 사본이면
`_common/helper/AttachmentCopyHelper`로 읽힌 사본 중 한 형식(HWPX > HWP > DOCX > XLSX > PDF)만 남기고(우선 형식을 읽지 못하면 다음 사본),
파일명 규칙(`ApplicationAttachmentRole`)으로 위원용·공고문 같은 비신청 문서를 AI 호출 전에 제외합니다(남는 문서가 없으면 전부 분석).
이름이 신청서·양식(`(양식)`, `서식`, 조사서·명세서·확인서, 신청내역, application 등)이 아니고 본문에 서식 신호(별지·서식 번호, 신청서·계획서, 서명·날인 칸(`(인)`·`(서명)`·`서명 또는 인`),
빈 날짜 줄(`년  월  일`, `20  .  .  .`), 업체명·대표자·연락처 같은 라벨만 있는 줄이 5개 이상인 입력 표, 동의·서약서, 영문 서식의 서명 칸)도 없는 첨부는 유료 분석을 보내지 않습니다. 공고문으로 이름 붙은 첨부는 "신청서 제출" 같은 언급만으로는
서식으로 보지 않고 구조 신호를 봅니다. 남는 문서가 없으면 AI 호출 없이 `NO_FORM`으로 닫고, 신청서로 보이는 문서부터 공고당 최대 8개를
3개씩 동시에 추출합니다.
분석이 남긴 사용자 안내(받지 못한 첨부, 서식 신호가 없어 건너뛴 첨부, 입력 위치를 확인하지 못해 제외한 양식, 신청자가 직접 체크해야
하는 동의 항목)는 성공·실패 모두 V48 `application_form_availability.analysis_warnings`(JSON, 최대 20개·500자)에 저장해
`GET /forms/availability`의 `state.warnings`로 보여 주고, 공고가 바뀌어 상태가 무효가 되면 비웁니다.
기업마당 첨부는 상세 페이지의 '본문출력파일' 구역(공고 본문에 넣은 파일)을 개수 상한에서 빼고, 같은 파일이 두 구역에 걸리면
한 번만 받으며, 같은 서식의 형식별 사본은 한 문서로 세어 8개를 넘으면 실패하지 않고 앞의 8개만 받은 뒤 나머지를 안내합니다. 각 문서의
우선 사본을 먼저 받고 다른 형식 사본은 남는 크기 한도 안에서 받아 두어, 우선 사본이 크기 제한에 걸리거나 읽히지 않아도 다른 사본으로
분석합니다(발행기관 중기부 HWPX가 있으면 기업마당 변환본은 받지 않음). 수집 단계에서 실패해도 그때까지의 안내를 `state.warnings`로 남깁니다.
받을 수 있는 첨부가 지원하지 않는 형식뿐인 공고(기업마당 ZIP 등)와 K-Startup 첨부가 자동 분석 한도를 넘는 공고도 받지 않은 첨부와 이유를 안내에 남깁니다.
AI Service가 HWPX native 입력 대상 한도(3,000개) 초과를 413으로 확정한 첨부(서식 여러 개를 묶은 파일 등)는 재시도·검토 잠금 없이
그 첨부만 제외하고 남는 문서가 없으면 `TOO_LARGE`로 닫습니다. 제외 안내는 내부 분류 이름 대신 사용자 문장으로 남깁니다
(예: `자동 분석 제외 첨부(서식 여러 개가 묶여 입력칸이 자동 처리 한도를 넘는 파일)`, `…(공고문·안내문처럼 신청자가 작성하지 않는 문서)`).
읽을 수 있는 신청서 파일이 없거나(`DOCUMENT_UNAVAILABLE`+`SOURCE_UNSUPPORTED`) 첨부가 너무 큰(`TOO_LARGE`) 공고는 다시 분석해도 같은 결과이므로
웹은 분석 버튼 대신 공고 원문 보기를 먼저 두고, 공식 첨부가 바뀐 경우를 위한 [첨부 다시 확인]만 작게 둡니다. 양식을 고를 때는
필드별 `documentWritable`로 자동 기입 문항 수(예: 자동 기입 17/57문항)를 보여 주고 자동 기입 비율이 높은 양식을 먼저 둡니다.
양식은 찾았으나 입력칸 매핑만 실패한 경우는 `RETRY_WAITING`으로 두어 3회까지 다시 시도하며, AI Service는 매핑 응답이 스키마
(문서에 없는 ID)를 어기면 위반 값을 돌려보내 한 번 교정 요청을 보낸 뒤 실패로 닫습니다. 검증된 응답은 `ApplicationFormSnapshotRepository → MyBatis → MySQL`에
파일 hash·파서·모델·프롬프트 버전과 함께 저장해 동일 추출 버전에서 재사용합니다. 발견 양식을 선택한 뒤
`ApplicationPreparationService → ApplicationPreparationRepository`가 계정 소유 준비 건을 생성합니다. 화면 진입과 목록·상세
조회만으로 DB 쓰기나 AI 호출을 실행하지 않으며, 기존 classpath manifest는 검수 기준과 이전 준비 건 복원에 사용합니다.
문항 답변은 `ApplicationPreparationService → AiApplicationPreparationFacade → AiApplicationPreparationClient → AI Service`로
DB transaction 밖에서 해석합니다. 요청 키와 당시 입력을 먼저 짧은 transaction으로 예약하고, 검증된 제안 또는 실패 상태를
별도 transaction으로 저장합니다. 사용자가 제안을 확인한 PUT만 문항 사실을 전체 교체하고 입력 revision을 증가시킵니다.
본인 준비 건의 DELETE는 `ApplicationPreparationRepository → MyBatis → MySQL`에서 소유자 조건으로 한 행을 지우고,
확인 사실·AI 실행 기록은 FK cascade로 삭제하지만 공용 `application_form_snapshot`은 유지합니다.
Frontend는 `/app/application-preparations`의 목록(상태 칩 `?status=`, 필수 답변 진행 막대, 현재 버전 문서 유무로 완료 배지, 접수 마감 D-n, 계정의 최근 양식 분석·문서 생성 작업으로 작업 중 카드와 확인 전 결과 표시, 같은 작업 목록을 작업 화면 틀이 읽어 사이드바 배지와 공유)·모달 삭제, `/new`의 지연 조회 관심 공고 팝업과 전체 카탈로그 공고 검색·선택을 첫 단계로,
공고를 고르면 곧바로 공고별 availability API와 최근 discovery job 목록을 읽어(AI 호출 없음) 저장된 양식 상태를 보여 주고, QUEUED·RUNNING job이 있으면 폴링을 이어받습니다. 유료 분석은 [입력칸별로 분석] 클릭에서만 시작하며 활성 snapshot은 [다음]으로 여는 두 번째 단계에 표시합니다. 미분석·변경 공고는 Discovery Job 완료 후 표시하며, `/:preparationId`의 공식 문항
상세와 질문·사실 확인을 연결합니다. AI 제안은 저장하지 않고 사용자가 선택·수정한 전체 문항 입력만 revision을 올려 저장합니다.
웹 답변 입력은 입력을 2초 멈추거나 질문·항목을 이동할 때 그 항목의 `PUT …/inputs`를 자동으로 호출하고(보낼 사실이 저장된 사실과 같으면 호출하지 않음),
탭 숨김·화면 이탈 시에는 `keepalive` 요청으로 마지막 저장을 보냅니다. `APPLICATION_PREPARATION_REVISION_CONFLICT`는 최신 준비 건을 다시 조회하되 입력 중 값은 유지해 사용자가 다시 저장하게 합니다.
"아직 정해지지 않았어요" 체크는 기존 사실 상태 `UNKNOWN`(값 null)으로 저장하며 문서 생성에서 제외됩니다. 로컬 저장소·이탈 경고는 두지 않습니다.
신청 문서 새 문서와 중복 지원 검토 1단계(사업 1 · 사업 2 칸)는 공용 `공고 고르기` 패널(`ProgramPickerPanel` → `useProgramPickerViewModel`)에서
관심 공고함 · 전체 검색 탭으로 공고 1개를 고릅니다. 전체 검색은 검색어·지역·지원 분야·출처·접수 상태(기본 "전체")를 `BrowseSupportProgramsUseCase` →
기존 catalog HTTP API로 전달하고, [검색]은 1페이지부터, [더 보기]는 마지막으로 적용한 조건으로 다음 페이지를 이어 붙입니다. 조건 해제·필터 초기화는 고른 행을 유지한 채 다시 조회합니다.
신청 문서는 행을 고를 때마다 저장된 양식을 조회(AI 호출 없음)한 뒤에만 확정할 수 있고, 중복 지원 검토는 다른 칸에서 고른 공고를 고를 수 없게 둡니다.
문서 생성은 웹이 `POST …/{id}/documents/jobs`로 작업을 접수(202)하고 `GET …/documents/jobs/{jobId}`를 2초마다 읽는 흐름입니다.
신청 준비 삭제는 `ApplicationPreparationController → ApplicationPreparationService → ApplicationPreparationRepository → MyBatis → MySQL`을 거칩니다.
삭제와 문서 생성 접수는 같은 준비 건 행을 `FOR UPDATE`로 잠그고 활성 작업도 잠금 조회로 확인합니다.
QUEUED·RUNNING·UNKNOWN 작업이 있으면 DELETE는 409 `APPLICATION_PREPARATION_RUN_CONFLICT`를 반환해 준비 건과 작업 기록을 보존합니다.
삭제가 먼저 커밋되면 대기하던 생성 접수는 소유한 준비 건을 찾지 못해 404로 종료합니다. 완료·실패 작업만 있으면 기존 cascade 삭제를 허용합니다.
`ApplicationDocumentGenerationJobController → ApplicationDocumentGenerationJobService`가 계정별 작업(V45 `application_document_generation_job`, 준비 건당 진행 중 1개·계정당 3개)을 접수하고,
같은 프로세스의 `ApplicationDocumentGenerationJobWorker`(2초 폴링, 인스턴스당 동시 2개)가 QUEUED 행을 UPDATE 한 번으로 claim해
`ApplicationDocumentService.generateNow → 공식 첨부 Client → ApplicationDocumentMappingService → ApplicationDocumentEditor → AiApplicationPreparationClient → AI Service Router → Service → 위치 선택 Agent → OpenAI`를 실행합니다.
작업은 단계(PREPARING·MAPPING·WRITING·SAVING)를 기록하고 SUCCEEDED면 파일 ID를, FAILED면 사용자용 실패 문구와(입력 위치 변경이면) 승인 안내를 돌려줍니다.
`ApplicationDocumentService.generateNow`는 `ApplicationDocumentMappingService.ensure`의 새 매핑 요청 또는 답변 기입 요청 중 최초 요청 직전에 작업의 `ai_started_at`을 한 번 기록합니다. 매핑 캐시를 사용하면 답변 기입 요청에서 기록하고, 생성 파일 재사용·답변 없는 원본 저장에는 기록하지 않습니다. 기록 저장에 실패하면 요청을 보내지 않습니다. 최초 매핑 호출 뒤의 알 수 없는 실패와 실행 중단도 기존 UNKNOWN 분류·만료 처리에 포함됩니다.
유료 AI 호출 뒤 결과를 확인하지 못한 실행은 UNKNOWN으로 남아 그 준비 건의 새 작업을 막고, `unknown-outcome-lock-ttl`(기본 24시간)이 지나면 실패로 내려 다시 받습니다.
QUEUED 1시간이 지나면 만료, RUNNING 30분이 지나면 유료 AI 호출 전(재시작 등으로 끊긴 실행)은 실패, 호출 뒤는 결과 불명으로 정리합니다. 동기 `POST …/documents`는 같은 규칙을 거치는 기존 계약으로 남아 있지만 웹은 호출하지 않습니다.
`APPLICATION_DOCUMENT_JOBS_ENABLED=false`이면 새 생성 작업 POST는 저장·이용량 확인 전에 503 `APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE`로 거절합니다. 이미 접수된 같은 계정·요청 키·작성본·답변 버전은 기존 작업을 반환하며 대상·버전이 다르면 409입니다. 기존 작업 GET도 계속 사용할 수 있습니다. 문서 실행기는 다른 기능의 활성 여부와 별개로 스케줄링을 등록하며, 실행 풀의 접수 거절 시 슬롯을 반환하고 폴링 실패 로그에 예외 원인을 남깁니다. 웹은 작업 목록 조회 실패를 빈 목록으로 바꾸지 않고 오류를 표시합니다. 모바일은 이 명시적인 접수 거절만 보관 요청에서 정리하고 일반 503·응답 유실의 요청 키는 유지합니다.
공식 첨부 SHA-256이 선택한 양식 버전과 일치할 때 원본의 문단·표 셀 또는 PDF 페이지를 분석합니다.
저장된 바인딩이 있는 HWP·HWPX·DOCX·XLSX는 작성 계획을 AI에 다시 묻지 않고 바인딩에서 결정적으로 만듭니다. 빈 칸은 입력하고, 글자가 있는
칸은 AI Service `answer_slots`의 고정 규칙으로 인쇄된 단위·라벨·글머리표·선택지를 남긴 채 빈칸에만 씁니다(`(   명)`→`(12 명)`, `□ 자가 □ 임차`→
`■ 자가 □ 임차`, `[ ]`→`[√]`, `유( )`→`유(○)`, `2026년    월    일`→`2026년 10월 1일`, 예시 문구는 전체 교체). 한 문단에 빈칸이 여럿이면
답의 항목명이 가리키는 빈칸을 고르고, 정할 수 없거나 인쇄된 선택지·연도와 답이 다르면 문단을 덮어쓰지 않고 그 답만 미기입으로 남깁니다.
체크박스·필드는 set_check·set_field입니다. 한 문단에 여러 답변이 묶인 경우만 그 답변들에 한해 모델에 배치를 묻고, 합친 계획은 기존과 같이
저장 바인딩·범위·scope 검증을 통과해야 합니다. PDF는 기존 경로(AcroForm 결정적, 평면 PDF는 모델)를 유지합니다.
칸보다 긴 답은 문서 전체를 실패시키지 않습니다. HWPX는 한컴 줄바꿈 규칙으로 줄 수를 추정해(python-hwpx FormFit) 칸 높이의 두 배를 넘는
칸의 답만, PDF는 Core가 최소 글자 크기로도 상자에 들어가지 않는 답만 빼고 나머지를 씁니다. 모델이 배치하지 못한 답(`unresolvedTargets`)도
같은 방식으로 뺍니다. Core가 직접 쓰는 HWP·PDF는 생성 전에 붙여 넣은 공백(NBSP·전각 공백·탭)을 보통 공백으로, CR을 LF로 바꾸고
폭 없는 공백 같은 서식 문자를 뺀 뒤, 그 형식에 쓸 수 없는 문자(HWP: 이모지 같은 보조 평면 문자·제어 문자, PDF: 나눔고딕에 없는
한자·이모지·㈜·① 같은 기호)가 남은 답을 AI 요청 전에 빼서 `UNSUPPORTED_CHARACTER`로 알립니다. 뺀 답은 이유(`OVERFLOW`·`AMBIGUOUS_SLOT`·
`SLOT_MISMATCH`·`UNSUPPORTED_CHARACTER`, 위치 미확인은 `INPUT_LOCATION_NOT_FOUND`)와 칸에 들어가는
대략의 글자 수를 미기입 답변 목록에 담고, 쓸 답이 하나도 남지 않을 때만 `OVERFLOW`·`NO_WRITABLE_INPUT`으로 실패합니다.
HWP·HWPX의 파란·회색 작성 예시는 답을 쓴 칸과 답을 쓴 표의 예시 행(채워진 칸이 모두 예시)에서만 지우고, 답이 없는 표·칸의 예시는
사용자가 직접 쓸 부분이라 남겨 그 칸 수(`remainingExampleCount`)를 결과 화면에 "직접 작성할 칸 N곳에 예시 문구가 남아 있어요"로 알립니다.
답은 예시나 굵은 라벨의 모양을 따르지 않고 같은 글꼴·크기의 검은 글씨로 쓰며, HWP 셀은 답으로 늘어난 줄만큼만 높입니다.
AI는 답변을 다시 쓰지 않고 기입 위치만 선택합니다. Core가 답변 전체의 매핑을 검증하고 원본에 사용자 값을 기입합니다.
서로 다른 답변이 같은 HWP/HWPX 텍스트 칸을 선택한 AI 응답은 그대로 사용하지 않습니다. AI Service가 칸마다 첫 답변과 충돌하지 않은 위치를 고정하고 나머지 충돌 답변을 고정된 칸을 금지한 한 번의 요청으로 다시 배치하며, 필요하면 답변 없는 예시 분류 요청을 분리한 뒤 전체 계약을 다시 검증합니다. 교정 실패는 정상 결과로 숨기지 않습니다.
HWP/HWPX는 파란 텍스트 후보와 표 문맥을 함께 전달하여 예시 삭제 대상도 선택합니다. Core는 후보 ID를 검증하고 선택된 파란 예시만 제거한 뒤 검은 글씨로 기입합니다. PDF의 기존 텍스트 삭제는 지원하지 않습니다.

HWP/HWPX의 모든 파란 문구 후보는 답변 유무와 관계없이 `clearExampleTargetIds`(예시·작성 힌트 삭제) 또는 `preserveExampleTargetIds`(제목·항목명·필수 안내 보존)에 정확히 한 번 포함되어야 합니다. AI Service와 Core API 양쪽에서 누락·중복·교집합·알 수 없는 ID를 거절합니다. 체크박스 답변을 Core가 모두 처리한 경우에도 예시 후보가 있으면 빈 facts로 분류를 요청합니다. 파일 편집 후 삭제 대상으로 선택한 문단에 파란 문구가 남았는지 다시 검사합니다. 의미 분류의 정확도와 실제 한글 조판 품질은 별도 검수가 필요하며, PDF의 기존 문구 삭제는 지원하지 않습니다.
HWP는 hwplib 1.1.11, HWPX는 ZIP/XML, PDF는 PDFBox와 OFL NanumGothic 글꼴을 사용합니다.
PDF 입력값은 AcroForm 필드로 남겨 다시 편집할 수 있습니다. 문서를 다른 확장자로 변환하지 않습니다.
`ApplicationDocumentRepository → MyBatis → MySQL`이 V32의 생성 파일·원본 hash·기입 위치를 저장합니다.
V33의 생성기 버전으로 이전 결과와 구분하여 같은 답변 revision의 수정된 초안을 재생성하며 이전 파일은 보존합니다.
생성기 5는 HWP 선택 컨트롤의 정확한 값 매칭을 Core에서 처리하고 나머지 답변 위치를 AI에 요청합니다. 체크 그룹 갱신·밑줄 빈칸 치환·HWP 줄 배치 재계산 뒤 저장합니다. 미정 답변은 기입 대상에서 제외하고 Frontend가 누락 항목을 표시합니다. 표가 있는 HWP 섹션의 표 밖 빈 문단은 위치 후보에서 제외하고, 예시 삭제 후 빈 문단이 되는 경우도 기입 단계에서 거절합니다. 이전 생성기 결과는 재사용하지 않습니다. 전체 페이지 조판과 실제 양식의 의미적 배치 품질은 자동 테스트와 별도로 검수해야 합니다.
외부 호출은 DB transaction 밖에서 실행하고 저장 시 입력 revision을 잠금으로 재확인합니다.
같은 revision의 저장 파일은 재사용하며, 현재 프로세스에서 같은 준비 건의 동시 생성은 거절합니다.
Frontend는 입력 화면과 `/:preparationId/documents` 결과 화면을 분리합니다. 파일마다 `초안 다운로드`로 원래 형식의 파일을 받고 이전 답변 버전의 파일은 접어 둡니다. archive API는 유지하지만 현재 결과 화면에서는 호출하지 않습니다. 모바일 브라우저 링크는 기존 Redis에 해시 키·파일 식별자·2분 만료만 보관하며 로그인 JWT를 URL로 전달하지 않습니다. HEAD·재시도를 허용하고 만료·삭제·계정 정지는 명시적인 410 오류로 처리합니다. 결과를 확인하지 못한 생성의 Redis 잠금은 영구가 아니라 `app.application-document.unknown-outcome-lock-ttl`(기본 24시간) 뒤 풀립니다.
내려받은 파일에서 수정하거나 이전 입력 화면에서 답변을 수정·저장한 뒤 다시 생성합니다.
V31의 문항별 텍스트 작성본 API·기록은 남아 있으나 현재 UI는 호출하지 않습니다.

`/app/saved-programs`의 진행 관리에서는 신청 준비 건의 단계를 조회·변경합니다. 단계 변경은 문서 입력 revision과 분리된 진행 revision으로 보호합니다.

로컬 Compose의 개인 목업 경로는 `demo-seed → application-preparations.sql / combination-reviews.sql → MySQL`입니다.
기본 시연 계정 admin·member마다 신청도우미 2건과 중복 검토 2건의 독립 parent/child 행을 만들고, 로그인 계정의 `owner_account_id` 조회 경계를 그대로 유지합니다.
V35·V37의 `(owner_account_id, demo_seed_key)` 유일 제약은 목업 중복만 막으며, 일반 사용자 작업의 NULL 키는 여러 행을 허용합니다.
기존 DB에서도 두 SQL을 증분 실행해 누락분을 복구하고 사용자 기록과 대상 밖 기존 목업은 보존합니다. 신규/기존 환경 모두 같은 SQL을 사용하며
대상 이메일 기본 탐색·override와 세부 실행법은 [데모 데이터](../infrastructure/README.md#데모-데이터)에 있습니다.

Frontend는 현재 공고의 활성 분석 작업을 3초마다 확인하며, 조회 재시도는 새 분석을 만들지 않습니다.
AI Service의 명시적 근거 검증 실패(`422 / APPLICATION_FORM_AI_INVALID_RESPONSE`)는 Client의 전용 예외 → DiscoveryService의 업무 오류 → JobService의 FAILED 저장으로 연결됩니다. 공고 재선택 후 새 요청은 허용하되 자동 재호출하지 않으며, 통신 유실·시간 초과는 UNKNOWN으로 차단합니다.
UNKNOWN은 Outbox 스케줄러의 만료 정리에서 같은 공고의 가용성이 AI 시작 이후 확정됐으면 즉시, 아니면 TTL(기본 30분) 뒤 FAILED로 닫혀 계정 활성 한도(3건)를 돌려주며, 이때도 AI를 다시 부르지 않습니다.
관리자 큐 운영 조회는 `QueueOperationsController → QueueOperationsService → Repository/MyBatis/MySQL + QueueOperationsClient/RabbitMQ`
로 생성·메일 발송·중복 검토·문서 분석·카카오 연결 해제의 다섯 큐 보관 상태·브로커 관측치를 읽습니다. 메시지 소비/재발행/DB 작업 상태 수정은 없습니다.
[실행권·만료·결과 불명·관리자 지표·운영 한계](rabbitmq-application-form-discovery.md)를 참고하세요.

중복 지원 검토의 현재 입력은 `기존 세션 Account 해석 → CombinationReviewController → CombinationReviewService
→ CombinationReviewRepository → CombinationReviewMapper → Mapper XML → MySQL`로 생성·조회·수정·삭제합니다.
검토 단위 선택 입력인 사업쌍 관계(같은 과제·같은 비용, V53 `same_project`·`same_cost`)도 같은 경로로 저장하며, 관계를 생략한 수정은 같은 UPDATE에서 저장된 관계를 유지합니다.
목록은 소유자·생성 ID 커서로 조회하고, 수정은 소유자·입력 버전 조건으로 원자적으로 교체합니다. 삭제도 소유자 조건으로 수행하며
선택 공고·실행 이력·보관 원문은 외래 키로 함께 삭제됩니다.
타인 검토와 없는 검토는 404, 본인 검토의 버전 충돌은 409입니다. 세션 쿠키 쓰기 요청의 Origin 검사는 유지합니다.
분석 POST는 `CombinationReviewRunController → CombinationReviewRunService`로 들어가 입력을 접수합니다.

1. `CombinationReviewRunRepository → MyBatis → MySQL`: 소유자·버전·요청 키 확인 후 QUEUED 입력 스냅샷 예약.
   실행 행 자체가 Outbox이며 새 POST는 202로 반환합니다. `CombinationReviewOutboxScheduler → CombinationReviewQueueClient
   → RabbitMQ → CombinationReviewRunConsumer → CombinationReviewRunService`가 DB에서 실행을 한 번 선점합니다.
2. 소비자는 선택한 제공처에 따라 `BizInfoAttachmentClient`, `MsitAttachmentClient`, `KStartupAttachmentClient`,
   `CnTradeNoticeAttachmentClient`를 통해 검증된 공식 상세의 직접 연결 첨부를 수집. 충남은 API 제목·본문과 게시판 상세를 교차 검증.
3. `SupportProgramDocumentParser`: PDFBox, Apache Tika HWP5 또는 HWPX/DOCX/XLSX ZIP/XML로 텍스트·위치를 추출. 신청 문서 발견과 중복 지원 검토가 같은 안전 경계를 사용.
   중복 검토는 근거용 `parseEvidence`로 PDF 글자 좌표 줄 잇기·표 행과 HWPX 표 행을 쓰고, 문서 기록에 `EVIDENCE_VERSION`을 남긴다(양식 분석 재사용 키는 그대로).
   공고별로 읽을 수 있는 문서가 있으면 크기 제한 초과·텍스트 추출 불가 첨부는 경고와 함께 제외하고, 모두 제외되면 실행을 실패 처리.
4. `CombinationReviewRunRepository`: 원문 바이트·해시·메타데이터·텍스트를 짧은 transaction에서 보존. 검증한 공식 공고 상세 주소와
   첨부 다운로드 주소를 서로 다른 필드로 저장해 화면의 공고 페이지 이동과 보관 원본 다운로드를 구분.
5. `AiCombinationReviewFacade → AiCombinationReviewClient → AI Router → CombinationReviewService → CombinationReviewAgent → OpenAI` 단일 호출.
   계약은 `CombinationReviewProperties`(`app.combination-review.contract-version`, 기본 v3)로 고르며, v3는 같은 경로로 사업별 상태 4값·관계를 보내고 세 질문 답을 받습니다.
6. AI와 Core에서 사업쌍·단계·인용을 검증하고 실행 성공/실패 저장. AI는 서버가 원문에서 만든 인용 선택지 번호만 고르고,
   코드가 정확한 원문과 근거 ID를 복원한다. 다른 사업쌍의 선택지나 범위 밖 번호는 실패 처리. 현재 입력은 덮어쓰지 않음.

네트워크 호출은 DB transaction 밖에서 수행합니다. 같은 요청 키는 기존 실행을 반환하고 새 키의 동시 실행은 DB에서 막습니다.
계정별 새 접수는 기존 공개 요청량 제한을 공유하며, 계정 전체 미완료 작업은 최대 3건입니다. 검토 큐 소비자는 1개이며
RUNNING과 UNKNOWN 재전달은 재실행하지 않습니다. 기존 Qdrant 검색은 사용하지 않습니다.
자동 수집 원문은 사람 검수 전으로 표시합니다. 사용자 화면은 3단계 입력·분석 흐름으로 연결되어 있으며
[비동기 접수·원문 관리·결과 불명·운영](rabbitmq-combination-review.md)을 참고하세요.

Core의 Run Service는 실행 순서·근거 묶음 구성·상태 저장을 맡습니다. AI Facade는 요청 변환·Client 호출·응답 검증을 감추고,
`client/mapper/AiCombinationReviewMapper`가 전송 DTO와 내부 모델 사이를 변환합니다. Facade는 상위 Service나 DB를 호출하지 않습니다.
검토 없음·입력 버전·실행 충돌은 프레임워크와 무관한 `domain/exception`에 둡니다. 수집/AI 통신 실패는 `client/exception`,
AI 경계 실패는 `facade/exception`에서 표현하고 Service가 공개 실행 오류로 바꿉니다. Repository와 Client는 Service 타입을 참조하지 않습니다.

```text
브라우저 → React Web → Core API
                       ├→ MySQL: 현재 공개 공고 카탈로그·공고별 공식 원문
                       ├→ Elasticsearch: Nori·BM25 키워드 후보 색인·검색
                       ├→ 공공데이터포털: 기업마당·K-Startup 공고 수집
                       ├→ 기업마당·K-Startup 공식 HTTPS 상세 페이지: 명시적 원문 질문 시 HTML 수집
                       └→ AI Service
                           ├→ OpenAI: 문서·질의 임베딩, 조건 변경 해석·후보 점수화·근거 답변
                           └→ Qdrant: 공고 검색·원문 근거 청크의 분리된 벡터 컬렉션
```

Core API는 공개 HTTP 계약, 기업마당·K-Startup 수집, MySQL 접근과 접수 상태 계산을 소유합니다. AI Service는
Core가 전달한 공고 문서·원문 청크의 색인·검색·점수화·근거 답변을 담당하며 MySQL에 직접 접근하지 않습니다.

브라우저는 Core API의 `/api`만 호출합니다. Compose에서 Vite는 `/api`를 `core-service:8080`으로 프록시하며,
AI Service는 호스트에 포트를 게시하지 않습니다. MySQL·Qdrant·Core API·Web의 개발용 포트는
`127.0.0.1`에 바인딩합니다. 기업마당·K-Startup 키는 Core API에, OpenAI 키는 AI Service에만 주입합니다.
이는 개발 환경의 서비스 배치이며 운영 인증·접근 제어가 구현됐다는 의미는 아닙니다.

## 관리자 Gov 에이전트

웹 관리자의 `/app/chat`은 Gov 에이전트로 표시하며 일반 회원의 기존 AI 대화 검색은 유지합니다.
모바일도 서버가 확인한 `ADMIN` 계정의 검색 AI 모드를 Gov 에이전트로 표시합니다.
`ChatScreen → shared GovAgent API → createApiFetch(Bearer, credentials: omit) → Core AdminPrincipal`로 같은 계약을 사용하며
선택 공고에 원문 질문·신청서 쓰기·중복 검토를 표시합니다. 모바일 `GovAgentMessage`는 기존
`ApplicationPreparationNewScreen`·`CombinationReviewEditorScreen`을 인라인 표시로 재사용합니다.
입력칸 분석과 검토 입력·실행은 대화 카드에서 수행하고, 양식 작성·문서 결과·검토 실행 결과는 기존 네이티브 화면으로 옮깁니다.
실행·미확인 요청 복구는 기존 모바일 API·유스케이스가 소유하며 카드를 접으면 입력을 보존하고 조회·폴링을 멈춥니다.
최신 카드·선택 공고·현재 계정 권한을 확인하고 선택 공고·Gov 메시지·저장 검토 ID를 기존 대화 스냅샷에 보관합니다.
파트너 조건은 대화 기록에 보존하고 `GovAgentMessage → 모바일 partners API → shared 추천 유스케이스·DTO → Core 추천 GET API`로
모집글 세 건을 조회합니다. 상세·전체 목록은 기존 협업 화면으로 연결하며 일반 회원의 대화와 웹의 기존 UI는 유지합니다.
`ChatPage → 기존 chat Redux 요청 수명 관리 → shared GovAgent API → Core AdminPrincipal → GovAgentService →
AiGovAgentClient → AI GovAgentSupervisor → OpenAI`가 한 턴의 위임 경로를 정합니다.
Core는 `SEARCH`이면 기존 조건 해석 Service로 제안을 준비하고 사용자의 확인 후 기존 검색 API가 실행되게 합니다.
`EVIDENCE`이면 사용자가 고른 `(sourceCode, sourceProgramId)`와 원래 질문으로 기존 사용량 경계·원문 RAG를 호출합니다.
`APPLICATION`이면 선택 공고와 안내만 반환합니다. 대화에는 1 양식 확인 → 2 답변 작성 → 3 초안 단계 띠가 있는 신청 문서 카드만 두고,
입력칸 분석·양식·분야 선택·답변 편집·문서 생성·다운로드는 카드 버튼이 신청 문서 화면(`/app/application-preparations/new`, 이미 시작한 준비 건은
`/app/application-preparations/{id}`)을 대화 위 시트로 엽니다. 대화에서 준비 건을 만들지 않으며, 이전 기록의 `preparationId`는 그 편집 화면 링크로만 씁니다.
AI 실행과 문서 생성은 각각 사용자가 누를 때만 기존 API로 요청합니다. 선택 공고 막대의 [신청 문서 쓰기] 칩을 누르는 것은 입력칸 분석 요청으로 보아
새 문서 화면을 `analyze=1`로 열고, 그 화면이 저장된 양식이 없고(`PENDING`·`STALE`) 진행 중·최근 분석이 없을 때만 기존 discovery-jobs API로 바로 시작합니다.
말로 요청한 카드·카드 버튼·지난 기록은 화면만 열고 분석은 버튼으로 시작합니다.
`COMBINATION_REVIEW`이면 선택 공고(없으면 null)와 안내를 반환합니다. 대화에는 1 공고 선택 → 2 분석 입력 → 3 분석·결과 단계 띠가 있는 중복 검토 카드만 두고,
[검토 시작하기]·[이어서 하기]·[진행 보기]·[결과 보기]가 검토 화면(`/app/combination-reviews/new`, `/{id}?step=analysis`, `/{id}/runs/{runId}`)을
대화 위 시트로 엽니다. 카드·칩으로 연 새 검토 시트에서 검토를 저장해 주소가 그 검토로 바뀌면 대화가 그 번호를 최근 중복 검토 카드에 붙입니다.
선택 공고는 첫 칸의 기본값이며, 실제 비교 대상은 검토 API에 저장한 두 공고입니다. 분석은 명시적 사용자 요청으로만 시작하고 기존 사용량·중복 접수·작업 복구 경계를 유지합니다.
카드 상태는 기존 목록·양식 조회·분석 작업·초안 작업·검토 실행 API로 읽고, 분석·초안 생성·검토 실행이 돌고 있으면 최근 카드만 5초마다 다시 읽다가 끝나면 멈춥니다(AI 호출 없음).
같은 3단계 띠(`shared/workspace/WorkSteps`, 단계 이름 `workStepNames`)를 신청 문서(새 문서·답변 입력·초안)와 중복 검토(입력·결과) 화면 맨 위에도 둡니다.
돌아가는 일은 공용 진행 카드(`shared/workspace/WorkProgress`)로 무엇을 하는지와 지난 시간만 보여 주고 예상 시간은 적지 않으며,
중복 검토 결과 화면도 분석 중이면 검토 입력과 같은 진행 카드(`ReviewRunProgress`)를 보여 줍니다.
`PARTNERS`이면 공고 식별자 없이 안내와 대화에서 읽은 모집글 조건(`partnerConditions`)을 반환합니다. 조건은 경로 선택과 같은 Supervisor 호출에서
함께 받으며(추가 OpenAI 호출 없음), 찾는 역할(LEAD·PARTICIPANT·DEMAND)·지역(17개 짧은 시·도 이름)·분야 말(최대 3개)·"이 공고"만 담습니다.
Core는 각 값의 근거 문구가 개인정보를 가린 사용자 말에 그대로 있는지, 지역이 근거 문구를 검색과 같은 지역 사전(`_common/domain/RegionDictionary`)으로
읽은 시·도에 드는지, 분야 말이 근거 문구 안의 낱말인지 확인하고, 맞지 않으면 버리지 않고 오류로 돌려줍니다.
"이 공고"는 사용자가 고른 공고가 있을 때만 그 공고로 좁힙니다. 대화의 최신 파트너 카드는 `GovPartnerBrief → RecommendPartnerRecruitmentsUseCase →
GET /api/v1/partners/recruitments/recommended → PartnerRecruitmentRecommendationService → PartnerRecruitmentMatcher(Domain)`로 맞춤 모집글을 세 건까지 보여 줍니다.
추천은 AI 없이 회사 소재지·설립연도, 협업·파트너 설정(역할·역량), 관심 공고·신청 준비 공고, 보낸 제안을 읽어 계산합니다. 회사 소재지는 같은 지역 사전으로
시·도 하나로 읽힐 때만 지역 비교에 씁니다. 마감·내 글·이미 제안한 글,
찾는 역할이 내 역할에 없는 글, 업력이 최소 업력보다 짧은 글, 말한 역할·지역·공고와 다른 글은 빼고, 내 공고(+3)·분야 말(+2씩)·겹친 역량(+1씩, 최대 3)·
같은 희망 지역(+1)으로 순서를 정합니다. 희망 지역이 달라도 거르지 않고 확인할 점으로만 보여 주며, 맞는 글이 없으면 조건 하나를 뺐을 때의 건수를 알려 줍니다.
카드의 조건 칩을 빼면 AI 없이 다시 조회하고, [같은 조건으로 파트너 관리에서 보기]는 역할·지역·첫 분야 말을 목록 주소로 넘기며,
아직 모집글이 없는 관심 공고는 [이 공고로 모집글 쓰기]로 작성 화면에 공고를 미리 고릅니다. 모집글 작성·제안 전송은 실행하지 않습니다.
원문 질문·신청 준비에 필요한 공고가 선택되지 않았으면 선택 안내를 반환합니다. 미지원 기능은 미지원 안내를 반환하며 임의의 공고·도구를 추정해 실행하지 않습니다.

클라이언트는 응답의 공고 식별자가 요청과 같은지, 인용이 공식 제공처 URL인지 확인한 뒤 기존 원문 답변 컴포넌트로 보여 줍니다.
`schemaVersion: 1` 대화 스냅샷에 선택 공고 `govProgram`과 메시지의 `govEvidence`·`govApplication`·`govReview`·`govPartners`를 선택 필드로 보관합니다.
신청 준비 기록에는 공고·안내와 선택 필드 `preparationId`만 저장합니다. ID는 양의 안전한 정수이며 ID가 없는 이전 기록도 그대로 읽습니다.
검토 기록에는 선택 공고 기본값·안내와 선택 필드 `reviewId`를 저장하며 실행 승인·작업 ID는 저장하지 않습니다. 파트너 기록은 안내만 저장하고 목록은 다시 조회합니다.
신청 준비·중복 검토·파트너 중 최신 카드만 활성화해 이전 카드의 중복 조회를 막습니다. 신청 준비는 선택 공고도 일치해야 하며,
준비 건의 소유권·공고 일치·답변·작업·파일 상태와 검토 건의 소유권·작업·결과는 기존 API에서 다시 확인합니다.
이전 기록과 일반 회원은 호환되며 열기만으로 AI를 호출하지 않습니다. 새 검색은 이전 선택을 해제하고,
새 대화·계정 변경·취소 뒤 도착한 응답은 기존 요청 ID와 AbortController로 폐기합니다.
이 기록은 화면 데이터이며 관리자 권한이나 서버 검증을 대신하지 않습니다.
선택 공고 막대의 [신청 문서 쓰기]·[중복 검토]·[파트너 찾기] 칩은 Core 경로 선택을 부르지 않고 고정 안내로 신청 준비·중복 검토 카드와
고른 공고를 조건으로 한 파트너 카드를 만듭니다. 이 공고로 쓰는 신청 문서가 있으면 [신청 문서 쓰기] 대신 [이어서 쓰기 · n/m]·[초안 보기]로 그 화면을 엽니다.
공고는 검색 결과 카드의 초록 [이 공고로 작업] 버튼으로 고릅니다. 고르기 전에는 막대 배경과 첫 줄 없이 같은 모양·크기의 작업 칩만 같은 들여쓰기로 두고(입력 중에도 유지),
누르면 실행하지 않고 최근 검색 결과의 [이 공고로 작업]을 빨간 계열 고리로 약 3초 강조하고(움직임 줄이기면 퍼지지 않는 고리) 첫 버튼으로 초점을 옮기며
칩 옆에 "[이 공고로 작업]을 눌러 공고를 골라 주세요."를 한 줄로 알립니다(결과가 없으면 "먼저 지원사업을 검색해 주세요."와 입력칸으로 초점). 그 결과에서 공고를 고르면 막대에서 누른 칩만 한 번 강조하고,
실행은 칩을 다시 눌러야 합니다. 원문 질문 남은 횟수는 한도에 가까워졌거나 다 썼을 때만 막대에 보여 줍니다.
로그인 뒤 대화 입력칸 아래 줄에는 Enter·Shift+Enter 안내를 두지 않고 화면 낭독기에만 알리며, AI 대화 검색 이용량은 그 줄에 그대로 둡니다.
대화에는 이름·상태 배지·버튼만 있는 작업 카드를 두고, 상태는 기존 신청 준비 목록·양식 조회·분석 작업·검토 실행 API로 다시 읽습니다(AI 호출 없음).
신청 문서는 신청 문서 화면에서 만들어지므로 카드는 공고로 내 신청 준비(목록 최근 20건)를 찾아, 지난 카드도 초안 완료([초안 받기]·[초안 보기])나
필수 답변 n/m을 보여 줍니다. 쓰기 전 신청 카드는 입력칸 분석 중·양식 n개·분석 전·양식 없음·원문 확인 필요를 보여 줍니다.
공고를 고르지 않아 `NEEDS_PROGRAM`을 받은 요청은 웹이 기억했다가, 공고를 고르면 [방금 질문을 이 공고로 묻기] 칩으로 누를 때만 다시 보냅니다(저장하지 않음).
로그인 뒤 대화(`/app/chat`, AI 검색·필터 검색·Gov)에서 연 공고 상세·원문 질문·신청 문서·중복 검토·파트너 모집글 상세는 대화를 뒤에 그대로 둔 채
대화 위 시트(`shared/chat-sheet`)로 띄웁니다. 주소는 그 화면의 주소로 바뀌어 새로고침·공유 링크는 전체 화면으로 열리고, 뒤로 가기·Esc·[닫기]는
시트를 닫습니다. 시트 안에서 다른 시트 화면으로 옮겨도(새 문서 → 답변 입력 → 초안) 시트를 유지하고 목록 같은 다른 화면으로 가면 시트를 닫고 그 화면을 엽니다.
대화가 아닌 작업 화면(신청 문서 작성 목록·관심 공고함·중복 검토·파트너·리포트 등)에서 연 공고 상세·원문 질문도 그 화면을 뒤에 둔 같은 시트로 띄우고, 신청 문서·검토처럼 그 자체가 목적지인 화면은 목록에서 열면 전체 화면입니다. 대화가 내려가지 않으므로 닫으면 스크롤·쓰던 글이 그대로이고, 닫을 때 작업 카드·관심 공고 표시(관심 공고함은 목록)만 다시 읽습니다. 데스크톱은 위·양옆으로 대화가 비치는 큰 시트,
600px 미만은 전체 화면이고, 시트 머리에는 [닫기]만 둡니다([전체 화면으로 열기]는 주석 처리로 숨김). 카드의 목록 링크처럼 대화가 있는 채로 Gov 대화를 떠나면 그때 연 신청 문서·중복 검토·파트너 화면 묶음 위에만
[대화로 돌아가기]를 둡니다. 사이드바 메뉴로 옮긴 화면에는 두지 않고, 그 묶음을 벗어나면 지워 나중에 다시 와도 남지 않습니다.
대화 안에 입력을 펼치지 않습니다. 작업 칩([신청 문서 쓰기]·[중복 검토])을 직접 누르면 카드를 만들고 그 화면을 시트로 바로 열고, 말로 요청해 생긴 카드는 카드만 둡니다.
최신 카드·선택 공고 일치 조건은 그대로 따릅니다.

검색·원문 질문·신청 준비·중복 검토·파트너 조회를 같은 대화에서 이어가며, 여러 단계 계획의 자동 실행은 후속 범위입니다.
기존 역할이 있는 Service를 직접 재사용하며 A2A나 별도 Agent 실행 계층은 추가하지 않습니다.

## 로그인 회원의 대화 기록

`WorkspaceLayout/useChatHistory → ChatConversationUseCase → ChatConversationRepository → data/api →
ChatConversationController → ChatConversationService → ChatConversationRepository → MyBatis Mapper → XML → MySQL`로
대화 화면 스냅샷을 보관합니다. Frontend Repository와 Core Repository는 각 애플리케이션의 경계를 담당합니다.
새 전송은 현재 대화에 누적하고 새 대화의 첫 전송은 별도 기록을 만듭니다. 비회원과 미전송 초안은 저장하지 않습니다.
사이드바 요금제 아래 목록은 생성 ID 기반 30개 단위 커서 조회를 사용합니다. 기록을 열면 기존 Redux 상태만 복원하며
검색·해석·OpenAI를 재호출하지 않습니다. 공고 결과는 저장 당시 내용이라는 안내를 표시합니다.

모바일은 `ChatScreen → mobile src/api/chatConversations → shared 대화 DTO 검증 → Bearer 인증의
ChatConversationController → 기존 Service·Repository·MyBatis·MySQL`로 같은 계정별 기록을 저장·조회합니다.
`X-Chat-Account`와 `expectedVersion`을 함께 보내고, API 경계에서 저장된 공고 DTO를 shared Mapper로 내부 모델로 변환합니다.
질문·답변·추천을 시간순으로 유지하고 완료된 대화 상태만 자동 저장합니다. 대화 기록 시트에서 기존 30개 커서 목록과
상세 스냅샷을 열며 AI를 재호출하지 않습니다. 새 대화는 화면만 초기화하고 서버 기록은 보존합니다.
저장 실패·충돌은 현재 대화와 함께 표시하며 재저장·미저장 이탈 안내를 제공합니다. 계정 전환·화면 이탈 시 진행 요청과 늦은 응답을 폐기합니다.
공개 HTTP·DB 계약은 변경하지 않습니다.

모바일 기록 삭제는 `ChatScreen의 삭제 확인 → mobile api/chatConversations → Bearer DELETE
/api/v1/me/chat-conversations/{id} → 기존 ChatConversationController·Service·Repository`로 이어집니다.
API 경계에서 204 응답을 확인한 뒤에만 해당 행을 제거하고 현재 대화이면 화면 상태와 대기 중인 스크롤을 초기화합니다.
다른 대화의 화면 상태는 유지하며 삭제 실패·계정 변경·늦은 삭제 응답은 현재 계정의 기록을 변경하지 않습니다.

Core는 세션 account ID로 모든 SQL을 제한하고 `X-Chat-Account` 사전조건으로 다른 탭의 계정 변경을 감지합니다.
`V19`의 복합 UNIQUE와 FK는 소유자별 ID를 보호하며 저장 transaction의 계정 행 잠금·expectedVersion 검사로
중복 생성·동시 덮어쓰기를 막습니다. 동일 내용 재전송은 멱등이며 충돌은 409로 드러냅니다. 이 스냅샷은 회원이 저장한
화면 데이터로 신뢰된 검색 결과나 서버 권한의 근거가 아닙니다. 탈퇴 이벤트의 대화 삭제는 탈퇴 transaction에 참여합니다.

카카오 탈퇴 연결 해제는 `AccountProfileService → AccountOAuthUnlinkRepository → MyBatis → MySQL(V28)`로
탈퇴와 작업 저장을 원자적으로 처리합니다. 공급자 identity는 성공 전까지 재가입 차단용으로 유지합니다.
`AccountOAuthUnlinkScheduler → QueueClient → RabbitMQ → Consumer → AccountOAuthUnlinkService → KakaoOAuthClient`로
외부 호출을 DB transaction 밖에서 실행하고, 결과 저장·이전 identity 해제만 짧은 transaction으로 묶습니다.
큐 off는 같은 DB 작업을 스케줄러가 직접 처리합니다. UNKNOWN은 재실행하지 않으며 재가입 차단을 유지합니다.
[설정·경합 방지·운영자 확인](rabbitmq-account-oauth-unlink.md)을 참고하세요.
브라우저는 계정 변경 때 진행 요청·메모리를 폐기하고, 조회 중 새 입력·화면 이동이 발생하면 늦은 복원을 적용하지 않습니다.
저장 실패는 현재 창의 내용을 유지한 채 안내하며 자동 fallback·강제 덮어쓰기를 하지 않습니다.
기록별 삭제는 같은 계층을 따라 `DELETE /api/v1/me/chat-conversations/{id}`로 처리합니다. `V21`의 `deleted_at`을
설정하면서 제목·스냅샷을 비우고, 저장과 같은 계정 행 잠금으로 늦은 최초 저장·갱신까지 차단합니다. 삭제는 멱등 204,
삭제된 ID의 조회는 404, 재저장은 409입니다. 다른 계정의 데이터에는 영향을 주지 않습니다.
Frontend는 확인 후 삭제 요청을 보내고 성공 시에만 목록·메모리를 지웁니다. 현재 대화 삭제 시 Redux 요청 ID도 초기화하며,
삭제 중 다른 대화로 전환했다면 그 대화는 보존합니다. 늦은 목록·상세·저장 응답은 삭제한 기록을 다시 표시하지 않습니다.
삭제 실패 시 기록을 유지하고 재시도를 안내합니다. 원문 공고·Qdrant 색인·다른 업무 문서는 삭제하지 않습니다.
병합 충돌을 해소한 마이그레이션 순서는 대화 테이블 V19 → 관리자 계정 관리 V20 → 대화 삭제 V21입니다.
대화용 V19의 기존 이력은 변경하지 않습니다. 관리자용 V19가 적용된 별도 DB의 주의사항은
[Core API 업그레이드 안내](../backend/core-service/README.md#v19-병합-충돌과-기존-db-업그레이드)를 따릅니다.

## 기업 맞춤 일일 리포트

앱 푸시는 기존 생성 큐를 재사용하고 이메일과 독립된 기기 설정·발송 Outbox를 사용합니다.
`DailyReportPushScheduler → DailyReportPushService → DailyReportPushClient → Expo Push Service → FCM/APNs`
경로로 READY 리포트만 알립니다. 모바일 세션·기기별 수신 설정과 receipt는 MySQL에 보존합니다.
Firebase DB/Auth를 추가하지 않습니다. [앱 푸시 경계·설정·검증](mobile-report-push.md)을 참고하세요.
모바일 OS 권한과 서버 수신 설정은 `DailyReportPushProvider`가 구분합니다. 초기 조회와 앱 복귀에서는 네이티브 권한을 읽기만 하고,
사용자의 수신 켜기에만 기존 기기 등록 경로를 실행합니다. 권한 거부의 `Linking.openSettings`는 설정 이동이며 허용·수신 활성화로 취급하지 않습니다.
기기 수신과 마감 알림 채널의 네이티브 스위치는 기존 Bearer 설정 API·shared 검증을 유지하고 계정 전환 뒤 이전 응답을 버립니다.

`DailyReportController → DailyReportService`는 저장된 기업 조건·지원 목적을 기존 검색에 전달하고,
추천 최대 3건 중 기업마당 공고에 기존 근거 답변을 연결합니다. 수집·검색·근거 답변 Agent를 새로 복제하지 않습니다.
`DailyReportRepository → MyBatis Mapper → XML → MySQL`에서 수신 설정·일별 입력과 결과·생성 시도 예산을 보존합니다.
수동 미리보기는 기존 동기 호출을 유지합니다. 정기 스케줄러는 리포트·예산·작업 Outbox를 함께 저장하고,
`DailyReportOutboxScheduler → DailyReportQueueClient → RabbitMQ → DailyReportGenerationConsumer → DailyReportService`로 생성합니다.
`DailyReportScheduler`는 `DailyReportConfig`가 정기 실행 활성 시에만 만드는 `dailyReportTaskScheduler`를 사용합니다.
공고 수집용 기본 스케줄러와 다른 단일 스레드이며 시작 지연 1분·완료 후 5분 간격은 유지합니다.
Core 내부 전용 소비자가 기존 검색·근거 답변을 재사용하며 DB 선점으로 중복 실행을 차단합니다. 별도 Worker 서버는 아닙니다.
메일은 이후 스케줄러 주기에서 V27 리포트 행의 발송 Outbox에 예약합니다.
`DailyReportDeliveryOutboxScheduler → DailyReportDeliveryQueueClient → RabbitMQ → DailyReportDeliveryConsumer → DailyReportService → DailyReportMailClient → SMTP`
로 전송하며 기존 NOT_REQUESTED → SENDING 선점과 UNKNOWN 재발송 금지를 재사용합니다.
발송 큐를 끄면 기존 스케줄러 직접 SMTP 경로가 유지됩니다. [발송 큐 상세](rabbitmq-daily-report-delivery.md)를 참고하세요.
생성·발송 예약 및 결과 저장만 짧은 transaction에서 수행하고 AI·원문 HTTP·SMTP 호출은 transaction 밖에서 수행합니다.
프런트엔드는 본인 리포트·설정과 명시적 이메일 확인·해지 화면을 제공합니다. 점수는 검색 관련도이며 선정 확률이 아닙니다.
[리포트 API·수신 동의·중복/비용 제한·운영 설정](daily-reports.md)에 상세 경계를 정리합니다.
[RabbitMQ 적용 상세](rabbitmq-daily-report-generation.md)는 예약/발행 transaction, 실패·중복·`UNKNOWN`, 운영 한계를 설명합니다.

## 관심 공고 마감 알림

웹 프로필과 모바일 알림 설정은 `NotificationSettingsController → NotificationSettingsService → NotificationSettingsRepository → MyBatis Mapper → XML → MySQL`로
본인 설정을 저장합니다. 스케줄러는 `DeadlineReminderScheduler → DeadlineReminderService → DeadlineReminderRepository → MyBatis Mapper → XML → MySQL`
에서 마감 7·3·1일 전 관심 공고를 마감일·일수별 고유 키로 한 번씩 예약하고 채널별 발송권을 선점한 뒤,
`DailyReportMailClient → SMTP`와 `DailyReportPushClient → Expo Push Service → FCM/APNs`로 transaction 밖에서 보냅니다.
발송 직전에 계정·설정·관심 공고·접수 상태·수신 주소·기기를 다시 확인하고 보낼 수 없으면 이유 코드와 함께 SKIPPED로 끝냅니다.
[조건·상태·설정](deadline-reminders.md)을 참고하세요.

## 요금제 사용량 한도

결제 연동 전이라 모든 회원은 FREE 한도로 시작하고 `account_plan`에 배정된 계정만 다른 요금제를 씁니다(V54).
하루 한도(AI 검색·원문 질문)는 아래 검색 경로에서 V56 `plan_usage_counter`로, 월 한도(신청 문서 초안·중복 검토)는 각 기능의 접수
transaction에서 셉니다. 월 한도는 `기능 Service(TransactionTemplate) → 기능 Repository.reserve(계정 행 잠금·작업 생성) →
PlanUsageService.requireMonthlyCapacity → PlanUsageRepository → MyBatis → MySQL` 순서로 새 작업까지 센 사용량을 확인하고, 넘으면 작업을
남기지 않고 되돌립니다. 유료 PLUS·PREMIUM은 30일 이용권이라 네 기능 모두 이용권 시작 시각부터 30일인 이용 기간 총량으로 세고,
V59 `account_plan.ends_at`이 지나면 FREE 기준으로 돌아갑니다. 사용량은 각 기능의 작업 표에서 실패하지 않은 작업으로 세므로 실패·만료는 별도 처리 없이 빠지고, 신청 문서·중복
검토 삭제는 같은 transaction에서 그 달 사용분을 `plan_usage_counter`에 남깁니다(V57). 작업 표를 남기지 않는 신청 문서 경로(이전 동기
양식 분석·문서 생성, 문항별 해석·초안)는 `PlanUsageService.consumeDraftProgram`이 AI 전에 같은 계정 행을 잠근 짧은 transaction에서 그
공고를 V58 `plan_usage_draft_program`에 기록하고, 실패하면 그 기록만 지웁니다. 화면은 `GET /api/v1/plan-usage`로 남은 횟수와
이용권이 끝나는 때를 읽습니다. 출시 전 무료 체험은 `PlanTrialController → PlanUsageService.startTrial → PlanUsageRepository → MyBatis → MySQL`
순서로 계정 행을 잠근 짧은 transaction에서 V60 `plan_trial`에 (계정, 요금제)마다 한 번 기록하고 `account_plan`에 `source = TRIAL`인
14일 이용권을 배정합니다. 결제 수단을 받지 않아 끝나면 무료로 돌아갑니다. 탈퇴는 같은 transaction에서
`AccountProfileService → WithdrawalMarkService → WithdrawalMarkRepository → MyBatis → MySQL(V62)`로 이메일·소셜 연결·사업자등록번호의 HMAC을
1년 남기고, 이메일·소셜 가입과 기업 등록은 계정·기업을 만드는 transaction에서 맞는 표식을 잠가 `PlanUsageService.inherit`로 탈퇴 계정의
체험 기록과 무료 기준 오늘·이번 달 사용량을 새 계정에 한 번 이어 적용합니다. 사업자등록번호 조회 같은 외부 호출은 그 transaction 밖에서 끝냅니다.
[한도·세는 규칙·판단 근거](plan-usage-limits.md)를 참고하세요.

AI 비용은 `ai-service OpenAI 응답 → 사용량 헤더(X-GovBiz-OpenAI-Usage) → Core AiUsageRecordingInterceptor → AiUsageService(REQUIRES_NEW)
→ AiUsageRepository → MyBatis → MySQL(V63)` 순서로 요청마다 남고, 계정·기능은 AI를 부른 기능이 `AiUsageContextHelper`로 표시합니다.
캐시 읽기·30분 쓰기·12시간 쓰기는 입력에서 분리해 각각의 가격으로 계산하며, 미보고 토큰·미등록 쓰기 단가는 미확정으로 남깁니다(V65).
조직 비용 비교는 `AiCostSyncService → OpenAiUsageClient(completions·embeddings) + OpenAiCostsClient → OpenAI`로 같은 UTC 기간을 모두 읽고,
`AiUsageRepository → MyBatis → MySQL`의 한 transaction에서 사용량·실제 비용·조회 완료 날짜를 함께 저장합니다.
동기화 상태 행을 잠그고 수집 시작시각을 비교해, 늦게 완료된 과거 수집이 새 결과를 덮는 것을 막습니다.
Core를 거치지 않은 Catalog·평가·직접 호출도 선택한 조직/프로젝트 범위면 포함되며, 회원·기능별 앱 기록과 중복 합산하지 않습니다.
관리자는 `/ops/usage` 또는 `/app/admin/ai-costs`에서 UTC 날짜로 비교합니다. 일부 날짜 미조회·토큰 미확정·가격 누락이면 차액을 확정하지 않고,
진행 중인 날짜와 제공자의 지연 집계 가능성을 표시합니다. 계정 상세의 이번 달 합계만 기존 서울 기준을 유지합니다.
[AI 사용량과 비용 계약](../backend/core-service/README.md#ai-사용량과-비용)에 저장 범위와 한계를 정리합니다.

## 검색·상세 조회·원문 근거 질문

공개 대화 해석·검색·근거 질문은 입력 검증 뒤 Controller에서 `SupportProgramRequestAdmissionService`를 거쳐
기존 업무 Service를 실행합니다. 하나의 Bean이 접속 주소별/전체 최근 60초 및 동시 작업 한도를 공유하며,
거절 시 하위 Service를 호출하지 않고 429 또는 503을 반환합니다. 잠금은 입장 판단·카운터 갱신에만 사용하고
외부 호출 중에는 유지하지 않습니다. `finally`로 정상·예외 종료 모두 동시 슬롯을 반환합니다.
준비 상태·상세 GET·Health·백그라운드 동기화·비웹 평가는 이 공개 제한과 분리합니다.
전달 헤더를 기본 신뢰하지 않으며 Compose 프록시/NAT 뒤에서는 주소별 한도를 공유할 수 있습니다.
단일 프로세스 보호이며 분산 한도·전역 비용 상한은 아닙니다. [설정·경계·검증](support-program-request-limits.md)을 참고하세요.

요청 제한을 통과한 AI 검색(검색어가 있을 때)과 원문 질문은 이어서 요금제 하루 한도를 씁니다.
`Controller → PlanUsageService.consume → PlanUsageRepository → MyBatis → MySQL`(로그인 회원) 또는
`GuestPlanUsageRepository → Redis`(로그인 전 AI 검색 체험)에서 AI 호출 전에 한 번을 먼저 빼고, 하위 Service가 실패하면
되돌립니다. 원문 질문은 로그인한 회원만 씁니다. 한도 초과는 `429 PLAN_QUOTA_EXCEEDED`, 사용량을 확인할 수 없으면
`503 QUOTA_UNAVAILABLE`이며 분당 제한과 다른 코드입니다. [요금제 사용량 한도](plan-usage-limits.md)를 참고하세요.

### 후속 대화의 조건 변경 해석

`POST /api/v1/support-programs/conversation/interpret`는 확정 상태·새 메시지·선택적인 미확정 제안 또는
마지막 질문과 초안, 최근 성공 검색의 조건·결과 수 요약을 처리합니다. Core의 전용 Service와 AI Client를 통해 AI Service의 조건 해석 Agent를 호출하고,
변경 목록을 검증·병합해 제안 또는 보완 질문을 반환하고, 결과 설명 질문에는 변경 없는 ANSWERED 응답을 반환합니다. 전체 상태 재작성으로 조건이 누락되지 않도록
변경 목록에 없는 필드는 코드로 유지합니다. 변경 전후 필드 목록은 Core가 계산합니다.
`서울특별시`→`서울`처럼 표기만 다른 지역 변경은 지역 사전으로 판별해 기존 표기를 유지하고 바뀐 조건으로 세지 않습니다.

이 단계는 Search Service·Repository·MySQL·Qdrant를 호출하지 않습니다. Web은 미확정 제안을 별도로 보관하고
사용자가 확인했을 때만 조건을 적용해 아래 기존 POST 검색을 실행합니다. 해석과 확인 검색은 별개의 공개 요청입니다.
질문·설명·오류·취소는 확정 조건을 바꾸지 않으며, 사용자가 확인한 검색 실패의 재시도는 다시 해석하지 않습니다.
입력을 시작해도 미확정 제안을 보관해 다음 발화에 전달합니다. 새 검색을 시작하면 이전 결과 요약을 비워
실패·취소를 과거의 0건 성공 결과와 혼동하지 않습니다. 설명은 전달된 사실에 한정하고 원인을 추측하지 않습니다.
서버 대화 세션·영구 프로필·무제한 이력·Agent graph는 추가하지 않습니다.
검색 대화의 모델은 조건 변경안과 답변·질문 종류 코드만 반환합니다. AI Service가 허용된 존댓말 문구와 검증된
검색 건수로 `answer`·`clarificationQuestion`을 작성하므로 범위 밖 설명·말투 변경을 자유 문장으로 출력할 수 없습니다.
확인 질문의 종류 코드(`clarificationKind`)는 Core가 허용 코드만 공개 응답에 전달하며, Web·앱은 찾는 지원사업을 묻는
`QUERY` 질문에 공용 지원 분야 빠른 답변을 보여 고른 문구를 새 메시지처럼 다시 해석합니다. 검색은 여전히 확인 카드에서만 실행합니다.
모델 오류는 그대로 오류로 반환합니다. 이 제한은 C02 안내문에 적용되며 추천·근거 답변의 의미 정확도를 보증하지 않습니다.
[C02 계약·검증 기록](conversation-condition-update.md)에 상태·문자·날짜·실패 경계를 명시합니다.

### 도우미 자유 질문

모바일은 로그인된 계정에서 `AssistantProvider → AssistantScreen → shared AskAssistantUseCase → mobile api/assistant →
Bearer POST /api/v1/assistant/messages → AssistantMessageController → AssistantMessageService → 기존 AI Service`로 연결합니다.
외부 응답은 모바일 API 경계에서 shared `assistantAnswerDtoSchema` 검증과 `toAssistantAnswer` 변환을 거칩니다.
모바일 도움말은 플랫폼의 현재 절차·기능을 소유하며 웹의 React·Redux·라우터를 가져오지 않습니다.
검색어·원문 질문 초안은 API·URL에 새로운 계약을 추가하지 않고 검증된 로그인 세션 메모리로 전달하며 기존 입력 교체 확인 후에만 적용합니다.
카드 목적지는 종류와 복합 공고 ID를 함께 검증합니다. 대화는 로그인 세션에만 유지하고 버튼 위치만 API·계정별 SecureStore에 보관합니다.
루트의 이동형 버튼과 메뉴는 같은 전체 화면 Modal을 열며 기존 시트는 배경 버튼을 차단합니다.
Modal 내부의 별도 `SafeAreaProvider`가 도우미 창의 안전 영역을 측정하며 `AssistantScreen`이 그 값으로 상·하단 여백을 갱신합니다.
열었던 네이티브 페이지는 `AssistantOrigin.path`에 로컬 문맥으로 보존해 페이지별 주요 질문을 선택합니다.
주요 질문과 `다른 주제 보기`를 구분하고 재진입 때 추천만 갱신하며 대화는 유지합니다. Core 요청에는 기존 `context.route`·`programSelected`만 전달합니다.
질문 전송·추천 질문 선택 시 추천 영역을 숨기고 `새 대화`나 다른 페이지·공고에서 열 때 다시 표시합니다.
추천 표시 상태는 대화·입력과 함께 로그인 세션에 유지하며 같은 화면에서 닫기 후 재진입은 이를 초기화하지 않습니다.
도움말의 `topic`·`companyAction`·`contextual`은 모바일 UI 메타데이터이며 `assistantHelpInput`에서 제외합니다.
공고 상세의 로컬 안내는 질문 창 열기만 전달하며, 빈 질문 초안은 기존 입력을 지우거나 AI를 실행하지 않습니다.
로그아웃·계정 전환·재로그인은 메모리와 진행 요청을 폐기하고 유료 실행을 자동 재전송하지 않습니다.
자유 질문은 모바일의 `EXPO_PUBLIC_ASSISTANT_AI_ENABLED=true`일 때만 활성화합니다. 아래의 웹 활성화와 Core 도구 에이전트 설정은 별도입니다.

`POST /api/v1/assistant/messages`는 화면 오른쪽 아래 도우미 위젯의 자유 질문을 받으며 로그인한 회원만 씁니다(비로그인 401). 주제·질문 알약(C1)은 네트워크 없이
프런트 도움말 데이터로 답하고, 프런트 스위치 `VITE_ASSISTANT_AI_ENABLED=true`일 때만 자유 입력이 이 경로로 옵니다(기본 꺼짐, 꺼지면 알약 안내로만 답함). Core는 길이 상한·개인 정보 마스킹·공유 요청 한도를 거친 뒤
AI Service의 `/internal/v1/assistant/answers`를 한 번 호출해 의도 하나와 그 의도의 필드(인용·검색어·계정 영역·확인 질문)를 받습니다.
AI Service는 DB를 보지 않고 도구도 없습니다. 상태 답(`ACCOUNT_STATE`)은 Core가 세션 계정으로 관심 공고함·받은 제안함·기업 등록을
읽어 문장을 만들고, 검색(`SEARCH`)·원문 질문(`PROGRAM_QUESTION`)은 실행하지 않고 기존 화면으로 이동 버튼만 붙입니다.
인용 id는 요청에 실린 도움말 안에서만, 이동 경로는 Core 상수와 도움말 행동 경로 안에서만 인정하며 어긋나면 502로 버립니다.
도우미 대화는 Redux의 `assistant` 상태와 계정 소유자를 포함한 브라우저 탭 `sessionStorage`에 보관합니다. 인증 확인 전에는 복원하지 않고, 확인된 같은 계정의 캐시만 복원합니다. 로그아웃·로그인·계정 전환은 auth 이벤트에서 대화와 캐시를 초기화하며 같은 계정 재로그인도 새 세션 버전으로 구분합니다. ViewModel은 이전 세션의 요청을 취소하고 늦은 성공·실패·관심 공고 조회 결과를 버립니다. 계정 정보가 없는 구버전 캐시는 초기화합니다. 자유 질문에서는 현재 세션의 최근 대화 최대 6개를 Core에 보내지만, 서버는 도우미 대화 기록을 저장하지 않습니다. 분류·인용 회귀는 [도우미 의도 분류 평가](../evaluation/assistant/README.md)로 확인합니다.

Core 설정 `app.assistant.agent-enabled=true`(루트 `ASSISTANT_AGENT_ENABLED`, 기본 꺼짐)면 같은 질문을 AI Service의
`/internal/v1/assistant/agent`(LangGraph 도구 에이전트)로 보냅니다. 분류 뒤 회원 자료가 필요한 의도(`PARTNER_MATCH` 모집글 매칭,
`ACCOUNT_STATE` 내 상태, `SAVED_PROGRAMS_QUESTION` 관심 공고 묶음 질문)만 AI Service가 Core 내부 읽기 도구
`GET /internal/v1/assistant/tools/{company-profile|recruitments|saved-programs}`를 최대 3회 되불러 답과 카드(`cards[]`, 모집글·공고, 이유·인용·상세 경로)를 만듭니다.
도구 호출은 Core·AI Service가 공유하는 비밀(`ASSISTANT_TOOLS_TOKEN`, 32자 이상)과 요청마다 발급하는 계정 묶음 HMAC 토큰(5분) 둘 다 있어야 통과하고,
응답 카드 id·경로·인용은 Core가 도구 결과·허용 목록·청크 원문과 다시 대조합니다. 관심 공고 묶음 질문은 첫 응답이 `needsDocuments`면 Core가 관심 공고
최대 10건의 원문을 확보·청킹·색인(6초 예산, 부분 성공 허용)해 같은 의도로 한 번 더 부르고, 관심 공고를 담을 때 원문을 미리 수집·색인하는
outbox 큐(`ASSISTANT_PREFETCH_QUEUE_ENABLED`, RabbitMQ)가 첫 질문 지연을 줄입니다. 비로그인은 도구 경로가 막혀 로그인 안내로 끝납니다.

공고 카드 식별자는 일반 공고와 같은 `sourceCode:sourceProgramId` 계약을 따릅니다. 제공처 코드는 최대 64자,
원본 ID는 최대 255 Unicode code point이며, Core가 원본 ID로 재구성한 상세 URL과 응답 카드의 경로가 일치해야 합니다.

### 확인된 조건의 검색

```text
POST /api/v1/support-programs/search (조건 검색)
GET /api/v1/support-programs/search (기존 단문·최신 목록)
  → SupportProgramController
    → SupportProgramSearchPreviewService (인증별 공개 범위·결과 보관)
      → SupportProgramSearchService
        → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
          → 빈 검색: findPublishedPresent로 공개 세대·지문이 있는 DB 공고 선택
          → 자연어 검색: findSearchablePresent로 위 조건에 index_ready=true 추가
        → 접수 상태 계산·필터
        ├→ 빈 검색어: 최신순 최대 5개 반환
        └→ 검색어 있음:
            AiSupportProgramRetrievalFacade
              → ElasticsearchSupportProgramClient → Nori·BM25 후보 최대 20개
              → AiSupportProgramIndexClient → AI Service → 현재 색인 검증 → 질의 임베딩 캐시/OpenAI → Qdrant 후보 최대 20개
              → Core: 두 순위의 RRF 결합 → 후보 최대 20개
            AiSupportProgramRankingFacade → HttpAiSupportProgramRankingClient
              → AI Service → 정확일치 랭킹 응답 캐시, 없으면 단일 Agent → OpenAI 점수화·검증
            Core의 응답 검증 → 최종 추천 0~5개 → 같은 공고의 다른 제공처 게시물 묶기
              → 회사 소재지와 겹치지 않는 지역 태그 공고는 뒤로·표시
```

공개 GET·POST 검색은 로그인 세션에 따라 비회원에게 앞의 최대 2건, 회원에게 최대 5건을 반환합니다.
응답의 `totalCount`는 전체 카탈로그 건수가 아니라 이번 추천 결과 수(0~5건)입니다. 비회원의 추가 결과가 있으면
Core의 `SupportProgramSearchPreviewService`가 `SupportProgramSearchResultRepository`를 통해 원본 결과·검색 조건을 Redis에 30분 보관하고,
브라우저에는 공개 2건과 난수 `resultToken`, `expiresAt`만 전달합니다. 잠긴 카드에는 원본 내용을 전달하지 않습니다.

```text
선택한 잠금 카드 → 회원가입/로그인 → POST /api/v1/support-programs/search/results
  → SupportProgramController → SupportProgramSearchPreviewService
    → SupportProgramSearchResultRepository → Redis: Lua로 토큰 만료·소유 계정 확인 및 최초 계정 연결
      → 보관된 전체 결과와 검색 조건 (회원 세션 인증은 기존 MySQL 경로)
```

복원은 추가 검색·임베딩·랭킹 호출 없이 같은 결과를 반환하며 첫 조회 계정에 토큰을 귀속시킵니다.
같은 계정의 재시도는 허용하지만 만료·미존재·다른 계정의 조회는 410으로 명시합니다.
`govbiz:search-result:v1:{SHA-256(token)}` 키의 JSON·소유 계정·TTL을 함께 관리하므로 Core 재시작·여러 Core 사이에서
상태를 공유합니다. TTL과 응답 `expiresAt`은 Redis 시계 기준의 고정 30분이며 복원으로 연장하지 않습니다.
기존 128건 조기 퇴거 대신 Redis `128mb/noeviction`과 개별 JSON 2MiB 제한을 사용합니다. 저장소 장애·용량 초과는
503 `SUPPORT_PROGRAM_SEARCH_RESULT_STORE_UNAVAILABLE`이고 로컬 메모리 fallback/자동 재검색은 없습니다.
Compose는 Redis 8.2.9·AOF 볼륨(`everysec`)을 사용하므로 Redis 컨테이너 재생성 후에도 볼륨이 남으면 복원되지만,
비정상 종료 시 최근 약 1초의 결과/계정 연결이 유실될 수 있습니다. 다중 Redis 복제/고가용성은 아직 구현하지 않습니다.
Lettuce 전용 DNS 캐시는 최대 5초로 제한해 Redis 컨테이너 교체로 IP가 바뀌어도 재연결할 때 새 주소를 확인합니다.
대화 기록 원본과 회원 세션은 MySQL을 유지하고, AI 랭킹·임베딩 캐시는 기존 AI Service 메모리에 둡니다.
Redis 추가는 첫 검색을 빠르게 하는 변경이 아니며 검색·복원 응답에는 `Cache-Control: no-store`를 설정합니다.
일일 리포트·평가는 기존 내부 `SupportProgramSearchService`를 계속 사용하고, 공개 카탈로그·상세 조회는 이 제한과 분리합니다.
파일별 책임·저장 구조·TTL·계정 경합·장애·설정·검증은 [Redis 적용 상세](redis-search-result-restoration.md)에 정리합니다.

등록 기업 계정의 새 채팅은 `Web → 기존 내 기업 조회 API → 회사 Service/Repository → MySQL`로
소재지·업종·설립연도를 읽어 기본 조건을 설정합니다. 이후 `Web → 대화 해석 → 확인 → 검색 → AI 랭킹`에
같은 조건을 전달합니다. 회사 조회 실패는 명시적으로 표시하며, 로그아웃·새 대화 후 늦은 응답은 무시합니다.
대화 중 수정·해제한 조건이나 과거 기록을 현재 회사 프로필로 덮어쓰지 않습니다.
설립연도 foundedYear는 날짜 establishedOn과 별도로 정밀도를 보존하며 둘 중 하나만 지정합니다.
AI는 연도 범위 전체로 확인 가능한 업력 요건과 정확한 날짜가 필요한 경계를 구분합니다.

Web의 POST 검색은 `query`와 선택적인 `companyConditions`를 따로 보냅니다. Core의 공개 DTO는
날짜·길이·문자 입력을 검증한 뒤 조건 Domain 모델로 변환합니다. 검색 Service는 요청별 서울 날짜를
한 번 정하고, 후보 검색에는 조건을 포함한 검색문을, Ranking Facade에는 원래 질의와 구조화된 조건을
전달합니다. Facade가 AI 전용 DTO로 바꿉니다. 이 검색 요청의 조건을 지원사업 원본 Repository나 계정·기업 DB에
저장하지는 않지만, 로그인 복원용 Redis 스냅샷에는 함께 보관합니다. 검색 조건 도입으로 SQL·동기화·스키마는
변경하지 않습니다. 조건이 없는 GET 및 비웹 평가 호출은 기존 단문 경로를 유지합니다.

1. Repository는 `is_source_present = TRUE`이고 제공처의 공개 세대·지문이 있는 공고를 읽습니다. 자연어 검색은
   `index_ready = TRUE`도 요구하며, 빈 검색은 공개 이후 색인 장애와 무관하게 기존 DB 목록을 유지합니다.
   저장된 신청 기간과 서울 날짜로 접수 상태를 다시 계산하고 `acceptingOnly=true`이면 `OPEN`만 남깁니다.
2. 검색어는 앞뒤 공백을 제거합니다. 검색어가 비어 있으면 `source_sort_timestamp` 내림차순·제공처 코드·원본 ID
   오름차순의 최대 5개를 AI 없이 반환합니다. 자연어 검색의 빈 후보가 전체 색인 장애 때문이면 503으로 알리고,
   최초 빈 DB나 준비된 제공처의 정상 0건이면 빈 목록을 반환합니다. 미공개 제공처 데이터는 노출하지 않습니다.
3. 비어 있지 않은 질의는 대상 공고 전체의 정확한 ID·내용 해시를 AI Service에 전달합니다.
   Core는 적격 공고 전체 값과 순서가 같은 동안 단일 불변 스냅샷의 해시·두 색인 버전 참조를 재사용합니다.
   스냅샷 크기는 제한하며 큰 입력은 저장하지 않고 정상 처리합니다. 가변 목록을 복사하고 HTTP 호출을 락으로
   직렬화하지 않습니다. DB 조회·접수 상태 계산·공개/색인 준비 검증·키워드 순위 계산은 매 요청 유지합니다.
   최신 공고 20개를 먼저 자르지 않습니다. Qdrant가 반환해야 할 개수는 `min(대상 공고 수, 20)`입니다.
4. `AiSupportProgramRetrievalFacade`는 먼저 `ElasticsearchSupportProgramClient`로 현재 적격 버전에 한정한
   Nori v2(`discard`, 사용자 사전·검색용 동의어)·BM25 상위 20개를 조회합니다. 동일 검색 시점의 전체 버전 가시성·부분 실패·ID·해시·점수를
   검증합니다. 질의·본문은 NFC로 정규화하며 동점은 정렬 시각 내림차순·제공처 포함 ID 오름차순입니다.
   이어 의미 검색 응답의 질의·ID·해시·중복·유한 점수·내림차순·개수를 검증합니다.
   의미 검색과 키워드의 1부터 시작하는 순위를 동일 가중치 RRF `1 / (60 + 순위)`로 합산하고,
   동점은 의미 검색 순위·제공처 포함 ID 오름차순으로 정렬해 중복 없는 최대 20개를 점수화에 전달합니다.
   어느 색인이든 실패하거나 잘못됐으면 오류를 반환합니다. 정상 키워드 일치가 없으면 의미 검색 순서를 유지합니다.
5. AI Service는 전체 입력이 같은 검증된 랭킹 응답을 재사용하거나 모든 후보를 다시 평가합니다.
   AI는 후보의 의미·자격·세부 점수를 판단하고 총점은 출력하지 않습니다.
   요청별 strict schema의 `rankings`는 후보 ID 자체를 필수 키로 선언한 객체이며 다른 키는 금지합니다.
   Agent가 후보별 원문 조각 선택지를 제공하고, LLM은 인용문을 재작성하지 않고 근거 번호만 선택합니다.
   출력 스키마는 자격별 분기를 나눠 MATCH·INCOMPATIBLE에 근거 번호 1개를 필수로 하며,
   UNKNOWN만 0~1개를 허용합니다. 추천 이유도 항목별 1~120자 제한을 생성 형식에 선언합니다.
   번호를 해당 후보의 원래 필드·문구로 복원한 뒤 검증된 키를 ID로 붙여 `AssessedSupportProgram` 목록으로 변환합니다.
   AI Service가 `2 × (semanticRelevance + supportTypeFit)`으로 관련도를 계산해 `ScoredSupportProgram`으로 변환한 뒤
   원문 인용과 자격·추천 기준을 검증하고 관련도 내림차순으로 정렬합니다. 자격 미확인은 별도로 표시합니다.
   Core도 최종 응답의 후보 ID·질의·계약 버전·점수·순서·추천 이유·실제 본문 인용을 재검증해
   비저장 검색 결과 `eligibilityReview`를 포함한 공개 응답으로 변환합니다.
6. Search Service가 `SupportProgramDuplicatePostings`로 서로 다른 제공처가 따로 올린 같은 공고(정규화 제목·기관·마감일
   일치, 제목 머리말 지역이 서로 다르면 제외)를 순위가 높은 한 칸으로 묶고 다른 게시물을 `alsoPostedBy`로 붙입니다. 랭킹 입력은 바꾸지 않습니다.
7. 회사 소재지가 있으면 Search Service가 `_common/domain/RegionDictionary`로 전국이 아닌 공고 지역 태그와 회사 시·도가
   겹치지 않는 공고(본문 지역 `MATCH` 제외)를 빼지 않고 결과 뒤로 보내 `regionTagMismatch`로 표시합니다.
   같은 그룹 안의 관련도 순서는 유지하며, 비회원 미리보기 2건·Redis 보관·일일 리포트도 이 순서를 씁니다.
8. 순위 매기기까지 간 검색은 AI Service가 이미 세던 사유별 제외 후보 수(관련도·지원 대상·지역)를 `exclusionCounts`로
   응답에 싣습니다. 검색어에 맞는 후보가 없으면 순위 매기기를 부르지 않고 모두 0입니다.

앱은 검색을 기다리는 동안 조건 정리(확인 후 보낸 순간 완료) → 공고 찾기 → 자격 확인 단계와 지난 시간을 보여 주고,
10초가 지나면 보통 걸리는 시간을 안내합니다. 서버가 단계 진행을 알리지 않으므로 공고 찾기·자격 확인은 보통 걸리는
시간만 적고 시간에 맞춰 단계를 넘기지 않습니다. 결과 카드는 `evidenceQuestionSupported`인 공고(또는 함께 묶인 같은 공고)에
"이 공고에 질문하기"를 두어 웹은 원문 질문 패널이 열린 상세(`?ask=1`), 앱은 공고 화면의 질문 시트로 엽니다. 웹 상세의 질문 패널은 1024px 이상에서 오른쪽 할 일 칸 자리에 들어가 본문을 가리지 않고(스크롤해도 남음), 그보다 좁으면 아래 시트로 덮습니다.
비회원은 기존 로그인 후 복귀 흐름을 거칩니다. 결과가 없던 마지막 검색에는 `exclusionCounts`로 센 사유와 조건 빼기
(뺀 후보가 있는 지역·업종·설립 조건, 마감·예정 공고 포함)를 두고, 고르면 AI 해석 없이 그 조건만 지운 확인 카드를 만들어
사용자가 확인한 뒤에만 검색합니다(`Web/앱 → 확인 카드 → GET 검색 → Core → AI 순위 매기기`).

AI의 두 캐시는 프로세스 안의 서비스 인스턴스에만 속합니다. 질의 임베딩은 정확한 입력 문자열별
최대 256개·300초, 랭킹 응답은 질의·조건·기준일·전체 후보 본문/메타데이터/순서·결과 제한·계약 버전이
같을 때 최대 128개·300초 재사용합니다. 모델·프롬프트·전처리 정책이 고정된 인스턴스끼리도 공유하지
않습니다. 전체 검색 결과 캐시는 아니며 Core의 현재 DB 조회·접수 상태 계산과 AI의 collection/전체 버전
검증·Qdrant 후보 조회는 매번 실행합니다. 준비 실패 시 캐시 조회 전에 오류를 반환합니다.
두 캐시는 검증된 정상 값만 복사 저장·반환하며 TTL은 성공 시점부터 계산합니다. 만료는 재사용 차단이며
물리적인 즉시 삭제 보장이 아닙니다. 같은 입력의 동시 요청만 합류하고 다른 입력은 병렬 처리합니다.
랭킹 대기자 하나의 취소는 공유 작업을 유지하고 마지막 대기자의 취소는 작업을 종료합니다. 임베딩 수행
요청이 취소되면 남은 요청이 다시 실행합니다. 실패는 저장하지 않으며 기존 오류·후보 수·배점·시간 상한은
유지합니다. 상세 범위는 [검색 지연 개선 기록](search-latency-20260908.md)을 참고하세요.

```text
GET /api/v1/support-programs/readiness
  → SupportProgramController → SupportProgramSearchReadinessService
  → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
  → 제공처별 공고 수·색인 준비·최근 동기화 시각과 전체 검색 범위를 반환
```

`support_program_sync_status`는 제공처별 공개 스냅샷의 세대·검색 문서 지문·공고 수와 색인 준비 상태를
최근 카탈로그 동기화 결과와 분리해 보관합니다. 제공처별 `indexReady=true`이면 공고 수가 0이어도 검색 가능합니다.
색인이 준비된 이전 스냅샷을 유지한 채 새 수집·사전 색인이 실패하면 `SEARCHABLE_WITH_SYNC_FAILURE`이며,
색인 준비가 확인되지 않은 공개/실패 상태는 `UNAVAILABLE`입니다.
공고 없는 초기 준비는 `PREPARING`, 상태 행 없이 공고가 남아 있는 복구 전 legacy는 `UNAVAILABLE`입니다.
시각은 서울 시계를 사용해 저장하고 API에서는 `+09:00` 오프셋이 포함된 ISO-8601 문자열로 반환합니다.

`SupportProgramSourceReadinessResult → SupportProgramSourceReadinessResponse` 변환으로 필수 `sources`와
전체 검색 범위를 제공합니다. 일부만 준비되면 `SEARCHABLE_WITH_PARTIAL_SOURCES`이며 외부 호출은 없습니다.
상태가 아직 없는 현재 공고의 제공처도 준비 미확인으로 표시합니다. 초기 빈 DB에서는 기업마당과
`KSTARTUP_SYNC_ENABLED=true`인 경우 K-Startup을 표시합니다. 하나가 준비 중이어도 준비된 제공처 검색은 유지합니다.
세부 정책과 검증은 [다중 제공처 준비](support-program-multi-source-preparation.md)에 있습니다.

점수화 계약은 `govbiz-support-program-ranking-v5`입니다. 의미 관련성 20/40점 이상을
충족해야 하며, `targetEligibility` 또는 `regionEligibility`가 `INCOMPATIBLE`이면 추천에서 제외합니다.
관련도는 `2 × (semanticRelevance 0~40 + supportTypeFit 0~10)`입니다. 자격·접수 상태를 가산점으로 쓰지 않습니다.
LLM 출력의 `targetAssessment`·`regionAssessment`는 자격 상태·설명·후보별 원문 조각 번호만 포함합니다.
미확인 자격 때문에 관련도가 낮아지거나 별도 총점 컷에서 탈락하지 않습니다.
Agent가 번호를 공식 API 본문의 `{field, quote}`로 복원하며 Core와 공개 HTTP 인용 계약은 유지합니다.
전체 `summary`·`targetDescription`도 그대로 모델에 제공해 조각 경계로 뒤쪽 조건·예외가 생략되지 않게 합니다.
후보 summary/targetDescription은 최대 6,000/2,000 code point이며 절단 여부를 별도로 전달합니다.
절단된 후보는 누락된 조건을 확인한 것처럼 판정하지 않도록 두 축 모두 `UNKNOWN`만 허용합니다.
`regions`는 후보 검색용 태그이지 자격 근거가 아닙니다. AI와 Core는 MATCH/INCOMPATIBLE의 본문 인용을 필수로
검증하며 실제 전달된 해당 필드의 정확한 부분 문자열만 인정합니다. 인용 존재 검증이 의미 판단을 보증하지는 않습니다.
지역 지침과 내부 schema는 회사·특정 사업장·개인 중 제한 주체를 먼저 구분하고 같은 주체의 주소를 비교합니다.
회사 주소로 본점·공장 주소나 개인 거주지를 확정하지 않습니다. 서울 기업·서초구 한정은 UNKNOWN이지만,
별도 허용 경로 없는 서울 기업·안산 관내 한정은 INCOMPATIBLE입니다. 본문에 없는 지점·이전 경로는 만들지 않고,
실제 허용된 대안 중 하나를 충족하면 다른 대안을 추가로 요구하지 않습니다. 충족 경로 없이 미확인 대안이 남으면
UNKNOWN이며, 확인된 회사 소재지 하나만으로 별도 사업장의 부재를 증명하지 않습니다.
이는 모델의 의미 판단 지침이며 독립적인 행정구역 필터가 아닙니다. 후속 변경은
[지역 충돌·Fast 기록](region-conflict-fast-20260908.md)에 정리합니다.
`UNKNOWN`은 확인 필요 배지로 구분하며 전체를 관련도순으로 표시합니다. 동점은 입력 후보 순서입니다.
검색당 최대 5개이며 공개 DTO의 `eligibilityReview`로 판정·설명·근거와 `OFFICIAL_API_TEXT` 범위를 노출합니다.
첨부파일을 자동 판독하거나 신청 자격을 확정하는 기능은 아닙니다. v5 점수화는 기존 DB·색인 구조와 호출 횟수를
유지합니다. C02 대화 해석은 사용자 확인 검색에 앞서는 별도 모델 호출입니다.
AI Service가 부적격 항목을 최종 응답에 넣으면 Core는 이를 응답 계약 위반으로 거부합니다.
결과가 0개인 것은 정상일 수 있으며 관련 없는 공고로 5개를 채우지 않습니다.

직접 필터 검색은 AI 추천과 분리된 공개 목록 경로입니다.

```text
필터 검색 탭 → ViewModel → BrowseSupportProgramsUseCase → Repository → GET /api/v1/support-programs/catalog
  → SupportProgramCatalogController → SupportProgramCatalogService
  → SupportProgramRepository.findPublishedPresent → MyBatis Mapper → Mapper XML → MySQL
```

공개 DB 스냅샷을 한 번 조회해 키워드·지역·분야·접수 상태·제공처로 필터링하고 정렬·페이지 처리를 합니다.
K-Startup은 업력·신청 대상·연령의 전용 분류도 정확히 비교합니다. 분류 메타데이터는 V7의 nullable JSON에
저장하고 `CatalogSupportProgram.startupDetails`로 복원하며, 공개 카드 DTO에는 AI 판단으로 노출하지 않습니다.
AI·임베딩·Qdrant·외부 제공처 API를 호출하지 않으며 색인 장애 후에도 이미 공개된 목록을 읽을 수 있습니다.
지역·분야는 제공처의 정확한 태그 일치이지 기업 자격 판정이 아닙니다. 결과에는 추천 점수나 자격 판정을 넣지 않습니다.
현재 규모에서는 기존 전체 스냅샷 조회에 전용 분류 매핑을 더해 재사용합니다. 트래픽·데이터 증가 시
실측에 따라 DB 필터/페이지 조회를 검토합니다. 입력·정렬·응답 계약은 [직접 조건 검색](support-program-catalog.md)을 참고하세요.

검색 카드의 상세 링크는 `/support-programs/detail?sourceCode={sourceCode}&sourceProgramId={id}`로
이동합니다. 상세 화면은 해당 URL의 식별자로 공개 상세 API를 다시 호출하므로 직접 진입·새로고침이 가능합니다.

```text
GET /api/v1/support-programs/detail
  → SupportProgramController → SupportProgramDetailService
  → SupportProgramRepository → MyBatis Mapper → Mapper XML → MySQL
```

상세 GET은 외부 API·AI를 호출하지 않습니다. 현재 노출된 복합 식별자 행만 반환하며 없는·미노출 행은
`SUPPORT_PROGRAM_NOT_FOUND`(404)입니다. 검색 문맥이 없으므로 추천 이유는 빈 배열, 점수는 `null`입니다.
공개 입력 제한과 JSON·오류 코드의 전체 계약은 [지원사업 API 계약](support-program-search-contract.md)에 있습니다.

### 공고 상세 첨부파일

상세 화면은 본문과 따로 첨부 목록을 불러옵니다. 목록은 공고 원문 페이지가 직접 연결한 파일(이미지 제외)이며,
파일은 Core가 원본에서 받아 내려 줍니다. 원본 다운로드 주소와 Referer는 Core 안에만 두고 공개 응답에 내보내지 않습니다.

```text
GET /api/v1/support-programs/detail/attachments
  → SupportProgramAttachmentController → SupportProgramAttachmentService
  → SupportProgramDetailService(현재 공개 공고 확인) → Redis 보관 목록(6시간)
  → 보관 목록이 없으면 제공처별 AttachmentClient.links(공식 상세 페이지만 읽고 파일은 받지 않음)

GET /api/v1/support-programs/detail/attachments/download?index=
  → 같은 목록의 index 첨부 → AttachmentClient.open(검증한 원본 주소)
  → 원본 응답 본문을 Core 응답으로 그대로 전달(UTF-8 파일 이름, 100MB 상한)
```

신청 문서·중복 검토가 쓰는 분석용 수집(`collect`)은 바뀌지 않습니다. 목록용 `links`는 형식·개수를 거르지 않고 이미지만
빼며, 원문 사이트로 가는 요청(보관 목록이 없을 때·받기)만 검색·AI와 별도인 고정 한도(주소별 분당 30, 전체 600, 동시 8)를 씁니다.

### 공고별 공식 원문 근거 질문

기업마당·K-Startup 상세 화면의 **이 공고에 질문하기** 링크는
`/support-programs/detail/question?sourceCode={sourceCode}&sourceProgramId={id}`로 이동합니다.
질문 페이지는 URL 식별자를 검증하므로 직접 접속·새로고침이 가능하며 상세 화면으로 돌아가는 링크를
제공합니다. 페이지 진입 시 API를 호출하지 않고, 사용자가 질문을 제출할 때 아래 기존 API를 호출합니다.
질문 입력·답변·근거 인용·취소 상태는 질문 페이지의 로컬 상태이며 새로고침 시 초기화됩니다.

```text
POST /api/v1/support-programs/detail/answers
  → SupportProgramController → SupportProgramEvidenceService
  → SupportProgramDetailService → 현재 공개 공고 확인
  → SupportProgramRepository → MySQL의 공고별 원문 캐시 조회
  → 캐시가 없거나 URL이 바뀌었거나 6시간이 지남:
      SupportProgramSourceDocumentFacade → 제공처별 Client
        → BIZINFO: BizInfoSourceDocumentClient → 기업마당 공식 HTTPS 상세 HTML
        → KSTARTUP: KStartupSourceDocumentClient → K-Startup 공식 HTTPS 상세 HTML
          (마감 공고는 진행 중 페이지의 fullUrl로 같은 공고의 마감 페이지를 한 번 따라감)
        → 제공처별 Mapper가 읽기 가능한 텍스트로 정규화
      → SupportProgramRepository → MySQL 원문 UPSERT
  → 같은 공고 ID·내용 해시의 불변 청크 재사용 (Core 인스턴스별 최근 32개 공고)
    → 없으면 SupportProgramEvidenceChunker → 결정적 청크 최대 50개
  → AiSupportProgramEvidenceFacade → AI Service
      → 별도 Qdrant evidence 컬렉션에 청크 색인
      → 질문과 가까운 청크 최대 5개 검색 (동일 질문 임베딩은 최대 256개/300초 재사용)
      → 단일 typed Agent → OpenAI 근거 답변·짧은 인용 번호 선택
      → Agent가 검증한 번호를 요청의 원래 청크 ID로 복원
  → Core가 청크·인용을 검증 → 답변과 원문 발췌·URL·원문 이름(sourceLabel) 반환
```

이 경로는 `BIZINFO`·`KSTARTUP` 현재 공고에만 제공되며, 지원 여부와 인용 원문 이름은
`SupportProgramEvidenceService.EVIDENCE_SOURCE_LABELS` 하나로 정합니다. 기업마당 공식 `https://bizinfo.go.kr` 및 그 하위 도메인의
상세 HTML만 허용하며, URL에는 요청한 원본 공고 ID와 같은 `pblancId`가 정확히 하나 있어야 합니다.
자동 리디렉션은 끄고 각 이동 URL을 같은 조건으로 검증해 최대 3회 따릅니다. 따라서 기존 상세 URL에서
`/sii/siia/selectSIIA200Detail.do?pblancId=...`로 이동할 수 있으며, 외부 호스트·비 HTTPS·다른 공고 ID·순환 이동은
거부합니다. 원문 HTML은 최대 500KB로 읽고 jsoup `1.23.2`로 파싱합니다. `.support_project_detail` 안의
`.title_area .title`이 요청 공고 제목과 일치해야 하며, `.view_cont` 본문만 추출해 메뉴·다른 공고·푸터를
제외합니다. K-Startup은 `k-startup.go.kr`의 `bizpbanc-ongoing.do`·`bizpbanc-deadline.do` 상세 URL과 같은 `pbancSn`만
허용하고 HTTP 리디렉션은 따르지 않으며, 마감 공고의 진행 중 페이지가 스크립트 `fullUrl`로 알려 주는 마감 페이지만
한 번 따라갑니다. HTML은 최대 1,000,000바이트로 읽고 `.app_notice_details-wrap`의 `#scrTitle h3`가 공백·따옴표·
문장부호를 무시하고 공고명과 일치할 때 공통 안내·첨부 목록·저작권·버튼·숨김 요소를 뺀 상세 본문을 추출합니다.
저장 URL은 마감 페이지가 아닌 공고의 `sourceUrl`입니다. 정규화 본문은 80~30,000자로 제한합니다. 공식 원문을 성공적으로 읽고 검증한 뒤에만
짧은 DB transaction으로 저장하므로 원문 수집·AI 오류가 공고 동기화·목록 검색·상세 GET을 바꾸지 않습니다.
현재 공고의 제공처가 지원 제공처가 아니면 422 `SUPPORT_PROGRAM_EVIDENCE_NOT_SUPPORTED`, 공식 원문 수집·검증에
실패하면 API 요약으로 대신 답하지 않고 503 `SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE`을 반환합니다. AI 근거 색인·검색·답변의 연결·시간 초과·계약
오류는 일반 AI 경계와 같은 502/503/504 분류를 사용합니다.

Frontend는 `evidenceQuestionSupported=false`인 상세(`MSIT`·`CNTRADE_NOTICE`)에서 질문 페이지 링크 대신 미지원 안내와
원문 링크를 표시합니다. 미지원 제공처의 질문 페이지에 직접 접속해도 입력을 표시하지 않고 ViewModel에서 전송을 차단합니다.
공식 URL 표시 허용은 원문 수집·RAG 지원과 별개입니다. 근거 링크는 서버가 준 `sourceLabel`로 "근거 N · 원문 이름"을 표시합니다.

원문은 제목·공식 URL을 포함한 텍스트로 저장하며, 같은 원문은 요청마다 다시 수집하지 않고 최대 6시간
재사용합니다. 청크는 내용·원문 해시·순서에서 결정적으로 만들며 각 청크는 최대 1,500 UTF-16 코드 단위입니다. AI Service는
일반 공고 검색 컬렉션과 다른 Qdrant 컬렉션만 사용하고, 요청 공고의 청크 집합으로 검색 범위를 제한합니다.
답변이 충분한 근거를 찾지 못하면 `INSUFFICIENT_EVIDENCE`와 인용 없는 안내를 반환합니다. `ANSWERED`에는
검색된 청크의 인용이 하나 이상 있어야 하며 Core는 인용이 전달한 청크 밖을 가리키면 응답을 거부합니다.
인용 발췌문은 선택한 청크 전체를 반환해 청크 뒤쪽의 답변 근거도 화면에서 확인할 수 있습니다.
웹 화면은 답을 먼저 보여 주고 근거 원문은 [근거 원문 N건 보기]로 접어 둡니다. 펼친 원문은 Core가 붙인 공고명·공식 원문
머리 줄과 빈 줄을 빼고, 답과 낱말이 가장 많이 겹치는 줄 한 줄 앞부터 5줄만 보이다 [전체 보기]로 처음부터 다 봅니다(AI 호출 없는
화면 규칙). 출처 링크는 같은 주소를 한 번만 둡니다.

모델에는 64자리 해시를 복사시키지 않습니다. Agent가 이번 요청 배열에 `index`(0~4)를 붙여 전달하고
`SupportProgramEvidenceAnswerSelection.citationChunkIndexes`를 검증한 뒤 원래 `citationChunkIds`로 변환합니다.
`index`는 원문의 `order`와 다르며 요청마다 새로 부여합니다. 범위 초과·중복·상태 모순을 보정하거나 무시하지
않고 기존 오류로 반환합니다. Core와 공개 HTTP의 인용 계약은 변경하지 않습니다.

첨부파일·PDF·OCR·과기정통부·충남 수출입공지 원문 수집은 이 흐름에 포함하지 않습니다. 공고 목록 검색의 의미·키워드 후보 선정·AI
점수화와도 별도 사용 사례이므로, 원문 질문을 하지 않으면 기업마당·K-Startup 상세 HTML을 수집하거나 evidence 컬렉션을
사용하지 않습니다.

## 검색 품질 평가 fixture 내보내기와 캡처

상세 공고의 고정 원문은 별도의 무료 `preflightEvidenceEvaluation` 명령으로 먼저 점검합니다.
`공식 RAG fixture → 실제 Core 청커 → 실제 검색 상한과 비교 → 참조 구절 매핑·후보 범위 보고서`
흐름이며, Spring·DB·HTTP·모델 호출 없이 동작합니다. 입력 해시와 청커 class 지문을 남기고 사람
검토를 승계하지 않습니다. 후보 청크가 검색 상한 이하면 검색 순위 판별을 측정할 자료로 집계하지
않습니다. 이 준비 결과를 아래 실제 검색 캡처나 서비스 전체 품질 검증 결과로 취급하지 않습니다.
[명령·출력 계약](../backend/core-service/README.md#상세-공고-rag의-실제-청킹-사전-점검)을 따릅니다.

```text
evaluation-fixture-export profile (비웹 실행)
  → findSearchablePresent로 준비된 제공처의 공개 공고 조회 → 지정한 referenceDate 기준 OPEN 공고만 선정
  → SupportProgramIndexDocumentMapper와 같은 ID·내용 해시·검색 문서 생성
  → 기준 날짜·전체 적격 카탈로그와 cases: []인 미라벨 fixture 초안을 원자적으로 JSON 기록
  → 질문을 고정하고 선택한 AI-only·혼합·사람 검토 방식으로 참조 라벨 확정

evaluation-capture profile (비웹 실행)
  → 질문 묶음 JSON 검증
  → 같은 referenceDate로 SupportProgramSearchService.searchWithTrace
      → 준비된 제공처의 현재 공고 → 기준 날짜의 적격 공고 → 의미·키워드 RRF 후보 최대 20개 → AI 최종 추천 최대 5개
  → 기준 날짜·질문별 후보 ID·최종 ID·카탈로그 지문을 원자적으로 JSON 기록
  → 별도 Python 평가 도구가 선택한 판정 출처의 fixture와 대조
```

두 경로 모두 공개 Controller나 디버그 HTTP endpoint가 아닙니다. `evaluation-fixture-export`는 자신의 웹 서버와
두 동기화 스케줄러를 끄고 공고 데이터는 MySQL에서만 조회합니다. 따라서 Qdrant·AI Service·OpenAI를 호출하지
않으며, 전체 카탈로그 검증이 끝난 뒤에만 출력 파일을 원자적으로 교체합니다. `referenceDate`는 실행 시각의
오늘이 아니라 신청 시작·종료일로 접수 상태를 다시 계산하는 평가 기준이며 생성 fixture에 함께 기록됩니다.
생성된 `cases: []`에는 고정 질문의 `id`·`query`·`split`과 선택한 판정 방식의 `relevantIds`를 채웁니다.
현재 공유 실행은 AI-only이며 사람 검토 정답으로 표시하지 않습니다. 질문 묶음의 `name`과 각
`id`·`query`·`split`은 fixture의 `cases`와 같은 순서·내용으로 맞춥니다.

`evaluation-capture` profile도 자신의 웹 서버와 두 동기화 스케줄러를 끄며, 모든 질문이 성공하고 캡처 중
카탈로그 지문이 같을 때만 출력 파일을 교체합니다. capture는 fixture와 같은 `referenceDate`를 명시해 같은
접수 상태 집합을 검색하며, Python 평가기는 두 날짜가 다르면 평가를 거부합니다. 별도 Core API 인스턴스가 카탈로그를 갱신한 경우에는 지문
변화로 결과 파일 기록을 거부합니다. 후보 ID는 `sourceCode:sourceProgramId` 형태이며, 첫 번째 `:` 앞의
`[A-Z][A-Z0-9_]{0,63}` 제공처 코드와 뒤의 원본 ID를 함께 사용합니다. 같은 Search Service가 만든
후보·최종 결과를 기록하므로 평가 코드가 운영 검색 흐름을 별도로 재현하지 않습니다. 실제 AI Service를
호출할 수 있으므로 기본 실행·CI에는 포함하지 않습니다. fixture 내보내기·라벨·캡처·평가 실행 규칙은
[검색 평가 자료](../evaluation/support-program-search/README.md)를 따릅니다.
새 fixture/capture는 같은 준비된 제공처 범위를 사용합니다. 기존 고정 평가 스냅샷·원표·캡처는 당시의
입력과 실행 결과로 보존하며, 이번 상태 필터를 소급 적용하거나 과거 지표를 다시 해석하지 않습니다.

## 기업마당 동기화와 공개 순서

```text
BizInfoSupportProgramCatalogSyncScheduler (기본: 최초 PT0S, 완료 후 PT6H)
  → Repository: 수집 시작 세대 발급 [짧은 DB transaction]
  → BizInfoSupportProgramCatalogFacade → BizInfoClient: 전체 페이지 수집·검증
  → BizInfoProgramMapper: 필수 필드 검증·공고 정규화
  → SupportProgramIndexSyncService.indexSnapshot: 모든 공고의 두 색인 준비
      → ElasticsearchSupportProgramClient → Elasticsearch: 불변 버전 추가·검색 가시성 검증
      → AiSupportProgramIndexClient → AI Service → OpenAI 임베딩 → Qdrant
  → Repository: 최신 시작 세대일 때만 MySQL에 공개 [짧은 DB transaction]
      → BIZINFO 기존 행 미노출 처리 + 수집 목록 UPSERT
      → 공개 세대·카탈로그 지문·공고 수·indexReady·성공 시각 기록
```

공공데이터포털의 전체 건수, 페이지 번호·크기, 페이지별 항목 수와 실제 수집 수가 일치해야 합니다.
기업마당 수집·응답 검증·필수 필드 정규화 중 하나라도 실패하면 카탈로그를 바꾸지 않습니다.
현재 Client는 페이지당 1,000건을 요청하며 최대 20페이지·20,000건으로 제한합니다.

Elasticsearch는 64개 단위로 버전 존재 여부를 확인하고 없는 버전을 준비합니다. 이어 Qdrant 색인은
전체 공고를 16개씩 나누어 AI Service에 요청합니다. AI Service는 동일 ID·해시의 벡터가 이미 있으면 재사용하고
없는 버전만 생성합니다. 모든 배치의 성공과 처리 건수를 확인한 후에만 DB 공개를 시도합니다.
색인 도중 실패하면 현재 세대일 때만 실패 시각을 기록하고 기존 공개 카탈로그·그 스냅샷의 색인 준비 상태를
유지합니다. 이미 준비된 벡터는 재시도 시 재사용할 수 있습니다. 더 최신 세대가 시작되면 이전 세대의
성공·실패 기록 모두 무시합니다.

MySQL의 `support_program_sync_generation`은 제공처별 최신 **시작** 세대를 관리합니다. 이전 실행이 늦게
끝나도 더 최근에 시작된 작업이 있으면 공개를 건너뜁니다. 후발 작업이 실패하더라도 이전 세대가 다시
공개 권한을 얻지는 않으며 마지막으로 공개된 카탈로그를 다음 성공까지 유지합니다.

시작 세대 발급과 공개는 각각 행 잠금을 사용하는 짧은 DB transaction입니다. 공개 transaction 안의
미노출 처리·UPSERT·상태 행 성공 기록 중 하나라도 실패하면 전체를 rollback합니다. 외부 HTTP 수집·색인은 DB
transaction 밖에서 실행하며, 수집 실패를 이유로 기존 행을 삭제하거나 다른 제공처 데이터를 변경하지 않습니다.
동기화 Service가 수집·사전 색인·공개 과정의 RuntimeException을 한 번 기록한 뒤 Scheduler가 다음 주기에 계속 실행합니다.

## 키워드·벡터 색인 정합성과 복구

Elasticsearch 버전 식별자·Nori/BM25 설정·장애 경계·`V24` 이후 재색인 절차는
[Elasticsearch 적용 상세](elasticsearch-lexical-search.md)에 설명합니다. 정기 복구와 공개 전 준비는
Elasticsearch를 먼저, 이어 Qdrant를 확인하며 모두 성공해야 `indexReady=true`입니다.
분석기 v2는 별도 인덱스로 재색인하며 v1을 수정하지 않습니다. `여행사/여행업체` 확장은 ES 검색 분석기에서만
수행하고, 공유 본문·내용 해시·Qdrant·RRF·AI 랭킹 계약은 바꾸지 않습니다. 지역·업종의 신청 자격 추론은 포함하지 않습니다.

두 Client Mapper가 공유하는 `SupportProgramIndexTextHelper`가 제목·기관·지원 대상·분야·지역·신청 기간 원문·요약으로 검색 문서를
구성합니다. 제어·형식 문자는 개행·탭을 제외하고 정리하며 Unicode 코드 포인트 기준 최대 12,000자로
제한합니다. UTF-8 문서의 SHA-256이 내용 해시이고, 내부 문서 ID는
`{sourceCode}:{sourceProgramId}`입니다.

AI Service는 문서 ID·내용 해시에서 Qdrant point ID를 결정하며, 임베딩 모델·차원·색인 규격에 따라
컬렉션을 분리합니다. 현재 DB의 정확한 문서 버전에 해당하는 point ID만 검색하도록 필터링하므로
이전 버전·미노출 공고·아직 공개하지 않은 세대의 벡터는 결과에 섞이지 않습니다.

```text
SupportProgramIndexSyncScheduler (기본: 최초 PT0S, 완료 후 PT1M)
  → SupportProgramIndexSyncService.repair
  → Repository: 현재 MySQL 공개 공고 목록·제공처별 상태 조회
  → 제공처별로 Elasticsearch 누락 버전 준비 → AI Service: 해당 버전의 누락 벡터 생성·저장
  → 해당 제공처 상태의 공개 세대·지문·공고 수가 읽은 스냅샷과 같을 때만 indexReady 갱신
  → 한 제공처 실패 이후에도 다른 제공처를 처리하고, 완료 후 실패를 오류로 전달
```

복구는 제공처 수집과 별도 단일 스레드에서 실행합니다. `SUPPORT_PROGRAM_INDEX_ENABLED=false`는
이 복구 작업만 끄며, 새 카탈로그 공개 전의 필수 색인은 끄지 않습니다.
공고가 0개인 공개 스냅샷도 제공처 상태를 기준으로 처리하고, legacy 채택도 제공처별로 수행합니다.

복구 색인이 실패하면 자신이 읽은 스냅샷과 상태 행이 여전히 같을 때만 `indexReady=false`로 바꾸며,
최근 카탈로그 동기화 성공·실패 기록은 바꾸지 않습니다. 복구가 늦게 끝난 동안 새 스냅샷이 공개되면 조건부
UPDATE가 0행이 되어 새 스냅샷 상태를 건드리지 않습니다. 이 상태는 마지막 전체 색인 준비 결과이며 실시간
Elasticsearch/Qdrant Health를 뜻하지는 않습니다.

공개 준비와 복구는 모두 `prune`을 호출하지 않습니다. 이전 스냅샷 기준의 삭제가 공개 준비 중인 새 벡터를
지우는 상황을 피하기 위해 현재 자동 삭제를 연결하지 않았습니다. 내부 `prune` API는 존재하지만,
안전한 보존·삭제 수명주기와 전체 다중 인스턴스 운영 검증은 후속 과제입니다.

검색 대상의 벡터가 하나라도 없거나 Qdrant·AI Service가 실패하면 일부 후보만으로 성공하지 않고 오류를
반환합니다. 별도 복구 작업의 성공 후 다시 검색할 수 있습니다. 빈 검색어 목록과 상세는 AI에 의존하지 않습니다.
조회 때 변하는 접수 상태는 벡터에 고정하지 않으며, DB의 `content_hash` 컬럼도 영속 색인 완료 기록으로
사용하지 않습니다. 현재 검색은 매번 전체 대상 공고와 ID·해시 목록을 읽고 전송하므로 대규모 데이터 성능은
별도 개선이 필요합니다.

## 데이터와 접수 상태

MySQL의 `support_program`은 `(source_code, source_program_id)` 고유키로 원본 공고를 식별합니다.
`categories`·`regions`는 JSON, 신청 기간은 원문과 nullable 날짜로 저장합니다. 원본에서 사라진 공고는
삭제하지 않고 `is_source_present=false`로 바꿉니다. UPSERT는 대소문자만 바뀐 원본 ID도 최신 표기로
갱신하여 MySQL과 벡터 식별자를 맞춥니다. 고유키 비교는 MySQL의 `utf8mb4_0900_ai_ci` collation을 따릅니다.

`support_program_source_document`는 원문 근거 답변에만 쓰는 공고별 공식 HTML 정규화 텍스트·원문 URL·해시·수집
시각을 같은 복합 식별자로 저장하고 공고를 FK로 참조합니다. 조회 시 공고의 공개 상태를 확인하므로 미노출 공고에는
원문 질문을 제공하지 않습니다. 이 테이블은 정기 목록 동기화에서 채우지 않고 명시적 원문 질문의 수집·검증이
성공했을 때 UPSERT합니다.

`application_form_snapshot`은 동적으로 발견한 공식 첨부의 양식 manifest JSON과 파일 hash, 파서·추출 모델·프롬프트 버전을
공고별 불변 버전으로 저장합니다. `application_preparation`은 계정별 작업 ID, 선택한 양식 버전·분야와 입력 revision을 저장하고
스냅샷 또는 기존 배포 manifest와 결합합니다. 모든 공개 응답은 `institutionReviewed=false`를 유지합니다.
현재 공고 카탈로그 행에 FK를 걸지 않아 접수 종료 후 카탈로그에서 빠진 공고의 저장 작업도 다시 읽습니다.
`application_preparation_fact`는 문항·고정 필드별 현재 사용자 확인 값과 원문, PROVIDED/UNKNOWN, 입력 revision을 저장합니다.
`application_preparation_interpretation_run`은 요청 키의 중복 실행을 막고 당시 입력과 AI 제안·모델·프롬프트 버전, 성공·실패를
JSON 스냅샷으로 보존합니다. 두 테이블은 준비 건 삭제 시 함께 삭제되며, AI 호출 자체는 이 transaction들 사이에서 수행됩니다.

`support_program_sync_status`는 제공처별 스냅샷의 공개 세대·지문·공고 수를 기록합니다.
V4 적용 전부터 있던 공고는 과거 공개 세대를 복원하지 않습니다. 대신 해당 제공처의 현재 공개 공고가 1건 이상인 경우에
한해, 전체 복구 색인이 성공한 뒤 그때 읽은 지문·공고 수를 sentinel 세대 `0`으로 조건부 채택할 수 있습니다.
빈 초기 DB는 `PREPARING`, 복구 전 legacy 공고는 `UNAVAILABLE`이며, 실제 지문이 있는 새 스냅샷은 bootstrap이 덮어쓰지 않습니다.

`account`·`account_session`(V5)은 회원 계정을 저장합니다. `account`는 소문자로 정규화한 이메일을 고유키로 두고
비밀번호 해시, 역할(`USER`·`ADMIN`), 이메일 인증·정지·삭제 시각과 약관 동의 시각을 저장합니다. 삭제된 계정은 모든
조회에서 제외하고 정지된 계정은 로그인과 세션 확인을 403으로 막습니다. `account_session`은 세션 JWT의 SHA-256
해시와 절대 만료·마지막 사용 시각만 저장하고 계정 삭제 시 함께 삭제됩니다. 이메일 중복은 DB UNIQUE 제약이 막고,
절대·유휴 만료 여부는 서울 기준 시계로 조회 시점에 판단합니다. 기업 테이블은 기업 등록 단계에서 추가합니다.

접수 상태는 `SupportProgramStatusResolver`가 읽을 때 계산합니다. 파싱된 시작일 전은 `UPCOMING`,
종료일 이후는 `CLOSED`, 시작일·종료일 범위 안은 `OPEN`입니다. 날짜 경계는 포함합니다.
날짜만으로 결정되지 않은 경우 예정 표현, 남아 있는 종료일, 명시적 종료 표현, 상시 접수 표현 등의
규칙을 순서대로 적용하고 판단 근거가 없으면 `UNKNOWN`을 유지합니다. 따라서 `접수 종료` 표현이
상시 접수보다 우선하더라도 파싱된 날짜를 무조건 덮어쓰지는 않습니다. 표현은 낱말 사이 띄어쓰기 변형만 같게 보고
공백을 지운 부분 일치는 쓰지 않으므로 `100개사 이상 시`가 `상시`로 읽히지 않습니다. Core와 Catalog는 같은 규칙을 씁니다.

수집 Client·동기화는 `BIZINFO`·`KSTARTUP`·`MSIT`·`CNTRADE_NOTICE`별로 구현됩니다. production 검색·색인·AI 점수화는
`sourceCode:sourceProgramId`를 내부 식별자로 사용하고 검색은 준비된 제공처 범위에서 실행합니다.
K-Startup은 별도 구체 Client·Facade·SyncService·Scheduler를 사용하고 기존 색인 Service·Repository를 공유합니다.
제공처별 Facade는 명시적 Qualifier로 구분하며 제공처 Registry나 새 production 의존성은 추가하지 않습니다.

초기 데이터만 한 번 반영할 때는 별도 `catalog-sync-once` CLI 프로필을 사용합니다. 흐름은
`CLI → SupportProgramCatalogSyncOnceService → 제공처 Facade/Client 전체 수집 → 비용 상한 검사 →
SupportProgramIndexSyncService(Elasticsearch·AI Service/OpenAI/Qdrant) → Repository/MyBatis/MySQL 공개`입니다.
합산 비용 검사 전에는 DB 쓰기와 유료 호출을 하지 않으며, 검사한 동일 스냅샷을 사용합니다.
전용 프로필은 Bean 생성 전에 자동 수집·복구·큐/메일 작업과 Flyway를 비활성화하고 HTTP 서버 없이 종료합니다.
적용 직전 호스트에 영속화한 배타적 receipt로 중복 실행을 막습니다. 실패한 시도도 자동 재시도하지 않습니다.
일반 API 서버 설정/공개 HTTP 계약은 바뀌지 않습니다. 모델·예산 전제와 실행법은
[Core API 일회성 수집](../backend/core-service/README.md#예산을-지정한-일회성-수집)을 참고하세요.

## K-Startup 수집 범위와 추가 분류

`KStartupSupportProgramCatalogSyncScheduler → KStartupSupportProgramCatalogSyncService →
KStartupSupportProgramCatalogFacade → KStartupClient → KStartupProgramMapper`에서 수집·검증한 뒤,
기업마당과 같은 `SupportProgramIndexSyncService`에서 Elasticsearch 키워드 색인을 먼저 준비한 뒤
`AI Service → OpenAI 임베딩 → Qdrant`로 벡터를 준비합니다. 같은 버전은 재사용합니다.
전체 색인 성공 후 Repository가 `KSTARTUP` 범위만 UPSERT·누락 비활성화·공개 상태 갱신합니다.

- 공식 API: `getAnnouncementInformation01`. 안정 ID는 `pbanc_sn`이며 화면 순번 `id`를 쓰지 않습니다.
- `KSTARTUP_SYNC_ENABLED=false`가 기본입니다. `KSTARTUP_API_KEY`와 초기 색인 비용을 확인한 뒤 켭니다.
- `RECENT_YEAR`는 서울 기준 오늘에서 1년 전 날짜를 API의 `cond[pbanc_rcpt_bgng_dt::GTE]`에 전달합니다.
  `KSTARTUP_SYNC_SCOPE=RECENT_THREE_MONTHS`는 같은 조건에 3개월 전 날짜를 전달하는 선택 옵션이며 기본값은 1년입니다.
  3개월은 90일 고정이 아니라 달력 기준으로 계산합니다. `OPEN`은 API의 모집 중 공고만 수집합니다.
  `ALL` 상태 필터는 전체 과거 이력이 아니라 이렇게 수집·공개된 범위 전체를 뜻합니다.
- API 날짜 조건을 실제 응답의 접수 시작일 하한으로 단정하지 않습니다. 2026-09-09 실수집에서는
  `20250909` 조건 응답 4,143건 중 325건이 그보다 먼저 시작했고, 모두 종료일이 기준일 이후였습니다.
  현재 수집기는 검증한 API 응답을 보존하며 시작일만으로 추가 제외하지 않습니다.
  [세 제공처 실수집·벡터 검증 기록](support-program-catalog.md)에 당시 결과를 정리합니다.
- 첫 페이지의 날짜 조건을 전체 수집 동안 고정합니다. 전체 이력 `totalCount`가 아닌 조건 일치 `matchCount`로
  페이지 수를 계산하고 각 페이지의 번호·크기·건수·전체 건수·ID 중복을 검증합니다. 실패 시 기존 목록을 보존합니다.
- 페이지당 1,000건 요청, 최대 20,000건·200페이지 안전 한도를 적용합니다. 전체 제공처 검색 후보 한도도 20,000건이므로
  전체 과거 이력 확장은 별도 성능·계약 검토가 필요합니다.
- 원문 `aply_trgt_ctnt`·`aply_excl_trgt_ctnt`만 대상 설명에 보존해 후보 자격 검토에 전달합니다.
  대상·업력·연령 분류는 별도 메타데이터와 벡터 검색 문서에만 넣고, 자격 근거 필드에는 합치지 않습니다.
  분류는 자격 충족의 증거가 아니며 원문 조건을 우선합니다.
- 공식 HTTPS 상세 URL의 호스트와 `pbancSn`이 원본 ID와 일치해야 합니다. 상세 HTML 추가 질문은 여전히 미지원입니다.
- 게시일이 없어 접수 시작일로 최신 정렬합니다. 제공처 간 같은 사업을 자동 병합하지 않습니다.

## 과기정통부·충청남도 수출입공지 수집

각 `Msit`/`CnTradeNotice` Scheduler → SyncService → CatalogFacade → Client → Mapper에서 전체 수집을
검증하고, 기존 `SupportProgramIndexSyncService`에서 Elasticsearch 키워드 색인과
`AI Service → OpenAI 임베딩 → Qdrant` 벡터 색인을 순서대로 준비한 뒤
Repository가 해당 `source_code`만 UPSERT·누락 비활성화·스냅샷 공개합니다. DB migration이나 신규 의존성은 없습니다.

- MSIT의 `response` 배열(header/body)과 충남의 최상위 `09/RETURN_SUCCESS` 응답을 별도로 검증합니다.
  첫 페이지와 각 페이지의 전체 건수·번호·실제 크기·행 수·중복 ID가 일치해야 하며 HTTP 200의 게이트웨이 오류도 실패입니다.
- MSIT는 공식 `msit.go.kr` 사업공고 상세 URL의 게시판 100/`nttSeqNo`를 검증해 ID로 사용합니다.
  실응답의 10건 페이지를 끝까지 읽으며 20,000건/2,000페이지 한도를 적용합니다. 장시간 수집은 전용 단일 스레드로 격리합니다.
- 충남은 `lbbNo`를 ID로 사용하며 1,000건을 요청하되 실제 응답 페이지 크기를 기준으로 완전성을 검증합니다.
  20,000건/200페이지 한도입니다. 숫자 ID로 암호화된 웹 상세 `idx`를 추측하지 않고 검증된 공식 공지 목록에 연결합니다.
- API에 없는 접수 기간/지역/분야는 추정하지 않습니다. 게시일은 정렬용이고 상태는 `UNKNOWN`입니다.
  MSIT는 본문 없이 제목·담당 부서 기반 검색이며 충남은 원문 본문 기반입니다. 선정 결과·일반 공지도 원본대로 포함됩니다.
- 두 수집기 기본 비활성, 전용 키 생략 시 승인된 `DATA_GO_KR_SERVICE_KEY`를 재사용합니다.
  평가 fixture/capture 프로필은 개발 환경변수와 관계없이 두 수집기도 끕니다.
- 수집기 구현과 실제 서비스 정상화는 별개입니다. 2026-09-09 CNTRADE_NOTICE 실 API의 `04 HTTP_ERROR`는
  빈 정상 결과로 숨기지 않으며, 제공처 복구 전에는 실제 수집 성공을 주장하지 않습니다.

## Frontend와 내부 계약

Frontend의 업무 호출 흐름은 `View → ViewModel Hook → UseCase → Repository → data/api → Core API`이며,
채팅 검색에서는 페이지 ViewModel과 UseCase 사이에 내부 채팅 Hook을 둡니다.
Awilix의 `app/di`에서 Repository·UseCase·외부 함수를 구성하고 `appContainer`가 앱 단위 인스턴스를
제공합니다. ViewModel 또는 내부 Hook은 UseCase·외부 함수 토큰을 조회하며 Repository를 직접 생성하지 않습니다.
`data/api`의 함수가 요청 URL·Fetch·Zod 응답 검증을 담당합니다.

화면 기능은 `presentation/features/chat`의 채팅 검색, `presentation/features/support-program-detail`의
상세 조회·원문 근거 질문, `application-preparation`의 신청 준비 생성·목록·상세, 그리고 `auth`(로그인·회원가입)·`pricing`·`partner-recruitment`·`company-profile`·`admin`의
계정 관련 화면으로 나눕니다. 각 feature가 전용 View·스타일·ViewModel·테스트를 소유하고,
서로의 화면 구현을 import하지 않습니다. 검색 카드와 상세 화면은 기존 상세 URL·복합 식별자로 연결합니다.
검색과 근거 질문이 함께 쓰는 안전한 오류 문구는 `presentation/shared/support-program`에 둡니다.
`support-program-detail` 안에서도 상세 조회와 질문은 별도 페이지입니다. `SupportProgramDetailPage`는
`useSupportProgramDetailViewModel`, `SupportProgramEvidenceQuestionPage`는
`useSupportProgramEvidenceQuestionViewModel`을 각각 사용하고 URL의 복합 식별자로 이동합니다.

채팅 메시지·검색 조건은 Redux Toolkit으로 관리하고 검색 요청 흐름은 내부 채팅 Hook의 thunk에 둡니다.
기업 조건은 폼에서 직접 적용하거나 C02 변경 제안을 확인해 적용하며 현재 대화의 메모리에만 보관합니다.
검색 요청마다 그 시점의 적용 조건을 사용하고, 새 대화·브라우저 새로고침으로 초기화됩니다.
C02는 확정 조건·새 발화·미확정 제안 또는 질문·최근 완료 검색 요약을 해석하며 화면의 전체 메시지를 다시 전송하지 않습니다.
검색 결과 설명은 대화에 표시하며 자동 검색이나 조건 변경을 일으키지 않습니다. 미확정 초안·질문·검색 의도와 적용 조건을 구분합니다. 로그인 세션은 아래 계정과 세션 절에 있고 프로필 영속 저장은 후속 범위입니다.
`ChatPage`는 페이지 ViewModel인 `viewmodel/useChatPageViewModel` 하나를 사용합니다. 이 ViewModel은
`hooks/useSupportProgramChat`의 Redux 상태·검색 요청 수명과 `hooks/useSupportProgramSearchReadiness`의
준비 상태 조회·polling을 조합합니다. 페이지 ViewModel은
검색 확인·검색 재시도만 준비 상태에 따라 제한하며 메시지 제출·추천 질문·다시 해석은 이와 독립적으로 처리합니다.
페이지 ViewModel은 DOM 참조·입력 조합·
포커스·스크롤도 Hook 로컬로 관리합니다. View는 렌더링·이벤트 연결·순수 표시용 포맷을 담당합니다.
조건 제안은 ViewModel의 `chatConversationProposal` 순수 변환이 요청 당시 조건을 기준으로 변경·유지·적용 값을
계산하며, `ChatPage`는 원본 해석 결과나 미확정 질문 대신 최종 `displayProposal`을 받습니다.
`ConversationProposal`과 `ProgramResults`는 각각 제안·결과를 표시하는 View 컴포넌트입니다.
카드·결과 집계의 자격 분류는 기존 `supportProgramEligibility`에서, 상세 URL 생성은 공용 routes에서 공유합니다.
React Router는 `/` 아래 공개 화면(검색·요금제·공개 파트너 모집·지원사업 상세), 로그인·회원가입, `/app` 아래 회원 세션이 필요한
작업 화면(작업 채팅·요금제·파트너 모집·프로필·관리자)과 두 SampleItem 예제 화면을 연결합니다. SampleItem은 업무 기능이 아니라 같은 UseCase의
Hook 상태와 Redux 상태 차이를 비교하는 예제입니다.

Core의 공개 계약은 기능별 `controller/dto`, 외부 계약은 시스템별 `client/dto`, 검증된 실행 결과는
`service/dto`, 업무 모델은 `domain`에 둡니다. 관계형 DB 접근은 `Repository → Mapper → XML`이며
`DbRow`를 Repository 밖으로 노출하지 않습니다. 같은 필드가 있어도 외부 입력과 공개 응답을 하나의
타입으로 합치지 않습니다. 상세 배치 규칙은 [Core API README](../backend/core-service/README.md)에 있습니다.

AI Service는 조건 변경 해석·점수화·원문 근거 답변에서 각각 `HTTP API → Service → Agent → LangChain → OpenAI → Response` 흐름으로
실행합니다. `bootstrap.py`가 클라이언트와 서비스 수명주기를 구성하고, 역할이 다른 Agent가 각각
`ChatPromptTemplate | ChatOpenAI.bind(...)` 체인으로 strict structured output을 한 번 요청합니다. 도우미 도구 에이전트(`app/assistant_agent`)만 예외로 LangGraph 그래프
(`classify → plan ⇄ tools → answer → verify`, 관심 공고 묶음 질문은 `retrieve → map → reduce → verify` 서브그래프)를 쓰며
도구는 Core 내부 읽기 API 세 개와 기존 근거 컬렉션의 문서 id 제한 검색뿐입니다. 그 밖의 tool·handoff·multi-agent orchestration은 없습니다. 일반 공고 색인·검색은
`support_program_index`, 원문 청크 색인·검색은 `support_program_evidence`가 OpenAI 임베딩과 분리된 Qdrant
컬렉션을 직접 사용합니다.
공고 추천은 Qdrant·Elasticsearch 검색 후 Core가 병합·검증한 공식 후보를, 상세 질의응답은
Qdrant 검색 후 Core가 ID·내용 해시·문서 ID를 검증하고 복원한 원문 청크를 LangChain 프롬프트의
근거로 사용합니다. 조건 해석은 이 검색 전에 실행됩니다. 검색·생성을 연결하는 기존 Core 경계와
임베딩 원시 응답 검증을 유지하며 LangChain 적용을 위해 컬렉션을 교체하거나 재색인하지 않습니다.
세 Agent의 공유 실행 함수는 `support_program_llm.py`에 있으며 완료 상태·거부·JSON 전체를 엄격히 검증하고,
LangSmith 추적·응답 저장·자동 재시도를 사용하지 않습니다.

공통 `OPENAI_MODEL`과 도우미 계획·답 모델의 기본값은 `gpt-6-luna`입니다.
랭킹 모델은 `OPENAI_RANKING_MODEL`로 지정하고 미설정이면 공통 `OPENAI_MODEL`을 상속합니다.
`OPENAI_RANKING_REASONING_EFFORT`는 `none`/`low`만 허용합니다. 제공 설정 예제는 비용 절감을 위해 랭킹도
GPT-6 Luna/low를 사용합니다. 기존 추론 수준·프롬프트·출력 계약은 유지합니다. 모델 객체는 분리하되 동일한 OpenAI
클라이언트·인증·재시도 정책을 공유하며 새 provider는 없습니다. orchestration 계층은 위 도우미 도구 에이전트의 LangGraph 하나뿐입니다.
도우미 자유 질문 분류는 `OPENAI_ASSISTANT_MODEL`(기본 `gpt-5-nano`, 추론 `low`)로 가장 싼 모델을 따로 씁니다.
출력 축약은 미채택이며 기존 후보 ID·필드명·출력 계약을 유지합니다. 축약 구현은 평가 경로에만 남깁니다.
`OPENAI_RANKING_SERVICE_TIER` 미설정 시 코드·Compose 기본값은 `default`입니다. 제공 `.env.example`은
기존 Fast 상시 사용 프로필인 `priority`를 유지합니다. 일반 처리보다 추가 요금이 있으며 일반 처리는 `default`로 지정합니다.
랭킹 요청에만 적용하고 대화 해석·RAG 답변·임베딩 설정은 바꾸지 않습니다. 후보·점수·출력/시간 상한은 유지합니다.
모델 교체는 토큰 단가 절감이며 토큰 수나 품질·속도의 개선을 보장하지 않습니다.
이전 Sol의 배포·실측은 [지역 충돌·Fast 기록](region-conflict-fast-20260908.md)에 보존하며 Luna 평가 결과로 재해석하지 않습니다.

두 색인 Service가 실제로 공유하는 입력 토큰 상한 처리는 `support_program_embedding.py`의 함수 하나로
유지합니다. 토크나이저 준비·인코딩·잘라내기를 작업 스레드에서 실행해 HTTP 이벤트 루프를 막지 않으며,
OpenAI 호출·응답 검증·오류 처리는 각 Service에 남겨 둡니다.

추천 점수화는 전용 설정으로 모델 `45s` → Agent 실행 `50s` → Core 읽기 `55s`를 사용합니다.
조건 해석·근거 답변은 기존 모델 `25s` → Agent 실행 `30s` → Core 읽기 `35s`를 유지합니다.
중복 지원 검토는 모델 `60s` → Agent 실행 `70s` → 전용 Core 읽기 `75s`를 사용하고 timeout을 AI 내부 504와 안전한 진단 로그로 구분합니다.
AI Health도 Core의 기존 공유 읽기 설정을 사용합니다. 공고 의미 검색 전체는 AI에서 `25s`, Core 읽기는
`30s`이며, 검색 화면은 의미 검색과 점수화의 순차 호출을 고려해 `90s` 후 요청을 취소합니다.
C02 해석은 별도 `40s` 제한이며 사용자 확인을 사이에 두므로 검색 요청에 해석을 합치지 않습니다.
이 값은 시간 예산이며 성능 목표가 아닙니다. 랭킹의 전용 RestClient 외에는 기존 의존 방향을 유지합니다.

## 계정과 세션

계정 흐름은 `AccountAuthController → AccountSignupService · AccountLoginService · AccountSessionService → AccountRepository → MySQL`입니다.
회원가입은 이메일·비밀번호만 받아 BCrypt 해시와 약관 동의 시각을 저장하고 같은 요청에서 세션을 발급합니다. 이메일 중복은 DB unique
제약의 `DuplicateKeyException`을 Service가 409로 바꿉니다.
가입·변경·재설정의 새 비밀번호는 영문 대·소문자, 숫자, 특수문자만 8~72자이며 한글·이모지·공백은 거부합니다. BCrypt의
UTF-8 72바이트 한도는 문자 규칙과 별개로 계속 검사합니다. 로그인·탈퇴는 기존 BCrypt 해시의
비밀번호 검증 호환성을 유지합니다. 재설정 토큰은 비밀번호 변경 transaction 안에서 잠가 같은 토큰의 동시 재사용을 막습니다.
사업자등록번호 확인은 `BusinessLookupController → BusinessLookupService → BiznoClient`로 외부 HTTP를 한 번 부릅니다.
`client/bizno/mapper/BiznoBusinessMapper`가 원문 JSON을 검증·정규화해 `account/domain/RegisteredBusiness`로 변환합니다.
Service와 공개 `BusinessLookupResponse`는 이 내부 모델을 사용하며, 계속사업자·등록 가능 여부 판단은 Domain이 소유합니다.
`BiznoClient`는 HTTP 오류를 `BiznoClientException`으로 바꿔 API 키가 담긴 URL이 로그·응답에 남지 않게 합니다.
원문 JSON과 Jackson 타입은 Bizno Client·Mapper 경계 안에서만 사용하고 공개 응답의 기존 여섯 필드는 유지합니다.
기업 등록은 `CompanyController → CompanyService → BusinessLookupService → BiznoClient(사업자등록번호 조회)`와
`CompanyService → CompanyRepository → MySQL`로 이어집니다. 서버가 등록 시점에
사업자등록번호를 다시 조회해 계속·휴업 사업자를 저장하고(폐업은 거절, 휴업은 파트너 기능만 제한), 계정 조회는 `company`를 LEFT JOIN해 요약과 `tier=COMPANY`를 계산합니다.
파트너 모집글은 `partner` 기능의 `PartnerRecruitmentController → PartnerRecruitmentService → PartnerRecruitmentRepository → MySQL`입니다.
Service가 세션 계정의 기업, `support_program`에 현재 있는 공고, 접수 상태(`SupportProgramStatusResolver`), 마감일 규칙을 확인한 뒤 저장하고,
공고당 한 건은 DB UNIQUE 제약이 보장합니다. 목록·상세는 기업·계정·공고를 JOIN해 읽고 모집 상태는 저장하지 않고 조회 시점에 계산합니다.
파트너 제안은 `PartnerProposalController · PartnerProposalBoxController → PartnerProposalService → PartnerProposalRepository → MySQL`입니다.
Service가 제안자의 기업, 모집글의 모집 상태, 당사자 여부를 확인하고, 수락·거절·철회는 `decision IS NULL AND withdrawn_at IS NULL`
조건의 UPDATE 영향 행 수로 동시 처리를 막습니다. 제안 상태와 담당자 연락처 공개 여부는 `PartnerProposal` 도메인이 응답·철회·경과 시간·모집 상태로
계산하며, 모집글 응답의 제안 수·내 제안은 `PartnerRecruitmentService`가 두 Repository를 묶어 붙입니다.
로그인 성공 시 `SessionTokenHelper`가 계정 ID를 `sub`로 하는 HS256 JWT를 발급하고, DB에는 토큰의 SHA-256 해시와
만료 시각만 저장합니다. 로그인이 필요한 Controller는 `Account` 파라미터를 선언하며
`AuthenticatedAccountArgumentResolver`가 HttpOnly 세션 쿠키(`govbiz_session`)의 서명·만료를 검사한 뒤 세션 행으로 계정을
채웁니다. 토큰은 응답 본문에 싣지 않고 쿠키로만 전달하며, 쿠키가 붙은 상태 변경 요청은 `SameSite=Lax`와
`SessionOriginInterceptor`의 Origin 검사로 CSRF를 막습니다. 로그인 시도는 `AccountLoginAttemptGuard`가 계정·접속 주소
기준으로 제한합니다. 세션 행이 없으면(로그아웃) JWT가 유효해도 401이고, "로그인 상태 유지" 여부에 따라 30일 또는 12시간의
절대 만료와 7일 유휴 만료를 함께 검사합니다. 쓸 수 없는 세션 쿠키는 resolver가 응답에 만료 쿠키를 붙여 지우며,
`Account?` 파라미터는 손님(null)으로, `Account` 파라미터는 401(정지 403)로 처리합니다. 화면 권한 단계(`tier`)는 `Account`가 역할·인증 상태로 계산해 `/me`에
내려 주고, 프런트의 `RequireAuth`는 이 값으로만 `/app` 아래 라우트를 나누며 서버가 모든 쓰기 API에서 다시 검사합니다.
Spring Security filter chain은 쓰지 않고 `spring-security-crypto`의 BCrypt만 사용합니다. 개발용 시드 로그인은
설정이 켜졌을 때만 별도 Controller가 등록되며 관리자·회원 시드 계정을 만듭니다.

Frontend에서 로그인 상태는 헤더와 여러 화면이 함께 읽으므로 `presentation/shared/auth`의 Redux slice와
`useAuthSession`·`useRestoreAuthSession` Hook이 소유하고, 로그인 화면은 `presentation/features/auth`가 소유합니다.
받은 제안함도 사이드바 배지·제안함 화면·모집글 상세가 함께 읽고 제안함 화면이 수락·거절로 바꾸므로 `presentation/shared/partner-proposal`의
Redux `receivedProposals` slice와 `useReceivedProposals` Hook이 계정당 한 번 조회해 소유합니다. 한 화면만 쓰는 서버 데이터(모집글 목록·상세, 보낸 제안함)는
Hook 로컬 상태로 두는 것이 규칙입니다.
세션 토큰은 브라우저의 HttpOnly 쿠키가 관리하므로 앱은 다루지 않고, `data/storage`에는 앱 시작 시 `/me`를 부를지
정하는 힌트만 둡니다. Repository가 로그인·로그아웃과 함께 힌트를 저장·삭제합니다.
세션 만료 판단은 서버가 합니다. 웹은 시작 때 한 번 복원한 뒤에도 `useWatchAuthSession`으로 따라가며, 쿠키 세션 Core API의 401(`data/api/coreFetch`)·
5분이 지난 뒤 화면 이동·탭 복귀 때의 `/auth/me` 재확인·다른 창의 힌트 변경(`storage` 이벤트)으로 로그아웃하고 로그인 화면에 끝난 이유를 알립니다.
화면은 로그인 전 `/` 아래 공개 경로(공용 헤더)와 로그인 뒤 `/app` 아래 내부 경로(사이드바)로 나뉩니다. `PublicOnly`는
로그인한 사용자를 공개 URL에서 같은 내용의 `/app` 화면으로, `GuestOnly`는 로그인·회원가입에서 복귀 경로로, `RequireAuth`는
비로그인 사용자를 `/login?next=`로 보냅니다. 경로 상수와 공개↔내부 대응은 `presentation/shared/routes/appPaths.ts`가 소유합니다.

### 관리자 감사 기록

관리자 API는 `AdminPrincipal`이 세션 계정·관리자 역할과 함께 접속 주소(`remoteAddr`)·User-Agent를 담아
`AdminAccountController · AdminAuditLogController → AdminAccountService · AdminAccessLogService → AdminAccessLogRepository
→ AdminAccessLogMapper → Mapper XML → MySQL(admin_access_log, V49)`로 접속기록을 남깁니다. 회원 목록·상세 조회는 결과를
돌려주기 전에, 정지·정지 해제·강제 로그아웃·권한 변경은 상태 변경·사유 기록(`account_admin_action`)과 같은 transaction에서
기록하며, 기록하지 못하면 503으로 조회 결과를 내주지 않고 조치를 되돌립니다. 기록은 추가만 하고 계정 ID에 외래 키를 걸지 않아
계정 행이 사라져도 남습니다. 권한 변경은 처리자·대상 행을 ID 순서로 잠가 마지막 활성 관리자가 사라지지 않게 합니다.
웹의 `/app/admin/audit-logs`는 같은 API를 최신순 커서로 쪽 단위 이동하며, 이 조회도 기록됩니다.

## 운영 답변 표본의 품질 검토

관리자 세션은 `React → Ops /session → Core /admin/session → Ops 사용자 연결`로 확인합니다.
평가 자료·비교 기준 조회는 별도 `/evaluation-catalog`를 새 평가·정기 실행 화면에서 호출하며,
표본 화면의 인증·조회·쓰기 전 확인에 평가 파일이나 벡터 저장소가 끼어들지 않습니다.

`상세 질문 Controller → Evidence Service → AI Facade 최종 검증 → Ops 전용 비동기 Client
→ Django 표본 DB → 기존 ops-sync 무료 구조 검사 → React 관리자 사람 검토`를 연결합니다.
Core 기본 수집 비율은 0이며 Ops도 별도 토큰·수집 활성화가 필요합니다. 실제 활성화는 배포 설정으로 관리합니다.
표본 전송은 동시 8건·응답 대기 기본 15초로 제한하며 사용자 답변을 기다리게 하지 않습니다.
Ops의 DB 저장 후 성공 응답과, 응답 시간 초과로 저장 여부를 모르는 상태를 구분해 표본 ID로 대조합니다.
Langfuse의 본문 없는 추적은 유지하고 검토용 표본에 보존 기간·일별 상한을 적용합니다.
Core는 수집용 공고 근거의 전화번호·이메일만 마스킹하고 `evidence_redacted`로 Ops에 알립니다.
질문·답변의 민감정보와 근거의 주민번호·인증정보는 계속 제외합니다. 사용자에게 반환한 답변과
원본 인용 ID는 유지하며 Ops의 자료 해시는 마스킹된 저장 사본을 기준으로 계산합니다.
사람의 근거 일치·관련성·완전성 검토와 무료 구조 검사를 구분합니다. 회귀 후보는 기대 답변·인용과
검토 버전을 고정하지만 기존 평가 자료·합격 기준으로 자동 등록하지 않습니다.
성공한 상세 답변의 수신 표본이므로 전체 검색 재현율·장애율·정확도로 해석하지 않습니다.
설정·보존·평가 요청 제외·API는 [Ops 운영 표본 품질](../backend/ops-service/README.md#운영-표본-품질)을 참고하세요.

## 오류 경계

AI 검색은 Core의 `search.total → database_fetch/eligibility_prepare/retrieval/ranking`과
Python의 `search.semantic → embedding/vector`, `search.ranking → ranking.model/selection`을
내부 HTTP `traceparent`로 연결합니다. Core는 OpenTelemetry OTLP로, AI는 공유 `app/tracing.py`의
Langfuse 클라이언트로 같은 프로젝트에 전송합니다. 전송 장애가 검색 재시도나 정상 응답 변경을 유발하지 않습니다.
추적 metadata에는 공고 ID·건수·캐시 상태·모델·제공된 사용량·프롬프트 해시를 남기며 본문·기업 정보·예외 원문은
제외합니다. 로그의 후보 ID 제외 정책과 별개로, Langfuse에서는 공식 공고 식별자만 허용합니다.
React Ops의 관리자 세션은 같은 웹의 `/ops/traces`를 연결합니다. Django가 Core 관리자 권한을 확인한 뒤
서버의 프로젝트 키로 Langfuse를 조회하므로, 이 화면에는 별도 Langfuse 로그인이 필요하지 않습니다.
[단계별 구조·설정·검증 범위](../infrastructure/llmops/README.md#지원사업-ai-검색-추적)를 참고하세요.

도우미도 `AssistantMessageService → AiAssistantClient → AI AssistantAgentService → LangGraph`를
하나의 `assistant-agent` trace로 연결합니다. Core는 새 `assistant.total`을 만들고 첫 AI 호출·응답 검증·
관심 공고 자료 준비·재호출·재검증을 구분합니다. 두 AI 호출의 `assistant.agent`는 각 Core HTTP 단계의
자식입니다. 검색과 도우미는 `_common/config/LlmTracingConfig`의 단일 OTLP provider를 공유하고,
특정 기능의 span·헤더 처리는 각 기능의 Helper가 담당합니다.
공개 요청의 부모 ID·baggage를 전파하지 않으며 내부 AI API만 유효한 sampled v00 부모를 수용합니다.
기존 분류 모드는 Core 단계만 추적합니다. 사람 검토·Ops 평가 점수·품질 합격을 생성하는 기능은 아닙니다.
[설정·단계와 검증 범위](../backend/core-service/README.md#도우미-core--ai-분산-추적)를 참고하세요.

상세 공고 질문도 `SupportProgramEvidenceService → AiSupportProgramEvidenceFacade → Client → AI 색인·검색·답변`
경로를 같은 `support-program-evidence` trace로 연결합니다. Core의 새 `evidence.total` 아래 원문·청킹 캐시,
세 HTTP 호출과 최종 인용 검증을 구분합니다. AI는 각 Core 부모 아래 준비·임베딩·Qdrant·모델·출력 검증을 기록합니다.
`SupportProgramEvidenceTracingHelper`가 기존 공용 OTLP provider를 사용하며 새 의존성·DB 스키마는 없습니다.
단독 원문 선수집에는 별도 Core 루트를 추가하지 않습니다. 이 추적은 Ops의 전체 RAG 평가 유형이나 검색·답변
품질 점수 생성을 포함하지 않습니다. [단계 구조와 검증 범위](../backend/core-service/README.md#상세-공고-rag-분산-추적)를 참고하세요.

AI Service의 랭킹·조건 해석 모델·HTTP·Agent 시간 초과는 내부 504로 반환되고 Core는 공개 `504 AI_SERVICE_TIMEOUT`으로
전달합니다. 의미 검색의 전체 실행·임베딩·Qdrant 전송 시간초과도 내부 `INDEX_TIMEOUT` 504로 전달합니다.
화면은 해당 endpoint의 검증된 오류 계약에 한해 AI 처리 시간 초과와 수동 재시도를 안내합니다.
조건 해석 실패는 일반 오류로 합치지 않고 시간 초과·일시 이용 불가를 구분하며, AI 로그에는 실패 종류·오류 클래스명·
경과 시간만 남깁니다. 요청 문장·기업 조건·모델 응답과 원문 예외는 기록하지 않습니다.
의미 검색의 준비·임베딩·Qdrant 시간과 랭킹의 준비·모델·검증 시간, 캐시 상태·후보 수·총시간은
`app` INFO로 기록합니다. 의미 검색 실패·취소는 실패 단계와 고정 코드·경과 시간을 기록합니다.
랭킹 출력 검증 경계는 JSON 문법 오류와 스키마·서버 검증 오류를 분리하고 허용 목록의 검증 유형·필드명만
기록합니다. 모델 응답·검증 입력값·후보 ID·임의 필드명은 기록하지 않습니다. Core도 DB·후보 준비·
의미/키워드 검색·랭킹·전체 성공/실패 시간을 기록합니다.
상세 근거 질문에는 색인·검색·답변 단계 시간, 질문/청크 임베딩 캐시 지표를 기록하며, 대화·랭킹·근거 답변에는
SDK가 반환한 입력·출력·캐시 입력·추론 토큰 수를 기록합니다. 입력·원문·응답 본문·캐시 키는 남기지 않습니다.
근거 질문 임베딩은 인스턴스별 256개/300초, 내용이 같은 청크 벡터는 128개/300초 재사용합니다.
공고·청크 ID나 인용 계약을 바꾸지 않으며 매회 Qdrant 검증과 실패 전파를 유지합니다. lifespan은 기존 app/root handler를 재사용하거나
stderr handler 하나를 추가합니다. 전역·OpenAI·HTTP 로그 수준은 바꾸지 않습니다.
시간 초과 외 LLM 실행 실패·색인 미준비·Qdrant 실패는 내부 503으로 반환되고 Core는 공개
`503 AI_SERVICE_UNAVAILABLE`로 변환합니다. Core가 관측한 연결·읽기 timeout 및 점수화·색인 API의
내부 408·504는 504, 예상하지 않은 HTTP 상태나 잘못된 응답 계약은 502로 분류합니다.
공개 응답은 `application/problem+json`이며 내부 URL·원본 라이브러리 예외를 노출하지 않습니다.

Core의 Health는 프로세스 상태, AI Health는 AI Service의 정해진 Health 응답을 확인하는 기능입니다.
이들이 성공했다고 MySQL·Qdrant·OpenAI를 포함한 실제 검색 전체가 준비됐음을 보장하지 않습니다.
전체 연결 동작은 [Compose 검증 절차](../infrastructure/README.md)로 확인합니다.

현재 제품은 공고 요약의 의미·키워드 결합 검색·구조화된 추천과, 기업마당·K-Startup 공식 상세 HTML의 공고별 근거 답변을 제공합니다.
실제 검색 후보·최종 추천의 캡처, AI-only 참조 판정과 변경 전후 보고서는
[공유 평가 자료](../evaluation/support-program-search/runs/support-program-catalog-20260906-v1/README.md)에 있습니다.
평가 가능한 질문은 6개, 그중 양성 질문은 2개뿐이며 독립적인 사람 검토 품질 증거는 아닙니다.
근거 답변은 [5단계 후속 검증](../evaluation/support-program-evidence/runs/official-flow-20260907-v1/README.md)에서
공식 HTML 2건·질문 6개의 실제 MySQL·Qdrant·모델 연결과 인용을 확인했습니다. 고정 HTML을 재생한
소규모 AI-only 검토이며 공고당 청크 1개여서 일반적인 검색 품질 근거는 아닙니다.
PDF·첨부·다른 제공처 확장은 후속 범위입니다.


## 중복 지원·수혜 검토 사용자 화면 (5-1)

모바일은 하단 `검색·관심함·리포트·전체`의 전체 메뉴에서 `/all/reviews`로 직접 진입한다.
목록·새 검토·편집·결과와 실행 이력을 제공하며 관심 공고함은 공고 선택 방법 중 하나다.
공고 선택의 `CatalogScreen`과 `ProgramCard`는 기존 필터 검색·상세 진입을 재사용하고 비교 대상 선택 버튼만 추가한다.
`현재 참여 상태 → 독립 사실` 변환은 shared `CombinationReviewParticipation`이 소유하며 웹의 `currentStatus`는 재수출한다.
호출은 `모바일 화면 → useCombinationReview → shared CombinationReviewUseCase → MobileCombinationReviewRepository → Core API`이며
공개 계약·응답 검증은 shared DTO, 인증·15초 HTTP 대기는 모바일 API 경계가 담당한다. Core 공개 HTTP 계약은 변경하지 않는다.
모바일의 공고 선택 다음 버튼은 `create`, 참여 상태 다음·이전 버튼은 변경된 경우 `replace → get`으로
입력을 저장한 뒤 이동한다. 최초 저장 이후 검토 ID와 `?step=`를 주소에 보존한다. 저장 실패는 현재 단계와
입력을 유지하고, `검토 실행`은 저장된 검토의 입력 버전과 추가 설명으로 `start`만 호출한다.
단계 저장은 유료 분석·분석 요청 키 보관을 실행하지 않는다.
분석 전에 API origin·계정별 SecureStore에 요청 키·버전·추가 설명을 보관하고 유실 응답은 같은 요청으로만 수동 확인한다.
화면·앱 활성 상태에서만 선택 실행을 3초 간격으로 읽으며 로그인·화면 진입·상태 조회만으로 분석 POST를 실행하지 않는다.
계정 변경에는 화면 상태와 늦은 응답을 차단하고 로그아웃에는 보관 요청을 삭제한다. UNKNOWN과 기술 실패는 허용 판단으로 대체하지 않는다.
모바일 결과의 인용·사업 순서는 실행 스냅샷 기준이다. 공식 HTTPS 페이지 열기와 보관 원본 다운로드(현재 웹 제공)를 구분한다.

웹의 `/app/combination-reviews`는 본인 목록·커서 조회·확인 후 삭제와 검토별 최근 실행 상태(실행 전·대기·분석 중·완료·실패·확인 필요)를 제공한다.
삭제는 `CombinationReviewController → CombinationReviewService → CombinationReviewRepository → MyBatis Mapper → XML → MySQL`로 처리한다.
Repository는 새 실행 접수와 같은 검토 부모 행을 `FOR UPDATE`로 잠근 뒤, 모든 실행 중 `QUEUED`·`RUNNING`·`UNKNOWN`이 있는지 현재 읽기로 확인한다.
해당 실행이 있으면 409 `COMBINATION_REVIEW_DELETE_CONFLICT`로 입력·실행 이력·보관 원문을 유지한다. 없으면 기존 FK cascade로 삭제한다.
웹은 같은 상태에서 삭제 버튼을 잠그며, 조회 이후 접수된 실행 때문에 DELETE가 거절되면 삭제 보호 안내를 표시한다. 다른 소유자와 없는 검토는 기존 404를 유지한다.
목록 상태는 Core 목록 응답의 `latestRun`(`CombinationReviewMapper.listReviews`가 검토별 최대 실행 ID를 LEFT JOIN)에서 읽고, 대기·분석 중인 검토만 그 검토의 실행 목록을 4초 간격으로 다시 읽는다.
`/new`와 `/:reviewId`는 `제목·공고 2개 선택 → 공고별 참여 상태 → 공고 분석`의 3단계 흐름을 제공하며 현재 단계는 `?step=`(participation·analysis, 1단계는 생략)에 둔다.
단계 이동 시 스크롤을 상단으로 초기화하고, 분석 단계에서 진행 카드(접수 뒤 경과 시간)·최근 실행 카드·실행과 이력 목록을 제공한다.
실행 이력 항목은 `/:reviewId/runs/:runId` 결과 전용 화면으로 이동해 결과를 자동 조회한다. 결과 화면은 같은 검토의 다른 실행 선택·이전 이력 추가 조회·분석 결과·원본 다운로드를 제공한다. RequireAuth와 WorkspaceLayout을 사용한다.
호출은 `View → ViewModel → CombinationReviewUseCase → Domain Repository 계약 → Data 구현 → HTTP/Zod → Core API`다.
공고 선택은 BrowseSavedSupportProgramsUseCase의 관심 공고함과 기존 BrowseSupportProgramsUseCase의 무료 카탈로그 API를 재사용하며 접수 종료·미지원 자동 분석을 구분한다. 관심 공고는 기본 화면에서 호출하지 않고 사용자가 선택 팝업을 열 때 조회하며, 선택 요약은 고정 높이 한 줄로 유지한다.
저장된 원본 식별자는 상세 API로 공고명과 기관명을 보완해 참여 상태 화면에서 `사업 1`이 어떤 공고인지 함께 표시한다.
신청·선정·확약·협약·수행·교부 입력은 항목별 도움말을 hover·keyboard focus로 제공하며 각 사실을 독립적으로 선택한다.
정책 변경 전에 저장된 3개 공고 검토와 실행 결과는 계속 조회하되, 새 입력과 새 분석은 정확히 2개 공고만 허용한다.

단계 이동 [다음 →]·[← 이전]은 바뀐 입력만 저장하고, 유료 분석은 분석 단계의 [검토 실행]에서만 접수한다. 현재 입력으로 끝난 결과가 있으면 [결과 보기 →]가 주 동작이고 [다시 실행]은 보조 동작이다. 입력 충돌 시 편집 내용을 유지한다.
단계 이동 성공 시 이전 단계의 검증 오류를 제거한다. 내부 제공처·원본 ID는 화면에 노출하지 않고, 실행별 추가 설명 입력은 참여 상태 단계 한 곳에서만 제공한다.
비동기 접수 POST 응답을 최대 15초 기다리며 서버 작업 취소를 보장하지 않는다. 미확인 요청의 키·버전·추가 설명만
계정별 탭 sessionStorage에 보관하고, 같은 요청 확인으로 재전송한다. 조회·마운트·로그인으로 POST하지 않는다.
저장소를 쓸 수 없으면 분석을 시작하지 않으며 일반 입력 초안·결과는 브라우저에 영속 저장하지 않는다.
계정 변경·로그아웃 시 기록을 지우고 이전 요청을 취소하며 세션 참조 검사로 늦은 응답을 차단한다.
QUEUED/RUNNING은 3초 간격 GET으로 상태를 확인하고 새로고침 후에도 DB 이력으로 조회를 재개한다.
조회 실패·완료·로그아웃에는 자동 조회를 중지한다. RUNNING이 20분을 넘으면 서버는 UNKNOWN으로 표시하지만
새 유료 요청으로 자동 교체하지 않는다. UNKNOWN은 같은 검토의 새 실행도 차단하며, 30분(TTL) 뒤 `RUN_OUTCOME_UNKNOWN_EXPIRED`로 FAILED가 되면 사용자가 새 분석을 실행할 수 있다.
FAILED/INTERRUPTED 역시 정상 근거 부족과 구분한다.

결과의 사업 순서·참여 상태·인용은 해당 Run의 스냅샷으로 표시한다. 여섯 단계의 판단 범위·질문·기관 확인·수집 한계와
자동 수집/사람 미검수 상태를 표시한다. 모델이 사용자 표시 문장에 반환한 참여 상태 코드는 한국어로 표시하고, 분석 한계가
참여 상태·추가 사실·공식 원문 수집 범위에서 확정할 수 없는 내용임을 안내한다. 여섯 단계는 반응형 2·3열 선택 보드에서 판단 상태를
먼저 비교하고 선택한 한 단계의 상세만 아래에서 확인한다. 공식 공고 상세는 외부 페이지로 열고, 보관 원본은 세션을 포함한 GET으로 내려받는다. 5-2의 비로그인 선택 유지·작업 이어보기,
신청서 작성 도우미, 실제 OpenAI 품질 평가는 포함하지 않는다.

HWP 체크박스의 FORM_OBJECT Caption은 주변 문항과 함께 별도 근거 블록으로 보존한다. 공식 신청 문항의 단일 선택지는 AI Service가 원문 인용에 포함된 `options`로 추출하고(인용이 선택지 앞에서 끝나면 라벨·선택지 구간으로 넓히고, 원문에서 확인되지 않거나 하나뿐인 선택지는 양식을 거부하는 대신 그 문항만 자유 입력으로 둠), Core API가 다시 검증한 뒤 양식 스냅샷과 공개 응답에 보존한다. Frontend는 선택지를 라디오 버튼으로 표시한다. 기존 스냅샷에서 `options`가 없으면 빈 목록으로 읽으며, 선택형 문항의 선택지를 확인하지 못한 경우 공식 원문 확인을 안내한다.

## 공고별 신청 양식 사전분석

신규·변경 공고의 상태와 시스템 분석 Outbox는 `application_form_availability`에 저장합니다. 공식 제공처 전체 동기화 성공 transaction에서 등록하고, 별도 Worker가 첨부 수집·파싱·AI 분석을 수행합니다. 성공 snapshot 저장과 AVAILABLE 활성화는 하나의 짧은 transaction입니다.

사용자 작성 화면은 신청 양식 확인 시 availability API에서 활성 snapshot을 먼저 읽습니다. PENDING 또는 STALE이면 기존 계정별 Discovery Job으로 공식 첨부를 분석해 snapshot을 저장하고 결과를 표시합니다. 다른 실패 상태는 자동 재분석하지 않습니다. 새 작성은 활성 formVersionId만 허용하고, 기존 작성의 과거 버전과 최종 생성의 공식 원본 해시 대조는 유지합니다.

Discovery는 첨부별 파싱 길이를 제한하고 각 첨부의 AI 문항 추출·Core 모델 변환·입력 위치 매핑을 독립적으로 처리합니다. 검증된 후보만 저장하며 다른 후보의 실패가 이미 검증된 양식을 취소하지 않습니다. 모든 후보가 실패하면 공고는 검토 상태와 실패 사유를 유지합니다.

Discovery 전용 timeout은 model 210초 < AI run 240초 < Core read 270초 < Worker lease 1,800초입니다. 다른 신청 준비 기능의 전역 timeout은 변경하지 않습니다. [상태·재시도 정책](application-form-availability.md)을 참고하세요.

## 신청 문서 MCP 파이프라인

모바일 신청문서는 Expo의 전체 메뉴 Stack 안에서 목록·공고/양식 선택·문항별 입력·검토·생성 결과·온라인 입력 안내를 제공합니다.
중복 검토의 카탈로그·관심 공고·공고 카드와 shared 업무 계약을 재사용하고, 기존 Core API에 Bearer 인증으로 연결합니다.
기기 저장·공유와 입력 이탈 방지는 모바일에서 처리합니다. [모바일 신청문서 경계·실행 안내](mobile-application-documents.md)를 참고하세요.

DOCX 경로는 `Core 공식 첨부 Client → ZIP/XML 문항 추출 → AI Service DocumentMap → 기존 Mapping·WritePlan → OOXML native edit → 재열기 검증 → Core 저장·다운로드`입니다. 문단·표 셀·명시적 내용 컨트롤 중 안전한 주소만 쓰고, 세로 병합·불명확한 다중 문단 셀·혼합 스타일 영역은 미지원으로 표시합니다. 단순 가로 gridSpan은 원본 셀 구조를 유지한 채 단일 주소로 편집합니다.
기존 세 포맷의 `mapVersion`·공통 `pipelineVersion`은 DOCX 추가만으로 변경하지 않습니다. DOCX는 설정 응답의 형식별 `engineVersion`으로 저장 지도와 생성 fingerprint를 구분합니다. Core는 DOCX 엔진 버전이나 원본 hash가 달라지면 재매핑하고, binding 또는 scope가 바뀌면 기존 migration 확인 흐름을 사용합니다.

HWPX 질문 추출은 Core가 hash와 함께 보낸 원본을 AI 내부에서 먼저 구조 분석한 뒤 OpenAI에 셀 정보를 전달한다. PDF의 평면 입력칸은 로컬 FFDetr 탐지 결과와 원문 글자·표 경계를 대조하고, 기존 PDFBox가 값을 기입한다. FFDetr 가중치는 이미지 빌드 시 고정 revision과 SHA-256으로 검증하며 실행 중 다운로드나 외부 PDF 서비스 호출을 하지 않는다. AI worker당 PDF 검사는 한 번에 하나씩 실행한다.

AI 문서 지도는 native index와 semantic index를 분리한다. HWPX의 병합되지 않은 단순 FORM_TABLE에서 같은 행의 라벨→입력 셀이 확인될 때만 semantic index를 국소 보정하고, 병합·반복·복합 표는 native 순서를 유지한 채 검토 상태로 남긴다. 표 앞 heading은 번호·길이·후속 입력 필드 밀도·반복 여부를 조합해 section metadata로만 기록한다. HWP/PDF는 구조 근거를 추측하지 않는다. native target ID·주소·배열·원본 표는 바꾸지 않으며 분석·매핑·검증 단계 상태와 집계는 선택적 `documentAnalysis` 감사 정보로 저장한다.

생성 경로는 Core의 공식 첨부·소유권·revision 관리와 AI Service의 형식별 MCP 실행을 연결한다. HWP는 Core hwplib의 구조 검사·범위 편집·재열기, HWPX는 Hangeul 파일 모드, PDF는 MCP 정리 후 PDFBox AcroForm 처리이다. AI는 HWP의 hwpTargets를 받아 지도와 계획만 반환하며 Core가 원본·plan hash·revision·bindings/scope를 독립 검증한다. HWP에 Windows·한컴 한글·브리지 설정이 필요하지 않다. 과거 직접 HWPX 편집 경로는 현재 생성에서 사용하지 않는다. 새 fingerprint로 과거 생성 결과와 구분하고 다운로드 이력을 보존한다. 구현 범위와 미지원 구조·검증 상태는 [MCP 구조](application-document-mcp-architecture.md), [설치](application-document-mcp-setup.md), [검증 기록](application-document-mcp-validation.md)를 확인한다.


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

### Phase 5-1: 신청 문항 상위 매핑 경계

`DocumentMap`은 HWP/HWPX/PDF/DOCX/XLSX의 FILE native map이다. `ApplicationFieldMapping`은
공식 문항과 확인된 입력 위치 관계를 업무 관점에서 읽는 projection이며 두 계약은 동일하지 않다.
`ApplicationFormManifest.fieldMappings(snapshot)`은 `sectionKey:fieldKey`, 문항 label, required,
status, writable과 연결된 targetId/box 참조만 계산한다. 한 문항의 여러 binding도 유지한다.
raw DocumentMap, NativeTarget/nativeLocator, pageImages, workbookMetadata, 버전과 scope는 복제하지 않는다.

```text
application_form_snapshot.manifest_json
  ├─ sections → ApplicationFormFieldDefinition (sectionKey:fieldKey)
  └─ documentMapSnapshot → ApplicationDocumentPlacement (factId ↔ targetId/box)
             │
             ├─ bindings + 공식 문항 → ApplicationFieldMapping (읽기 전용)
             │                          ↓
             │                    ApplicationDocumentService
             │                    기입/미기입 답변 분리
             └─ raw DocumentMap + bindings + scopeTargetIds
                                        ↓
                                     WritePlan → native editor → verification
```

문서 생성 Service는 검증된 FILE snapshot의 projection으로 작성 가능한 답변을 선택한다.
필수 binding 누락은 `REQUIRED_MAPPING_MISSING`/writable=false, 선택 문항은 `UNMAPPED`/writable=false다.
둘 다 생성을 중단하지 않고 `INPUT_LOCATION_NOT_FOUND` 미기입 답변으로 알리며, 칸이 확인된 답변만 기입한다.
AI 매핑은 고쳐 달라고 한 번 더 요청해도 규칙을 어긴 문항(같은 칸 중복 등)만 미매핑으로 빼고 나머지 binding을 살리며,
문항별 이유는 DocumentMap `unmappedReasons`에 남는다. 살릴 binding이 하나도 없으면 기존처럼 매핑 실패다. `MAPPED`는 위치 연결 결과이며 사용자 답변 확인이나 제출 완료를 뜻하지 않는다.
FILE write authority는 계속 기존 `ApplicationDocumentMapSnapshot → DocumentMap → bindings/scope → WritePlan`에 있다.
sourceSha256, mapVersion, pipelineVersion, engineVersion, planHash와 이관 비교/승인 규칙은 변경하지 않는다.
projection은 저장하지 않으므로 DB migration과 공개 HTTP/MCP JSON 변경도 없다.

후속 ONLINE_FORM 경로는 `ApplicationPreparationService → 별도 FormMap → 신청 문항 상위 매핑 → 사용자 검토`
위치에 추가할 수 있다. 공유할 의미는 기존 field identity, 확인된 사실 연결, writable/unmapped 상태와 사용자 검토다.
DocumentMap/NativeTarget/WritePlan/native editor는 공유하지 않는다. Phase 5-1에서는 ONLINE_FORM을 구현하지 않았으며
provider, enum, registry, Google Forms API/OAuth, 브라우저 파싱과 자동 제출도 추가하지 않았다.

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
평가 fixture와 검증 범위는 [Phase 5-2 평가 보고서](../evaluation/application-map/runs/phase5-online-form-map-20260927-v1/README.md)를 참고한다.

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

검증 범위와 결과는 [Phase 5-3 평가 보고서](../evaluation/application-map/runs/phase5-online-form-source-review-20260927-v1/README.md)를 참고한다.

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

[Phase 5-4 평가 기록](../evaluation/application-map/runs/phase5-online-form-source-acquisition-20260928-v1/README.md)을 참고한다.

## Phase 5-5: Google Forms 공식 실행 조건

일반 Google 로그인 scope `openid email`과 Phase 5-4 capability는 유지한다.
공식 REST read에는 `forms.body.readonly`, standalone Apps Script의 `FormApp.openById` 기반
prefill에는 별도 `forms` scope와 같은 standard Cloud 프로젝트의 API executable 배포가 필요하다.
현재 배포·delegated 실행·실제 Form 접근 권한과 안전한 단기 token lifecycle이 확인되지 않아
incremental auth/GoogleFormsClient/prefill bridge를 추가하지 않았다.
기존 서명 OAuth 쿠키는 암호화 저장소가 아니고 Redis는 AOF 영속화를 사용하므로
access token 보관에 그대로 재사용하지 않는다. 새로운 credential 저장 체계도 추가하지 않는다.

판정은 PHASE5_GOOGLE_FORMS_PREFILL_BLOCKED다. Owned/Shared/Public responder-only 모두
NOT_RUN / UNKNOWN_NOT_VERIFIED이며, 공식 API 조사만으로 READ_SUPPORTED/PREFILL_SUPPORTED를
선언하지 않는다. Phase 5 종료 조건은 미충족이다. 자동 제출·비공식 parsing·entry ID 조립은 없다.
설계·보안 gate·permission matrix·실제 검증 범위는
[Phase 5-5 평가 기록](../evaluation/application-map/runs/phase5-google-forms-prefill-20260928-v1/README.md)을 참고한다.


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


## 공개 Google Form 질문 조회 (`skn-31`)

이미 확보된 공개 Google Forms responder URL의 읽기 전용 검사 경로는 `ApplicationPreparationService.inspectPublicOnlineForm → ApplicationOnlineFormMcpClient → AI Service /internal/v1/application-preparations/online-form/inspect → 별도 단기 stdio Google Public Form Reader MCP → 익명 GET → ApplicationOnlineFormSource → 기존 reviewOnlineForm`이다. 이 Manifest 매핑 경로에는 공개 Controller를 두지 않고, 구글 설문 답변 미리 채우기는 `ApplicationGoogleFormController`가 같은 reader를 쓴다. Document MCP와 FILE 형식은 그대로다. `DOCUMENT_INTERNAL_TOKEN`으로 기존 Core ↔ AI 내부 인증을 재사용한다. Form 검사 과정에서 OpenAI를 호출하거나 DB에 snapshot을 쓰지 않는다.

Reader는 `docs.google.com/forms/.../viewform`과 `forms.gle`만 허용하고 각 redirect와 DNS 결과를 검사한다. TLS 검증을 유지한 채 확인한 공인 IP로 연결하며 GET만 보낸다. Cookie, OAuth, 사용자 브라우저 세션은 전달하지 않는다. HTML 응답은 4 MiB, redirect는 최대 3회다. Google 로그인으로 보내거나 401이면 `LOGIN_REQUIRED`, `/closedform`으로 보내면 `CLOSED`, 안내 문구만 남고 답할 문항이 없으면 `NO_QUESTIONS`다. 검증한 공인 주소 중 IPv4부터 순서대로 연결해 IPv6 경로가 없는 컨테이너에서도 읽는다. 질문은 응답 화면 HTML에 들어 있는 `FB_PUBLIC_LOAD_DATA_` JSON에서 읽는다(계약 `google-public-form-reader-v2`, parser `fb-public-load-data-v1`). 이 데이터에는 여러 페이지의 모든 문항과 미리 채운 링크에 쓰는 `entry` 번호가 있어 복수 페이지 설문도 읽는다. 안내 문구·페이지 나눔·이미지·동영상은 문항이 아니며, 선택지 문구는 미리 채운 링크가 정확히 일치해야 체크되므로 공백까지 원문 그대로 둔다. 2026-10-01 이전의 DOM 접근성 표시 파싱(`semantic-dom-v1`)과 Phase 5-5의 "비공식 parsing·entry ID 사용 금지" 판단은 이 변경으로 대체했다. 공식 Forms API·Apps Script 경로가 막힌 상태는 그대로이며, 공개 응답 화면이 이미 내려주는 데이터만 읽고 제출은 하지 않는다.

Capability의 `PUBLIC_READ_SUPPORTED`는 URL/provider가 공개 reader 시도 대상이라는 뜻이며 실제 조회 성공을 보장하지 않는다. `/edit`는 `REQUIRES_AUTH`, Google 외 URL은 `UNSUPPORTED_PROVIDER`다. `forms.gle` redirect의 최종 목적지는 MCP inspection에서 검증한다.

`controlId`는 질문 순서와 label/type/options의 hash로 만든 snapshot 내부 식별자이며, 미리 채우기에는 별도 필드 `entryId`를 쓴다. `semanticFingerprint`는 제목과 질문 순서·label·required·type·options를 정규화한 값이며 HTML nonce와 무관하다. 날짜·시간·파일 업로드·표 형식·척도처럼 지원하지 않는 질문은 `UNKNOWN`(사유 포함)으로 반환한다. Manifest 매핑 경로는 이 경우 실패시켜 부분 매핑을 막고, 미리 채우기 경로는 그 문항만 `UNSUPPORTED`로 남겨 사용자가 직접 답하게 한다. 이 JSON은 공식 Forms API 계약이 아니므로 구조가 바뀌면 `SOURCE_CHANGED`·`PARSER_FAILED`로 명시적으로 실패한다. 로그인 필요 설문과 자동 제출은 지원하지 않는다.
