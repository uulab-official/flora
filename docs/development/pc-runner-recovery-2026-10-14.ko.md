# PC Runner 복구와 실제 GitHub 자동 OTA 검증

## 종료 원인과 설치

2026-10-14 19:04 KST의 기존 로그는 Promise의 `ISOLATION_UNAVAILABLE` 이후 supervisor가 수동 복구 중단 표식을 남겼음을 보여준다. 당시 Docker 조회가 실패한 구체적인 이유나 디스크와의 인과관계는 기록만으로 확정할 수 없다. 복구 시점에는 디스크 공간도 부족했다. 이 채팅에서 생성한 재생성 가능한 Android 컴파일 중간 디렉터리 네 개만 정리했고, APK·IPA 네 개의 SHA-256과 소스·키·앱 데이터·복구 기록을 보존했다.

Docker 정적 격리 설정 오류와 작업 수신 전 일시적인 daemon 연결 오류를 분리했다. 정확한 `runner-initialization/DOCKER_DAEMON_UNAVAILABLE`에만 앱별 재시도를 적용한다. 작업 수신 후 격리 실패, 인증 거절, 설정 충돌, 게시 결과 불명, 복구 저널 오류는 계속 중단한다. Presence의 일시적인 전송 실패는 다음 주기에 다시 확인하며 성공한 응답을 만들어내지 않는다.

설치한 controller는 `~/.flora/pc-runner-uulab/controller-recovery-20261014/ci/flora-runner`이다. 배포 패키지의 56개 checksum을 검증했다. 이전 controller·service 설정·스크립트·LaunchAgent는 private 백업에 남겨 두었다. 앱별 토큰 JSON 세 개의 바이트와 권한 0600을 유지했다. 서비스 JSON의 controller 경로를 갱신했고, 일일 조회 한도 확인 후 polling 간격을 10초에서 30초로 늘려 유휴 조회 요청을 줄였다. 앱별 배포 정책과 토큰은 바꾸지 않았다.

LaunchAgent는 `RunAtLoad=true`, `KeepAlive={SuccessfulExit:false}`로 설치했다. 재부팅 후 **사용자 로그인 시** 시작한다. 수동 복구 표식이 있으면 다음 실행은 정상 종료하여 재시작 반복을 막는다. 다음 실제 실행 검증을 완료했다.

- 큐가 비어 있을 때 supervisor에 SIGKILL을 보냈고 launchd가 다른 PID로 복구했다.
- 자체 Lima VM을 정상 종료한 뒤 LaunchAgent의 `bootstrap`만 실행했다. RunAtLoad가 VM과 Runner를 시작했고 세 앱의 실제 presence가 갱신됐다.
- 실제 PC 전원 재부팅은 수행하지 않았다. PC가 꺼져 있거나 잠들어 있으면 작업은 큐에서 대기한다.

## GitHub 자동 배포

기존 검증 ref에 다음 실제 커밋을 fast-forward push했다. 업무 브랜치와 원본 작업 트리는 보존했다. 앱 설정·네이티브 코드·런타임·키·자동 배포 정책을 변경하지 않고 JS 검증 표식 한 줄만 바꿨다. 수동 큐 등록이나 수동 OTA 게시 API를 호출하지 않았다.

| 앱 | 저장소 / ref | 실제 커밋 | iOS 배포 | Android 배포 |
| --- | --- | --- | --- | --- |
| Isso | uulab-official/isso / codex/flora-ota-integration | c421b838c723831a42dbc1995fad05ccf6f9eafc | 81901f3e-9ddd-418a-bd92-16424ee68255 | 1997cea1-bde3-4ba2-a623-fad5755097b3 |
| Promise | uulab-official/promise / codex/flora-ota-integration | 7a58a7a0ef33835fc182a0a9235dd19a0c5ffc21 | aa07d6df-5fcd-4aec-82bc-d3b9560aebee | 2fd1a4ae-2110-4c28-9b9f-c13a9320ee16 |
| Reward | uulab-official/reward / codex/flora-reward-integration | 8666f91c88e74b361ea5ba546e9533dc40478608 | 7e83448c-5391-4a65-87c9-05b9817e103e | 일일 조회 한도 초기화 대기 |

GitHub webhook이 각 앱에 iOS·Android 작업을 두 개씩 생성했다. 기존 채널은 `flora-verification`, Isso·Promise 런타임은 `flora-rn0863-v1`, Reward는 `flora-reward-rn0863-v1`이며 Reward의 앱 루트는 `apps/app`이다. 자동 배포 정책 버전은 각각 4·4·1로 유지한다.

각 커밋의 GitHub Actions 실행은 조회 시점에 0건이다. 저장소 전체 Actions 기능이 비활성화됐다는 뜻은 아니다. 이 검증 ref에 push로 실행되는 workflow가 없고 PC Runner 경로만 사용했다. EAS 빌드·업데이트·워크플로는 호출하지 않았다.

## 저장 한도와 보존

새 Hermes bundle 여섯 개는 base64로 저장되므로 기존 192 MiB 내부 한도에 모두 들어가지 않는다. 진행 중 iOS 작업의 게시와 정리가 끝난 직후 Runner를 잠시 정지하고, 현재 Time Travel bookmark와 20개 테이블 집계·스키마를 확보했다. 신규 `0006_workspace_capacity_256mib.sql` 전체를 관리자 Query API의 단일 요청으로 적용했다. 83개 SQL이 모두 성공했다.

