# Cloudflare Control Plane과 PC 독립 Runner 설계

2026-10-06 · 상태: 제안 설계, 아직 구현되지 않음

## 아키텍처 선택

1. **권장: 중앙 Control Plane + 조직 Runner pool.** 설정/이력/권한은 조직 소유, 무거운 실행은 호환 Runner에 배정한다. 개인 PC 교체와 EAS 비용 의존을 함께 줄이며 Cloudflare에 적합하다.
2. 개인 PC 중심 CLI와 파일 동기화. 초기 구현은 쉽지만 로컬 로그인·Keychain·절대 경로가 숨은 의존성이 되기 쉬워 새 PC 요구를 만족시키기 어렵다.
3. 서비스 자체의 managed build farm. 가용성을 운영자가 책임질 수 있으나 macOS 서버 비용·격리·운영 범위가 크다. 초기 범위에서 제외하고 추후 선택 provider로 둔다.

## 1. 컴퓨터와 작업의 소유권

요청하는 브라우저, 소스가 저장된 Git repository, 관리하는 Control Plane, 실행하는 Runner는 서로 다른 주체다.

- 브라우저는 사용자의 조직 권한으로 API에 의도를 제출한다
- Control Plane은 상태·스냅샷·승인·scheduler를 소유한다
- Runner는 조직에 등록된 제한된 실행 주체다. 모든 앱과 secret의 소유자가 아니다
- Provider account는 Integration instance에 귀속되고 정확한 조직/프로젝트/타깃에 매핑된다

기본 Job에는 고정 machine ID를 넣지 않는다. 필요한 OS/architecture/toolchain/capability/trust/environment policy로 eligible pool을 계산한다. 의도적으로 전용 머신을 요구하는 정책만 별도로 pin할 수 있으며 가용성 저하를 표시한다.

## 2. 플랫폼별 실행 매트릭스

| 요청 PC | 작업 | 실제 실행 조건 |
| --- | --- | --- |
| Mac/Windows/Linux | iOS build | 호환 macOS + Xcode Runner |
| Mac/Windows/Linux | Android build | 검증된 Java/SDK/Gradle Runner |
| Mac/Windows/Linux | Web/OTA bundle | 해당 framework/toolchain을 지원하는 Runner |
| 아무 PC의 브라우저 | Store 상태 조회 | 해당 provider API 권한이 있는 Control Plane adapter |
| 아무 PC의 브라우저 | artifact 재배포 | 기존 artifact와 target/승인/버전 정책을 충족하는 실행 경로 |

Mac 한 대만 등록되어 있고 꺼져 있으면 iOS build는 불가능하다. 이를 “대기 중, macOS/Xcode Runner 필요”로 보여준다. 자동으로 돈이 드는 cloud Mac을 구입하거나 provider 권한을 확대하지 않는다.

## 3. 불변 실행 명세

Job 생성 시 다음 입력을 검증·정규화하고 digest를 고정한다.

- organization/project/application/target IDs
- source provider + immutable repository identity + commit SHA + root directory
- action 및 adapter ID/version/protocol version
- config snapshot과 secret/credential version references
- Node/package manager/lockfile/Xcode/Java/SDK 등 toolchain requirements
- native fingerprint/runtime compatibility, artifact requirements
- approval policy, retry policy, requester, correlation ID

환경변수의 현재 값, 이동하는 branch name, 개인 PC의 working tree를 실행 중 다시 읽지 않는다. dirty local checkout은 공식 release 입력이 될 수 없다. 개발용 local-only preview가 있다면 별도 상태로 표시한다.

## 4. 신뢰와 Secret

Runner를 등록할 때 조직 소유자가 신뢰 경계를 이해할 수 있어야 한다. 해당 머신의 administrator와 실행되는 build script는 주입된 secret을 읽을 가능성이 있다. 임시 token과 cleanup만으로 이를 제거하지 못한다.

