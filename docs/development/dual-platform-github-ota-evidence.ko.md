# Isso·Promise PC Runner 자동 iOS·Android OTA 검증

2026-10-13 UTC 최종 검증: GitHub Actions와 EAS 없이 두 앱의 실제 push에서 네 플랫폼 작업이 모두 자동 게시됐다. 아래 최초 Actions 구현 기록은 과거 경로이며 현재 자동 실행 구성은 PC Runner다.

## 현재 PC Runner의 실제 결과

상주 LaunchAgent를 제어된 방식으로 재시작한 뒤 아래 커밋을 push했다. 별도의 수동 게시나 CLI 호출 없이 supervisor가 의존성 준비·network=none Docker export·에셋 업로드·게시를 처리했다.

| 앱 | 실제 소스 SHA | iOS 배포 | Android 배포 |
| --- | --- | --- | --- |
| Isso | `d9a1389de8244b9de6b19ff5a91200c8635a541f` | `1fd1a305-3588-40ab-b0e4-2f964924a525` | `60bd320c-a474-4c38-afd9-3a1c9bd5353d` |
| Promise | `56fb88d37994e148fc64f8f573a2df1ddd4f147f` | `ea42d794-6e7c-4070-9591-293d4bd33321` | `d7b37b40-423a-42bf-a632-eff01fa42901` |

네 작업 모두 succeeded, attemptCount=1이다. receipt의 앱·플랫폼·소스 SHA·배포 관계를 확인했다. 검증 커밋은 PC Runner 문서만 추가했으며 `V6-PC` JS·SDK·lockfile·공개 연결·runtime·native 설정은 유지했다. QA 브랜치 `codex/flora-ota-integration`, 채널 `flora-verification`만 대상으로 했으며 원본 앱 체크아웃은 변경하지 않았다.

공개 HTTPS의 네 최신 manifest에서 HTTP 200·배포 ID·앱 ID·RSA 서명을 확인했다. Android launch asset은 자기 앱에서 HTTP 200 및 SHA-256 일치, 다른 앱에서는 양방향 HTTP 404였다. 잘못된 runtime/channel은 두 앱 모두 HTTP 204였다.

변경 전 배포 3개씩, Isso 작업 6개와 Promise 2개, 기존 asset·detection·GitHub 연결 v2를 전체 객체로 비교해 동일함을 확인했다. D1 설정 4행과 이전 정책 6행도 원문 그대로다. 최종 배포는 앱별 7개이며 중간 성공·실패·취소 기록도 보존했다. 정책 v4는 계속 iOS+Android, enabled=true이고 updatedAt은 Isso `1791870784590`, Promise `1791870789717`로 유지했다. 정책을 다시 저장하거나 플랫폼을 전환하지 않았다.

CI binding v10은 두 앱 모두 enabled=false다. QA 소스에서 Actions workflow를 제거했다. 마지막 Actions 실행은 이전 취소 실행 38357243176 / 38357245436이며 이번 소스의 Actions 실행은 없다. Actions 비용·EAS 사용량 없는 경로지만 PC 전력·네트워크·기존 호스팅 사용량은 남는다. 유료 Cloudflare 리소스나 사용 한도를 확대하지 않았으며 계정 청구 플랜 자체는 확정하지 않았다.

증거: `dist/real-apps-2026-10-13/evidence/pc-final-{isso,promise}-{operations,automation,automation-ci}.json`, `pc-final-settings-policies.json`, `pc-final-preservation.json`, `pc-final-delivery.json`. 비밀번호·세션 cookie·Runner token은 포함하지 않는다.

## PC 시작·운영과 검증 한계

12:56 UTC Reward의 별도 진단용 캐시 복제 중 호스트 디스크가 부족해 전용 VM에서 `read-only file system` 오류가 발생했다. 배포 작업과 두 앱 복구 journal이 모두 0개인 것을 확인하고 서비스를 중지했다. 완료된 QA 빌드의 재생성 가능한 intermediates와 해당 진단의 임시 복제만 정리했으며 APK·소스·운영 데이터·기존 증거는 보존했다. 12:57 UTC 기존 VM을 정상 stop/start하여 Docker 29.9.0 응답과 VM 파일 쓰기 성공을 확인하고 기존 두 앱 서비스를 다시 시작했다. 이 사건은 원인이 확인되지 않은 앞선 09:15 UTC 중단과 구분한다.

후속 운영 관측: 09:15 UTC 서비스가 RUNNER_TRANSPORT_UNAVAILABLE / ISOLATION_UNAVAILABLE를 기록하고 fatal-stop으로 중단됐다. 원인은 확정하지 않았다. 호스트 시계가 09시대에서 12시대로 진행한 관측과 겹치므로 Reward 설치 제한 시간 실패를 전부 pnpm 성능 문제로 단정하지 않는다. 12시대에 Lima/Docker 정상 응답, 두 앱의 미완료 작업 0개와 복구 journal 0개를 확인한 후 서비스를 시작했고 접속 갱신을 다시 확인했다. `pc-recovery-*-automation.json`과 `pc-restored-*-automation.json`에 관측을 저장한다. 이전 네 건 게시 증거와 정책 v4는 보존했다.

