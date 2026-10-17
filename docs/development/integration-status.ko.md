# 실제 연동 현황

**2026-10-14 자격증명 후속:** 앱별 iOS 인증서·프로비저닝·Android Keystore·ASC/Google Play·APNs/FCM·Firebase 파일의 암호화 등록과 교체·사용 중지 이력을 Cloudflare에 반영했습니다. 기존 GitHub·OTA 키와 세 앱의 데이터/정책/이력을 보존했습니다. 전체 825개 통과·실패 0·선택 실행 3개 제외이며 Safari에서 두 앱의 등록 화면 전환도 확인했습니다. 실제 공급자 키 등록과 native 서명/푸시 실행은 후속입니다. [범위와 검증 증거](app-credentials.ko.md)를 참고하세요.

**2026-10-14 최신 상태:** Isso·Promise·Reward 세 앱을 운영 API에서 다시 조회했습니다. 각 앱의 PC Runner는 online이며, 각 앱의 최근 iOS·Android 자동 작업은 succeeded입니다. Reward GitHub 접근 차단은 해결됐고, 실제 커밋 `8655f3b0edfdfc655cbb78b27bfaafb0b1f2a244`에서 Actions·EAS 없이 두 플랫폼 OTA가 자동 게시됐습니다. 실제 Reward의 iOS Simulator·Android Emulator에서 SDK 적용·완전 재시작을 확인했습니다. Android는 네이티브 캐시 수정으로 QA APK를 한 번 데이터 유지 방식으로 갱신했습니다. 기존 설정과 앱별 이력은 보존했습니다. [Reward 완료 증거](reward-github-pc-ota-evidence.ko.md).

아래 2026-10-13의 Reward 차단·두 저장소 권한 제한은 당시 관측 기록입니다. 사용자가 GitHub App 설치 범위를 전체 저장소로 변경한 후의 현재 상태와 구분합니다. 통합 관리의 현재 기능 범위와 미구현 항목은 [통합 프로젝트 관리 상태](unified-project-management-status.ko.md)에 정리했습니다. 이번 운영 화면 재점검은 브라우저 도구의 `ERR_BLOCKED_BY_CLIENT`로 시각 검증을 수행하지 못했으며, 최신 상태는 실제 API 응답과 코드에 근거합니다.

2026-10-13 관리 기능 후속: 앱별 연결 개요와 플랫폼/결과 로그 필터, 연결 저장 전 소스 검증 및 안전한 GitHub 오류 구분, PC Runner 상태·호스트 공간/Docker 사전 검사를 운영에 반영했다. 전체 773개 중 770개 통과·3개 선택 실행 제외, 기존 세 앱의 설정·정책·배포·작업 이력 보존을 확인했다. Reward는 여전히 GitHub App의 저장소 접근이 거절된다. 자세한 변경·운영 반영·화면 검증 범위는 [프로젝트 관리 검증](project-management-evidence.ko.md)에 있다.

2026-10-13 후속 상태: GitHub Actions 없이 PC LaunchAgent 재시작 뒤 Isso·Promise의 새 커밋에서 iOS·Android OTA 네 건이 자동 게시됐다. 기존 배포·작업·설정·정책·GitHub 연결을 보존했고 정책 v4의 두 플랫폼과 updatedAt도 그대로다. Runner presence와 앱별 로그를 hosted Flora에 반영했다. 아래 이전 기록과 구분한 최신 결과는 [PC 자동 게시 검증](dual-platform-github-ota-evidence.ko.md)에 있다. 새 V6-PC 기기 적용은 미검증이다. Reward는 등록·SDK 소스·533개 테스트·Android QA APK까지 준비했으며 GitHub App 저장소 권한과 자동 OTA 검증은 남아 있다.

[README](../../README.md) · [PC 개발 인수인계·체크리스트](pc-handoff.ko.md) · [제품 로드맵](../roadmap/milestones.ko.md)

실제 연동 증거 갱신: 2026-10-13 UTC. 아래 운영 증거는 Isso·Promise의 `codex/flora-ota-integration` 브랜치, `flora-verification` 채널, iOS Simulator QA 앱을 대상으로 한다. 앱 main 병합·스토어 출시·물리 기기 검증은 포함하지 않는다. 현재 PC Runner의 커밋·배포 ID는 [PC 자동 게시 기록](dual-platform-github-ota-evidence.ko.md)에 고정한다. GitHub Actions 기록은 이전 검증이다.

## 현재 제공되는 기능과 남은 연결

