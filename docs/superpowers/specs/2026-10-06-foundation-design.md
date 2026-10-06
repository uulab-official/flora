# Foundation 0A 설계안

작성일: 2026-10-06

상태: **2026-10-06 설계 승인. 상세 구현 계획 검토 중, 구현 전.**
이 문서는 전체 제품 비전 중 첫 번째로 검증할 수 있는 작은 기반을 정의한다. [통합 기획서](../../product/integrated-plan.ko.md)의 모든 기능을 한 번에 구현하는 계획이 아니다.

## 1. 목표와 성공 기준

사용자의 목적은 완전 오픈소스 앱 통합 운영, Expo 유료 플랜 의존 제거, Cloudflare 배포, 선택형 provider 연동, 다른 개발자·다른 PC에서의 재현 가능한 운영이다.

첫 단계에서는 **동일 조직·앱·타깃·소스·설정으로 만든 Job이 어느 호환 Runner로 이동해도 입력과 이력이 유지되고, 오래된 실행권으로 결과를 덮어쓰지 못한다**는 계약을 코드와 테스트로 확립한다.

이 단계의 결과는 실행 가능한 로컬 개발 기반이다. 실제 로그인/Runner 서버/Cloudflare 배포/Store/OTA 기능 완성은 아니다.

## 2. 범위

### 포함

- pnpm workspace + strict TypeScript, 고정 Node/package-manager 버전, lockfile
- 중립적인 organization/project/application/flavor/environment/platform target 타입과 런타임 입력 검증
- repo와 app 분리, source SHA/root directory/lockfile/adapter provenance 계약
- scope별 CONFIG 값과 SECRET/FILE/CREDENTIAL version reference의 결정적 resolution
- canonical immutable config snapshot과 digest, plaintext secret 제외
- Job state/attempt/lease/fence/idempotency/retry class domain 규칙
- SQL migration: tenant-scoped foreign keys, unique target/idempotency, snapshot/attempt/artifact relation
- SQLite 기반 실제 영속성 contract/integration tests. Cloudflare D1의 배포 검증과 구분
- provider capability 계약 및 미연결·미지원 action의 fail-closed 경계
- local-only doctor/config validation/dry-run 시뮬레이션 중 검증 가능한 최소 CLI
- 안전한 fixture, 단위·통합 테스트, 정적 검사, clean checkout 문서

### 제외

- OAuth/GitHub App 등록, 실제 사용자/Runner 인증 및 공개 API
- 실제 secret 저장·암복호화·배포 또는 계정 credential 전송
- native build, signing, Store upload/submit, OTA publish, Web deploy
- 자동 Cloudflare provisioning, 비용 발생 인프라, 실제 domain 설정
- public Dashboard와 demo auth bypass
- Push/Links/Revenue/Analytics 구현

Vault는 보안 경계·데이터 envelope·key custody 계약을 문서화하고 redaction 유틸리티를 테스트할 수 있다. 키 운영이 없는 상태에서 production Vault 완료로 표시하지 않는다.

## 3. 패키지 경계

처음에는 `packages/core`, `packages/config`, `packages/runner-protocol`, `packages/db`, `packages/cli` 정도만 필요하다. 별도 `providers` 계약 fixture는 외부 요청을 보내지 않는다. 실제 구현 계획에서 최소 개수로 확정한다.

- core: tenant/target/source/release/artifact identity 및 error/capability
- config: scope validation/resolution/snapshot
- runner-protocol: Job/attempt/state/lease/fencing 입력·출력
- db: migration과 영속성 원자 연산 adapter
- cli: doctor·설정 검사·명시적인 로컬 simulation

Core와 API는 provider SDK나 UI를 의존하지 않는다. 모듈 간 식별자는 opaque ID이며 display name 변경에 영향받지 않는다. private workspace package 이름은 브랜드를 포함하지 않는다.

## 4. 타깃과 설정 계약

Organization은 모든 소유권의 루트다. Project/Application 참조와 Flavor/Environment는 같은 organization/app 관계를 검증한다. Platform은 ios/android/web enum이다. repo identity + app root는 Application 연결이며 Project ID와 repo ID를 혼용하지 않는다.

설정 입력은 runtime 검증된 `scope`, `key`, `kind`, `version`, `value` 또는 `versionRef`다. 조직·프로젝트·앱·flavor·environment·platform·완전한 target override 순으로 우선순위를 명시하고 동일 우선순위·동일 키 중복은 오류로 처리한다. 완전한 target override는 app+flavor+environment+platform을 모두 지정하므로 free/production/ios와 pro/production/ios를 분리할 수 있다. 불완전한 교차 selector는 거부한다. 해당 타깃과 무관한 selector는 제외한다. 빈 key, prototype 오염 키, 잘못된 selector, cross-tenant ref, secret plaintext는 거부한다.

Snapshot에는 target, source revision, resolved non-secret values, immutable version references, resolver schema version을 포함한다. 정렬된 canonical representation으로 digest를 계산해 입력 순서에 영향받지 않게 한다. 기존 snapshot은 수정하지 않는다. CLI 출력에는 secret reference만 보이고 raw secret은 입력받지 않는다.

## 5. Job과 lease 계약

Job 생성은 organization-scoped idempotency key + request digest를 사용한다. 동일 key/동일 digest는 기존 Job 반환, 동일 key/다른 digest는 conflict다.

