# OTA 실행 확인 보고의 같은 실행 내 전송 검증

iOS 후속 적용 검증은 [보강 SDK의 iOS 첫 적용 실행 내 보고 검증](sdk-immediate-ios-2026-10-15.ko.md)에 별도로 기록했다. 아래 iOS 게시 기록과 구분하며, 세 앱 모두 새 번들 적용 확인 후 보고용 추가 실행 없이 실제 SDK 집계가 완료됐다.

## 변경과 대상

이 기록은 앞선 [SDK 수집 검증](sdk-telemetry-2026-10-15.ko.md) 이후 SDK 보고 지연 보강을 실제 앱 번들에 넣는 후속 검증이다. 기존 격리 체크아웃과 연결된 GitHub 검증 브랜치를 사용한다. 원본 앱 체크아웃과 운영 배포 채널은 변경하지 않는다.

SDK는 네이티브 저장소 제한 시간을 200ms에서 1,000ms로 늘렸다. 이전 배치가 전송되는 중 적용·재시작 이벤트가 추가되면, 전송 완료 후 직렬화된 큐를 다시 읽어 동일 flush의 남은 배치로 전송한다. 최대 4개 배치, 요청별 16개 이벤트, 실패 backoff와 타이머 없는 동작은 유지한다.

세 앱 모두 공개 앱 버전, SDK 네이티브 버전, 네이티브 입력 20개, Runtime, 서명 키와 자동화 정책을 보존했다. 기존 SDK 아카이브에 JavaScript 파일을 덧씌우고 잠금 파일의 SHA-512만 갱신했다. 세 아카이브의 실제 `dist/telemetry.js` SHA-256은 `9ca5e76b32b24b89638a6efc5ca96535aa082422dbb739cce8ef09b8e707325a`다.

| 앱 | 커밋 | GitHub 브랜치 | 실행 표시 |
| --- | --- | --- | --- |
| Isso | `203a338acd86ec1131714dace3331fcb032cfd44` | `codex/flora-ota-integration` | `V9-SDK-Telemetry` |
| Promise | `01d8e8ff2aa3c6856dbe95fe1fc6db09ba7b1800` | `codex/flora-ota-integration` | `V9-SDK-Telemetry` |
| Reward | `f840fb5df75a3bca03d82ab5ad5c296ad5ad5021` | `codex/flora-reward-integration` | `Reward-Flora-V6-SDK-Telemetry` |

PC Runner의 기존 iOS+Android 정책으로 커밋당 두 작업이 생성된다. EAS·Actions 실행이나 Runner 설정 변경은 없다. 아카이브와 잠금 파일의 일치 여부를 Runner가 검증하고, 해당 커밋의 vendored SDK를 frozen install한다.

첫 Isso iOS 자동 작업 `automation_789fb8db-0425-4478-8541-09954d2084e2`는 heartbeat의 `RUNNER_TRANSPORT_UNAVAILABLE`로 취소됐다. 설치된 controller에 원래 lease 만료 안에서 최대 두 번 재시도하는 구현이 이미 들어 있고 checksum도 유효함을 확인했다. 세 복구 journal이 비어 있고 해당 작업에 게시 결과가 없음을 서버에서 확인한 뒤 서비스를 재개했다. 취소 이력은 유지하며 같은 커밋의 iOS 재시도 작업 `automation_921c1ec8-4e91-40f8-8baf-daa65455f214`를 추가했다. 새 SDK 오류나 성공한 자동 배포로 표현하지 않는다.

Promise Android 첫 작업 `automation_07956430-f9a7-4799-9bed-8c0022a3eaeb`는 `EXPORT_FAILED`로 게시 전 종료됐다. 정제된 supervisor 로그에는 하위 단계의 상세 원인이 남지 않았으므로 원인을 추정하거나 수정됐다고 주장하지 않는다. 동일 커밋 iOS export 성공을 확인하고, 실패 이력을 보존한 채 Android 재시도 `automation_ae493331-4388-4209-84f5-4932299becea`를 추가했다. 다른 앱 게시 중 받은 명시적 `409 BUSY` 이후 같은 request key로 한 번 재요청했다.

## 보존과 용량