- untrusted fork/PR에는 production secret이나 signing key를 주지 않는다
- build와 store publish credential을 분리한다. bundle build에 store account credential이 꼭 필요한 것은 아니다
- 전용 production Runner와 최소 권한 scope를 지원한다
- job token은 org/job/attempt/fence/secret version/audience/expiry에 바인딩한다
- 매번 요청 시 Runner revoke와 active lease를 확인한다. 긴 JWT 만료만 기다리지 않는다
- token·key 원문을 queue/audit/config snapshot/에러 메시지에 넣지 않는다
- release approval은 입력 digest에 바인딩한다

Vault MVP는 envelope encryption 설계부터 시작한다. 키 생성/등록/보관/회전/복구 경로가 실제 검증되기 전 “안전하게 secret을 관리한다”라는 출시 표시를 하지 않는다.

## 5. Job, attempt, lease, fence

Cloudflare Queues는 [at-least-once 전달](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)을 제공한다. Queue message를 받은 것과 Job의 실행권을 얻은 것은 다르다.

1. API가 tenant-scoped idempotency key와 요청 digest로 Job을 생성한다. 같은 key·같은 입력은 기존 Job, 같은 key·다른 입력은 conflict다
2. 작업과 outbox event를 함께 저장한다. 큐 전송 실패 시 outbox 재조정으로 복구한다
3. Runner는 API에 outbound claim을 요청한다. coordinator는 DB 원자적 compare-and-swap 또는 하나의 직렬화된 Durable Object로 실행권을 부여한다
4. 매 claim은 증가하는 fencing token 및 새 attempt ID를 받는다. 서버의 시각이 lease 판단의 기준이다
5. heartbeat/log/artifact finalize/complete는 org+job+runner+attempt+fence와 미만료 lease를 확인한다
6. lease expiry 후 안전한 작업만 다음 attempt로 할당한다. 이전 attempt 기록을 덮어쓰지 않는다
7. 오래된 Runner의 heartbeat/complete는 거부한다. 이미 시작한 OS process도 협조적으로 종료를 요청한다

D1에 구현할 때는 read-then-write가 아닌 조건부 UPDATE/RETURNING과 unique 제약을 사용하고, D1 session/read consistency와 실제 race test로 검증한다. 메모리 Map의 단일 프로세스 테스트를 분산 안전성 증거로 사용하지 않는다. KV는 claim의 권위 있는 저장소가 아니다.

### 외부 부수효과

fence는 Flora가 관리하는 상태 쓰기를 막을 수 있지만 이미 외부 Store로 나간 요청을 취소할 수는 없다. 외부 action에는 operation ID, provider request ID, artifact digest, target version, 결과 receipt를 남긴다.

| 작업 유형 | 오류/timeout 후 기본 정책 |
| --- | --- |
| 순수 탐지·검사 | bounded retry + backoff |
| 재현 가능한 build | 새 attempt로 재시도, 기존 실패 이력 유지 |
| artifact 저장 | content digest 및 conditional write로 중복 방지 |
| Store upload | provider에서 해당 version/build/artifact receipt 조회 후 판단 |
| Store submit/release, push 대량 발송 | 결과 불명 시 waiting/reconciliation_required, 무조건 자동 재실행 금지 |

exactly-once delivery/실행을 보장한다고 표현하지 않는다. 중복 방지·탐지·조정 범위를 action별로 명시한다.

## 6. 로컬 상태

Runner가 보유할 수 있는 장기 상태는 machine identity, policy-compatible toolchain 설치, 폐기 가능한 cache다. identity credential은 OS 보안 저장소를 사용하고 회전·revoke가 가능해야 한다.

Job workspace는 격리된 임시 디렉터리다. 종료 처리에는 subprocess 종료, 파일·임시 Keychain·profile 제거, lease 결과 전송, 원문 로그 폐기를 포함한다. 시작 시 orphan workspace를 검사한다. 제거 실패는 운영 경고이며 완전 삭제 성공처럼 숨기지 않는다.

