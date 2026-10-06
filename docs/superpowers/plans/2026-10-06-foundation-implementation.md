# Foundation 0A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 깨끗한 checkout에서 앱 타깃 검증 → 설정 스냅샷 → SQLite Job 생성·Runner 교체·결과 이력 조회를 실행할 수 있는 오픈소스 로컬 Foundation을 만든다.

**Architecture:** Core/config/protocol은 Provider SDK와 UI에 독립적인 TypeScript 모듈이다. SQLite adapter는 같은 계약을 실제 영속성·경쟁 테스트로 검증하고 CLI는 이 모듈들을 명시적인 로컬 시뮬레이션으로 연결한다. 인터넷 API, 로그인, 실제 credential, native build와 Cloudflare 배포는 이번 단계에 넣지 않는다.

**Tech Stack:** Node.js 24.19.0, pnpm 11.19.0, TypeScript 5.9.3, @types/node 24.19.1, Node test runner, node:sqlite, Web Crypto. 런타임 외부 의존성 없이 시작하며 Turborepo는 필요한 규모가 될 때 추가한다.

**Spec:** [승인된 Foundation 설계](../specs/2026-10-06-foundation-design.md), 기준 문서 commit `28650a6fae76eab4367161b252dc02a5b3f92f66`

상태: **상세 계획과 Native 구현 + 독립 리뷰 방식 승인. 로컬 구현·검증 중.** 목표 검토 시점은 2026-10-07 09:00 KST이며 아래 완료 기준을 생략하거나 완료를 보장하는 마감 약속이 아니다.

## Global Constraints

- **완전 오픈소스:** Apache-2.0을 유지하고 Core/공식 adapter/RBAC/Audit/Self-host를 유료 잠금하는 구조를 추가하지 않는다
- **Cloud-only:** 개발·검증은 클라우드에서 수행한다. 사용자의 Mac에 접속하거나 로컬 credential을 읽지 않는다
- **브랜드 독립성:** DB/내부 ID는 중립 이름, workspace namespace는 `@app-ops`, 표시 이름만 기본 Flora
- **strict TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` 활성화
- **앱 타깃:** `Application + Flavor + Environment + Platform`; Platform은 `ios | android | web`
- **Project ≠ Repository:** immutable repository identity와 상대 app root를 별도로 보관한다
- **스냅샷:** non-secret CONFIG와 SECRET/FILE/CREDENTIAL의 immutable version reference만 저장한다
- **실행권:** 원자 claim, attempt, 증가하는 fence, lease expiry, tenant-scoped idempotency를 함께 사용한다
- **부수효과:** 미연결 Provider는 fail closed한다. 실제 upload/submit/OTA/deploy 성공을 만들지 않는다
- **취소:** operator 권한 검사와 Runner lease 검사를 분리한다. offline Runner도 operator가 취소할 수 있다
- **검증 범위:** SQLite 로컬 검증을 Cloudflare D1 분산 운영 검증으로 표시하지 않는다
- **이식성:** 개인 절대 경로·global package·로컬 로그인 상태 없이 실행한다. 검증되지 않은 OS는 미검증으로 표시한다
- **게시:** fresh main 확인, secret scan, 전체 테스트, 독립 리뷰, non-force update와 원격 재확인 후 게시한다. CI에는 deploy를 넣지 않는다

## Review Focus

1. 잘못된 JSON/unknown field/prototype key/절대·상위 경로가 들어오면 안전한 오류와 nonzero exit를 반환한다 → Task 1/2/6
2. expired Runner가 살아 돌아오거나 취소와 완료가 경쟁하면 한 최종 상태만 유지하고 이전 fence를 거부한다 → Task 4
3. idempotency key는 같지만 타깃·snapshot·source가 다르면 기존 결과를 잘못 재사용하지 않는다 → Task 4
4. 같은 조직이라도 다른 앱의 flavor/source/artifact를 연결하면 거부하고 기록을 부분 저장하지 않는다 → Task 1/3/5
5. 공백·한글 경로, 읽기 전용 입력, 두 번째 실행, 설치 후 lockfile 변동을 만나도 데이터 덮어쓰기 없이 결과가 재현된다 → Task 6/7

## 실행 경로와 파일 구조

최종 smoke path는 `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm platform doctor --json` → `pnpm platform config validate --file examples/local-workflow.json` → `pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement`다. 시뮬레이션 DB는 매번 OS 임시 디렉터리에 만들고 종료 시 닫는다. 사용자가 지정한 기존 DB나 파일을 덮어쓰는 옵션은 만들지 않는다.

| 경로 | 책임 |
| --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.node-version`, `.nvmrc`, `.npmrc`, `.gitignore` | 고정 toolchain·workspace·설치·출력 제외 |
| `tsconfig.base.json`, `tsconfig.tests.json`, `scripts/test.mjs`, `scripts/verify-toolchain.mjs`, `scripts/pnpm-entry.mjs` | strict typecheck, shell glob에 의존하지 않는 테스트 수집, toolchain 검사 |
| `packages/core/src/{errors,identity,source,providers,index}.ts` | 런타임 검증·tenant/target/source·capability 계약 |
| `packages/config/src/{schema,canonical,resolve,index}.ts` | config 입력·결정적 serialization/digest·불변 snapshot |
| `packages/runner-protocol/src/{schema,state,index}.ts` | Job/attempt/lease/action 타입과 전이 규칙 |
| `packages/db/migrations/0001_foundation.sql` | tenant 제약·immutable records·Job/attempt/audit schema |
| `packages/db/src/{database,migrate,catalog,snapshots,jobs,artifacts,events,index}.ts` | SQLite adapter와 원자 연산 |
| `packages/cli/src/{main,doctor,config-command,simulate,format}.ts` | 로컬 CLI·진단·전체 흐름 |
| `packages/*/package.json`, `packages/*/tsconfig.json` | 각 모듈의 private workspace export와 build |
| `packages/*/test/*.test.ts`, `packages/db/test/fixtures/claim-worker.ts`, `tests/cli.test.ts` | 실제 module/DB/process 기반 테스트 |
| `examples/local-workflow.json`, `docs/development/local-foundation.ko.md` | secret-free 입력과 실제 실행 지침 |
| `.github/workflows/ci.yml`, `scripts/clean-install.mjs` | 비배포 OS 매트릭스와 깨끗한 재설치 검증 |