이번 배포 전 canonical payload는 241,456,548 bytes였으며, 새 여섯 번들로 기존 256MiB 내부 상한을 넘을 것으로 확인했다. [0009 마이그레이션 검증](workspace-capacity-320.ko.md)에 따라 내부 상한만 320MiB로 늘렸다. Cloudflare의 [무료 DB당 500MB 제한](https://developers.cloudflare.com/d1/platform/limits/) 내에서 동작하며 요금제를 변경하지 않는다. 앱별 96MiB·128개 자산, 자산당 16MiB 제한을 유지한다.

실제 적용 전후 기존 용량 원장 19행이 완전히 같고 176개 트리거가 유지됐다. 변경한 스키마 객체는 CHECK 2개와 admission trigger 18개뿐이다. 모든 기존 원본·자산·이력·회계 사실 행은 그대로다. `d1-{capacity-before,capacity-after,migration-comparison}.json`에 비교 근거가 있다. 키는 별도 DO에 있으므로 API의 기존 키 메타데이터/이력을 추가 비교한다.

## 관찰 방식

범위는 기존 `Flora_RealApps_Android_OTA_QA_API36` 에뮬레이터의 실제 설치 앱 세 개다. 물리 기기 검증으로 표현하지 않는다. `scripts/observe-sdk-immediate-android.mjs`는 ADB 읽기와 소유자 `/api/projects` 읽기만 수행한다. SDK 이벤트를 대신 보내거나 앱을 실행·재시작하지 않는다.

아직 적용되지 않은 새 배포와 서버 적용/재시작 0을 기준선으로 잡는다. 정상 OTA 흐름을 별도로 실행한 뒤 새 표시, 배포 ID, 네이티브 committed 상태를 확인한다. 이후 새 JS 실행이 한 번만 관찰되고 프로세스가 바뀌지 않는 동안 서버의 다운로드·적용·재시작 각각 1과 비워진 실제 SDK 대기열을 확인한다. 관리자 요약 캐시 때문에 읽기 관찰은 최대 15초 간격이며, 적용 확인 후 최대 2분을 허용한다. 기록된 시간은 실제 전송 지연의 상한인 관찰 지연이다.

기존 APK 해시·앱 데이터 보존 표식, 서명된 매니페스트와 전체 자산 해시는 별도 검증기로 확인한다. 새 번들 적용 후 결과를 보내기 위해 앱을 다시 여는 조작을 하지 않는다. 기존 실패/복구 이력도 삭제하지 않는다.

## 검사 결과

- SDK 전체 및 실제 Worker HTTP 통합 59/59 통과.
- Isso 시작/저장소 15/15, Promise 12/12, Reward 시작/활성화 18/18 및 저장소 3/3 통과.
- 실제 workerd 용량 마이그레이션 3/3, TypeScript 검사 통과. 이력 두 배 증가 후 insert 조회량은 54→54행이다.
- 실제 APK·보존 데이터·서명·전체 다운로드 파일 해시 검증 완료. 물리 기기 검증은 수행하지 않았다.

Isso Android 자동 배포 `b0434fab-f519-4a82-b2e0-f0a03f2efffc`는 같은 OS 프로세스(PID 12930)에서 기존 번들→V9 새 번들의 OTA JavaScript 재시작으로 적용됐다. 새 번들 실행은 한 번이며 이후 앱 실행 조작이 없었다. 네이티브 실행 확인 관찰 뒤 390ms에 서버의 다운로드·적용·재시작 각각 1, 적용률 100%와 실제 대기열 0을 확인했다. 이 시간은 관찰 시각 차이이며 네트워크 전송 시간의 정밀 측정값은 아니다. APK·보존 표식이 그대로이고 RSA 서명과 40개 다운로드 파일 해시가 유효하다. `isso-immediate-report.json` 및 `isso-native-inspect.json`이 근거다.

Reward Android 자동 배포 `c12c10b0-35db-428b-aa74-dafc17f9a81c`는 기존 시작 제한 8초가 닫힌 뒤 완료된 다운로드를 캐시에 유지했다. 다음 정상 시작에서 캐시를 활성화해 V6 새 번들을 실행했다. **새 번들이 확인된 뒤 보고를 위해 다시 실행한 적은 없다.** V6의 첫 실행 확인 관찰 뒤 464ms에 서버의 다운로드·적용·재시작 각각 1, 적용률 100%와 실제 대기열 0을 확인했다. 새 번들 실행 한 번과 PID 15266 유지를 관찰했고 APK·보존 표식 및 서명·57개 파일 해시가 유효하다. `reward-activation-starts.json`으로 다운로드 준비를 위한 시작과 새 번들 활성화를 구분한다.

Promise Android 재시도 배포 `03199489-73cd-4f3e-872b-b1bcdd145ef1`도 같은 OS 프로세스(PID 12673)의 V9 OTA JavaScript 재시작으로 적용됐다. 첫 새 번들 실행 확인 관찰 뒤 550ms에 다운로드·적용·재시작 각각 1, 적용률 100%, 대기열 0을 확인했다. 새 번들 실행 한 번이며 이후 추가 실행이 없고 APK·보존 표식·서명·51개 파일 해시가 유효하다.

### 최종 게시와 적용 결과

| 앱 | PC Runner iOS 게시 ID | PC Runner Android 게시 ID | Android 다운로드 / 적용 / 재시작 | 적용 확인 뒤 추가 실행 |
| --- | --- | --- | --- | --- |
| Isso | `6febb52a-23c5-4844-a1ab-74f571ba65e4` | `b0434fab-f519-4a82-b2e0-f0a03f2efffc` | 1 / 1 / 1 | 0 |
| Promise | `c4b24cc3-fae5-4858-b215-c539021c057a` | `03199489-73cd-4f3e-872b-b1bcdd145ef1` | 1 / 1 / 1 | 0 |
| Reward | `40763fcf-f8ee-4aad-ab0e-ae420ef56f3a` | `c12c10b0-35db-428b-aa74-dafc17f9a81c` | 1 / 1 / 1 | 0 |

첫 GitHub push가 자동 생성한 6개 작업 중 Isso iOS는 취소, Promise Android는 export 실패 후 같은 커밋의 별도 재시도 작업으로 게시됐다. 최종 게시 6건과 취소·실패 2건을 모두 보존한다. 이 표의 iOS 열은 게시 증거이며 이번 후속 요청에서 iOS 기기 적용을 새로 검증했다는 뜻은 아니다. Android 재시작은 네이티브 ReactHost의 OTA JavaScript 런타임 재시작이며 OS 프로세스 재시작과 구분한다.

최종 API 비교에서 기존 배포 36건, 기존 자산·작업 이력·GitHub 연결·자동화 정책·키와 교체/접근 이력이 보존됐다. 새 게시만 추가돼 Isso 13→15, Promise 13→15, Reward 10→12다. 최신 작업 20건 밖으로 밀린 Isso 과거 작업 3건도 개별 상세 API로 동일함을 확인했다. 세 Runner 연결 파일의 SHA-256도 이전과 같다. D1의 원본·앱·앱 설정·GitHub 연결·Runner·정책 원장은 변하지 않았다.

최종 canonical payload는 276,485,267 / 335,544,320 bytes, 물리 DB 크기는 282,877,952 bytes다. 기존 자산을 삭제하지 않았고 요금제·EAS·Actions 설정을 바꾸지 않았다. 해당 세 커밋의 Actions 실행 수는 각각 0이다. SDK 보고 경로와 관리자 캐시 정책도 그대로다.

마지막 소유자 API 확인에서 세 Android 최신 배포의 SDK 다운로드·적용·재시작이 각각 1, 적용률 100%, Runner가 모두 온라인이었다. 2026-10-15 05:12 UTC 캐시된 계정 전체 D1 지표는 읽기 905,005 / 5,000,000, 쓰기 33,191 / 100,000이다. 계정 전체 수치이며 Flora 단독 청구량이 아니다. Isso의 배포된 프로젝트 카드에서도 새 Android 집계를 확인해 `isso-sdk-immediate-projects.png`에 저장했다. 세 앱의 최종 화면을 다시 확인할 때는 브라우저 세션이 만료돼 로그인 안내가 표시됐다. 따라서 전체 화면의 최종 시각 검증을 했다고 주장하지 않고, `final-summary.json`의 실제 앱 관찰 및 인증된 API 결과를 최종 근거로 사용한다.

검증 자료는 `dist/sdk-report-drain-2026-10-15/evidence/`에 저장한다. 소유자 세션, 익명 설치 식별자와 SDK 보고 티켓은 결과 파일에 저장하지 않는다.
