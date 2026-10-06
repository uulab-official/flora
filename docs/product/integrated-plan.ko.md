# Flora 통합 기획서

Open Source App Operations Platform · 2026-10-06

상태: **제품 요구사항 및 설계 방향. 구현 완료 목록이 아님.**
원문 1~102 항목은 [요구사항 추적표](requirements.ko.md)에 빠짐없이 연결한다. 원문의 예시 숫자·도메인·앱 이름은 데모 데이터이며 실제 인프라나 배포를 의미하지 않는다.

## 1. 제품 정의와 위치 (원문 1~4, 93)

iOS, Android, Web 앱의 빌드·서명·버전·스토어 배포·OTA·환경변수·인증서·푸시·링크·분석·광고 수익을 하나의 웹에서 관리하는 오픈소스 App Operations Platform.

GitHub, Expo/EAS, Apple, Google, Firebase, Cloudflare, Sentry, 광고 및 Attribution 서비스를 연결·조율·관찰·실행한다. 앱 운영 상태와 이력을 통합하는 Control Plane이며 외부 서비스마다 존재하는 제품·계약·심사 절차를 그대로 존중한다.

핵심 문장:

- 개발자의 PC와 조직의 공용 머신이 Runner다
- 사용자의 인프라를 최대한 활용한다
- 앱 운영에 필요한 모든 상태와 이력을 한곳에서 보여준다
- 특정 PC나 특정 개발자가 없어도 팀은 운영할 수 있다

### 지원 범위

초기 Framework는 Expo 중심이다. React Native CLI, Flutter, Web의 adapter 계약을 고려하고 Native iOS/Android는 후속 단계로 확장한다. 웹은 Expo Web, React/Vite, Next.js, Flutter Web, Static Web을 대상으로 한다. 초기 Platform은 iOS/Android/Web이며 macOS, Windows, visionOS, tvOS, Wear OS는 향후 범위다.

## 2. 실행 구조와 Runner (원문 5~8, 78, 82, 91~92)

Cloudflare API는 Job/Schedule/State를 관리하고 실제 컴파일·테스트·업로드는 Runner가 수행한다. Queue는 명령 전달과 재조정을 돕고 빌드를 실행하지 않는다.

Runner 책임: 정확한 Git revision checkout, Node 및 도구 버전 선택, package manager 실행, Expo/Xcode/Gradle/Flutter/Web build, Fastlane, 테스트·lint, OTA bundle, Web deploy, artifact 생성, 정제된 로그 전송. 캐시는 폐기 가능하고 권위 있는 설정·비밀값은 로컬 상주 상태가 되어서는 안 된다.

Runner 등록 시 조직, OS/architecture, Node/Java/Xcode/Android SDK/Flutter/Fastlane/CocoaPods 등의 capability와 버전을 기록한다. Personal/Organization/CI/Dedicated 유형을 지원한다. 환경별 허용 및 production 로컬 승인 정책을 둔다. 지속 운영에는 개인 노트북 하나 대신 공용·전용 Runner pool을 권장한다.

MVP 통신은 outbound HTTP polling이다. 인바운드 포트 개방이나 고정 IP를 요구하지 않는다. 사용자 UI에서 Build 요청 → 권한·승인 확인 → Job 저장 → Queue → 호환 Runner claim → config/secret snapshot → build → artifact → 결과 기록 순이다.

Lease만으로 중복 실행이 사라진다고 가정하지 않는다. 원자적 claim, 증가하는 fencing token, 단기 Job token, heartbeat(기본 15~30초, 정책화), idempotency key, 외부 부수효과 reconciliation을 결합한다. 만료된 Runner의 완료·업로드 확정은 거부한다. Store submit/release처럼 외부 상태가 불명확하면 자동 재실행하지 않고 조회·조정·승인을 거친다.

Disable은 새 작업 할당을 중지한다. Revoke는 인증 갱신·Job·Vault 접근을 차단하고 활성 lease를 무효화한다. 이미 Runner가 읽은 비밀값이나 보낸 외부 요청을 마법처럼 회수할 수는 없으므로 provider credential 회전과 외부 상태 확인도 필요하다.

