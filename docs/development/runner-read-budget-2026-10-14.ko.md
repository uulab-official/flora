# PC Runner의 D1 조회 비용 개선과 초기화 후 검증

이 문서는 2026-10-14의 조회 비용 개선과 다음 한도 초기화 후 수행할 검증을 구분한다. 실제 마지막 Reward Android 게시가 확인되기 전에는 여섯 배포 완료로 기록하지 않는다. 이전 배포와 키·이력 보존 기준은 [Runner 복구 기록](pc-runner-recovery-2026-10-14.ko.md)과 `dist/runner-recovery-2026-10-14/preservation-before.json`에 있다.

## 비용 원인과 적용 상태

Cloudflare의 무료 D1 한도는 쿼리 횟수가 아니라 실제 읽은 행 수로 집계되며, 계정의 데이터베이스들이 한도를 공유한다. [공식 조회 비용 정의](https://developers.cloudflare.com/workers/platform/pricing/)와 [인덱스 안내](https://developers.cloudflare.com/d1/best-practices/use-indexes/)를 확인했다. 일일 한도는 [00:00 UTC에 초기화](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)된다. 이번 다음 시각은 **2026-10-15 09:00 KST**다.

PC Runner는 앱별 빈 큐 확인 간격을 30→60→120→240→300초로 늘린다. 앱 하나의 대기가 다른 앱 확인을 막지 않으며, 실제 작업 결과를 받으면 기본 간격으로 돌아간다. 유휴 상태에서 각 앱은 최대 5분 안에 다시 확인한다. 활성 export가 직렬 실행되는 시간은 별도이며 인수한 작업의 heartbeat·서명·게시·복구 규칙은 바꾸지 않는다. Presence는 서버의 120초 온라인 판정에 맞춰 별도 60초 간격을 유지한다.

HTTP 503의 정확한 `D1_DAILY_READ_LIMIT` 또는 `D1_DAILY_WRITE_LIMIT` 진단이 작업 수신 전이나 presence에서 확인되면, 서비스 전체의 DB 호출을 다음 UTC 자정까지 기다린다. 알 수 없는 오류·권한 거절·작업 인수 이후 오류·게시 결과 불명은 이 경로로 재실행하지 않는다. 재시작하면 실제 오류로 대기를 다시 설정하므로 성공한 presence를 만들어내지 않는다.

새 controller는 `~/.flora/pc-runner-uulab/controller-read-budget-20261014/ci/flora-runner`에 설치했다. 배포 파일 56개의 SHA-256을 검증했고 이전 서비스·스크립트는 `~/.flora/pc-runner-uulab/read-budget-backup-20261014`에 보존했다. 세 앱의 토큰 설정 JSON과 권한은 바이트까지 같다. LaunchAgent의 사용자 로그인 자동 시작 설정은 유지했다. 실제 2026-10-14 13:18:05 UTC 로그에서 claim과 presence가 고정 한도 오류를 받고 `quota-cooldown`으로 전환한 것을 확인했다. 초기화 뒤 자동 재개 결과는 아직 확인되지 않았다.

시간을 진행시키는 실제 supervisor 스케줄링 테스트에서 세 앱의 첫 유휴 한 시간 claim 호출은 이전 120회에서 44회로 줄었다. 안정화 뒤에는 앱별 5분 간격이므로 세 앱 총 하루 864회 수준이다. 프로세스 재시작과 실제 작업으로 유휴 간격이 초기화되면 호출이 추가된다. 이 호출 수 테스트는 실제 D1 행 수 계측과 구분한다.

서버의 최신 작업 조회와 쓰기 시 용량 검사는 별도로 실제 local workerd/D1에서 계측한다. 세 scoped Runner와 앱 A의 여섯 배포·90개 transition(각 export의 heartbeat 12개), B·C의 빈 이력 fixture에서 empty claim은 **105/9/9→27/9/9행**으로 줄었고 presence는 각 6행을 유지한다. 이 샘플을 앱별 5분 claim·60초 presence에 적용하면 정상 유휴 하루 **38,880 rows read / 0 D1 rows written**이다. 시작 첫 시간의 추가 호출을 포함한 한 번 시작하는 하루의 샘플 상한은 39,096행이며 실제 export·사용자/SDK/API 이용과 계정의 다른 DB 사용량은 별도다.

활성 claim은 297행, heartbeat는 206행, 1 MiB 자산 업로드는 약 981행을 읽던 경로다. [새 증분 회계](incremental-capacity-accounting.ko.md)는 기존 자료를 복제하지 않고 logical PK·byte charge만 가진 불변 witness와 테이블별 18행의 집계로 전체 이력 재합산을 대체한다. 로컬 검증에서 단일 append는 **1,058→53행**이며 이력을 두 배로 늘려도 53행으로 같다. Counter·키·이력·권한·lease·앱별 용량 제한은 유지한다. 회계 metadata의 쓰기와 저장 공간은 추가되므로 read만으로 전체 무료 한도 여유를 단정하지 않는다.

최신 작업 조회는 Worker **`a7801508-2b4c-4b13-9c8a-d6066a874ba6` 100%**로 배포했고 기존 DB·DO·vars·secret binding 10개를 그대로 유지했다. 증분 회계 SQL은 **원격 미적용**이다. `0007_incremental_capacity_accounting.sql`의 최종 SHA-256은 `e2ac8fdba56d1f8964cf0b63ee5ea240e899b915d81ba0435d8f245bd7690e38`이며 전체 58,833 bytes·SQL 128개를 한 transaction으로 적용해야 한다. 기존 0005·0006은 바이트까지 유지했다. 로컬 회계 검증 17개가 모두 통과했으며 원격 비용은 초기화 후 별도 확인한다. 초기 hidden-rowid 회계 prototype의 숫자는 superseded 증거로만 보존하고 최종 적용 근거로 사용하지 않는다.

최종 SQL hash의 독립 Worker→DO→D1 검증에서 활성 claim은 **87 read / 8 write**, heartbeat는 **72 / 8**, 1 MiB 자산은 **285–287 / 39**였다. Heartbeat 이력 64개를 더 저장해도 72행으로 같았고 기존 transition 158개가 남아 있었다. 최종 숫자는 `dist/runner-read-budget-2026-10-14/stable-witness-final-full-endpoints.json`, 회계/보안/보존 증거는 `capacity-accounting-verification.json`에 있다. 이전 variant의 비용을 최종 hash의 값으로 섞지 않는다.

## 최종 로컬 검사와 범위

PC supervisor·health·CLI·daemon 검사 **85개**, 최종 회계 검사 **17개**, 독립 최종 endpoint/growth 검사 **2개**가 통과했다. Workspace build와 수정 범위의 strict TypeScript, `git diff --check`도 통과했다. 전체 프로젝트 검사 결과는 **1,004개 중 998 pass / 3 fail / 3 skip**이다. 실패는 기존 `tests/dashboard-qa.test.ts`의 elevation/motion CSS 검사 세 건(`local, hosted and auth surfaces share restrained elevation and preserve motion preferences`, `disabled elevation resets outrank primary hover and pagination controls`, `switching to reduced motion cancels in-flight control transitions`)이며 이번 작업에서 CSS를 변경하지 않았다. 전체 타입 검사는 기존 admin-navigation·hosted-ui·project-ui 테스트 선언/nullable/fake Document 오류 때문에 실패했다. 전체 검사 통과로 기록하지 않는다.

첫 전체 실행에서 발견한 hosted asset 목록의 8→10개 변경 누락은 실제 현재 manifest에 맞게 검사만 수정했고 재검증에 통과했다. 192 MiB 앱별 한도 검사는 첫 전체 실행에서 local workerd 연결의 ECONNRESET이 발생했지만 같은 검사의 단독 재실행과 최종 전체 실행 모두 통과했다. 원인을 코드로 단정하지 않는다. 전체 결과와 최초 실패는 `workspace-tests-final.log`, `workspace-tests-first-run-status.json`, `workspace-typecheck-final.log`에 보존했다.

## 초기화 후 후속 검증

사용자의 요청에 따라 이 채팅에 **Flora Reward Android 자동배포 검증** 자동 확인을 등록했다. 다음 실행은 2026-10-15 09:05 KST이며 완료 확인 뒤 중지한다. 원래 PC Runner는 09:00 KST 한도 초기화 후 자동으로 작업 조회를 재개한다. PC와 Codex가 실행 가능한 상태여야 후속 검증을 수행할 수 있다.

1. `service.mjs status`와 고정 로그로 실제 서비스 상태를 확인한다. 토큰 JSON 전체를 출력하지 않는다. 대상 Worker는 `flora-uulab`, origin은 `https://flora.uulab.co.kr`, 계정은 `1302e647c709ce0cc8b4d64938772cb9`, D1은 `717d19c0-9e46-4deb-9539-560161e7397c`, owner는 `flora-uulab-owner-v1`, DB identity는 `flora-uulab-d1-v1`이다. 현재 bindings와 marker를 읽기 전용으로 재확인한다.
2. [증분 회계 적용 안내](incremental-capacity-accounting.ko.md)의 로컬 안전·동시성 검증, 위 최종 SHA와 원격 미적용 여부를 확인한다. `flora_capacity_facts`와 `flora_capacity_ledger`의 존재 여부로 적용 여부를 먼저 확인한다. 18개 source table의 실제 PK key/metadata 합계 및 수동 rowid `-1` 여부를 확인하고 실패 시 원본을 삭제·수정하지 않는다. 적용 안내의 단일 원자 transaction만 사용하며 기존 0001~0006을 다시 실행하지 않는다. 현재 Time Travel bookmark와 보존 기준을 확보하고, 적용 전후 원본 이력·counter·새 집계·FK와 기존 권한/lease/provenance/용량 제한을 확인한다. 활성 export를 임의 중단하지 않는다. 이미 적용됐다면 반복 실행하지 않는다.
3. 정상 Flora 관리자 로그인을 승인된 기존 계정으로 수행한다. `scripts/flora-live-api.mjs`에 private stdin으로 인증 정보를 전달하고 cookie와 CSRF는 메모리에만 둔다. 원문 비밀번호·cookie·토큰·개인키를 파일·로그·자동 확인 prompt에 저장하지 않는다. 기존 세션은 한 시간 후 만료되므로 정상 로그인으로 갱신한다.
4. Reward 앱 `application_1225979e-f858-4cd0-9213-55b201e7e6a5`의 원래 Android 작업 `automation_8dbdcdcb-0a94-47cf-ad8e-5a3a555f330a`를 작은 단일 GET `/api/apps/<appId>/automation/jobs/<jobId>`과 실제 로그로 확인한다. 상태 확인은 30~60초 간격이며 전체 목록을 반복 조회하지 않는다. 자동 인수·export·자산 업로드·게시를 PC Runner가 수행해야 한다. 수동 큐 등록·게시 API나 추가 커밋으로 결과를 만들지 않는다. 진행 중 Runner가 있으면 중복 controller를 실행하지 않는다.

   서버의 정상 조회가 회복됐는데 서비스가 이전 한도 대기로 멈춰 있는 경우에는 먼저 현재 job lease·게시·복구 journal과 해당 서비스의 프로세스를 확인한다. 활성 작업이나 불확실한 게시가 없고 세 journal이 비어 있는 것이 확인된 경우에만 기존 관리 service의 stop/start로 정상 복구한다. 토큰/정책을 바꾸거나 journal을 삭제하지 않는다.
5. 기대 provenance는 `uulab-official/reward`, `codex/flora-reward-integration`, root `apps/app`, commit `8666f91c88e74b361ea5ba546e9533dc40478608`, runtime `flora-reward-rn0863-v1`, channel `flora-verification`, platform `android`다. 다른 커밋이 이미 최신이거나 lease/복구 상태가 달라졌다면 현재 근거를 먼저 확인하며 이전 상태를 강제로 복원하지 않는다.
6. 실제 `succeeded`와 deployment/receipt가 확인되면 `dist/runner-recovery-2026-10-14/verify-delivery.mjs reward android <actualDeploymentId>`로 해당 배포의 서명·자산 SHA-256·JS 표식을 검증한다. 나머지 다섯 배포와 이미 검증한 227개 자산을 불필요하게 다시 export/다운로드하지 않는다.
7. 큰 읽기 전용 operations/automation 응답은 API helper의 지원된 `evidenceFile` 경로인 `dist/real-apps-2026-10-13/evidence/<app>-runner-preservation-after.json` 및 `<app>-runner-automation-after.json`에 저장한다. 터미널에서 잘린 JSON을 보존 근거로 사용하지 않는다. 기존 앱별 설정·토큰·키와 교체/접근 이력, 원본 배포 18건·자동 작업 32건·detection 27건·자산 metadata 185개를 원본 기준과 비교한다. `state-credential-native-after.json`에 필요한 현재 정상 API 증거를 확보한 뒤 기존 `verify-final.mjs`의 실제 조건이 모두 맞을 때만 `final-verification.json`을 생성한다. 앱별 잘못된 runtime/channel/교차 앱 자산 거절 증거도 보존한다.
8. 실제 D1 `meta.rows_read/rows_written`과 GraphQL 계정 사용량으로 변경 후 비용을 기록한다. 이미 있는 정상 증거를 다시 수집하기 위해 무거운 전체 쿼리를 반복하지 않는다. 새 계정/DB나 유료 전환으로 우회하지 않는다. 전체 여섯 게시와 보존 검증을 완료하면 실제 마지막 deployment ID를 보고하고 자동 확인 `flora-reward-android`를 PAUSED로 바꾼다. 같은 상태는 조용히 종료하며 새 실패·필수 외부 조치만 알린다.

이 후속 검증은 OTA 자동 게시·다운로드 확인이다. 수행하지 않은 실제 기기 적용·재시작 또는 물리 PC 재부팅을 완료로 기록하지 않는다.