claim은 영속 store에서 원자적으로 `queued` 또는 정책상 재시도 가능한 만료 attempt를 새 attempt에 할당한다. 시각은 서버 clock abstraction에서 얻고 양수 bounded lease duration을 검증한다. fence는 증가만 한다.

Runner의 heartbeat/complete/artifact finalize는 organization/runner/attempt/fence/status/expiry를 검증한다. 운영자의 cancel은 조직 RBAC와 Job 현재 상태를 검사하는 별도 경로다. Runner가 offline이거나 lease가 만료되어도 권한 있는 운영자는 취소할 수 있고, 취소는 실행권을 무효화한다. 만료된 lease는 heartbeat로 부활하지 못한다. 완료된 Job의 중복 완료는 같은 결과만 idempotent하게 처리하고 다른 결과는 conflict다. 취소와 완료 경쟁의 허용 전이를 명시한다.

retryable build와 external side effect를 구분한다. `store_submit`, `store_release` 등 결과 불명 작업은 자동 reclaim하지 않고 reconciliation_required 이유의 waiting 상태로 둔다. simulation은 실제 Store에 요청하지 않는다.

## 6. 저장 계약과 migration

SQL 제약은 같은 tenant 안에서만 child/reference를 연결하도록 composite foreign key를 사용한다. application/flavor/environment/target/job/attempt/artifact/release의 참조 무결성을 테스트한다. config snapshot과 completed attempt는 append-only 계약을 갖는다.

Job claim의 affected row/fence를 검증한다. select → unconditional update 패턴은 허용하지 않는다. 실제 SQLite 두 connection 경쟁 테스트로 하나만 실행권을 얻는 것을 확인한다. D1 adapter를 구현하는 다음 단계에서 D1 환경의 concurrency/transaction/read consistency를 다시 검증한다.

Audit/outbox 테이블 설계와 local write path의 event를 포함할 수 있지만, DB administrator 불변성이나 외부 durable delivery를 과장하지 않는다. migration은 clean DB 적용 및 무결성 실패 테스트를 갖는다.

## 7. CLI와 clean-machine 설치 경험

README는 clone → 고정 toolchain 준비 → frozen lockfile install → check/test → local dry-run 순서의 실행 가능한 지침을 제공한다. 개인 PC 절대 경로, 개인 account ID, 실제 token, global npm 설정을 요구하지 않는다.

`platform doctor`는 현재 process의 OS/architecture/tool version과 지원하지 않는 항목을 정확히 반환하고 자동 설치를 하지 않는다. 개발 setup 명령은 OS별 차이를 문서화한다. `platform config validate`와 `platform job simulate`가 구현되면 이름에 맞는 로컬 동작만 수행하고 network credentials를 요청하지 않는다. `flora` alias는 표시 이름 설정과 분리한다.

모든 예제에는 example/test ID와 가상 config만 사용한다. generated state는 workspace 안의 명시적 output 폴더 또는 메모리를 사용하고 사용자의 기존 파일을 덮어쓰지 않는다.

## 8. 테스트 설계

테스트는 구현 전 실패를 확인한다. 예상 검증 항목:

- organization A에서 organization B의 app/secret/artifact ref 거부
- 같은 flavor의 development/production, 같은 production의 free/pro 구분
- scope 우선순위·동순위 충돌·잘못된 입력·prototype key 방어
- config 변경 후 과거 snapshot 유지, 입력 순서 변경에 digest 동일
- SECRET/FILE/CREDENTIAL은 version refs만 포함
- 같은 idempotency key의 같은 요청 재사용, 다른 요청 conflict
- 두 connection의 concurrent claim 중 유효 lease 하나
- lease 만료 후 새 fence, 이전 Runner 완료·heartbeat 거부
- 위험 action의 만료는 자동 실행 대신 reconciliation waiting
- 취소/완료 경쟁과 terminal state 불변성
- 다른 target/source/snapshot/artifact digest 연결 거부
- public provider 작업은 unsupported/unconfigured이면 실패
- redaction을 구현할 경우 stdout/stderr chunk 경계와 알려진 encoding 테스트
- clean checkout에서 frozen install/typecheck/test 반복 성공

## 9. 보안과 검증 한계

이 단계에는 인증된 인터넷 API와 실제 Vault가 없으므로 배포용 secret을 넣지 않는다. 로컬 모델은 production auth를 대체하지 않는다. Windows/macOS/Linux CI를 실제로 실행한 경우에만 해당 OS 검증 완료로 표시한다. iOS native 검증은 Mac+Xcode에서 별도의 실증이 필요하다.

Dependencies는 공개 registry의 안정 버전을 pin하고 license/security 검사를 한다. 새 workflow는 테스트만 실행하고 배포·credential 생성·권한 확대를 하지 않는다. publish 전 secret scan, 전체 테스트, 독립 리뷰, 최신 main 확인, non-force update를 수행한다.

## 10. 검토할 결정

- 위 Foundation 0A의 범위와 성공 기준이 사용자가 원하는 첫 구현 단위인지
- 설계 승인 뒤 작성할 상세 구현 계획을 검토하고 실행 방식을 확정할 것

승인 전에도 문서·공식 자료 확인·읽기 전용 저장소 조사는 진행할 수 있다. 제품 scaffolding과 코드는 설계·계획 검토 뒤 시작한다.