Node/package manager 버전과 lockfile을 고정하고 framework adapter가 필요한 toolchain을 보고한다. install/fix는 실제 설치·라이선스 동의가 필요한 별도 동작이다. doctor는 진단만 하고 임의로 machine 설정을 바꾸지 않는다.

## 7. Release·Artifact provenance

artifact는 organization/release/target/job/attempt/source/config/secret refs를 바인딩한다. size, media type, content digest, storage object version, builder/toolchain/adapter/native runtime provenance를 보존한다. 다른 tenant의 artifact를 ID만 바꿔 연결할 수 없어야 한다.

binary upload 성공과 provider processing 성공을 구분한다. release timeline은 append-only event와 현재 projection으로 구성한다. 조회 화면의 최신 상태에는 마지막 provider 동기화 시각과 stale/error를 표시한다.

동일 source/config로 다른 PC에서 새 빌드를 만들었을 때 의미적 입력 일치와 검증 가능성을 보장한다. timestamp·code signing·외부 도구의 nondeterminism으로 bytes가 달라질 수 있다. artifact digest는 실제 결과를 식별하며 잘못된 “항상 같은 bytes” 약속을 피한다.

## 8. Provider plugin 계약

MVP plugin은 저장소에 포함된 검토된 모듈이다. 임의 JavaScript를 API 프로세스에서 실행하는 marketplace를 먼저 만들지 않는다.

각 adapter는 다음을 선언한다.

- 안정된 provider ID, manifest schema version, adapter version
- 기능별 지원 상태 및 실행 위치(control plane / runner)
- 설정 schema, 필요한 credential 종류와 최소 scope
- input/output schema, timeout, rate limit, retry class
- idempotency 지원, reconciliation 방법, 관측 가능한 status
- health check와 credential expiry/revoke 결과
- domain error와 provider 원문 오류의 안전한 정규화

Core는 provider SDK를 모르고 계약만 의존한다. public action은 adapter/credential/policy가 없으면 fail closed한다. `connected`, `uploaded`, `live`는 실제 증거가 있는 상태만 사용한다.

## 9. Hosted / BYOC / Self-host 경계

| 모드 | Control Plane | Artifact/OTA 자원 | 키·권한 책임 |
| --- | --- | --- | --- |
| Hosted | 운영자 Cloudflare | 운영자 기본 또는 사용자 선택 자원 | 운영자 Vault 정책 + 사용자 provider 권한 |
| 부분 BYOC | 운영자 Cloudflare | 사용자 Cloudflare | metadata와 key custody 위치를 별도 고지 |
| Self-host | 사용자 Cloudflare | 사용자 Cloudflare | 사용자가 key backup/rotation/복구 책임 |

Self-host는 실행 코드·schema migration·설정·업그레이드·백업/복원 안내를 함께 공개해야 성립한다. “배포 버튼이 있음”만으로 지원 완료가 아니다. 리소스 provisioning은 명시적 권한과 cost preview를 거친다. Provider free quota는 영구 제품 계약이 아니다.

## 10. 필수 실패 시나리오

- 동시에 두 Runner가 claim: 하나만 유효한 lease를 받음
- heartbeat 유실: lease 만료 후 이전 fence를 가진 완료·artifact 확정 거부
- Runner revoke: 갱신/secret 수령/상태 변경 거부, 관련 외부 credential 영향 안내
- Store 요청 직후 네트워크 단절: 중복 submit 없이 provider 조회·manual resolution
- 조직 A ID로 조직 B child/reference 접근: tenant mismatch 거부
- approval 이후 config 변경: 승인된 snapshot만 실행하거나 새 승인 필요
- 새 PC에 toolchain 없음: preflight 실패, actionable doctor 결과
- 유일한 Mac offline: blocked/waiting 표시, iOS 성공 상태 생성 금지
- raw log에 secret이 chunk 경계로 등장: 전송 전 redaction 검증
- backup 복구 후 오래된 queue 재전달: job/attempt/fence/idempotency로 안전하게 거부·정리
