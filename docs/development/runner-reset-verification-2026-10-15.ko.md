# 한도 초기화 후 DB 적용과 Reward Android SDK 검증

사용자는 2026-10-15에 DB 개선뿐 아니라 Reward Android 자동 배포·다운로드·실제 SDK 적용·완전 재시작까지 요청했다. 10월 14일의 [준비 기록](runner-read-budget-2026-10-14.ko.md)과 보존 기준은 유지하고, 이번 새 증거는 `dist/runner-reset-2026-10-15/`에 추가한다. 이전의 다섯 게시나 V3 기기 적용을 새 Android 배포 완료로 쓰지 않는다.

**현재 완료 상태:** 원격 DB 개선 적용·원본 보존, 세 앱의 여섯 플랫폼 자동 게시, 새 Reward Android V4의 실제 SDK 다운로드·적용·완전 재시작, 기존 설정/키/이력 및 다른 앱 설치 상태 보존을 확인했다. 전체 build/typecheck와 1001개 테스트가 통과했고 실패는 0건이다. 아래는 준비부터 완료까지의 시각별 기록이며, 기기 검증은 전용 Android 에뮬레이터를 사용했다.

## 초기화 전 확인한 결과

- 2026-10-15 07:49 KST 현재 PC Runner는 `running`, PID 50287이다. 정확한 D1 한도 진단에 따른 09:00 KST 대기 상태를 유지하며 중복 controller를 실행하지 않았다.
- 기존 Isso·Promise·Reward Runner 설정 파일의 SHA-256과 0600 권한은 10월 14일 기준과 같다. 새 DB나 유료 리소스를 만들지 않았다.
- 남은 CSS 실패 세 건과 테스트 mock 타입 오류를 수정했다. 전체 빌드와 strict TypeScript는 성공했고 전체 검사 **1004건 중 1001 pass / 0 fail / 3 skip**이다. 선택적 Windows/real Expo CLI/real PNPM 검사 세 건을 이번 작업 때문에 새로 제외하지 않았다. 로그는 `workspace-build.log`, `workspace-typecheck.log`, `workspace-tests.log`에 있다.
- Hosted control elevation·disabled specificity·reduced-motion CSS를 Worker **`07f38293-b2ff-4648-9eb2-cb5b2e6460df` 100%**로 배포했다. 기존 DB·DO·vars·secret binding 10개를 동일하게 유지했다. 정상 로그인 뒤 `/app.css`를 받아 빌드 파일과 바이트까지 일치함을 확인했고 비로그인 접근은 401이다. Cookie·CSRF는 메모리에만 보관했다. DB 회계 migration은 아직 원격 미적용이다.
- 기존 전용 AVD `Flora_RealApps_Android_OTA_QA_API36`를 port 5560 / ADB server 5038로 데이터 초기화 없이 켰다. 다른 AVD나 기기는 조작하지 않았다. Reward installed APK SHA-256은 `7d15f6986dccfdb178f685d30876c5e3fbaa184ba1881c513343e5a2a6a5bcbc`, 보존용 sentinel은 `456a3daafe196c6d99813d355d65facfb027f3a093cb2bc82a2383fa489629bd`로 기존 baseline과 같다.
- 기기의 현재 committed update는 이전 V3 `debf9199-cc67-4472-906d-c1c8f9f1994e`이며 pending/cached가 없고 launching=false, blocked가 비어 있다. 이는 새 V4 완료 증거가 아니다. Isso·Promise·Reward 각각의 APK·sentinel·native state를 `evidence/device-app-isolation-before.json`에 보존했다.

## 09:05 KST 후속 실행

기존 `flora-reward-android` 자동 확인의 범위를 SDK 적용·재시작까지 확대했다. 최초 대상 시각은 2026-10-15 09:05 KST다. PC와 Codex가 실행 가능한 상태여야 하며, 같은 상태를 반복 알리지 않는다. 실제 모든 완료 조건이 충족되면 자동 확인을 PAUSED로 바꾼다.