### 새 PC 보장

`platform runner install`은 목표 UX다. 설치 후 로그인·조직 등록·doctor가 필요하며 Xcode/Android 도구 설치 및 라이선스 동의는 별도로 안내한다. 원래 PC의 파일을 복사하거나 개인 Apple/Expo 로그인 세션을 재사용하지 않고 작동해야 한다. iOS 실행은 macOS/Xcode Runner로 라우팅한다. 어느 OS에서도 모든 도구가 동일하게 실행된다고 보장하지 않는다.

## 3. 조직·앱·타깃 모델 (원문 9~13, 64~66)

소유권 기본 계층은 User → Membership → Organization → Project → Application이다. Flavor, Environment, Platform은 독립적인 빌드 축이다. 사용자 친화적인 탐색 트리와 DB 소유권 모델을 혼동하지 않는다.

`BuildTarget = Application + Flavor + Environment + Platform`

Flavor 예: free/pro/enterprise/brand-a. Environment 예: development/preview/staging/production. Platform 예: ios/android/web. 같은 production 환경은 여러 flavor에서 사용할 수 있다. PlatformTarget은 bundle ID/package name/domain과 provider app mapping을 관리한다.

Project는 업무 묶음이고 Repository와 동일하지 않다. Repository 하나의 `apps/stairs`, `apps/runner`, `apps/puzzle`를 서로 다른 Application에 연결한다. 저장소 연결은 root directory, lockfile 위치, workspace, detector 결과와 사용자의 확인을 보존한다. Git branch/tag는 입력 UI이고 Job에는 해석된 commit SHA를 고정한다.

Expo adapter는 APP_VARIANT/APP_ENV와 app.config를 연결하고 Android productFlavor, iOS Scheme/Configuration/Target, Flutter flavor 매핑을 별도 adapter에서 담당한다. 자동 탐지는 제안이며 위험한 설정 변경이나 배포를 자동 승인하지 않는다.

### GitHub

Source provider는 GitHub App을 우선한다. 조직 설치 및 선택 repository 접근, short-lived installation token, 서명 검증 webhook과 delivery deduplication을 사용한다. Repository/branch/PR/commit/tag/release를 읽고 Application에 연결한다. 사용자 로그인과 repository 설치 권한을 구분하며 PAT 강제를 금지한다.

## 4. Configuration과 Vault (원문 14~22)

값은 CONFIG, SECRET, FILE, CREDENTIAL로 구분한다.

- CONFIG: API URL, environment 이름, feature 기본값, 공개 AdMob app ID
- SECRET: 서버 API key, Sentry upload token 등 비밀값
- FILE: google-services.json/plist/service-account.json 등의 파일 종류. 파일이라고 공개 값이 되는 것은 아니다
- CREDENTIAL: Apple certificate/profile/API key/APNs key, Android Keystore 등 구조화된 인증 정보

클라이언트 앱에 들어가는 값은 역분석으로 읽힐 수 있다. EXPO_PUBLIC 등 클라이언트 공개 설정에 서버 비밀값을 넣지 않도록 build-time 검사와 UI 경고를 둔다.

### 상속과 버전

Organization → Project → App → Flavor → Environment → Platform 순으로 기본 우선순위를 적용하되, 각 레코드는 정확한 scope selector와 버전을 갖는다. 같은 우선순위의 중복 키는 임의 순서로 덮어쓰지 않고 오류로 처리한다. 교차 축 결합은 App+Flavor+Environment+Platform을 모두 지정한 명시적 target override로 지원하며 일반 Platform scope보다 높은 우선순위를 갖는다. 불완전한 교차 selector를 임의로 해석하지 않는다.

History/Diff/Rollback/Author/Reason/Timestamp를 남긴다. Rollback은 과거 기록의 수정이 아니라 새 버전 작성이다. Build/OTA/Release에는 현재 값을 동적으로 참조하지 않고 config snapshot과 secret/credential version reference를 고정한다. 설정 diff에는 secret plaintext를 노출하지 않는다.