doctor/clean-install에서 pnpm은 `npm_execpath`를 realpath로 해석해 공식 pnpm package의 JS entry와 package.json version을 확인하고 `process.execPath`로 실행한다. 정상 pnpm entry를 찾지 못하면 명시적인 unavailable/설치 안내를 반환한다. Windows의 `.cmd`/`.bat`를 shell:false로 직접 spawn하거나 사용자 문자열을 shell command로 합치지 않는다.

각 task는 그때 필요한 package manifest/tsconfig만 생성하고 아직 구현하지 않은 빈 package는 미리 만들지 않는다.

각 package는 `src`를 `dist`로 컴파일하고 `exports`/`types`는 자기 package의 dist만 가리킨다. 내부 import는 `.js`, package 간 import는 `@app-ops/*`와 `workspace:*`를 사용한다. 테스트는 build 뒤 Node 24의 type stripping으로 실행하고 별도 `tsconfig.tests.json`으로 typecheck한다. root scripts는 `build`, `typecheck`, `test`, `check`, `platform`, `verify:clean`이다. Windows에서 다른 shell 문법을 요구하지 않도록 파일 검색·cleanup은 Node script로 작성한다.

## 공통 데이터 계약

필드는 아래에서 정의한 이름을 그대로 사용한다. ID는 `[a-z][a-z0-9_-]{2,95}`, 사람이 보는 이름은 별도 문자열이다. ID/키가 `__proto__`, `prototype`, `constructor`인 입력은 거부한다. 객체는 Object.prototype 또는 null prototype만 허용하고 배열은 Array.prototype만 허용한다. custom prototype, array hole/추가 property, schema에 없는 필드는 오류다. 위험한 key는 SourceRevision.toolchain을 포함해 재귀적으로 거부한다.