설치된 사용자 LaunchAgent `kr.co.uulab.flora-runner`는 RunAtLoad=true, KeepAlive=false다. 재부팅 후 사용자 로그인 때 시작한다. PC 전원 재부팅은 실행하지 않았으며 서비스 재시작과 그 뒤 실제 자동 게시를 검증했다. PC가 잠들거나 꺼지면 처리가 멈춘다. [설치·운영 문서](local-pc-runner.ko.md).

Task-local Lima 2.2.1 / Docker 29.9.0 / Node 24.19.0 / npm 10.9.8을 사용한다. compiler 이미지 `sha256:92817a4c042105fbf28aecf0be0a550b7f441e5a91ba2e5d7e58886a9c46e70f`를 고정했다. 온라인 의존성 준비는 검증한 manifest·lock·vendor만 입력하며 lifecycle scripts를 실행하지 않는다. 앱 export는 network=none·비루트·read-only root·cap-drop이다. VM은 private scratch만 마운트하고 앱별 token과 복구 journal은 밖에 둔다. OTA/GitHub App 개인키는 서버에 보관한다.

앱별 Runner presence와 작업 이벤트를 hosted Flora에서 조회한다. presence는 배포 성공 증거와 구분한다. 서비스 로그는 고정 단계·상태·ID만 보관한다.

최초 PC 실행에서는 Isso iOS 수동 bootstrap·Android 자동 게시, Promise iOS 자동 게시가 성공했다. 07:52 UTC supervisor의 예기치 않은 종료로 Promise Android는 취소 이력으로 남았다. 정확한 종료 원인은 확정하지 못했다. 별도 Reward 빌드의 디스크 부족을 supervisor의 확정 원인으로 단정하지 않는다. durable fatal-stop을 로그보다 먼저 저장하고 uncaughtException/unhandledRejection·child stream 오류의 안전한 중단·진단 검증을 추가했다. 이후 새 커밋 네 건이 자동 게시됐다.

이번 V6-PC의 새로운 기기 다운로드·적용·재시작은 미검증이다. 전용 ADB가 제한 시간 안에 응답하지 않아 버튼 조작이나 데이터 삭제를 하지 않았다. 후속 Reward 격리 export 중 호스트 swap 사용량 약 32 GiB를 확인하고, 사용하지 않는 전용 QA emulator PID와 AVD 이름·포트 5560을 다시 확인해 해당 프로세스만 정상 SIGTERM 종료했다. AVD·앱 데이터 파일은 삭제하지 않았다. 이전 실제 앱 적용 증거는 [Android 기록](android-github-ota-evidence.ko.md)과 [iOS 기록](real-apps-ota-evidence.ko.md)에 별도로 남아 있다. main·스토어·물리 기기는 변경하지 않았다.

Reward는 별도 등록·SDK 연결·533개 테스트·두 플랫폼 로컬 export·Android 최초 QA Release APK 검사를 완료했다. `codex/flora-reward-integration`에 `e09ee8e2c7b46696824ab6ce100ebc372ac43ded`를 push했다. GitHub App의 Reward 저장소 권한, 실제 PC 자동 게시와 기기 적용은 아직 완료하지 않았다. 현재 App 설치는 Isso·Promise만 허용하며 계정 전체를 조회하는 사용자 OAuth 연결은 구현되어 있지 않다.

---

## 이전 Actions 구현과 최초 검증 기록

2026-10-13 초기 기록. 현재 Actions는 중단했으며 아래 비용·실행 구성은 당시 방식이다.

목표는 `codex/flora-ota-integration` 브랜치의 push 한 번으로 각 앱의 iOS·Android OTA를 함께 게시하고, 이후에도 정책을 전환하지 않는 것이다. 채널 `flora-verification`, runtime `flora-rn0863-v1`, 기존 Flora SDK 0.3.1과 공개 native 설정을 유지한다. EAS는 사용하지 않는다.

## 구현과 호환성

- 새 정책 `platforms: ["ios", "android"]`를 지원한다. 기존 단일 `platform` 정책은 원문을 다시 쓰지 않고 계속 읽고 처리한다. 새 D1/SQLite 마이그레이션은 없다.
- 앱/커밋별로 감지는 한 번, 플랫폼별 큐·lease·receipt·배포는 독립적이다. 웹훅 재전송은 플랫폼별 고정 requestKey로 중복을 막고, 이전 단일 플랫폼 requestKey도 재사용한다.
- 최신 정책 version·platform membership·연결을 저장소 CAS에서 검증한다. 한 플랫폼 export 실패가 성공한 다른 플랫폼의 배포·이력을 제거하지 않는다.
- 서버가 CI 세션에 허용 플랫폼을 저장한다. Runner는 앱·소스 SHA·플랫폼으로 제한된 작업을 요청하고 실제 응답 플랫폼을 확인한다. 모든 선택 플랫폼이 게시돼야 GitHub 실행이 성공한다.
- 두 플랫폼은 같은 GitHub Ubuntu Runner에서 순서대로 처리하고 Docker 도구 준비는 한 번이다. 플랫폼별 작업·복구 디렉터리는 분리한다. 단일 플랫폼 CI 토큰 30분, 두 플랫폼 최대 60분, workflow 최대 60분으로 제한한다. 실제 실행 시간만 사용량에 반영하며 지출 한도는 0으로 유지한다.
- 동시 앱 업로드의 `409 BUSY`만 최대 두 번 재시도한다. 전체 HTTP 제한 시간과 원본 본문·lease 헤더를 유지하고, 인증·fence·config 오류는 재시도하지 않는다.
- 로컬/호스팅 관리 UI 모두 자동 정책에 `iOS + Android`를 제공한다. 수동 작업의 단일 플랫폼 선택과 구분하고, 앱 전환·늦은 응답을 차단한다.