재현성은 source SHA, lockfile digest, 도구 버전, adapter 버전, native fingerprint, 설정과 비밀 버전, 빌드 명령 및 결과 digest로 설명한다. 폐기된 secret, 만료된 인증서, 외부 패키지 삭제 때문에 과거 빌드를 다시 실행하지 못할 수 있으며 이 제한을 표시한다. 동일 의미의 빌드와 bit-for-bit 동일 binary를 구분한다.

### Vault 보안

MVP 목표는 envelope encryption이다. 데이터 암호화 키(DEK)와 키 암호화 키(KEK)를 분리하고 키 식별자·알고리즘·nonce·인증 태그·AAD(tenant/secret/version)를 기록한다. KEK는 일반 DB와 별도 보안 경계에서 관리한다. key rotation, 재포장, backup/restore, 권한 검사를 설계한다. Zero Knowledge, BYOK, Runner-only, hardware-backed secret은 별도 검증이 필요한 후속 기능이다.

Runner는 승인된 Job의 단기·최소 scope token으로 필요한 버전만 받는다. iOS는 Job 전용 임시 Keychain 및 provisioning profile을 사용하고 Android는 Job 전용 임시 Keystore와 제한된 파일 권한을 사용한다. 종료·실패·취소·재시작 후 정리를 한다. SSD/OS 캐시까지 완전 삭제를 보장한다고 표현하지 않는다.

stdout/stderr는 전송 전에 masking하며 원문 로그를 디스크/서버에 먼저 저장하지 않는다. chunk 경계를 넘는 secret, 흔한 인코딩·문자 escaping을 테스트한다. masking은 보조 방어이며 의도적으로 값을 변형해 유출하는 악성 build script를 막는 sandbox가 아니다. production secret 작업은 신뢰된 revision과 신뢰된 Runner만 사용한다.

## 5. Release와 버전 (원문 23~28, 65~68)

Release는 1급 객체다. Marketing Version, iOS build number, Android versionCode, runtime version, OTA revision, Web deployment 번호를 한 문자열로 합치지 않는다.

Release는 Application/source revision/생성자/상태/시각을 갖고, 실제 실행 결과는 target별 Build/Deployment/StoreRelease/OTAUpdate와 연결한다. 환경·플랫폼별 설정이 다르므로 snapshot은 각 실행 target에 고정하고 Release는 그 집합을 참조한다. 단일 Release config ID만으로 모든 플랫폼의 실제 값을 표현하려 하지 않는다.

Build에는 release/target/버전/Runner/Job/attempt/artifact/source/config/secret reference, 도구 버전과 digest, 시작·완료 시각이 필요하다. version allocation은 app identity 및 store 제약에 따라 원자적으로 예약한다.

타임라인은 커밋 선택, 빌드 시작, 업로드, provider 처리, TestFlight/Play 상태, staged rollout, OTA/Web 변경을 함께 표시한다. 요청 성공, 업로드 완료, provider 처리 완료, 심사 통과, 사용자 공개를 서로 다른 상태로 보여준다.

### 상태

Job 기본 상태: created, queued, assigned, running, waiting, success, failed, cancelled, expired. 재시도는 별도 attempt로 남긴다. 전이마다 권한·현재 version·fence를 검사한다. waiting에는 approval/toolchain/provider_reconciliation 등 이유가 필요하다.

Release 기본 상태: draft, building, testing, ready, releasing, partial, live, paused, rolled_back, failed, archived. 플랫폼별 결과를 집계하므로 Android만 성공했다고 전체 live가 되지 않는다. partial의 원인과 복구 동작을 표시한다.

### Apple / Google Play

Apple Developer 및 App Store Connect API/Transporter/TestFlight를 adapter로 묶고 app 정보, build, version, beta group, 심사·공개 상태를 다룬다. Google Play는 internal/closed/open/production track과 단계적 rollout을 다룬다. provider별 capability, 계정 권한, 약관/심사 제한을 UI에 반영한다.