1. 10월 14일 runbook의 target identity·bindings·schema·Time Travel bookmark·원본 subset 보존 기준을 확인한다. 새 SQL의 SHA는 `e2ac8fdba56d1f8964cf0b63ee5ea240e899b915d81ba0435d8f245bd7690e38`다. [원자 적용 절차](incremental-capacity-accounting.ko.md)에 따라 **신규 파일 전체 하나**를 한 transaction으로 적용한다. 이미 적용됐으면 반복하지 않는다. 준비한 audit helper가 있는 경우 그 README와 정적 SQL을 먼저 읽고 pre/post 원본·counter·fact·ledger·FK를 같은 snapshot 기준으로 검증한다. 활성 export를 취소하거나 기존 이력을 수정하지 않는다.
2. 원래 Reward Android job `automation_8dbdcdcb-0a94-47cf-ad8e-5a3a555f330a`를 PC Runner가 정상 자동 인수·export·업로드·게시하는지 확인한다. 추가 commit, 수동 enqueue/finalize, 중복 Runner로 결과를 만들지 않는다. 30~60초의 단일 job 조회를 사용한다. 현재 source/ref가 바뀌었다면 먼저 최신 authority/provenance를 확인한다.
3. 실제 succeeded와 deployment ID를 받아 `dist/runner-recovery-2026-10-14/verify-delivery.mjs reward android <actualDeploymentId>`로 서명·모든 자산 SHA-256·실제 commit 표식을 검증한다. 기대 원본은 `8666f91c88e74b361ea5ba546e9533dc40478608`, app `application_1225979e-f858-4cd0-9213-55b201e7e6a5`, runtime `flora-reward-rn0863-v1`, channel `flora-verification`, root `apps/app`, marker `Reward-Flora-V4-PC-20261014`다.
4. Android 조작 직전에 정확한 AVD 이름, emulator-5560, ro.kernel.qemu=1, root 권한과 이전 APK/sentinel hash를 확인한다. 해당 AVD의 `kr.co.uulab.reward/.MainActivity`만 정상 cold-launch하여 **기존 SDK startup 경로**로 다운로드한다. 초기화·재설치·native state/cache 수동 쓰기를 하지 않는다. 다운로드가 startup deadline을 넘겨 cached로 남으면 실제 cached manifest/signature/assets와 old committed/new cached 구분을 기록한 후 정상 다음 cold-launch를 사용한다. 열린 사용자 세션에 강제 reload를 넣지 않는다.
5. 현재 verifier는 새 marker의 seed/baseline 모드를 거절하고 새 폴더에만 결과를 기록한다. `node scripts/verify-reward-android-ota.mjs verify <actualDeploymentId> Reward-Flora-V4-PC-20261014`로 실제 FLORA_LAUNCH updateId/marker/source=update, native committed/pending=null/launching=false/blocked=[], 캐시 서명·자산 digest와 `오늘의 걷기` 제품 진입을 확인한다. 앞선 다운로드 경과와 전후 PID도 실제 logcat/native state에서 보존한다.
6. 같은 helper의 `restart` 모드로 완전 force-stop/start 뒤 PID가 달라지고 같은 새 updateId·marker·committed·제품 진입·APK와 sentinel hash가 유지되는지 확인한다. 새 verify/restart JSON·스크린샷은 `dist/runner-reset-2026-10-15/evidence/`에 쌓인다. Isso·Promise의 APK/sentinel/native state가 device-app-isolation-before 기준과 같은지도 비교한다.
7. 적용·재시작 뒤 `python3 dist/runner-reset-2026-10-15/capture-device-isolation.py after`로 세 앱의 실제 상태를 다시 읽는다. 이 helper는 앱을 실행/변경하지 않고 기존 캡처 파일 덮어쓰기도 거절한다. 기존 18 OTA 배포·32 자동 작업·27 detection·185 자산 metadata, 앱별 설정·키·접근/교체 이력과 토큰 보존 기준을 최신 정상 API/원본 subset hash로 비교한다. 실제 D1 비용과 한도 사용량을 기록한다. 기존 `verify-final.mjs`는 서버 게시·보존을 검증하는 범위이므로 그 결과의 기기 미검증 필드를 새 기기 결과로 쓰지 않는다. 이어 `node dist/runner-reset-2026-10-15/verify-complete.mjs`가 실제 새 verify/restart와 isolation 전후 증거를 결합하여 통과할 때만 `complete-verification.json`을 만든다. 누락된 실제 증거가 있으면 파일을 생성하지 않음을 확인했다. 자동 확인 종료는 여섯 게시·새 Reward Android SDK 적용·완전 재시작·보존 확인까지 포함한다.

이 기기 증거는 전용 **Android 에뮬레이터**에서 실행한 실제 RN/Flora SDK 증거다. 물리 휴대폰이나 PC 전체 재부팅을 수행했다고 보고하지 않는다.

## 09:01 이후 실제 적용 결과

2026-10-15 09:00:17 KST의 첫 gate 질의는 정상 응답했다. 09:00:38의 사전 감사는 현재 charged source 4180행, payload 201138561 bytes, 예상 witness 856381 bytes, 최대 key 239 bytes, manual rowid -1 및 외래키 오류 0건을 확인했다. 기존 `_cf_KV` 테이블은 정의를 확인하고 그대로 보존했다. 원래 27 detection·185 자산 metadata·18 배포·32 terminal job, 총 262개 기록의 canonical SHA-256 모두 기준과 같았다.

09:01:14에 신규 0007 **전체 128문장 하나**를 정상 관리자 Query API 요청으로 적용했다. 정확한 파일 SHA가 일치했으며 응답의 모든 statement가 성공했다. 실제 비용은 **42753 rows read / 12654 rows written**이다. 복구용 Time Travel bookmark와 전후 증거는 `migration-applied-and-preserved.json`에 있다. 원본 source/history는 삭제·수정하지 않았다.

