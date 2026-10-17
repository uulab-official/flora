# 보강 SDK의 iOS 첫 적용 실행 내 보고 검증

2026-10-15, 기존 `Flora Native OTA QA` iOS 26.5 시뮬레이터에 설치된 Isso·Promise·Reward Release 앱으로 확인했다. 물리 iPhone 검증은 아니다. [앞선 PC Runner 게시 및 Android 검증](sdk-immediate-report-2026-10-15.ko.md)의 iOS 번들을 그대로 사용했다. 새 커밋·export·배포·EAS·Actions 실행, 바이너리 빌드·재설치·데이터 초기화·마이그레이션은 수행하지 않았다.

## 실제 결과

| 앱 | PC Runner 게시 iOS 배포 | 다운로드 / 적용 / 재시작 | 적용 확인 후 보고용 추가 실행 | SDK 대기열 | 확인→서버 관찰 |
| --- | --- | --- | --- | --- | --- |
| Isso | `6febb52a-23c5-4844-a1ab-74f571ba65e4` | 1 / 1 / 1 | 0 | 0 | 478ms |
| Promise | `c4b24cc3-fae5-4858-b215-c539021c057a` | 1 / 1 / 1 | 0 | 0 | 557ms |
| Reward | `40763fcf-f8ee-4aad-ab0e-ae420ef56f3a` | 1 / 1 / 1 | 0 | 0 | 505ms |

세 앱의 최신 iOS 배포 모두 `source: sdk-self-report`, 보고 설치 1, 누적 적용률 100%, 실패·롤백 0이다. 여기서 100%는 이번 배포를 보고한 QA 설치 1개 기준이며 전체 사용자 적용률을 의미하지 않는다. 관찰 시간은 네이티브 확인을 감지한 뒤 서버 요약을 읽을 때까지의 시각 차이이며 정밀 네트워크 전송 지연 측정값은 아니다.

Isso·Promise는 기존 QA 화면의 `Flora OTA 적용`을 한 번 눌렀다. 기존 V8에서 V9 보강 번들로 OTA JavaScript 런타임이 재시작됐다. 각각 PID 70285·63855를 유지했고 새 JS 평가가 한 번 추가된 뒤 다운로드·적용·재시작 보고가 도착했다. 그 뒤 앱을 다시 실행하지 않았다.

Reward는 기존 8초 시작 제한을 그대로 유지했다. 준비 시작(PID 77236)에서 다운로드가 제한 이후 완료돼 캐시와 `pendingId`에 남았으며, 제품 화면을 강제 재시작하지 않았다. 다음 정상 시작(PID 86415)에서 캐시를 활성화해 V6 보강 번들이 실행됐다. **V6 첫 실행 확인 후 보고를 보내기 위한 추가 실행은 0회다.** 전체 네이티브 JS 평가 3회는 준비 시작의 이전 번들 1회, 캐시 활성화 시작의 이전 번들 1회와 새 번들 1회다. 최초 다운로드부터 단 한 번만 실행했다고 표현하지 않는다.

최종 읽기에서도 위 세 PID·확인된 배포와 빈 대기열이 유지됐다. iOS 재시작은 OTA JavaScript 런타임 재시작이며 OS 프로세스 교체와 구분한다.

## 관찰과 독립 검증

`scripts/observe-sdk-immediate-ios.mjs`는 기존 설치 앱의 네이티브 상태·XcodeBuildMCP 런타임 로그·실제 SDK 영속 대기열을 읽고, 소유자 `/api/projects`로 서버 요약을 확인한다. 앱 실행·중지·reload·설치나 SDK 보고 POST를 수행하지 않는다. 세 앱 모두 적용 전 서버 적용/재시작이 없는 기준선에서 시작했다.

Release 앱의 `console.info`는 캡처되지 않아 `FLORA_LAUNCH` 로그 개수를 꾸며내지 않았다. 대신 네이티브 `ReactInstance: evaluateJavaScript() with JS bundle` 로그로 JS 평가를 세고, 실제 UI와 `activeId`·`launchedId`·`launchPending=false`, 별도 다운로드 번들 표시·서명·파일 해시를 대조했다. Isso·Promise의 화면에는 V9와 정확한 배포 ID가 표시된다. Reward는 제품 화면 진입과 네이티브 확인, V6 표시가 포함된 서명 검증 번들로 확인했다. 번들에 표시 문자열이 있다는 사실만으로 실행 성공을 판정하지 않는다.