적용 직전과 직후 counter는 **188,320,501 bytes**로 같았으며, 20개 테이블의 행 수와 stored-byte 합계도 같았다. 159개 스키마 정의의 정규화 hash를 비교하여 상한 숫자 외 정의가 동일함을 확인했다. 39개 의존 trigger와 18개 workspace 용량 검사를 복원했고 FK 오류는 없었다. 기존 `0005`는 바이트까지 보존했다. 앱별 64 MiB·128개, 단일 자산 16 MiB 제한은 유지한다.

256 MiB는 Flora 자체 payload 상한이다. [D1 Free의 DB당 500 MB와 계정 전체 5 GB 제한](https://developers.cloudflare.com/d1/platform/limits/)은 별도이며 실제 SQLite 파일 크기와 일일 사용량도 함께 확인해야 한다. 새 DB·R2·유료 업그레이드·외부 빌드 서버를 추가하지 않았다. PC 전력과 네트워크는 사용한다.

기존 OTA 배포는 Isso 7·Promise 7·Reward 4건, GitHub detection 14·10·3건과 기존 자산 metadata 54·64·67개를 원본 JSON 기준으로 비교하여 모두 보존했다. 한도 오류 발생 후 관리자 D1 조회에서 기존 배포 18건·detection 27건·자산 185개·자동 배포 작업 32건의 원본 JSON hash도 다시 비교하여 일치했다. 앱별 등록 정보·설정과 기존 인증서·키 12개 및 키 접근·교체 이력도 동일하다. 기존 네이티브 작업 12·10·0건과 이벤트·키 사용 기록도 동일하며 Runner의 마지막 연결 시각만 운영 과정에서 갱신될 수 있다. 기존 APK·IPA 네 개의 hash를 재확인했다.

## 무료 DB 일일 한도로 남은 작업 대기

2026-10-14 UTC 일자의 계정 D1 analytics는 7,464,960 rows read, 5,559 rows written을 기록했다. [D1 Free의 일일 조회 한도는 5,000,000 rows](https://developers.cloudflare.com/workers/platform/pricing/)다. 실제 Worker binding과 관리자 Query API 모두 일일 조회 한도 오류를 반환한 것을 확인했다. 저장 용량 확대와 별개의 한도이며 유료 전환이나 별도 DB로 우회하지 않았다.

Isso·Promise의 iOS·Android 네 건과 Reward iOS 한 건은 게시를 완료했다. 다섯 배포의 서명과 총 227개 자산의 다운로드·SHA-256·커밋 표식이 일치했다. Reward Android 원래 작업 `automation_8dbdcdcb-0a94-47cf-ad8e-5a3a555f330a`는 첫 시도 중 heartbeat와 실패 보고가 503으로 거절되어 중단됐으며, 생성 자산·게시 기록이 없고 세 앱의 복구 저널도 비어 있음을 확인했다. 서버의 첫 lease는 만료됐다. Runner는 작업 수신 전 실패를 제한된 간격으로 재시도하며 기존 작업의 만료 lease 회수와 재시도를 기다린다.

[일일 한도는 00:00 UTC에 초기화](https://developers.cloudflare.com/d1/observability/debug-d1/)되므로 다음 시각은 **2026-10-15 09:00 KST**다. 이 시각 이후 원래 Reward Android 작업을 다시 가져올 수 있도록 서비스는 실행 상태로 유지했다. 재시도 후 게시 성공은 아직 확인되지 않았다. D1이 거절하는 동안 실제 서버 presence는 갱신되지 않으므로 로컬 프로세스 실행과 Flora의 온라인 상태를 구분한다. 화면에는 정확한 한도·초기화 시각을 표시하고 조회 실패를 프로젝트 0개로 표시하지 않는다.

## 검증 범위

Runner 회귀·CLI 통합 검증 **86개**, 실제 local workerd/D1 용량 검증 **10개**, D1 오류 분류 검증 **22개**, 관리 화면 검증 **126개**, 자동 배포 store·HTTP 검증 **27개**가 통과했다. Runner·Cloudflare 빌드와 변경 범위의 엄격한 타입 검사도 통과했다. 앱별 claim 조회가 owner+app 인덱스를 사용하도록 바꾸어 로컬 실제 D1의 조회량은 196행에서 6~7행으로 줄었다. 권한·만료·플랫폼·최신 커밋 검사와 다른 앱의 이력은 동일하며 운영 환경의 변경 후 조회량은 한도 초기화 뒤 확인해야 한다. 전체 workspace 타입 검사는 기존 Cloudflare UI 테스트의 implicit-any·app.js 선언·fake Document/nullability 오류 때문에 실패했으며 전체 통과로 기록하지 않는다.

실제 OTA 전달 검증은 앱의 커밋된 공개 인증서로 manifest의 RSA 서명을 확인하고 모든 자산을 다운로드하여 SHA-256을 비교한다. 다운로드한 Hermes bundle에서 해당 커밋의 JS 표식도 확인한다. 배포·다운로드 검증은 네이티브 기기의 적용·재시작 증거와 구분한다. 이 복구 작업에서 새 커밋의 기기 적용·재시작은 수행하지 않았다.

운영 증거는 `dist/runner-recovery-2026-10-14/`, 실제 push와 원격 SHA·Actions 조회는 `dist/pc-ota-verification-2026-10-14/push-receipt.json`에 있다. 운영자가 사용하는 시작·정지·상태 명령과 치명적 중단 처리 방법은 [PC Runner 운영 안내](local-pc-runner.ko.md)에 있다.
