# Reward GitHub·PC Runner OTA 검증

2026-10-14 KST. **Reward의 GitHub 연결 → PC Runner 자동 export → iOS·Android OTA 게시 → 실제 SDK 적용 → 완전 재시작까지 완료했습니다.** 실제 Reward 저장소의 QA 브랜치와 검증 채널에서 수행했으며, 테스트용 앱의 결과를 Reward 결과로 대체하지 않았습니다.

## 연결과 자동 게시

사용자가 GitHub App 설치 범위를 전체 저장소로 변경한 뒤, Flora API 두 페이지에서 166개 저장소와 `uulab-official/reward`(ID `1403085321`) 접근을 확인했습니다. Reward 소스 동기화는 HTTP 201로 성공했습니다. 기존 Isso·Promise 연결은 유지했습니다. 다른 도구의 토큰을 Flora에 복사하지 않았습니다.

- 앱: `application_1225979e-f858-4cd0-9213-55b201e7e6a5`
- 저장소 / 브랜치 / 루트: `uulab-official/reward` / `codex/flora-reward-integration` / `apps/app`
- 플랫폼 / 채널 / 런타임: `ios`, `android` / `flora-verification` / `flora-reward-rn0863-v1`
- 자동 정책: Reward v1 활성화. 기존 Isso·Promise 정책 v4와 앱 버전·런타임은 유지.
- 실제 인식: Expo 57, RN 0.86.3. Expo OSS export와 Flora 자체 네이티브 엔진을 사용하며 EAS는 사용하지 않습니다.

| GitHub 소스 | 플랫폼 | 자동 게시 ID | 결과 |
| --- | --- | --- | --- |
| `e64bcb221a91ab471c31ecb641cc7d442a4fadac` (V2) | iOS | `9d3f8691-1e2a-49ec-bd59-72f19dca768d` | 게시·적용·완전 재시작 확인 |
| 동일 V2 | Android | `78ad1c77-655e-4fff-a2a2-b64f4f218f57` | 두 번째 자동 시도 게시; native 수정 기준에서 적용·재시작 확인 |
| `8655f3b0edfdfc655cbb78b27bfaafb0b1f2a244` (V3) | iOS | `4e319902-cf36-4076-bc5d-f3186f6a80ad` | 첫 시도 게시·적용·완전 재시작 확인 |
| 동일 V3 | Android | `debf9199-cc67-4472-906d-c1c8f9f1994e` | 첫 시도 게시·적용·완전 재시작 확인 |

두 커밋 모두 GitHub 이벤트가 각 플랫폼 작업을 생성했습니다. V3 작업은 iOS `automation_7292ece3-ab7d-4170-ab73-e865d0daeaa9`, Android `automation_5546ab3a-fa6d-4f38-8194-3e652e0e3483`입니다. 수동 queue/publish API는 호출하지 않았고, GitHub Actions 실행은 두 커밋 모두 0건입니다. 기존 PC·Lima/Docker와 Cloudflare 자원을 사용했으며 새 유료 서비스나 계정 플랜 변경은 하지 않았습니다.

V3 전송 중 명령줄 GitHub 자격정보가 만료됐습니다. 연결된 GitHub 도구에서 같은 `bonjin-app` 계정과 Reward 쓰기 권한을 확인한 뒤 QA ref만 force 없이 갱신했습니다. 모든 blob과 최종 tree `f55cadffe086e8ff3aae166e5c02ae7019e736c8`가 검증한 로컬 후보 `8c58dd98df435d9a72dcd1c83fe3f248af48874e`와 동일합니다. API가 생성한 커밋의 SHA는 로컬 커밋과 구분합니다. 근거: `reward-v3-github-source-receipt.json`, `reward-v3-automatic-publication.json`.

## Android 네이티브 수정과 실제 적용

기존 SDK는 완료된 미적용 캐시를 cold launch 때 삭제했습니다. 실제 기존 V1 APK에서 서명·57개 해시가 정상인 캐시가 재시작 직후 사라지고 새 staging 디렉터리가 만들어져 약 41초 동안 재다운로드되는 것을 관측했습니다. JS 시작 게이트가 8초에 닫힌 후 네이티브 다운로드가 완료될 수 있어, 미적용 캐시 보존이 필요했습니다.

SDK 0.3.2는 기존 v1 상태와 호환되는 선택적 `cached` 필드에 완전히 검증된 후보 하나를 보존합니다. 캐시 자체를 실행하지 않습니다. 다음 시작에서도 새 서버 확인 → 동일 manifest·서명·해시 검증 → SDK reload가 필요합니다. 손상 캐시·symlink·차단 후보를 버리면서 기존 확정 업데이트와 rollback 상태를 보존합니다. 수정 전 3개 회귀 실패를 재현했고 수정 후 Android JVM 테스트 31개가 통과했습니다.