Store의 중단·전진 수정·새 버전 제출과 OTA/Web의 rollback은 의미가 다르다. 이미 설치된 native 앱을 이전 버전으로 즉시 되돌리는 기능으로 약속하지 않는다.

## 6. OTA와 Web (원문 29~34)

UpdateProvider 초기 경로는 Expo Updates 공개 프로토콜을 따르는 자체 서비스다. React Native CLI는 Hot Updater adapter를 검토하고 Flutter/custom provider는 후속 검증한다. EAS Update 연결도 선택 adapter로 둘 수 있으나 EAS 유료 구독이 필수인 core 구조는 금지한다.

OTA 모델: Runtime, Channel, Update, Rollout, Deployment. Publish/History/Channel/Runtime/Environment/Rollout/Pause/Rollback/Promote를 지원한다. signed manifest, asset hash, runtime compatibility, cohort의 안정적 할당, 캐시 제어, 비정상 실행 수집과 rollback 조건을 설계한다. 기기의 offline 상태·check 시점 때문에 rollback 즉시 전 기기에 적용된다고 약속하지 않는다. native API 변경은 새 binary/runtime을 요구한다.

Adoption과 failed launch detection은 SDK telemetry가 있어야 판단할 수 있다. 수집하지 않은 실패율을 0으로 표시하지 않는다. automatic rollback은 신뢰 가능한 충분한 표본과 정책을 갖춘 후 추가한다. App Store/Play 정책 준수는 실제 지원 기능을 구현할 때 다시 검토한다.

Web은 first-class platform이다. Cloudflare Workers/Pages deploy adapter를 우선하고 Vercel/Netlify/Self Host는 후속이다. Static과 SSR/edge framework 지원을 구분한다. Next.js는 Cloudflare 호환 adapter와 런타임 제약 검증이 필요하다.

배포 이력, commit, health, rollback, preview/production, custom domain을 관리한다. GitHub PR preview에는 URL/QR/commit/status/logs를 제공하고 PR 종료 시 리소스·secret scope·retention을 정리한다. 포크 PR에 production secret을 전달하지 않는다.

## 7. Links와 Attribution (원문 35~39)

초기 Links 모듈: short URL, QR, deep link, Universal Link, Android App Link, campaign parameter, click analytics. 사용자 도메인과 provider 도메인을 지원한다.

OS가 검증된 Universal/App Link와 설치 상태에 따라 앱을 연다. 서버가 설치 여부를 모든 환경에서 완벽히 감지한다고 가정하지 않는다. association 파일, bundle/package mapping, 검증 상태, 브라우저 예외, store/web fallback을 관리한다. Deferred Deep Linking은 별도의 SDK·privacy·provider 검증 과제다.

Click/unique visitor/country/platform/browser/referrer/campaign/conversion을 다루되 IP 보존 최소화, 동의·보관기간·삭제·접근제어를 기본으로 한다. conversion은 관측 가능한 이벤트만 집계한다.

Attribution 단계: (1) UTM/click ID/install source/Android Install Referrer/campaign mapping, (2) SDK/deferred linking/conversion, (3) privacy preserving attribution/Apple attribution/advanced cohort. AppsFlyer의 전체 기능 복제는 MVP가 아니다.

## 8. Push와 앱 내 운영 (원문 40~45)

PushProvider: FCM, APNs, Expo Push, Custom. 즉시·예약·시간대·segment·test device·preview·campaign·delivery/open·deep link를 지원한다. provider accepted, device delivered, opened는 서로 다른 관측값이다. SDK 없이 open을 추정하지 않는다. 잘못된 token 정리와 수신 동의·해제 정책이 필요하다.