| 영역 | 구현된 것 | 실제 운영 연결·미비점 |
| --- | --- | --- |
| source/config/history | 기존 반입·immutable snapshot·앱별 공개 CONFIG, GitHub SHA 고정 Flora SDK/Expo/RN 인식과 서명된 push 자동 Job | GitHub App을 Isso·Promise 두 저장소의 Contents/Metadata 읽기로 제한해 설치했다. 실제 push에서 앱별 자동 Job과 게시가 성공했고 기존 CONFIG v1, GitHub 연결 v2, 수동 배포와 JSON 반입은 보존했다. |
| Dashboard/CLI | 보호된 loopback UI와 CLI, 멀티앱 registry·공개 CONFIG·앱별 반입 이력, 기존 데이터 보존 migration | 실제 앱 두 개의 설정 / GitHub 연결 / 자동 작업 / 수동·자동 OTA 이력을 분리했다. 앱별 Runner presence와 배포 이벤트를 조회한다. GitHub CI binding v10은 비활성화했으며, push 정책 v4는 iOS·Android를 함께 대상으로 유지한다. 조직 로그인/RBAC·범용 importer는 후속 범위다. |
| Runner/build | 기존 검사 simulation과 별도 OTA Runner: 앱별 머신 등록·SHA downloader·Docker export·lease/취소/회수·atomic 발행, GitHub OIDC 단기 인증과 서버 checkpoint | 기존 PC의 전용 Lima VM에서 자격 정보 없는 의존성 준비와 network=none Docker Expo export를 실행했다. 두 앱의 실제 새 커밋에서 iOS·Android 네 건의 OTA 게시가 성공했다. Actions·EAS 실행은 사용하지 않는다. 사용자 로그인 후 자동 시작 설정을 확인했으며 실제 전원 재부팅은 미검증이다. native/Web 빌드·스토어 제출은 후속 범위다. |
| OTA | 앱별 export 에셋·배포 이력, runtime/플랫폼/주소 검사, 서명된 manifest·immutable 다운로드, 자체 iOS/Android 엔진의 해시 검증·원자적 적용·롤백 | [이전 테스트 앱 증거](native-ota-evidence.ko.md): bare RN 두 앱의 iOS·Android Release 및 이전 정상 버전 복구. [실제 앱 증거](real-apps-ota-evidence.ko.md): GitHub Isso·Promise 고정 commit, 운영 HTTPS 서명/파일, 실제 두 앱의 iOS Simulator Release 다운로드·적용·완전 재시작·앱별 ID와 로컬 파일 보존 확인. 이전 V4 Android 다운로드·적용·재시작 증거와 최신 V6-PC 자동 게시를 구분한다. 최신 V6-PC 기기 적용·물리 기기·스토어 배포는 미검증. 기존 반입 snapshot의 `otaDestination: not-evaluated`는 해당 옛 증거를 보존한다. |
| Apple/Google | StoreProvider와 release 추적 설계 | App Store Connect/Google Play 상태 sync·upload·processing·submit adapter가 없다. 다른 작업의 API 조회나 게시 권한은 Flora의 지속 접근 권한이 아니다. |
| Cloudflare hosted path | Worker·SQLite `FloraAuth` DO·D1 store, 단일 소유자 비밀번호 로그인, 잠긴 setup, source/baseline 반입·조회, GitHub/OTA 관리와 공개 native 업데이트 경로 | `flora.uulab.co.kr`의 전용 D1/DO, 실제 DNS/TLS, 소유자 등록/로그인, GitHub 비공개 저장소 읽기를 확인했다. 초기 setup은 다시 잠갔다. Free 성능/CPU와 계정 청구 플랜은 별도 미검증. 옛 반입 API의 runner: unavailable은 기존 검사 provider를 뜻한다. OTA 자동화는 별도 API와 외부 Runner를 사용한다. |
| Vault·조직 공용 운영 | 기초 identity/config 타입과 설계, 서버 DO의 GitHub App 개인키 및 앱별 OTA RSA 키 보관 | 앱 소스에는 공개 인증서만 포함한다. 일반 Vault·키 회전/복구·다중 소유자 권한은 후속 범위다. |

근거: [현재 범위 README](../../README.md), [blocked provider](../../packages/dashboard/src/blocked-provider.ts), [제품 CLI 구성](../../packages/cli/src/dogfood-command.ts), [Runner 계약](../../packages/runner-protocol/src/verification.ts), [hosted API](../../packages/cloudflare/src/hosted-api.ts), [고정 smoke profile](../../packages/dogfood/src/profile.ts).

## 화면은 어떤 데이터를 표시하나?

운영 UI 코드는 인증된 동일 origin 또는 loopback의 `/api/state`·`/api/sources`·`/api/baselines`에서 저장 데이터를 읽는다. 자료를 반입하면 저장·조회는 실제 동작이지만 그 기원은 `operator-import`, 연결 방식은 `one-shot-source-snapshot`이다. 새 앱 테스트를 실행하거나 provider를 실시간 조회한 결과가 아니다. HEAD도 별도 반입 관측이 없으면 최신 여부를 알 수 없다.