- `Target`: `id, organizationId, projectId, applicationId, flavorId, environmentId, platform`. id는 config에서 제공하는 안정된 opaque ID다. 동일 tuple의 다른 id 또는 동일 id의 변경된 tuple을 DB에 저장할 수 없다
- `Catalog`: `organizations`, `projects`, `applications`, `flavors`, `environments` 배열. 각 entity는 `id`, 소유 조직 ID 및 필요한 부모 ID를 가진다. 모든 ID/관계 중복·불일치를 검증한다
- `SourceRevision`: `id, organizationId, applicationId, repositoryId, commitSha, rootDirectory, lockfileDigest, adapterId, adapterVersion, toolchain: Record<string,string>`
- `commitSha`: 소문자 Git SHA-1 40자리 또는 SHA-256 64자리. `lockfileDigest`와 결과 digest는 SHA-256 64자리
- `rootDirectory`: `.` 또는 정규화된 POSIX 상대 경로. 절대 경로, `..`, backslash, NUL, 빈 segment 금지
- `Reference`: `kind: SECRET | FILE | CREDENTIAL`, `organizationId, resourceId, versionId`. plaintext/value/token/key-material 필드 금지
- `ConfigEntry`: `key, versionId, scope, binding`. `binding`은 `{kind: CONFIG, value: string}` 또는 `Reference`; key는 `[A-Z][A-Z0-9_]{0,127}`
- `scope`는 아래 정확한 shape의 union이며 unknown field를 허용하지 않는다. 모든 shape에 organizationId가 있다
  - `{level:organization, organizationId}`
  - `{level:project, organizationId, projectId}`
  - `{level:application, organizationId, applicationId}`
  - `{level:flavor, organizationId, applicationId, flavorId}`
  - `{level:environment, organizationId, applicationId, environmentId}`
  - `{level:platform, organizationId, applicationId, platform}`
  - `{level:target, organizationId, applicationId, flavorId, environmentId, platform}`
  flavor와 environment는 독립 축이다. 완전한 target override는 가장 높은 우선순위이며 `free+production+ios`를 `pro+production+ios`와 다르게 설정할 수 있다. flavor+environment만 가진 불완전한 target selector는 이번 schema에서 거부한다
- `ConfigSnapshot`: `schemaVersion:1, id, digest, target, source, entries`. `id=cfg_<digest>`이며 digest 대상에는 id/digest/시각을 넣지 않는다
- `DomainError`: `code, safeMessage`; code는 validation/tenant/scope/state/lease/idempotency/provider/permission 등 안정된 enum. CLI는 payload 전체나 raw SQL 오류를 출력하지 않는다

## Task 1: 검증 가능한 타깃과 소스 모델

**Files:** tooling/workspace 파일, core의 errors/identity/source/providers/index, core package manifest/tsconfig, `packages/core/test/identity.test.ts`, `packages/core/test/providers.test.ts`

**Interfaces:** `parseCatalog(input:unknown):Catalog`, `parseTarget(input:unknown,catalog:Catalog):Target`, `parseSourceRevision(input:unknown,target:Target):SourceRevision`, `requireCapability(provider:ProviderDescriptor|null,capability:Capability):void`. `ProviderDescriptor`는 `id,version,capabilities`만 갖는다. `Capability`는 `build|store.upload|store.submit|ota.publish|web.deploy`다.

- [ ] 고정 버전과 private workspace를 선언하고 TypeScript/test runner만 설치한다. `node`/`pnpm` 버전 확인 실패는 설치 방법을 설명하며 OS 설정을 변경하지 않는다
- [ ] 실패 테스트: free/production/ios와 pro/production/ios가 서로 다른 target; 다른 조직 app은 `TENANT_MISMATCH`; 다른 app flavor는 `INVALID_RELATION`; source root `../app`, `/tmp/app`, `C:\\app` 및 unknown field 거부; null provider는 `PROVIDER_UNCONFIGURED`, 미지원 capability는 `PROVIDER_UNSUPPORTED`
- [ ] `pnpm build && node scripts/test.mjs packages/core/test`를 실행해 미구현 함수로 실패함을 확인한다. 테스트 하네스 오류면 먼저 고친다
- [ ] 위 parser와 error/capability 계약을 최소 구현한다. provider에는 실행 메서드나 가짜 응답을 넣지 않는다
- [ ] 같은 테스트와 `pnpm typecheck`를 실행해 전체 성공을 확인한다
- [ ] 검증된 변경을 `feat(core): validate portable application targets and provider capabilities`로 커밋한다

## Task 2: 설정 resolution과 불변 snapshot

**Files:** config manifest/tsconfig와 src 4개, `packages/config/test/{schema,resolve,snapshot}.test.ts`

**Interfaces:** `parseConfigEntries(input:unknown):readonly ConfigEntry[]`, `canonicalJson(value:JsonValue):string`, `sha256(text:string):Promise<string>`, `resolveSnapshot(input:{target:Target;source:SourceRevision;entries:readonly ConfigEntry[]}):Promise<ConfigSnapshot>`