최초 active 상태가 오기 전에 초기 background/null을 실제 background 전환으로 처리하던 JS 문제도 별도 회귀 테스트로 수정했습니다. 이 독립적인 문제를 캐시 유실의 실제 원인으로 주장하지 않습니다. 검증 채널에서만 phase/reason/elapsed/lifecycle 로그를 기록하며 사용자 데이터나 예외 원문은 기록하지 않습니다.

**Kotlin 수정은 OTA로 설치할 수 없어 Android QA APK를 한 번 데이터 유지 방식으로 갱신했습니다.** 원래 APK(소스 `e09ee8e…`, SHA `4698c779…`)와 원래 보존 파일 증거는 그대로 보관했습니다. 수정 APK의 실제 빌드 소스는 로컬 `20aac0ec9165974b491b9c479d9bf6fa93ec5523`, SHA-256은 `7d15f6986dccfdb178f685d30876c5e3fbaa184ba1881c513343e5a2a6a5bcbc`입니다. GitHub 기준 커밋 `677b47218b90729756cde16c51aa18b5f4521189`와 tree가 같지만, 빌드 출처를 다른 SHA로 바꾸지 않았습니다.

APK의 기존 QA signer와 공개 Flora 연결 설정은 byte-identical입니다. 앱 버전 `1.0.0` / build `26100501` / runtime / 채널은 유지했습니다. `install -r` 뒤 기존 QA 보존 파일과 V1 홈을 확인했습니다. 원본 저장소·앱 데이터·native state를 초기화하거나 수동으로 OTA를 stage하지 않았습니다.

수정 APK 첫 실행에서는 실제 로그로 `deadline` 종료(8,153 ms)를 관측했고, 뒤늦게 완료된 V2 다운로드가 `cached`에 보존됐습니다. 다음 cold launch에서 실제 SDK reload로 V2를 적용하고, 별도 프로세스 재시작 `5139 → 5459` 후에도 유지했습니다.

V3에서는 첫 V2 실행이 새 다운로드를 시작하지 않았고, 다음 실행 PID 5994에서 실제 SDK가 V3를 다운로드해 기존 V2를 유지한 채 `cached`에 보존했습니다. 첫 실행의 정확한 종료 원인은 기존 V2 로그에 없으므로 추정 원인을 확정하지 않습니다. 다음 cold launch PID 6088에서 같은 프로세스 내 V2 → V3 JS reload를 관측했습니다. 새 V3 시작 로그는 약 998 ms에 `no-update`로 정상 진입했습니다. 이후 별도 완전 재시작 `6088 → 6396`에서도 V3 marker와 동일 ID를 확인했습니다.

V3의 RSA 서명·57개 파일 해시·app/runtime/channel/platform·native committed ID·pending 없음·launching=false·blocked 없음·실제 제품 홈을 검증했습니다. OTA 동안 수정 기준 APK와 QA 데이터는 그대로입니다. 기존 SDK 0.3.1 운영 클라이언트에 Kotlin 수정을 전달하려면 별도 네이티브 바이너리 갱신이 필요합니다.

근거: `reward-android-cache-cold-launch-reproduction.json`, `android-candidate-cache-{red,green}.log`, `reward-android-native-fix-baseline.json`, `reward-android-v3-{downloaded-before-apply,verify,restart}.json`, `reward-android-v3-sdk-reload.log`, V3 화면.

## iOS 실제 적용

기존 Release Simulator 앱을 재빌드·재설치하지 않았습니다. SDK tar 비교에서 0.3.1 → 0.3.2의 iOS native·JS API 파일은 동일하고 Android Engine/Store와 package metadata만 달라졌습니다.

V3 첫 실행에서는 다운로드가 시작 게이트 뒤에 완료됐습니다. 다음 cold launch PID 15671에서 캐시를 이용한 실제 SDK RN reload를 확인했습니다(JS eval 10:57:01 → teardown 10:57:02 → 새 eval 10:57:04). native activeId=launchedId=V3, previousId=V2, launchPending=false, blocked 없음과 제품 홈을 확인했습니다. 별도 완전 프로세스 재시작 `15671 → 17100`에서도 V3가 유지됐습니다.

RSA 서명과 53개 파일 해시를 검증했고 native executable·embedded HBC·QA 보존 파일은 최초 기준과 같습니다. Release JS console marker는 관측되지 않았으므로, HBC marker의 존재를 콘솔 실행 증거로 설명하지 않습니다. 실제 선택·확정된 native launch 상태, SDK reload 로그와 제품 진입을 함께 확인했습니다.

근거: `reward-ios-v3-{verify,restart,ota-lifecycle,downloaded-before-apply}.json`, `reward-ios-v3-sdk-reload.log`, V3 화면. V2 성공 증거는 `reward-ios-v2-archive/`에 별도로 보존했습니다.