demo·렌더링 CI는 공개 synthetic fixture를 사용한다. 예제의 2개 파일/4개 테스트는 가상의 개발 증거다. 오류·수익 연동은 미연결이다. 별도 자동 배포 화면의 Job·Runner·정책은 실제 저장 자료를 표시하며, 등록이나 leased 상태만으로 export 성공을 표시하지 않는다. 여러 flavor 행을 여러 독립 앱의 운영 연결로 세지 않는다. [UI 구현](../../packages/cloudflare/public/app.js)과 [반입 범위](dogfood.ko.md)를 확인한다.

기존 JSON importer는 `flavors/config.json`, `package.json`, `package-lock.json` 등 고정 파일 집합을 요구한다. baseline은 두 지정 smoke 파일·4개 검사에 고정된다. 새 GitHub 인식 경로는 이 형식과 독립적으로 Expo/RN의 package·공개 설정을 읽지만, 일반 테스트 보고서·Unity 빌드까지 수집하는 기능은 아니다. 형식을 맞추려고 파일명을 바꾸거나 검사 성공값을 꾸미지 않는다.

## 실제 확인된 상태와 확인하지 못한 것

| 관측 시점/대상 | 결과 | 의미와 한계 |
| --- | --- | --- |
| 2026-10-12 원격 main·새 Mac checkout | 둘 다 `b2f14736…`; 새 checkout의 기존 미커밋 변경 없음 | 다른 사람의 작업을 복사하거나 덮어쓰지 않고 문서 변경만 별도로 준비했다. |
| 해당 baseline의 Foundation CI | macOS/Windows/Ubuntu 모두 success | [실제 실행](https://github.com/uulab-official/flora/actions/runs/37701924355). 앱 native build·스토어·OTA·운영 배포 증거는 아니다. |
| 해당 baseline의 화면 CI | 두 synthetic rendering workflow success | [Dashboard](https://github.com/uulab-official/flora/actions/runs/37701924369), [Hosted](https://github.com/uulab-official/flora/actions/runs/37701924393). 운영 계정 데이터가 아니다. |
| 2026-10-10 기존 Wrangler `whoami` | 미인증 | 이번 인수인계에서는 로그인·OAuth·토큰 발급을 재시도하지 않았다. 다른 기기의 인증 여부를 뜻하지 않는다. |
| 2026-10-10 공개 권한 DNS | `flora.uulab.co.kr A`: `NXDOMAIN`, `aa` | 당시 공개 호스트가 존재하지 않았다. 이 문서 작성 시점의 DNS를 새로 조회한 결과는 아니며, account 내부 Worker/DO/D1 부재도 증명하지 않는다. |
| 지정 계정 내부 | zone Active, 자원 존재/공유 여유, route 충돌 미확인 | 유효한 기존 관리 접근을 먼저 확인해야 한다. 과거 수치나 placeholder를 실제 설정으로 간주하지 않는다. |

운영 연결을 표시하려면 provider account·app/project·source SHA·최종 관측 시각·상태/오류와 결과 receipt를 실제로 확인해야 한다. 소스 커밋·dry-run·합성 테스트는 이를 대신하지 않는다.

## 연동 시 필요한 권한과 책임

- GitHub: 우선 선택 repo의 metadata/contents와 필요한 CI 상태 읽기. 현재 개발 도구의 인증을 Flora에 복사하지 않는다.
- Runner: 한 조직/job/attempt에 한정한 machine identity·claim/heartbeat/result와 revoke. 등록과 지속 자격정보 보관은 별도 신뢰 경계다.
- Apple/Google/EAS: 우선 특정 app ID/package/project의 상태 조회부터 구현한다. 다른 작업의 키·로그인을 서버로 옮기지 않는다. 업로드·submit·OTA publish는 별도 capability와 고정 artifact 승인 범위다.
- Cloudflare: 지정 계정·Free 용량·전용 리소스·정확 hostname을 확인한다. 새 지속 grant나 결제/초과과금 약정이 필요하면 해당 단계를 중단한다. R2·Access·유료 fallback을 자동 활성화하지 않는다.
- Flora 최초 소유자: 배포된 Free 성능·인증/저장 gate 후 검증된 HTTPS 화면에서 사용자가 직접 등록한다. 에이전트가 비밀번호·setup 원문을 생성·관찰·저장하지 않는다.

다음 실제 작업의 우선순위·완료 조건은 [PC 개발 체크리스트](pc-handoff.ko.md)에 있다. 모든 앱을 연동한 상태로 보고하지 않는다.