상속 우선순위는 organization=0/project=1/application=2/flavor=3/environment=4/platform=5/target=6이다. 동일 조직의 무관한 selector는 제외하되, 다른 조직 레코드/Reference는 오류다. 같은 우선순위·키가 두 번 있으면 값이 같아도 conflict다. 다른 kind로 덮어쓰기는 오류이며 secret이 CONFIG로 바뀌는 것을 허용하지 않는다. CONFIG는 공개 값이라는 계약이며 임의 문자열의 비밀 여부를 완벽히 탐지한다고 주장하지 않는다.

- [ ] 실패 테스트: `API_URL`을 org→app→production 순으로 정의하면 production 값; platform override보다 exact target override가 우선; free+production+ios override는 pro+production+ios 및 free+staging+ios 및 free+production+android에 적용되지 않음; platform이 빠진 target scope는 INVALID_INPUT; 동일 레벨 duplicate는 `CONFIG_CONFLICT`; secret binding에 `value`가 있으면 `INVALID_INPUT`; cross-tenant reference 거부
- [ ] 실패 테스트: entries 순서를 바꿔도 같은 digest, source SHA/target/entry version이 바뀌면 다른 digest, 입력을 나중에 수정해도 snapshot 불변, 반환 객체의 중첩 필드 수정 거부, 정상 plain/null-prototype object와 array 허용, toolchain의 constructor/중첩 custom prototype 거부, depth65 거부, secret sample plaintext가 snapshot JSON에 없음
- [ ] `pnpm build && node scripts/test.mjs packages/config/test`의 실패 원인을 확인한다
- [ ] sorted-key canonical JSON + Web Crypto SHA-256, 복사 후 deep freeze, selector matching과 엄격한 union parser를 구현한다. `undefined`, nonfinite number, custom prototype는 canonical serializer에서 거부하되 정상 JSON object/array는 허용한다. resolved entries 배열은 key 순으로 정렬하고 object key는 사전순으로 직렬화한다. 깊이는64이하로 제한한다
- [ ] config 테스트와 전체 `pnpm check`가 성공해야 다음 task로 간다
- [ ] `feat(config): resolve immutable target snapshots with version references` 커밋

## Task 3: tenant-safe SQL 저장과 provenance

**Files:** DB manifest/tsconfig와 migration/database/migrate/catalog/snapshots/events, `packages/db/test/{migration,catalog,snapshots}.test.ts`

**Interfaces:** `openDatabase(path:string):DatabaseSync`, `migrate(db:DatabaseSync):void`, `insertCatalog(db:DatabaseSync,catalog:Catalog):void`, `saveTarget(db:DatabaseSync,target:Target):void`, `saveSource(db:DatabaseSync,source:SourceRevision):void`, `saveSnapshot(db:DatabaseSync,snapshot:ConfigSnapshot):Promise<void>`, `createRelease(db:DatabaseSync,input:ReleaseInput):Release`, `listEvents(db:DatabaseSync,organizationId:string,jobId:string):readonly AuditEvent[]`

`ReleaseInput`/`Release`는 `id, organizationId, applicationId, sourceRevisionId, version, createdBy`다. `ReleaseSummary`는 release와 해당 조직의 `jobs`, `artifacts`, `events` 배열이며 platform별 live 상태를 추론하지 않는다. source와 release의 app이 같아야 한다. 저장 순서는 catalog → target → source → snapshot → release다. target 등록은 명시적 saveTarget 경로이며 snapshot 저장에 암묵적으로 숨기지 않는다. 동일 target ID/tuple은 재사용하고 동일 ID의 변경 또는 동일 tuple의 다른 ID는 conflict다. 일치 여부 검증은 SQL FK와 application layer 양쪽에 둔다. Job의 release+source 및 snapshot+target+source 조합도 unique/composite FK로 같은 provenance를 강제한다.

필수 테이블: `schema_migrations`, `organizations`, `projects`, `applications`, `flavors`, `environments`, `platform_targets`, `source_revisions`, `config_snapshots`, `snapshot_references`, `releases`, `jobs`, `job_attempts`, `artifacts`, `audit_events`. `snapshot_references`는 secret material이 없는 version-reference metadata다. 아직 존재하지 않는 Vault에 연결되었다고 표시하지 않는다. Job/audit write는 같은 SQLite transaction 안에 둔다. Queue/outbox delivery는 범위 밖이며 schema만 생성해 작동한다고 주장하지 않는다.