09:01:27의 사후 감사에서 새 18행 ledger·4181개 fact·원본 source·기존 counter가 일치했다. 유효하지 않은 fact, 회계 불일치, FK 오류는 모두 0건이다. 변하지 않아야 하는 schema digest와 기존 capacity 관련 trigger 39개를 보존했으며 이전 기록 262개의 해시도 모두 일치했다. 적용 중 정상 Runner heartbeat 한 행이 추가되어 pre/post payload가 201138561→201142807 bytes로 증가한 것은 별도 확인했다. 물리 DB 크기는 203100160→205369344 bytes다. 사후 감사 자체는 21405행을 읽고 0행을 썼다.

Runner는 재시작 없이 09:00에 quota 대기를 끝내고 세 앱의 presence를 정상 갱신했다. 원래 Reward Android job은 자동으로 attempt 2 / leased가 되었고, 정상 heartbeat를 갱신하며 export한다. 아직 이 단계를 게시·기기 적용 완료로 기록하지 않는다. 정상 관리자 API로 별도 비교한 세 앱의 설정과 기존 키 12개, 키 접근/교체 및 네이티브 작업 이력이 기준과 일치했고 `state-credential-native-after.json`에 보존했다.

## 09:17 실제 완료

원래 Reward Android 작업은 PC Runner의 **attempt 2로 succeeded**가 되었고 새 배포 **`ba0ded11-d92f-4d64-b8e0-a98bc5693fee`**를 게시했다. 새 enqueue/commit/finalize 호출 없이 원래 GitHub commit `8666f91c88e74b361ea5ba546e9533dc40478608`에서 export·업로드·서명을 자동으로 마쳤다. Isso·Promise·Reward 각각 iOS/Android **여섯 게시**와 서명·총 **284개 자산**이 검증됐다. 새 Reward Android 자체는 57개 파일·22784325 bytes·marker `Reward-Flora-V4-PC-20261014`의 다운로드/서명/SHA-256을 확인했다. 원래 GitHub ref 세 개와 Actions 실행 건수 0도 재확인했다.

첫 기기 실행 PID 5009에서 8.095초 startup deadline 후 기존 V3 세션을 유지하고 새 V4를 cached로 저장했다. 다운로드 완료 이후 `evidence/reward-android-downloaded-before-apply.json`에서 old committed/new cached 분리 및 실제 57개 캐시 파일의 서명·digest를 확인했다. Native cache/state를 수동으로 쓰거나 열린 세션을 reload하지 않았다. 정상 cold-launch PID **5252**에서 새 배포 ID/marker/source=update를 실제 JS FLORA_LAUNCH로 확인했고 native committed가 새 ID, pending/cached=null, launching=false, blocked=[]이며 제품 화면에 진입했다. 두 번째 완전 force-stop/start 후 PID **5567**에서도 같은 새 배포로 제품 진입·native commit·서명·57개 다운로드 파일을 검증했다.

기존 APK 및 Reward QA sentinel의 해시가 유지됐고 Isso·Promise의 설치 APK·sentinel·native state도 전후 동일했다. 앱별 설정·기존 키 12개·접근/교체 이력, 원래 262개 서버 기록과 기존 네이티브 작업/키 사용 이력을 보존했다. 소유 앱에만 이력이 나타나며 다른 runtime/channel은 204, 다른 앱 자산은 404인 **9개 scope 검사**도 migration 후 다시 통과했다. 설치기기 증거는 전용 Android 에뮬레이터이며 실제 휴대폰과 물리 PC 전체 재부팅 증거는 아니다.

실행 중 PC 디스크가 찼지만 export 게시 자체는 성공했다. 활동 중인 컴파일러가 없음을 확인한 뒤 이 작업의 `reward-ios-derived/ModuleCache.noindex`와 `Build/Intermediates.noindex`만 정리했다. 원본 소스·키·서명 제품·APK/IPA·앱 데이터는 보존했으며 기존 서명 APK/IPA 네 개의 SHA-256과 세 Runner 토큰 설정의 바이트/0600 권한도 다시 확인했다. 정리 후 약 7.8 GiB의 여유 공간과 정상 Runner health, 빈 복구 저널을 확인했다. `disk-cache-cleanup.json`과 `retained-artifacts-and-settings.json`에 증거가 있다.

Cloudflare GraphQL이 09:17:25 KST에 보고한 계정 전체의 현재 UTC 일일 누적은 **116483 rows read / 14670 rows written**이다. migration/감사/게시/다운로드의 일회성 사용량까지 포함하며 무한 무료 용량을 의미하지 않는다. [D1 분석 지표](https://developers.cloudflare.com/d1/observability/metrics-analytics/) 및 [공식 한도](https://developers.cloudflare.com/d1/platform/pricing/)와 구분해 `account-d1-usage-after.json`에 시각을 기록했다.

`complete-verification.json`이 여섯 자동 게시와 실제 Android 적용·완전 재시작·다른 앱 격리/데이터 보존을 결합하여 통과했다. 기존 자동 확인 `flora-reward-android`는 **PAUSED**로 종료했다. PC Runner 서비스는 중단하지 않고 사용자 로그인 자동 시작 설정과 정상 실행을 유지한다. 전체 build/typecheck, 전체 테스트 1001 pass / 0 fail / 기존 선택 검사 3 skip 결과와 `git diff --check`도 보존했다.