In-App SDK는 Banner/Modal/Bottom Sheet/Tooltip을 version/country/user attribute 등의 조건으로 표시한다. Remote Config는 environment/version/platform/flavor/country/percent rollout을 지원하고 maintenance/reward multiplier/feature toggle 등 공개 클라이언트 설정을 다룬다. Feature flag는 안정적 bucketing, 평가 버전, kill switch를 갖추고 이후 실험 프레임워크의 기반으로 쓴다. 서버 secret 저장소와 remote config를 혼용하지 않는다.

## 9. Revenue와 Observability (원문 46~49)

AdMob network/mediation reporting과 AdSense reporting을 연결한다. 앱·사이트·광고 계정 mapping, 통화·시간대·집계 지연·추정/확정 수익 차이를 표시한다. Ad unit/mediation 관리 가능 여부는 계정의 실제 API capability로 확인한다. 구독 수익은 향후 별도 provider다.

Organization Revenue는 앱별 수익을 같은 기준으로 비교할 수 있어야 한다. 통화 변환 없이 다른 통화를 단순 합산하지 않는다. Revenue alert는 후속이다.

초기 관측: Build/Deploy/OTA/Runner logs 및 store status. 후속: Crash/App/Web error/performance/session. Built-in, Sentry, OpenTelemetry, Firebase Crashlytics를 adapter로 연결하며 자체 warehouse/Crashlytics 복제는 MVP에서 제외한다.

## 10. 조직 권한·감사·보안 (원문 50~53, 79~82)

Organization은 초기부터 필수다. Owner/Admin/Developer/Release Manager/Secret Manager/Viewer/Guest 역할을 action별 capability로 매핑한다. scope는 organization/project/app/environment이고 deny-by-default다. 외부 개발자는 staging build/OTA/log만 가능하고 production/secrets/store/billing은 제외할 수 있다.

Production build, OTA, submit, release, rollback, secret reveal은 별도 권한과 승인 정책을 갖는다. 빌드 전 승인은 정확한 target, source SHA, config/secret refs, toolchain과 실행 action의 입력 digest에 바인딩한다. 이미 생성된 결과를 publish/submit하는 승인은 해당 artifact digest도 포함한다. 아직 만들지 않은 artifact digest를 빌드 승인에 요구하지 않는다. 승인 뒤 해당 입력이나 결과물이 바뀌면 재승인한다. 2-person approval은 후속 기능이며 오픈소스 범위다.

사용자 로그인은 GitHub 우선, Google/email magic link 후속. Runner는 device flow 또는 browser login+PKCE와 회전 가능한 machine credential을 사용한다. 장기 사용자 비밀번호 저장을 금지한다.

Audit Event에는 tenant/actor/action/target/결과/이유/시각/correlation ID를 저장한다. 애플리케이션에서 append-only이며 일반 API로 수정·삭제할 수 없다. DB 관리자까지 물리적으로 삭제할 수 없다고 주장하지 않는다. 장기 위변조 탐지는 외부 보관·hash chain·검증 가능한 export를 별도 설계한다. secret 값이나 provider credential은 audit payload에 넣지 않는다.

절대 금지: plaintext secret DB, 원문 secret log, 필수 GitHub PAT, 인증서 Git commit, 무권한 production action, Runner inbound port, Cloudflare Global API Key 요구. TLS, envelope encryption, scoped short-lived token, credential rotation, tenant isolation, revoke, request validation을 검증한다.

## 11. Cloudflare·운영 모드·비용 (원문 54~61, 96~98)

우리 서비스는 Cloudflare 중심으로 배포한다. Workers는 API/auth callback/webhook/Runner API/link redirect/OTA manifest, D1은 관계 metadata/job/release/audit/config metadata, R2는 artifact/OTA asset/log archive/암호화 blob을 담당한다. Queues는 비동기 작업, Cron은 scheduling/reconciliation에 쓴다. KV는 eventual consistency를 허용하는 캐시·조회용이며 lease나 권한 판정의 유일한 저장소가 아니다. 필요 시 Durable Objects/Analytics Engine을 추가한다.

운영 모드:

- Hosted: 운영자가 관리하는 Cloudflare의 Control Plane과 기본 저장소
- BYOC: 사용자가 연결한 Cloudflare 자원을 사용. 어떤 metadata/secret/key가 어느 계정에 있는지 명시
- Self-host: 공개 코드로 자신의 Cloudflare에 전체 Control Plane 설치. Docker는 후속

“BYOC이면 모든 데이터가 무조건 사용자 계정에만 있다”라고 뭉뚱그리지 않는다. Hosted coordination + user R2 같은 부분 BYOC와 전체 control-plane self-host를 구분한다. 사용자 탈퇴/연동 해제 때 export·key custody·삭제·resource cleanup 절차를 안내한다.

공식 OAuth 권한 흐름을 우선하고 실제 account scope와 provisioning 지원을 확인한다. 등록·승인·credential 보관은 안전한 절차가 필요하다. 문서 또는 버튼이 있다고 실제 연결됨으로 표시하지 않는다.

무료 한도는 설계 참고값이다. provider가 모든 quota를 API로 제공한다고 가정하지 않고, versioned policy + 공식 문서 + 실측 usage를 조합한다. polling/heartbeat/log/request/index write 비용을 포함해 추산한다. 사용자 증가에 따른 상태·로그·저장 비용 자체가 사라지는 것은 아니다.

### 오픈소스와 SaaS

Core/Dashboard/Runner/CLI/공식 adapter/RBAC/Audit/Vault/Self-host 코드를 모두 공개한다. 유료 편의 기능이 생겨도 기본 팀 운영과 안전한 배포를 막는 인위적 제한을 만들지 않는다. 라이선스는 사용자의 비교 요청에 따라 Supabase 저장소와 같은 Apache-2.0을 적용한다. Appwrite 저장소는 BSD-3-Clause임을 확인했다. dependency license와 배포 의무를 별도로 검토한다. 유료 과금은 hosted infra, managed operations, support, 관리형 보관/분석/Runner 등의 서비스 편의성에 둘 수 있다.

## 12. Adapter와 코드 구조 (원문 62~77, 99~101)

외부 서비스는 SourceProvider, BuildProvider, StoreProvider, UpdateProvider, DeployProvider, PushProvider, AnalyticsProvider, AdsProvider, SecretProvider로 분리한다. Core는 GitHub/Apple/Google/Cloudflare SDK를 직접 import하지 않는다.

Provider는 단순 connect 메서드만 제공하지 않고 설치 instance, 필요한 scope, credential reference, config schema, protocol version, 지원 capability, health, normalized error, retry/reconcile, rate limit을 기술한다. 지원되지 않은 기능은 명시적 unsupported 결과를 반환한다. 서드파티 plugin은 core 프로세스의 모든 secret을 공유하지 않으며 실행 위치와 trust boundary를 명확히 한다. MVP는 검토된 built-in adapter부터 시작한다.

추천 모노레포: pnpm + Turborepo + strict TypeScript. `apps/dashboard`, `apps/api`, `apps/docs`; `packages/core`, `db`, `auth`, `runner`, `runner-protocol`, `cli`, `vault`, `config`, `release`, `build`, `updates`, `links`, `push`, `analytics`, `sdk`, `sdk-expo`, `sdk-react-native`, `sdk-web`; `providers/github`, `cloudflare`, `apple`, `google-play`, `expo-updates`, `firebase`, `apns`, `admob`, `adsense`; `tooling`.

이 목록은 장기 경계이며 빈 패키지를 전부 생성하라는 지시가 아니다. 실제 구현에 필요한 모듈부터 만든다. Dashboard는 React/TypeScript/Tailwind/shadcn을 우선 검토하고 Next.js 채택 시 Cloudflare runtime 호환성을 검증한다. API는 `/api/v1/` REST이며 UI와 business logic을 분리한다.

DB 이름은 users/organizations/projects/applications/releases처럼 중립적으로 한다. UI는 PRODUCT_NAME을 쓰고 CLI 구현은 `platform` 같은 내부 명령에 브랜드 alias를 연결한다. package publish 이름과 URL도 별도 배포 설정으로 다룬다.