- [ ] 실패 테스트: clean DB migration, 같은 migration 재실행 no-op, 다른 migration checksum 거부; org A→org B FK 실패; 같은 org의 다른 app flavor/source/release 연결 실패; snapshot UPDATE/DELETE 및 audit UPDATE/DELETE를 일반 SQL adapter 경로에서 거부; success/failed/cancelled/expired 상태의 job_attempts에 대한 UPDATE/DELETE를 trigger로 거부하며 active attempt의 heartbeat 갱신은 허용
- [ ] `pnpm build && node scripts/test.mjs packages/db/test/migration.test.ts packages/db/test/catalog.test.ts packages/db/test/snapshots.test.ts` 실패 확인
- [ ] FK를 켜고 STRICT table/복합 FK/unique 제약과 append-only trigger를 작성한다. `platform_targets`의 unique는 org+app+flavor+environment+platform이다. JSON content는 깊은 복사 후 schema/digest를 비동기로 재검증하고, await가 끝난 뒤에만 짧은 SQLite transaction을 시작한다. 열린 transaction 안에 await를 두지 않는다
- [ ] migration checksum ledger와 transaction wrapper를 구현한다. 실패하면 전체 rollback하고 raw SQL/값을 CLI에 내보내지 않는다. 잠금 timeout은 5초, 외부 extension loading은 금지한다
- [ ] 전체 테스트 성공 후 DB를 닫고 같은 파일을 다시 열어 snapshot/release가 남아 있는지 테스트한다
- [ ] `feat(db): add tenant-safe foundation migrations and immutable provenance` 커밋

## Task 4: Job lease·fence·재시도와 operator 취소

**Files:** runner-protocol manifest/tsconfig와 schema/state, DB jobs, `packages/runner-protocol/test/state.test.ts`, `packages/db/test/{jobs,races}.test.ts`, claim-worker fixture

**Interfaces:** `createJob(db,input:NewJobInput):Promise<Job>`, `claimJob(db,input:ClaimInput):Lease|null`, `startJob(db,input:LeaseProof):Job`, `heartbeat(db,input:LeaseProof):Lease`, `completeJob(db,input:LeaseProof & {artifactId:string;resultDigest:string}):Job`, `failJob(db,input:LeaseProof & {failureCode:FailureCode;retryable:boolean}):Job`, `recoverExpiredJobs(db,organizationId:string,now:number):number`, `cancelJob(db,input:CancelInput):Job`.

- `NewJobInput`: `organizationId,releaseId,targetId,sourceRevisionId,snapshotId,kind,idempotencyKey,createdBy,requiredCapabilities`. Job ID는 adapter가 생성한다. request digest는 key/생성 시각/새 Job ID를 제외한 실행 입력에서 내부 계산하고 capability 배열은 중복 제거·정렬한다. 저장 전에 Job.sourceRevisionId = Release.sourceRevisionId = Snapshot.source.id 및 Job.targetId = Snapshot.target.id를 확인한다. 같은 조직·같은 앱이어도 이 등식이 깨지면 INVALID_RELATION이며 Job/audit를 저장하지 않는다
- `kind`: `build|store_submit|store_release`; 마지막 두 종류는 상태·실패정책만 모델링하며 실제 provider action은 없다
- `RunnerCapability`: `node|xcode|android-sdk|ios|android|web`. ios target은 `runnerOs=darwin`과 ios+xcode, android는 android+android-sdk, web은 web+node를 요구한다. 추가 requiredCapabilities도 모두 충족해야 한다
- `ClaimInput`: `organizationId,jobId,runnerId,runnerOs,capabilities,now,leaseDurationMs`; `runnerOs=darwin|win32|linux`, capabilities는 RunnerCapability 배열이다. `Lease`는 `organizationId,jobId,runnerId,attemptId,fence,expiresAt`를 가진다
- `Job`: NewJobInput의 필드와 `id,requestDigest,status,attemptCount,currentAttemptId|null,fence,leaseUntil|null,waitingReason|null,resultDigest|null`를 가진다. `AuditEvent`는 `sequence,organizationId,jobId,actorId,action,at,attemptId|null,fence|null,safeCode|null`만 기록한다
- `FailureCode`: `BUILD_FAILED|RUNNER_LOST|UNSUPPORTED_TOOLCHAIN`; arbitrary message나 stdout을 실패 저장 필드로 받지 않는다
- `LeaseProof`: `organizationId,jobId,runnerId,attemptId,fence,now`; `CancelInput`: `organizationId,jobId,actorId,reason,authorization:{organizationId,actorId,actions},now`
- cancellation authorization은 신뢰된 application boundary가 공급하는 내부 context이며 인증 token이 아니다. 로컬 fixture 외 외부 입력을 이 context로 직접 변환하지 않는다. action `job.cancel`이 없으면 `PERMISSION_DENIED`
- `now`는 adapter가 제공하는 safe-integer millisecond clock이다. CLI/미래 API 사용자가 임의 서버 시각을 지정할 수 없다. 테스트만 clock을 고정한다. lease는 5,000~120,000ms, 기본 30,000ms. 만료 판단은 `now >= expiresAt`