## 검증 소스와 고정 Runner

| 앱 | 소스 SHA | GitHub 실행 |
| --- | --- | --- |
| Isso | `9b20fb5ca8c3cc50c6dff7b6b516027a881d661a` | [38354285217](https://github.com/uulab-official/isso/actions/runs/38354285217) |
| Promise | `1c3c33a10cea704f6c2433f4720e4f59fc5a0d06` | [38354284069](https://github.com/uulab-official/promise/actions/runs/38354284069) |

앱 변경은 workflow pin과 QA JS marker `V5-Dual`뿐이다. SDK archive / dependency / lockfile / 앱 버전 / 공개 연결 / runtime / native 설정은 Android V3 및 기존 iOS QA 설치 기준과 동일하다. 두 앱 startup 테스트 21개와 타입 검사를 통과한 깨끗한 별도 worktree의 커밋을 push했다. 원본 앱 checkouts와 운영 기기는 변경하지 않는다.

Trusted artifact `51a777e855967a776e9e761cfd4d3a6f6d75773a`, reusable workflow `32fdba841d0c613754138521a8bad13f88c80f5a`를 고정하고 49개 배포 파일 SHA-256을 확인한다. 각 앱의 CI binding v8이 exact workflow/ref/repository/app을 제한한다. 장기 토큰·OTA 개인키·GitHub App 개인키·EAS 자격정보는 앱 저장소에 추가하지 않는다.

## 완료 전후 데이터 대조

변경 전 각 앱 배포는 3개(iOS 2 + Android 1), 자동 작업은 Isso 6 / Promise 2, 정책은 v1 iOS / v2 Android / v3 iOS였다. 기존 설정 CONFIG v1과 GitHub 연결 v2를 유지하고 새 정책 v4에 두 플랫폼을 저장했다. 검증 후 **v4 두 플랫폼을 유지하며 이전 단일 정책으로 복원하지 않는다**.

서버 정책·설정 원본과 각 앱의 operations / automation / CI JSON은 `dist/real-apps-2026-10-13/evidence/dual-before-*.json`으로 저장했다. 신규 배포 후 기존 레코드 전체, 앱별 SHA·플랫폼·작업·배포 관계, 고유 파일 교차 앱 거절, 잘못된 runtime/channel 거절을 비교한다.

## 무료 범위와 제한

GitHub 조직의 Free plan과 Actions 예산 0 / prevent_further_usage=true를 유지한다. Private 저장소는 호출자 계정의 포함된 사용량으로 실행하며 무료 포함량 소진 후 유료 실행을 켜지 않는다. [GitHub 공식 과금 문서](https://docs.github.com/en/actions/concepts/billing-and-usage).

두 플랫폼을 큐에 넣는 요청은 실측 D1 38개 쿼리, 재전송 8개다. 실제 GitHub 감지의 외부 요청 6개를 포함해 기존 요청 예산 안에서 처리한다. [Cloudflare D1 제한](https://developers.cloudflare.com/d1/platform/limits/). Cloudflare 새 유료 서비스·리소스·마이그레이션은 추가하지 않는다. 계정 요금제 자체를 Free로 확정한 것은 아니다.

## 실제 결과

실제 GitHub 두 실행, 네 개 플랫폼 게시, 서버 보존·분리 검증 후 결과를 기록한다.

### 최초 실제 실행 실패와 복구

최초 Isso [38354285217](https://github.com/uulab-official/isso/actions/runs/38354285217) / Promise [38354284069](https://github.com/uulab-official/promise/actions/runs/38354284069)는 Docker 도구 준비 뒤, 복구 디렉터리 초기화에서 중단됐다. 플랫폼별 nested 경로의 상위 폴더가 없었고 엔진의 의도된 nonrecursive / owner-only 검증에 걸렸다. claim / export / OTA 게시 전에 실패한 것이며 새 배포는 없었다.

엔진 보안 검증을 변경하지 않고 bootstrap을 privateRoot 바로 아래의 recovery-ios / recovery-android / work-ios / work-android로 수정했다. 기존 ENOENT를 재현한 RED와 실제 파일 권한·CLI 초기화를 포함한 bootstrap 12/12 GREEN, 49개 배포 해시 검증을 통과했다. 첫 4개 작업은 attemptCount=0 / lease=null을 확인하고 cancelled 이력으로 남겼다. 정책 v4는 그대로 유지했다. 새 workflow pin으로 새 커밋을 push해 재검증한다.