`scripts/verify-sdk-telemetry-ios.mjs`의 읽기 전용 `inspect` 모드로 기존 설치 경로·데이터 컨테이너·네이티브 실행 파일·embedded bundle·데이터 보존 표식의 SHA-256이 이전 기준선과 같음을 확인했다. Isso 36개, Promise 47개, Reward 53개 다운로드 파일의 해시와 고정 인증서에 대한 RSA 서명이 모두 유효하다. 네이티브 pending/blocked는 없다.

실제 SDK 보고가 집계된 **뒤에** 증거 digest를 `ios-simulator` 운영자 검증 이력으로 각각 추가했다. 운영자 검증은 `source: operator-verification`이며 SDK 설치·적용 집계를 대신 만들지 않는다. SDK가 자체 보고한 환경은 Isso `iosSimulator=1`, Promise·Reward `unknown=1`이다. 독립 운영자 증거가 시뮬레이터임을 확인해도 SDK의 unknown을 물리 기기로 바꾸지 않는다.

## 기존 상태 보존과 조회량

검증 전후 세 앱의 프로젝트 설정·GitHub 연결·탐지 결과·자산·배포 원본·기존 작업·자동화 정책·키 메타데이터와 접근/교체 이력을 비교해 모두 동일함을 확인했다. 배포 수는 Isso 15, Promise 15, Reward 12로 유지됐다. 기존 Android 요약도 배포 ID·SDK 집계·운영자 증거까지 완전히 동일하다. 세 Runner는 온라인이다. 변경은 실제 iOS SDK 결과와 추가 운영자 검증 이력뿐이다.

관찰용 서버 읽기는 앱별 시작 기준선 1회와 네이티브 확인 뒤 1회로 끝났다. 지연 시에도 15초 간격·확인 뒤 최대 2분·전체 최대 5분으로 제한한다. 서버의 기존 SDK 보고 경로(D1 쓰기 없음), 요약 캐시와 Runner 사용량 수집 정책을 바꾸지 않았다. 계정 전체의 캐시된 05:42 UTC D1 사용량은 읽기 938,954 / 5,000,000, 쓰기 34,842 / 100,000이다. Flora 단독 사용량이나 이번 검증의 순증가량으로 표현하지 않는다. 요금제와 한도 설정을 변경하지 않았다.

인증된 운영 `/api/projects`에서 앱별 iOS·Android 각각 다운로드/적용/재시작 1을 최종 확인했다. 관리자 브라우저는 `/login?returnTo=%2Fprojects`로 이동하므로 이번 최종 관리자 카드 화면을 시각 검증했다고 주장하지 않는다. 로그인 후 [프로젝트 목록](https://flora.uulab.co.kr/projects)의 각 앱 iOS 카드에 같은 SDK 집계가 제공된다.

## 증거

`dist/sdk-immediate-ios-2026-10-15/evidence/`에 다음을 저장했다. 세션 쿠키·CSRF·익명 설치 ID·SDK 티켓 원문은 저장하지 않았다.

- `live-before.json`, `live-after.json`, `native-before.json`
- 앱별 `*-immediate-report.json`, `*-native-inspect.json`, `*-combined-proof.json`, `*-operator-proof.json`, `*-ios.jpg`
- `reward-preparation-launch.json`, `reward-prepared-cache.json`, `reward-activation-launch.json`
- `final-native-and-evaluations.json`, `preservation-summary.json`, `app-isolation.json`, `final-summary.json`

새 관찰 스크립트의 구문 검사, 세 앱 실제 OTA 관찰·네이티브 서명/전체 자산 검증·인증된 서버 읽기·기존 상태 비교를 수행했다. SDK/앱 구현은 이번에 변경하지 않았으며 앞선 테스트 통과 수를 이번 재실행 결과로 표시하지 않는다.