이번 결과 모델은 build attempt당 하나의 synthetic artifact다. completeJob은 해당 artifactId가 같은 Job/attempt/target/source/snapshot에 속하고, resultDigest가 그 artifact.digest와 같은지 검사한다. artifact가 없거나 digest가 다르면 완료를 거부한다. store_submit/store_release의 실제 성공 완료는 미연결 provider이므로 PROVIDER_UNCONFIGURED로 거부한다. Task4의 완료 테스트는 Task3 schema에 test fixture로 유효한 artifact 행을 준비하고, Task5가 production recordArtifact 경로를 추가한다.

상태 흐름: 생성 `queued` → claim `assigned` → start `running` → `success`; operator cancel은 queued/assigned/running/waiting→cancelled. build lease 만료는 attempt를 expired로 남기고 최대 3 attempts까지 queued, 그 뒤 job expired. 위험 kind 만료는 waiting + `reconciliation_required`. terminal state에서 다른 결과/전이는 거부한다. 명시적 실패는 attempt failed를 남기고 retryable build만 3회 한도 내 queued로 돌아가며, 한도 초과 또는 non-retryable build는 failed다. 위험 kind의 결과 불명 실패는 waiting/reconciliation_required다. 같은 lease identity·동일 resultDigest의 완료 재전송은 terminal 기록을 확인한 뒤 원래 success를 idempotent하게 반환하며 lease가 이미 끝났다는 이유만으로 거부하지 않는다. 다른 fence/runner/result는 거부한다.

- [ ] 실패 테스트: 같은 key/같은 canonical 요청→기존 job; 같은 key/다른 target/source/snapshot→`IDEMPOTENCY_CONFLICT`; org별 같은 key 허용; 같은 app이지만 Release와 다른 source 또는 Snapshot과 다른 target/source는 row/audit 없이 거부; artifact 없음/잘못된 artifactId/resultDigest 불일치 완료 거부; 부족한 capability 또는 Windows/Linux Runner의 iOS claim은 실행권 없음
- [ ] 실패 테스트: `now=1_000_000`, TTL30,000에서 claim 한 번만 성공; 1,030,000에 heartbeat/complete는 `LEASE_STALE`; recover→새 attempt fence2; fence1의 start/complete 거부
- [ ] 실패 테스트: 위험 job 만료는 waiting이며 새 Runner claim 불가; build 최대 attempts 이후 expired; non-retryable 실패는 failed; terminal 동일 완료 재전송만 허용; 권한 없는 cancel 거부; offline/expired Runner가 있어도 허용된 operator cancel 성공; terminal attempt의 runner/fence/result/status 변경 및 삭제는 직접 SQL에서도 거부
- [ ] 각 테스트 파일을 실행해 실패 확인 후 상태 함수와 SQL 원자 연산을 구현한다. claim/recover/cancel/complete는 짧은 `BEGIN IMMEDIATE` transaction + 조건부 UPDATE + affected-row 검사를 사용한다. 무조건 UPDATE와 메모리 전용 lease는 금지한다
- [ ] 실제 파일 DB를 두 Worker thread의 별도 connection으로 열고 동시 claim barrier를 사용한다. valid lease는 정확히 하나다. cancel/complete 경쟁은 먼저 commit한 전이만 성공하고 audit event·최종 state가 일치한다. 메모리 mock으로 대체하지 않는다
- [ ] 전체 `pnpm check` 성공 및 20회 반복 race test 성공 확인 후 `feat(jobs): enforce atomic leases fencing and safe retry policies` 커밋

## Task 5: Artifact 결과와 Release 이력 연결

**Files:** DB artifacts/events, `packages/db/test/{artifacts,timeline}.test.ts`

**Interfaces:** `recordArtifact(db,input:ArtifactInput,proof:LeaseProof):Artifact`, `getReleaseSummary(db,organizationId:string,releaseId:string):ReleaseSummary`