## 기존 데이터와 앱별 분리

최종 실제 API 비교에서 Isso의 기존 작업 16개·게시 7개, Promise의 작업 12개·게시 7개와 두 앱의 connection/detection/asset/deployment 전체 값, 정책 v4, Runner 권한은 모두 원래 기록과 같습니다. transient presence 시각은 비교에서 구분했습니다. Reward 작업 ID를 Isso 경로로 읽으면 같은 관리자라도 HTTP 404이며 Reward 경로는 HTTP 200입니다.

D1의 기존 설정 5행과 원래 정책 이력 8행의 기록된 버전·JSON 값은 그대로입니다. Reward 정책 v1 한 행만 추가됐습니다. 후속 V3 게시 후 설정 5행·정책 9행의 전체 기록 컬럼을 이전 게시 snapshot과 다시 비교해 동일함을 확인했고, 두 SELECT의 rows_written은 0입니다.

기존 workspace 용량 부족은 기존 자료를 삭제하지 않고 128 → 192 MiB 제한 마이그레이션으로 해결했습니다. 원래 D1 전체의 private 0600 SQL 백업을 보존했으며, 83개 statement 적용 전후 20개 테이블의 행 수·저장 바이트·schema/trigger/index/counter와 FK를 검증했습니다. 기존 0001–0004 재실행이나 migration ledger 도입은 하지 않았습니다. 세부 근거는 [용량 적용 기록](workspace-capacity.ko.md)과 `capacity-live-*.json`입니다.

추가 근거: `reward-v3-existing-app-isolation.json`, `reward-v3-live-job-isolation.json`, `reward-v3-settings-preservation.json`. V2 증거는 Android/iOS의 읽기 전용 archive에 유지합니다.

## PC Runner와 검증 범위

Reward 전용 Runner `runner_afec0e53-9ce3-41af-b15f-38ce806c4b46`은 별도 app-scoped 자격정보와 `work-reward`/`recovery-reward`를 사용합니다. 기존 Isso·Promise 설정과 권한을 보존했습니다. Reward는 고정 ARM64 이미지 `dd627dc8…`, Node 24.19.0, pnpm 11.10.0을 사용하며 실제 compiler 컨테이너의 network mode는 `none`입니다. 앱에 GitHub 자격정보·OTA 개인 키를 넣지 않았습니다.

V2 Android 첫 attempt의 heartbeat 통신 실패와 `LEASE_EXPIRED` 기록은 그대로 남겼습니다. heartbeat에만 같은 credential/attempt/fence/요청을 최대 두 번 재시도하도록 보완했고, 20초와 원래 lease 만료 중 빠른 시점에 종료합니다. 인증·권한·충돌·stale/invalid 응답은 재시도하지 않습니다. 최종 standalone controller main `869d04e5…`를 비활성 queue/journal 확인 후 설치했고, 이후 V3 두 플랫폼은 각각 첫 attempt에 성공했습니다.

응답을 잃은 claim의 안전한 재응답 프로토콜은 아직 없으므로 claim/finalize의 새 재시도를 확대하지 않았습니다. 장기 통신 장애에서는 안전 중단을 유지합니다. 실제 장애 원인 해소나 무중단 운영을 이 검증에서 주장하지 않습니다. 기존 LaunchAgent 자동 시작 등록은 유지했으며 실제 PC 재부팅은 수행하지 않았습니다.

| 검증 | 실제 결과 |
| --- | --- |
| Flora build / typecheck / 전체 회귀 | 789 pass, 0 fail, 3 선택 실행 제외 |
| Android 네이티브 엔진 | 31 pass; 캐시 유실 RED 회귀 포함 |
| Reward 최종 소스 | 타입 검사와 546 tests pass; GitHub 최종 tree 일치 |
| heartbeat 최종 집중 검사 | 47 pass; 최종 guard 이후 전체 회귀도 통과 |
| 실제 자동 배포 | V3 iOS·Android 각각 첫 attempt 성공; Actions 0 |
| 실제 클라이언트 | iOS Simulator와 전용 Android Emulator에서 SDK 적용·제품 진입·완전 재시작 |

검증 대상은 iOS Simulator `Flora Native OTA QA`와 Android Emulator `Flora_RealApps_Android_OTA_QA_API36`입니다. 운영 브랜치 merge·store 배포·물리 휴대폰·운영 사용자 건강 데이터나 정산 기능의 검증으로 확대 해석하지 않습니다. 기존 데이터 보존은 실제 Flora 기록과 QA 앱 보존 파일에 근거합니다.

증거 파일은 `dist/real-apps-2026-10-14/evidence/`, 서버 API snapshot은 `dist/real-apps-2026-10-13/evidence/reward-v3-*.json`에 있습니다. [이전 준비 기록](reward-flora-connection.ko.md)과 최신 완료 결과를 구분합니다.