### UX / CLI

Organization overview: 앱 수, online Runner, 진행 Release, 심사, 경고, 최근 작업. App navigation: Overview/Releases/Builds/OTA/Web/Store/Environments/Flavors/Credentials/Links/Push/Analytics/Revenue/Logs/Integrations/Settings. 기능 미구현을 실제 성공처럼 연출하지 않는다.

Integrations: GitHub, Cloudflare, Apple, Play, Firebase/APNs/Expo, AdMob/AdSense, Sentry, Firebase/Supabase/Appwrite. optional 모듈의 설치/연결/권한 부족/장애 상태를 구분한다.

CLI 목표: login/init/runner/build/ota/deploy/release/submit/rollback/env/secrets/doctor. init은 framework/platform/repository/environment/OTA를 탐지하고 확인을 받는다. doctor는 실제 도구 버전·지원 여부·해결 방법을 표시한다. software install/OS license 수락을 검출과 혼동하지 않는다.

### 개발 품질

Production-grade를 목표로 strict TS, domain boundary, migrations, unit/integration/contract/E2E tests, structured error/log/audit, secret masking, idempotency/retry, 문서, local development를 함께 만든다. 거대 API, provider 분기 남발, UI business logic, credential 몰아넣기, 특정 UULAB 앱 하드코딩을 금지한다.

초기 개발 순서는 monorepo → schema → auth → organization/RBAC → project/app → GitHub → env/flavor → config/vault → runner protocol/daemon → scheduler → Expo detector/build → artifact/release → OTA → Cloudflare deploy → Apple/Play → dashboard/hardening이다. Audit와 tenant isolation은 마지막 장식이 아니라 첫 쓰기 경로부터 적용한다.

## 13. 단계·완료 기준 (원문 83~90, 94~95, 102)

Phase 0: identity/organization/project/app/target/GitHub/Runner/Job/config/vault 기반.

Phase 1: 실제 Expo 앱으로 iOS/Android/Web build, credential/config, Release, OTA publish/history/rollback, Web deploy/history/rollback, TestFlight/Play upload, RBAC/history/audit. 이 단계부터 UULAB 실제 앱을 관리한다.

Phase 2: store version/TestFlight/Play track/staged rollout, PR preview, scheduled build/release, OTA rollout/monitoring, remote config/flags.

Phase 3: Push/In-App/Short URL/QR/Universal/App Link/campaign/click analytics.

Phase 4: AdMob/AdSense/revenue/basic attribution/conversion/crash/analytics/monitoring.

Phase 5: plugin marketplace, Flutter advanced, RN CLI, native apps, GitLab/Vercel/Netlify/AWS, Docker self-host, enterprise SSO/advanced approval.

MVP 제외: 자체 DB 제품/Firebase Auth 대체/완전 AppsFlyer/자체 Crashlytics·warehouse/macOS build farm/AI/복잡한 billing/Kubernetes/모든 cloud.

첫 E2E: GitHub 연결 → Expo 앱 탐지 → Runner 등록 → production config/credentials → iOS build/TestFlight upload → Android build/Play upload → Expo OTA → Expo Web/Cloudflare → 모든 결과를 Release에서 확인. development와 production 격리를 검증한다.

추가 필수 E2E: PC A가 없고 PC B/공용 Runner만 있는 상태에서 같은 입력으로 작업 수행; A lease 만료 뒤 A의 뒤늦은 완료 거부; Windows 사용자의 Mac Runner iOS 요청; 호환 Runner 부재 표시; revoke/tenant isolation; 외부 업로드 응답 유실 후 중복 공개 없이 reconciliation.

제품 성공 기준: 내부 앱 5개 이상을 실제 운영하고 인증서 찾기/.env 공유/대시보드 이동/production commit 찾기/배포자 확인/빌드 설정 추적에 드는 시간을 줄인다. 첫 Foundation 테스트 통과만으로 이 MVP가 완성되었다고 보고하지 않는다.