`ArtifactInput`: `id,organizationId,jobId,attemptId,releaseId,targetId,sourceRevisionId,snapshotId,digest,sizeBytes,mediaType,storageKey`. 현재 artifact는 **로컬 simulation 결과 metadata**이고 실제 앱 바이너리·R2 object가 아니다. storageKey는 `simulation/<digest>`만 허용한다. Artifact의 관계는 caller 값대로 신뢰하지 않고 저장된 Job/attempt/snapshot/source와 전부 대조한다. fixture artifact digest는 실제 생성한 synthetic JSON bytes에서 계산한다.

- [ ] 실패 테스트: 성공한 연결은 ReleaseSummary의 target/job/artifact/source/config에서 동일 ID; stale fence·다른 app/target/source/snapshot·음수 size 거부; 같은 artifact ID/같은 내용은 재사용, 다른 내용은 conflict
- [ ] 실패 테스트: artifact 저장이나 complete 실패 시 audit/metadata 부분 저장 없음; timeline은 monotonic DB sequence로 정렬하고 raw config/credential 값이 없음
- [ ] `pnpm build && node scripts/test.mjs packages/db/test/artifacts.test.ts packages/db/test/timeline.test.ts` 실패 확인
- [ ] active running lease에서 artifact를 기록하고 완료와 이력에 연결한다. content-addressed metadata와 immutable row를 사용한다. completeJob resultDigest는 이 단일 artifact의 실제 synthetic bytes digest와 일치해야 한다. native/store/web의 live 상태를 생성하지 않는다
- [ ] 전체 테스트 성공 후 `feat(releases): connect local artifact provenance and job timeline` 커밋

## Task 6: 새 checkout에서 실행하는 로컬 CLI

**Files:** CLI manifest/tsconfig와 src, example JSON, `tests/cli.test.ts`, local-foundation 문서, README 상태

**Interfaces:** `runCli(argv:readonly string[],io:CliIO):Promise<number>`, `inspectToolchain():Promise<DoctorReport>`, `validateConfigFile(path:string):Promise<ConfigSnapshot>`, `simulateWorkflow(input:WorkflowInput,scenario:Scenario):Promise<SimulationReport>`

`CliIO`는 stdout/stderr 쓰기와 입력 파일 읽기를 분리한다. `Scenario=happy-path|runner-replacement|unsafe-expiry`. WorkflowInput은 catalog/target/source/configEntries와 예시 Release 버전을 포함한다. 입력은 최대 1MiB UTF-8 JSON이며 secret material은 받지 않는다.

명령:
- `platform doctor [--json]`: Node/pnpm/OS/architecture 및 native 도구의 존재 여부. shell 없이 `spawn`과 argv 사용, timeout 3초, 자동 설치·설정 변경 없음. iOS 미지원 OS는 정확히 표시한다
- `platform config validate --file <path>`: snapshot ID/digest/target, CONFIG key와 reference ID 목록만 출력. 값 전체나 secret reference 원문 payload를 에러에 출력하지 않는다
- `platform job simulate --file <path> [--scenario <name>]`: local-only 안내와 Job/attempt/fence/timeline/ReleaseSummary. 실제 build·upload·network 호출 없음
- `--help`, `--version`; unknown command/flag는 exit2, validation/domain failure는 exit1, 성공은 exit0. `flora`와 `platform` bin alias는 같은 main을 사용한다

- [ ] 실제 child process 테스트를 먼저 작성한다. doctor JSON의 `mode=local`, OS 실측값; valid config exit0; malformed JSON/prototype/unknown field/대형 입력 exit1; unknown command exit2
- [ ] end-to-end 테스트: happy-path는 synthetic artifact+success; runner-replacement는 Runner A expiry 후 B fence2 success, A complete 거부 event; unsafe-expiry는 reconciliation waiting, artifact 없음
- [ ] 공백·한글 임시 경로, read-only input, 두 번 실행을 테스트한다. Windows에서는 `.cmd`가 PATH에 있어도 선택하지 않고 검증된 pnpm JS entry를 Node로 실행하는 테스트를 둔다. 입력 hash는 그대로, 각 실행 DB는 독립, stdout/stderr에 fixture secret 문자열 없음
- [ ] 테스트 실패를 확인하고 CLI/doctor/fixture를 구현한다. `PRODUCT_NAME`은 표시 이름만 바꾸며 ID/결과 digest/테이블에 영향을 주지 않는다
- [ ] 실제 명령 3개와 전체 `pnpm check`를 실행한다. README에 복사 가능한 설치 절차, 현재 구현/미구현, local-only 상태, native 도구 제한을 기록한다
- [ ] `feat(cli): demonstrate portable local config and runner-replacement workflow` 커밋

## Task 7: 깨끗한 설치·CI·리뷰·게시

**Files:** `.github/workflows/ci.yml`, clean-install script, local-foundation 문서, README, roadmap 진행 상태

- [ ] clean-install script의 실패 테스트를 작성한다. 임시 export에 lockfile이 없거나 frozen install이 변경하면 실패하고 원본 checkout을 변경하지 않는다
- [ ] registry에서 일반 공개 dev dependency만 받고 install scripts를 실행하지 않는 frozen install을 사용한다. 현재 구현에 native package build가 필요해지면 계획 변경 이유와 추가 설치 위험을 검토한다
- [ ] fresh source export와 별도 pnpm store로 설치 → build/typecheck/test → doctor/config/simulation을 실행한다. 캐시와 기존 node_modules로 가려지는 의존이 없고 git-tracked file hash가 유지되어야 한다
- [ ] CI를 ubuntu-latest/windows-latest/macos-latest에서 같은 Node24.19.0/pnpm11.19.0로 실행하도록 작성한다. `permissions: contents: read`, checkout credential persistence 해제, Actions는 검증한 공식 commit SHA로 pin, secrets·deployment·PR target workflow 없음
- [ ] lockfile diff, dependency license 목록, dependency audit 결과를 기록한다. release-candidate인 Node SQLite는 local reference adapter에만 쓰며 production D1 검증은 별도라는 제약을 명시한다
- [ ] 전체 test/typecheck/build/clean-install, secret scan, 원문 요구 대조 후 독립 전체 리뷰를 받는다. Critical/Important finding은 수정하고 전체 검증을 다시 실행한다
- [ ] 최신 remote main과 차이를 재확인하고 non-force commit/push한다. 다른 변경이 있으면 rebase/merge 검토하며 덮어쓰지 않는다. 실제 Cloudflare 배포나 권한 등록은 하지 않는다
- [ ] 원격 commit/tree를 검증하고 해당 SHA의 CI가 끝날 때까지 확인한다. 실패하면 원인·수정·재실행, 권한/환경 blocker면 그대로 보고한다. 세 OS 모두 pass일 때만 세 OS 검증 완료로 표시한다
- [ ] README/진행 문서/Notion에 실제 구현 범위와 미완료 영역을 반영하고 exact commit·검증 명령·CI 결과·다음 최소 단계 전달

## 계획 자체 검토 결과

설계 §1~3 → Tasks1/6/7, §4 → Tasks1/2/3, §5 → Task4, §6 → Tasks3/4/5, §7 → Tasks6/7, §8 → 각 task의 실패·경쟁·CLI 테스트, §9 → 전체 제약/Task7, §10 → 본 계획 검토 단계로 대응한다. Vault는 key custody/envelope 설계 문서를 유지하되 암호화 제품 코드를 만들지 않는다. secret redactor는 실제 로그 transport가 생길 다음 단계로 넘기며 이번 단계에서는 raw secret 입력 자체를 지원하지 않는다.

먼저 이 계획을 검토한 뒤 실행 방식을 선택한다. 권장 방식은 **Native 구현 + 독립 전체 리뷰**다. 한 사람이 target/config/job/SQL의 맞물리는 계약을 일관되게 구현하고 마지막 별도 리뷰로 확인하는 편이 이번 크기의 연결된 작업과 일정에 맞는다. **Subagent-driven**을 선택하면 task마다 별도 구현자·리뷰어를 배정하고 마지막 전체 리뷰를 추가한다. 어느 방식이든 테스트·비밀정보 검사·실제 배포 금지 경계는 같다.

## 확인한 기술 자료

- [Node 24.19.0 SQLite API](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html): node:sqlite는 release candidate이며 이번 로컬 reference adapter의 제한으로 고지
- [pnpm install](https://pnpm.io/cli/install): frozen lockfile 동작; 별도 파일 hash 검사도 수행
- [Cloudflare D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/): 다음 D1 adapter 구현 때 batch/transaction semantics를 다시 검증. SQLite 테스트로 대체하지 않음

확인일: 2026-10-06. 위 자료는 제품 구현 완료나 실제 provider 연동의 증거가 아니다.
