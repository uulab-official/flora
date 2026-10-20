# Organization Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 Owner·키·배포 이력을 유지하면서 같은 조직의 팀원과 승인된 새 PC가 앱별 권한으로 기존 연결과 키를 재사용한다.

**Architecture:** 기존 `flora-owner-v1` DO에 사용자·멤버십·권한·감사를 추가하고, 기존 canonical owner/database/app 식별자와 암호문은 그대로 사용한다. 사람의 앱 권한, 개인 Runner 승인, 지속 조직 자동화를 분리한다. D1의 신규 Runner 발급에만 generation별 gate/reservation을 추가하고, 멤버 활성화 전에 기존 Runner를 positive access ledger에 대조한다.

**Tech Stack:** Node 24.19.0, pnpm 11.19.0, TypeScript, Cloudflare Workers/SQLite DO/D1, 기존 Web Crypto·password verifier, node:test, 로컬 Miniflare/workerd, 기존 웹·CLI·PC Runner.

**Spec:** [승인된 조직 접근 설계](../specs/2026-10-19-organization-access-design.md), 커밋 `7f376048e3a888470bd95df66ee4a64b682cb844`.

**Status:** 2026-10-20 KST 구현 계획 검토본. 설계 승인을 구현 계획 승인으로 간주하지 않는다. 제품 코드·키·계정·운영 데이터는 아직 변경하지 않는다.

## Global Constraints

- 한 Flora 설치의 한 조직이 첫 범위다. 기존 관리자는 보호된 bootstrap Owner이며 추가 Owner·이메일 변경·조직 이전은 지원하지 않는다. 표시명은 기존 workspaceName을 사용한다.
- `FLORA_OWNER_ID`, `FLORA_DB_IDENTITY`, origin, DO 이름, 기존 D1 owner/app IDs, verifier·epoch·세션, envelope/AAD·키 버전·OTA trust, Runner credential/lease/job/배포·저널을 조직 도입 때문에 재작성하지 않는다.
- Owner 외에는 명시적 앱 목록과 `admin / deployer / viewer`의 교집합만 허용한다. 새 앱 wildcard·브라우저 필터만의 인가·caller가 만든 grant는 금지한다.
- Owner 포함 raw key/password/provider token export를 만들지 않는다. native에는 기존 distribution/provisioning/keystore pin만 전달하고 APNs/FCM/스토어 키는 전달하지 않는다.
- Owner 기존 요청 15분 5회·KDF 시간당 60회 유지. 팀원은 개별 같은 상한과 비소유자 합계 KDF 시간당 240회. Owner 예산은 분리한다.
- 사용자별 세션 5개·1시간, step-up 5분. nonce 256비트·서버에는 해시만, invite/reactivate 24시간·reset 15분. 링크는 `/join#invite=…`, fragment는 메모리로 옮긴 뒤 제거한다.
- ASCII 이메일 ≤254자, trim/lowercase만 적용하고 Gmail alias 재작성은 하지 않는다. 표시명·PC label 1~80자, 제어문자 금지.
- 목록 기본 25·최대 50, 멤버 쓰기 body ≤16 KiB, 앱 접근 batch ≤100. org 메타데이터 기본 64 MiB·감사 기본 256 MiB, 안전한 운영 설정으로 조정 가능하며 요금제/seat 제한이 아니다.
- PC 요청 대기 24시간, 승인 후 claim 10분, Owner 외 self-approval 금지. 기존 조직 Runner는 개인 sponsor 회수·웹 로그아웃으로 중단하지 않는다.
- D1 예약 행 ≤2 KiB·미소비 ≤100·만료 정리 한 번에 ≤50. DO/D1 분산 원자성을 가정하지 않는다. DO cursor는 await 전에 소비하고 민감 부작용 전 live fence를 재검사한다.
- 기존 원문/감사/복구 이력은 용량 정리 대상이 아니다. 쓰기 실패·불명확 결과를 성공으로 표시하지 않고, 응답 유실을 이유로 mutation을 반복하지 않는다.
- EAS·Actions·유료 제품 활성화·새 polling/alarm·D1 인증 조회를 추가하지 않는다. 기존 API의 Owner 호환과 public SDK 프로토콜을 유지한다.
- 제공자 키 발급/폐기/자동 갱신·푸시 전송·스토어 제출·SSO·이메일 발송·다른 설치로 키 이전은 이 계획에 포함하지 않는다.
- 원본 dirty checkout은 그대로 두고 기존 격리 checkout에서 작업한다. 각 작업은 RED → GREEN → 관련 회귀 → `git diff --check` → 명시한 파일만 로컬 commit(`[skip ci]`) 순서다. push/운영 전환을 각 작업의 자동 후속 단계로 넣지 않는다.

## Review Focus

- RF1: Owner 이메일의 case/공백·동일 이메일 초대·다른 설치의 동일 appId가 기존 Owner 또는 다른 앱의 권한으로 합쳐지지 않는다. Tasks 1, 4, 5.
- RF2: 목록 cursor·body·crypto·D1 await와 계정/앱 전환 사이에 권한이 바뀌면 응답 범위와 신규 부작용을 다시 검사한다. 이미 제출한 결과는 사실대로 남긴다. Tasks 2, 5, 10.
- RF3: 승인자가 강등되거나 claim 응답이 유실된 PC 등록은 토큰 재조회/중복 발급으로 복구하지 않는다. pause·사용자 재활성화도 옛 토큰을 부활시키지 않는다. Tasks 7, 8.
- RF4: 초대/reset의 KDF 도중 상태 변경·만료·예산 소진은 비밀번호와 권한을 되돌리지 않으며, 팀원 트래픽이 Owner 로그인 예산을 소진하지 않는다. Tasks 3, 4.
- RF5: preparing 전 시작한 구버전 enrollment가 D1 barrier 뒤 commit하려는 경우 기존 유효 Runner는 보존하고 미연결 신규 token 성공은 거절한다. reservation 소비도 insert 실패와 함께 rollback한다. Tasks 6, 8.

## File Structure and Dependency Order

모두 저장소 상대 경로다. 아래 표에서 `org/` 및 source 파일명은 `packages/cloudflare/src/`, `public/`은 `packages/cloudflare/`, `test/`는 `packages/cloudflare/` 기준이며 `migrations/`는 `packages/cloudflare/` 기준이다. `scripts/`, `tests/`, `docs/`와 `packages/`로 시작하는 경로는 저장소 루트 기준이다. 새 모듈을 아래 책임으로 나누고 auth-do 전체를 다른 프레임워크로 재작성하지 않는다.

| 경계 | 생성/수정 파일과 책임 |
| --- | --- |
| 자료형·저장 | `org/types.ts`, `org/schema.ts`, `org/store.ts`: 11개 DO 테이블, 기존 Owner 결합·revision·예산·감사 |
| 인가 | `org/policy.ts`, `org/route-policy.ts`: 역할/앱/action 판정과 route 목록; `contracts.ts`, `auth-do.ts`: 실제 grant/fence; `config.ts`: 운영 예산 설정 |
| 사람 인증 | `org/member-auth.ts`, `org/invitations.ts`, `org/http.ts`: 팀원 세션·KDF 예산·step-up·초대·멤버 API |
| 감사 | `org/audit.ts`: DO 변경 사건과 외부 작업 intent/결과; 기존 Vault/운영 이력에 별도 actor 참조 |
| PC 접근 | `org/runner-access.ts`, `org/runner-registration.ts`: sponsor/요청/승인/회수와 OTA/native adapter |
| D1 발급·전환 | `org/runner-gate.ts`, `org/migration.ts`, `migrations/0014_org_runner_access.sql`: gate·reservation·기존 Runner 대조 |
| 배포 호환 | `org/protocol.ts`, `scripts/org-access/preflight.mjs`, `scripts/org-access/ui-qa.mjs`, build manifest: 최소 protocol 확인·pause/restore 규칙 |
| 범위 있는 기존 API | `hosted-api.ts`, `contracts.ts`, `d1-import-store.ts`, `operations-store.ts`, `automation-store.ts`, `native-build-store.ts`, `credential-vault.ts`, `auth-do.ts` |
| 웹 | `public/organization.{js,css,d.ts}`, `public/account-security.{js,d.ts}`, `public/join.{js,css,d.ts}`, `admin-routes.{js,d.ts}`, `app.js`, `auth.js`, `index.html`, `http.ts`, `scripts/build-cloudflare.mjs` |
| CLI·문서 | `packages/cli/src/setup/runner.ts`, `packages/cli/test/setup-runner.test.ts`, README 한국어/영어, 새 `docs/development/organization-access.ko.md` |
| 검증 | `test/org-*.test.ts`, `test/fixtures/org-entry.ts`, `test/org-fixtures.ts`, `tests/organization-e2e.test.ts`; 기존 auth/Vault/native/automation/SDK 테스트 유지 |

의존 순서: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. 뒤 작업이 끝나기 전 팀원·개인 PC의 active 사용을 열지 않는다. 기존 Owner와 기존 서비스는 owner_only에서 계속 검증한다.

## Shared Interfaces

정의 위치는 `packages/cloudflare/src/org/types.ts`다. 아래 이름을 인접 작업에서 바꾸어 부르지 않는다. storage 타입은 기존 DO 생성자의 `storage` 타입, password/session/Runner 타입은 기존 타입을 import한다.

```ts
type OrgMode = 'owner_only' | 'preparing' | 'active' | 'paused';
type OrgRole = 'owner' | 'admin' | 'deployer' | 'viewer';
type OrgAction = 'org.self' | 'org.manage' | 'app.read' | 'app.deploy'
  | 'app.manage' | 'credential.read' | 'credential.manage'
  | 'runner.request' | 'runner.approve' | 'runner.organization';
type RunnerKind = 'ota' | 'native';
type ActorRef = { kind: 'human' | 'runner' | 'webhook' | 'system'; id: string };
interface OrgState { id: string; ownerId: string; dbIdentity: string; origin: string;
  mode: OrgMode; revision: number; orgAccessEpoch: number; minProtocol: number }
interface OrgPrincipal { organizationId: string; userId: string; membershipId: string;
  role: OrgRole; authSource: 'legacy_owner' | 'member'; authEpoch: number;
  membershipRevision: number; ownerEpoch: number; sessionHash: string; expiresAt: number }
interface OrgGrant extends AuthGrant { principal: OrgPrincipal }
interface OrgPage<T> { items: T[]; nextCursor: string | null }
interface OrgBinding { ownerId: string; ownerEmail: string; dbIdentity: string; origin: string; workspaceName?: string }
interface OrgMemberState { userId: string; membershipId: string; role: OrgRole;
  userStatus: 'active' | 'disabled'; membershipStatus: 'active' | 'disabled';
  authEpoch: number; membershipRevision: number }
interface OrgLimits { metadataBytes: number; auditBytes: number }
interface OrgSelfView { organizationId: string; userId: string; membershipId: string;
  displayName: string; role: OrgRole; permissionRevision: number; appIds: string[];
  capabilities: OrgAction[] }
interface OrgDisplayView { id: string; name: string; mode: OrgMode; revision: number }
interface OrgMemberView { userId: string; membershipId: string; displayName: string;
  email: string; role: OrgRole; status: 'active'|'disabled'; revision: number; appIds: string[] }
interface AuditIntent { id: string; actor: ActorRef; action: OrgAction; appId?: string;
  membershipRevision?: number; state: 'pending' | 'completed' | 'rejected' | 'unknown' }
interface RunnerAccessRef { kind: RunnerKind; runnerId: string }
interface OrgCheckpoint { schemaVersion: 1; origin: string; ownerId: string; dbIdentity: string;
  organizationId: string; minProtocol: number; revision: number; orgAccessEpoch: number;
  auditSequence: number; mode: OrgMode; observedAt: number }
```

아래 입력형의 나머지 저장 열은 spec §5의 불변식을 따른다. 사람에게 반환하는 DTO는 password/session/nonce/token 해시를 제외한다. `MembershipInput={expectedRevision:number;role:'admin'|'deployer'|'viewer';addAppIds:string[];removeAppIds:string[]}`, `InvitationInput={purpose:'invite'|'reset'|'reactivate';email:string;targetUserId?:string;expectedRevision:number;role?:Exclude<OrgRole,'owner'>;appIds?:string[]}`이다. invite/reactivate만 role/appIds를 받고 reset은 해당 필드를 거절한다. invite의 expectedRevision은 org revision, reset/reactivate는 대상 membership revision이다. 다음 요청 DTO와 모든 시각은 epoch milliseconds로 고정한다.

```ts
interface RunnerRequest { id: string; appId: string; kind: RunnerKind; name: string;
  platforms: ('ios'|'android')[]; requesterUserId: string; approverUserId: string|null;
  state: 'pending'|'approved'|'issuing'|'claimed'|'revoked'|'unknown';
  revision: number; requestedAt: number; expiresAt: number; claimExpiresAt: number|null;
  runnerId: string|null }
```

이 DTO는 개인 요청용이다. 조직 Runner는 Owner 전용 기존 enrollment adapter로 생성하며 서버에서 organization 소유 모드를 고정한다. 승인자 snapshot·sponsor epoch·미확정 발급 참조는 서버 행에만 둔다. native 요청의 platforms 길이는 정확히 1, OTA는 중복 없는 1~2개다.

테스트 공통 fixture는 `test/org-fixtures.ts`에 `createOrgFixture(t: TestContext): Promise<OrgFixture>`로 둔다. `OrgFixture`는 `runtime`(기존 createTestRuntime 결과), `owner`(cookie/CSRF), `request(actor: TestSession|null, method:string, path:string, body?:unknown):Promise<Response>`, `control(input:Record<string,unknown>):Promise<Response>`, `snapshot():Promise<PreservationSnapshot>`을 제공한다. `TestSession={cookie:string;csrfToken:string}`; `PreservationSnapshot`은 원본 auth/verifier/epoch/session·키 envelope·연결·정책·Runner/lease/job/배포의 비교 가능한 정렬 결과이며 비밀은 테스트 메모리에서만 비교한다. fixture용 control은 로컬 entry에서만 clock/reconstruct/지연 fence/쓰기 실패/SQL 검사에 사용하며 production bundle에 넣지 않는다. `native-http.test.ts`의 실제 owner 등록과 synthetic D1 migration 패턴을 재사용한다.

아래 test 코드는 각 이름의 **핵심 assert 발췌**다. Step 1에 적은 fixture 상태와 실제 production API/저장 메서드로 before/after를 구성한다. 원문 비밀을 assert 실패 메시지나 결과 로그에 넣지 않는다. 테스트를 쓰기 전에 production 구현을 추가하지 않는다. 첫 RED 전에 기존 HEAD의 `pnpm build`로 dist 의존 fixture를 준비한다. RED의 명령은 명시된 assert 또는 새 모듈 부재로 실패해야 한다. 매 GREEN은 먼저 다시 build하므로 이전 dist로 통과시키지 않는다. 아래 GREEN/Verify는 exit 0과 모든 지정 테스트 PASS가 합격 조건이며, 검증 대상 assertion의 skip은 통과로 계산하지 않는다.

---

### Task 1: Additive 조직 저장과 기존 Owner 연결

**Files:** Create `packages/cloudflare/src/org/{types,schema,store,audit}.ts`, `packages/cloudflare/test/{org-store.test.ts,org-fixtures.ts,fixtures/org-entry.ts}`; Modify `packages/cloudflare/src/auth-do.ts`(초기화 연결만), `packages/cloudflare/src/config.ts`, `packages/cloudflare/src/contracts.ts`, `packages/cloudflare/test/config.test.ts`.

**Interfaces:** `OrgStore(storage,binding:OrgBinding,limits?:OrgLimits)`, `bootstrap(owner:{epoch:number;claimed:boolean},now:number):OrgState`, `state():OrgState`, `member(userId:string):OrgMemberState|null`, `setAccess(actor:OrgPrincipal,userId:string,input:MembershipInput,now:number):void`; `OrgAudit(storage).begin(input:Omit<AuditIntent,'id'|'state'>,now:number,fence:()=>void):AuditIntent`, `settle(id:string,state:'completed'|'rejected'|'unknown',refs:Record<string,string>,now:number):void`. 모두 동기 DO 저장 계약이며 내부 transaction/fence를 생략하지 않는다.

- [ ] **Step 1 — RED:** `bootstrap_adds_only_org_rows`, `bootstrap_rejects_identity_drift`, `protected_owner_and_atomic_budget`, `RF1_owner_email_is_reserved`, `configured_limits_reject_invalid_or_unsafe_bytes`를 작성한다. 등록/미등록 fixture, 기존 Owner 세션·암호문·진행 중 lease를 준비하고 재구성·중복 bootstrap·예산 초과 쓰기를 실행한다.
  ```ts
  assert.deepEqual(after.originalRows, before.originalRows);
  assert.equal(after.organization.mode, 'owner_only');
  assert.equal(rejected.code, 'ORG_ACCESS_CAPACITY');
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-store.test.ts`. 새 store가 없거나 보존 계약 assert로 실패해야 하며 외부 네트워크 실패를 RED로 인정하지 않는다.
- [ ] **Step 3 — Implement:** 11개 테이블/index를 spec §5대로 생성하고 bootstrap Owner는 기존 verifier 참조만 만든다. ID·Owner 예약 이메일·양의 revision/epoch·표시명·body·UTF-8 실제 증가량·권한 축소 안전 사건의 별도 경로를 검증한다. `readConfig(env)`에 optional decimal string `FLORA_ORG_METADATA_BYTES`/`FLORA_ORG_AUDIT_BYTES`를 추가해 `FloraConfig.orgLimits:OrgLimits`로 전달한다(기본 67,108,864/268,435,456 bytes). 양의 safe integer만 허용하고 잘못된 설정은 기존 configuration 오류로 거절하며 HTTP 입력으로 예산을 덮어쓰지 않는다. 감사 사건은 최대 2 KiB다. 변경·예산·감사는 한 transactionSync에 넣고 role/권한 검사 실패 시 원본과 카운터도 rollback한다. 새 storage 실패는 고정 오류로 반환하며 성공한 회수를 허위로 표시하지 않는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-store.test.ts packages/cloudflare/test/config.test.ts packages/cloudflare/test/auth.test.ts packages/cloudflare/test/credential-vault.test.ts`. 원래 테이블 hash·Owner epoch/session과 Vault round-trip이 같아야 한다.
- [ ] **Step 5 — Commit:** 위 Task 1 파일만 stage; `docs`가 아닌 `feat(org): add additive owner-bound organization storage [skip ci]`로 로컬 commit한다.

### Task 2: 현재 권한을 재검사하는 grant와 역할 판정

**Files:** Create `packages/cloudflare/src/org/policy.ts`, `packages/cloudflare/test/org-policy.test.ts`; Modify `packages/cloudflare/src/contracts.ts`, `packages/cloudflare/src/auth-do.ts`, `packages/cloudflare/src/org/store.ts`.

**Interfaces:** `OrgPolicy(store:OrgStore)`, `resolveLegacy(grant:AuthGrant,now:number):OrgPrincipal`, `require(principal:OrgPrincipal,action:OrgAction,appId:string|undefined,now:number):void`, `fence(principal:OrgPrincipal,action:OrgAction,appId?:string):()=>void`, `visibleApps(principal:OrgPrincipal,cursor:string|null,limit:number):OrgPage<string>`. 기존 `FloraAuth.requireSession`은 반환형을 `Promise<OrgGrant>`로 확장하되 기존 AuthGrant 소비자와 호환한다. `assertCurrent(grant:AuthGrant)`는 서버가 발급·WeakSet에 등록한 객체와 연결된 principal만 검증한다.

- [ ] **Step 1 — RED:** 역할 표 전체의 parameterized allow/deny, `foreign_app_is_404`, `forged_grant_is_denied`, `RF2_after_await_revision_change`, `paused_member_reads_are_denied`, `owner_compatibility`, `auth_point_lookups_bounded`를 쓴다. 두 앱의 서로 다른 접근과 권한 변경 전 캡처한 fence를 사용한다.
  ```ts
  assert.equal(forbiddenApp.status, 404);
  assert.equal(viewerMutation.status, 403);
  assert.equal(writesAfterRevocation, 0);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-policy.test.ts`. 존재하는 앱 ID만 바꾸어 성공하거나 복제한 grant가 허용되면 실패다.
- [ ] **Step 3 — Implement:** Owner 저장 identity와 새 principal을 분리한다. 현재 mode/user/authEpoch/membership revision/명시 앱 접근을 검사하고 `appId`가 필요한 action의 누락을 거절한다. grant에 role을 넣었다고 현재 행 검사를 건너뛰지 않는다. SQL cursor는 동기 소비하고 app scope 밖과 unknown app을 동일하게 거절한다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-policy.test.ts packages/cloudflare/test/auth.test.ts`. 인가 때문에 D1 인증 조회가 발생하지 않아야 한다. 기본 세션/사용자/멤버십/앱 접근은 최대 4개 indexed point lookup인지 계측하며 기존 config/epoch 검사와 await 뒤 live fence 재검사는 별도 계측한다.
- [ ] **Step 5 — Commit:** Task 2 파일만 `feat(org): enforce live app-scoped capabilities [skip ci]`.

### Task 3: 팀원 로그인·세션·재인증·비밀번호 변경

**Files:** Create `packages/cloudflare/src/org/member-auth.ts`, `packages/cloudflare/test/org-auth.test.ts`; Modify `packages/cloudflare/src/auth-do.ts`, `packages/cloudflare/src/org/store.ts`, `packages/cloudflare/test/fixtures/org-entry.ts`; 기존 `packages/cloudflare/src/auth-state.ts`, `packages/cloudflare/src/auth/password.ts`는 verifier/Owner 세션 계약을 재사용한다.

**Interfaces:** `MemberAuth(store:OrgStore)`, `login(email:string,password:string,now:number):Promise<{session:NewSession;principal:OrgPrincipal;sessionToken:string;csrfToken:string}>`, `session(sessionHash:string,now:number):OrgPrincipal`, `logout(principal:OrgPrincipal,now:number):void`, `reauth(principal:OrgPrincipal,password:string,now:number):Promise<void>`, `changePassword(principal:OrgPrincipal,current:string,next:string,confirmation:string,now:number):Promise<void>`. raw token 결과는 HTTP 응답용 메모리에서만 사용한다.

- [ ] **Step 1 — RED:** `member_sessions_do_not_evict_owner`, `sixth_session_evicts_only_same_user`, `RF4_member_budget_cannot_starve_owner`, `member_password_change_revokes_old_sessions`, `owner_recover_invalidates_members`, `ambiguous_session_source_fails_closed`를 쓴다. TTL 경계·epoch 변경·알 수 없는 이메일·KDF 대기 중 권한 변경도 포함한다.
  ```ts
  assert.equal(ownerSessionAfterMemberBurst.status, 200);
  assert.equal(oldMemberSession.status, 401);
  assert.equal(publicUnknownError, publicWrongPasswordError);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-auth.test.ts`.
- [ ] **Step 3 — Implement:** 기존 Owner 이메일 경로를 보존하고 member/unknown 예산을 분리한다. 미등록/owner_only/preparing/paused에서 member 로그인은 거절한다. 기존 `createPasswordVerifier`/`verifyPassword`와 배포별 minimum을 쓰며 crypto 후 transaction에서 auth snapshot을 재확인한다. `/api/auth/login|session|logout` 호환, `POST /api/auth/reauth`, `POST /api/auth/member/password`를 연결한다. Secure/HttpOnly/SameSite·CSRF·무대기 BUSY와 제한된 body를 유지한다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-auth.test.ts packages/cloudflare/test/auth.test.ts packages/cloudflare/test/password.test.ts`. 기존 enrollment/recover/setup renew 테스트도 그대로 통과해야 한다.
- [ ] **Step 5 — Commit:** Task 3 파일만 `feat(org): add isolated member authentication and sessions [skip ci]`.

### Task 4: 초대·reset/reactivate와 멤버 관리 API

**Files:** Create `packages/cloudflare/src/org/{invitations,http}.ts`, `packages/cloudflare/test/org-invitations.test.ts`; Modify `packages/cloudflare/src/auth-do.ts`, `packages/cloudflare/src/org/store.ts`, `packages/cloudflare/test/fixtures/org-entry.ts`.

**Interfaces:** `InvitationService(store:OrgStore,auth:MemberAuth)`, `issue(actor:OrgPrincipal,input:InvitationInput,now:number):Promise<{id:string;nonce:string;expiresAt:number}>`, `preview(nonce:string,now:number):Promise<{organizationName:string;maskedEmail:string;role:OrgRole;appCount:number}>`, `accept(input:{nonce:string;email:string;password:string;confirmation:string},now:number):Promise<NewMemberSession>`, `revoke(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):void`; `type NewMemberSession = Awaited<ReturnType<MemberAuth['login']>>`로 정의한다. `handleOrgHttp(request:Request,context:OrgHttpContext):Promise<Response|null>`를 이 작업에서 정의하고 `OrgHttpContext={store:OrgStore;policy:OrgPolicy;auth:MemberAuth;invitations:InvitationService;grant:OrgGrant|null;now:()=>number}`로 context를 정의한다. null grant는 preview/accept에만 허용한다. Task 7/8의 서비스는 이 context에 명시적으로 추가한다.

- [ ] **Step 1 — RED:** `RF1_reserved_and_normalized_email`, `nonce_accepts_once`, `RF4_reset_after_kdf_cannot_restore_old_access`, `reset_does_not_reactivate`, `reactivate_preserves_user_id`, `lost_accept_response_login_recovers`, `step_up_and_csrf_required`를 쓴다. revision/Owner epoch/purpose generation을 KDF 전·중·후 변경하고 nonce 원문 비노출을 검사한다.
  ```ts
  assert.equal(acceptSuccessCount, 1);
  assert.deepEqual(afterReset.appAccess, currentAccess);
  assert.equal(oldNonceAfterRoleChange.status, 403);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-invitations.test.ts`.
- [ ] **Step 3 — Implement:** spec §7·§13의 organization/members/invitations, revoke, access, disable, preview, accept API를 연결한다. Owner 외 멤버 관리를 거절하고 Owner 삭제/강등을 막는다. active 전에는 초대·수락·새 개인 PC 발급을 열지 않는다. nonce는 hash만 저장하고 수락은 계정·세션·소비·감사를 원자적으로 확정한다. reset payload의 role/appIds를 거절한다. 재발급/권한 변경/비밀번호 변경이 이전 nonce를 무효화하며 accept 응답 유실에 nonce로 암호를 다시 바꾸지 않는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-invitations.test.ts packages/cloudflare/test/org-auth.test.ts`. 실제 이메일 발송·계정 추가·외부 제공자 호출은 없다.
- [ ] **Step 5 — Commit:** Task 4 파일만 `feat(org): add one-time invitations and protected membership management [skip ci]`.

### Task 5: 기존 관리 API 전체에 앱 범위와 감사 연결

**Files:** Create `packages/cloudflare/src/org/route-policy.ts`, `packages/cloudflare/test/org-scope-http.test.ts`; Modify `packages/cloudflare/src/{auth-do,hosted-api,contracts,d1-import-store,operations-store,credential-vault}.ts`, `packages/cloudflare/src/org/{audit,http}.ts`, `packages/dashboard/src/{operations,automation}-http.ts`의 scope 전달 계약.

**Interfaces:** `managementRequirement(method:string,pathname:string):{action:OrgAction;appId?:string;ownerOnly:boolean}`(알 수 없는 관리 route는 ownerOnly); `ReadScope={appIds:readonly string[];permissionRevision:number}`; 기존 hosted/store factory에 서버가 만든 `ReadScope`를 optional 인자로 추가한다(Owner는 생략해 기존 결과 유지). `begin/settle`은 Task 1, `/api/me`는 `OrgSelfView`, `/api/organization`은 `OrgDisplayView`, Owner의 멤버 목록은 `OrgPage<OrgMemberView>`만 반환한다. internal principal/sessionHash/epoch/dbIdentity는 웹 응답에 넣지 않는다.

- [ ] **Step 1 — RED:** `all_management_routes_are_classified`, `RF1_two_installations_same_app_id_are_isolated`, `RF2_scoped_cursor_and_after_submit_revoke`, `viewer_cannot_import_or_rollback`, `deployer_cannot_change_policy`, `credential_metadata_is_role_scoped`, `github_search_is_owner_only`를 실제 HTTP로 쓴다. root summary·import/baseline/log·native/credential/CI/usage의 전역 경로도 공격한다.
  ```ts
  assert.deepEqual(memberProjectIds, allowedAppIds);
  assert.equal(remoteWritesBeforeRevokedSubmit, 0);
  assert.equal(alreadySubmittedWriteCount, 1);
  assert.equal(settledActualResult.state, 'completed');
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-scope-http.test.ts`.
- [ ] **Step 3 — Implement:** 응답을 만들기 전에 DO의 앱 ID 페이지를 D1 조회 조건에 전달한다. 빈 페이지를 무한 채움 하지 않는다. cursor를 org/user/권한 revision/filter에 결합한다. Vault의 canonical 암호화 context는 바꾸지 않고 `actor`만 별도 새 감사에 연결한다. async body/crypto/조회/외부 제출 직전에 live fence를 넣는다. 외부 변경은 영속 intent → 1회 제출 → completed/rejected/unknown이며, 권한 회수 후 결과 기록은 기존 intent만 마감한다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-scope-http.test.ts packages/cloudflare/test/credential-http.test.ts packages/cloudflare/test/operations-http.test.ts packages/cloudflare/test/native-http.test.ts`. original Owner JSON과 public SDK는 아직 그대로여야 한다.
- [ ] **Step 5 — Commit:** Task 5 파일만 `feat(org): scope management reads and writes with durable audit intents [skip ci]`.

### Task 6: D1 신규 Runner 발급 barrier와 reservation

**Files:** Create `packages/cloudflare/migrations/0014_org_runner_access.sql`, `packages/cloudflare/src/org/runner-gate.ts`, `packages/cloudflare/test/org-runner-gate.test.ts`; Modify `packages/cloudflare/src/automation-store.ts`, `packages/dogfood/src/automation.ts`, `packages/dogfood/test/automation.test.ts`, `packages/cloudflare/test/org-fixtures.ts`의 synthetic migration 목록.

**Interfaces:** `RunnerGate(db,ownerId:string)`, `block(generation:number,operationId:string):Promise<GateReceipt>`, `reserve(input:{runnerId:string;operationId:string;appIds:string[];generation:number}):Promise<void>`, `seal(generation:number):Promise<GateReceipt>`, `read():Promise<GateReceipt>`; `GateReceipt={ownerId:string;generation:number;phase:'blocked'|'ledger_only';protocol:1}`. `AutomationService.enrollRunner(input:RunnerEnrollmentInput,allocation?:{runnerId:string}):Promise<RunnerEnrollment>`에 server-only 선택 ID를 추가한다. HTTP의 enrollment body는 그대로라 caller ID는 받지 않는다.

- [ ] **Step 1 — RED:** `RF5_late_old_enrollment_cannot_cross_barrier`, `reservation_consumption_rolls_back_on_capacity_failure`, `reservation_scope_generation_and_reuse_rejected`, `existing_revoke_and_leases_are_unchanged`, `expired_cleanup_is_bounded`를 real local D1로 쓴다. 구버전 insert를 barrier 전부터 보류했다가 blocked와 ledger_only 각각에서 재개한다.
  ```ts
  assert.equal(successfulUnlinkedTokens, 0);
  assert.equal(afterFailedInsert.reservationConsumed, false);
  assert.deepEqual(after.existingRunnerVersions, before.existingRunnerVersions);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-runner-gate.test.ts`.
- [ ] **Step 3 — Implement:** gate/reservation 및 version=1 전용 guard만 추가한다. immutable/accounting/기존 trigger와 업무 행을 수정하지 않는다. blocked 생성과 guard 설치의 DB 경계를 검증하고 ledger_only에서는 현재 generation/owner/id/정확한 앱 범위의 예약을 insert와 같은 transaction에서 한 번 소비한다. 실패한 batch는 예약도 원복한다. schema 적용 자체만으로 운영 gate를 켜지 않고 Owner 준비 절차가 명시적으로 해당 owner를 block한다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-runner-gate.test.ts packages/cloudflare/test/automation-store.test.ts packages/dogfood/test/automation.test.ts`. guard를 업데이트/revoke/history insert에 잘못 적용하지 않아야 한다.
- [ ] **Step 5 — Commit:** Task 6 파일만 `feat(org): fence Runner issuance with D1 reservations [skip ci]`.

### Task 7: PC 요청·승인·claim과 원자적 접근 행

**Files:** Create `packages/cloudflare/src/org/{runner-access,runner-registration}.ts`, `packages/cloudflare/test/org-runner-registration.test.ts`; Modify `packages/cloudflare/src/org/http.ts`, `packages/cloudflare/src/auth-do.ts`, `packages/cloudflare/src/native-build-store.ts`, `packages/cloudflare/test/fixtures/org-entry.ts`.

**Interfaces:** `RunnerAccess(store:OrgStore)`, `request(actor:OrgPrincipal,appId:string,input:{kind:RunnerKind;name:string;platforms:('ios'|'android')[]},now:number):RunnerRequest`, `approve(actor:OrgPrincipal,id:string,expectedRevision:number,now:number):RunnerRequest`, `claim(actor:OrgPrincipal,id:string,expectedRevision:number):Promise<RunnerEnrollment|{runner:NativeRunnerSummary;token:string}>`, `revoke(actor:OrgPrincipal,ref:RunnerAccessRef,now:number):void`, `assertService(ref:RunnerAccessRef,appId:string,platform:string|undefined,now:number):void`. `RunnerRequest`는 Shared Interfaces의 안전한 DTO다. request/approve/revoke는 `RunnerAccess` 메서드, 외부 await가 필요한 claim은 `RunnerRegistration(access:RunnerAccess,gate:RunnerGate,automation:AutomationService,native:NativeBuildStore)` 메서드로 정의한다. `OrgHttpContext`에 `runnerAccess:RunnerAccess;runnerRegistration:RunnerRegistration`을 추가한다. `NativeBuildStore.enroll`에 내부 옵션 `{runnerId?:string;onInserted?:(runner:NativeRunnerSummary)=>void}`를 추가하고 callback은 기존 native insert transaction 안에서만 호출한다.

- [ ] **Step 1 — RED:** `RF3_approver_demotion_and_claim_timeout`, `self_approval_requires_owner`, `claim_response_loss_never_reissues`, `native_access_and_credential_roll_back_together`, `ota_unknown_is_not_ready`, `one_personal_pc_revoke_preserves_other_pc`를 쓴다. 승인 후 요청자·승인자 revision 변경, 응답 유실/abort/재구성, 같은 PC의 OTA/native 별도 토큰을 포함한다.
  ```ts
  assert.equal(secondClaimReturnsRawToken, false);
  assert.equal(unknownAccess.state, 'unknown');
  assert.equal(unrelatedRunnerStillAuthorized, true);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-runner-registration.test.ts`.
- [ ] **Step 3 — Implement:** Task 6 서버 예약 ID로 DO pending → D1 reservation/발급 → 결과 확인 → ready를 연결한다. native는 한 DO transaction에서 credential/access/감사를 확정한다. approved → issuing CAS는 한 번만 성공하고 유실을 approved로 되돌리지 않는다. 요청자 본인의 claim과 승인자 현재 권한을 재검사한다. 모든 spec §13 runner-request API와 Owner의 기존 발급 adapter를 연결하되 preparing/unknown에서는 신규 발급을 닫는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-runner-registration.test.ts packages/cloudflare/test/native-build-store.test.ts packages/cloudflare/test/native-http.test.ts`.
- [ ] **Step 5 — Commit:** Task 7 파일만 `feat(org): add approved individual Runner registration [skip ci]`.

### Task 8: 기존 Runner 대조·활성화·pause·배포 protocol

**Files:** Create `packages/cloudflare/src/org/{migration,protocol}.ts`, `packages/cloudflare/test/org-migration.test.ts`, `scripts/org-access/{preflight,preflight.test}.mjs`; Modify `packages/cloudflare/src/org/{http,runner-access}.ts`, `packages/cloudflare/src/auth-do.ts`, `scripts/build-cloudflare.mjs`.

**Interfaces:** `OrgMigration(store:OrgStore,gate:RunnerGate,adapters:MigrationAdapters)`, `prepare(actor:OrgPrincipal,expectedRevision:number):Promise<MigrationReceipt>`, `step(actor:OrgPrincipal,expectedRevision:number):Promise<MigrationReceipt>`, `activate(actor:OrgPrincipal,expectedRevision:number):Promise<OrgState>`, `pause(actor:OrgPrincipal,expectedRevision:number):OrgState`, `resume(actor:OrgPrincipal,expectedRevision:number):OrgState`. `MigrationReceipt={phase:OrgMode;revision:number;generation:number;linked:number;nextCursor:string|null;minProtocol:number;gate:GateReceipt|null;checkpoint:OrgCheckpoint}`. `MigrationAdapters`는 `otaPage(cursor:string|null):Promise<OrgPage<RunnerCredential>>`와 `nativePage(cursor:string|null):Promise<OrgPage<NativeRunnerCredential & {ownerEpoch:number}>>`를 제공하며 최대 50개 최신 자격 행을 stable ID 순서로 반환한다. raw token은 없다. `assertProtocol(current:number,candidate:number):void`는 downgrade와 unknown을 거절한다. `OrgHttpContext`에 `migration:OrgMigration`을 추가한다. preflight는 `checkOrgProtocol(input:{origin:string;artifactPath:string;sessionCookie:string;ledgerDirectory:string},deps:{fetch:typeof fetch;readFile:typeof import('node:fs/promises').readFile}):Promise<{ready:true;current:number;candidate:number;checkpoint:OrgCheckpoint}>`를 export하고 CLI 실행은 import 시 시작하지 않는다. 테스트에서는 bounded stdin·인증 오류·redirection·timeout·unknown 응답·비밀 비노출을 검사하며 HTTPS 단일 origin의 GET 한 번만 허용한다. `recordOrgCheckpoint(directory:string,checkpoint:OrgCheckpoint):Promise<void>`도 같은 script에서 export한다. 운영 외부 원장은 별도 0700 디렉터리의 immutable 0600 checkpoint 파일로 만들고 기존 설치/Runner 저널을 덮어쓰지 않는다. 이전 checkpoint보다 protocol/revision/orgAccessEpoch/auditSequence가 낮거나 identity가 다르면 거절한다. 활성화·중지와 복원 준비 시 최신 checkpoint를 별도로 확보하며 최신 회수 상태를 입증할 수 없으면 온라인 복원을 거절한다. rename/fsync 실패·symlink·동시 기록은 성공으로 숨기지 않는다. `preflight.test.mjs`가 이 저장·경합 계약도 검증한다.

- [ ] **Step 1 — RED:** `RF5_migration_rechecks_barrier_and_scope`, `resume_preparing_after_lost_reply`, `RF3_pause_resume_cannot_revive_personal_tokens_or_approvals`, `legacy_org_services_and_epoch_survive`, `incompatible_rollback_and_unknown_protocol_blocked`, `stale_revocation_restore_never_opens_member_access`를 작성한다. 도중 revoke, Owner recover, gate 불명확, 지연된 old insert도 포함한다.
  ```ts
  assert.deepEqual(after.originalAuthority, before.originalAuthority);
  assert.equal(resumedOldPersonalToken.status, 403);
  assert.equal(candidateProtocolZero.ready, false);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-migration.test.ts`와 `node --test scripts/org-access/preflight.test.mjs`.
- [ ] **Step 3 — Implement:** spec §15 순서를 고정하고 barrier 확인 전 열거·ledger_only 전 active·active 후 owner_only 복귀를 거절한다. 기존 tokens/epochs/leases를 재생성하지 않고 legacy organization 접근 행을 추가한다. pause는 orgAccessEpoch를 증가시켜 개인 token/미소비 승인을 영속 무효화한다. 최초 org-aware owner_only 코드 배포 후, 인증된 GET access-migration에서 protocol을 조회하는 preflight를 필수로 둔다. 이후 unknown/구버전 artifact는 거절하고 비org 코드로 rollback하지 않는다. restore는 기존 AuthState 주석의 운영 계약(public-auth offline·최신 setup generation 대조)을 유지한다. 이것을 기존 자동 복원 API라고 가정하지 않는다. org-aware paused 상태에서만 최신 외부 checkpoint의 revision/epoch/auditSequence를 대조하고 오래된 snapshot은 preflight가 거절하는 테스트를 작성한다. 자동 backup/restore 엔진이나 오래된 DB의 자동 권한 복구는 만들지 않는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck` 후 위 두 테스트 명령을 실행해 모두 PASS여야 한다. build는 `packages/cloudflare/dist/authz-protocol.json`에 `{schemaVersion:1,organizationAccess:1}`을 출력한다. preflight CLI는 `--origin <HTTPS> --artifact <manifest> --ledger /절대경로/org-checkpoints`, Owner session cookie는 최대 16 KiB stdin JSON 한 줄에서 메모리로만 받아 인증된 access-migration GET을 한 번 수행한다. 검증된 Owner 전용 migration 응답의 checkpoint만 성공 후 원장에 추가한다. 출력은 고정 코드/protocol뿐이며 비밀·raw error·자동 복구가 없다. 첫 배포 전 새 API가 없다는 사실을 legacy 안전의 증거로 쓰지 말고, 마지막 배포 체크포인트에서 기존 식별자를 확인한다.
- [ ] **Step 5 — Commit:** Task 8 파일만 `feat(org): add resumable access cutover and protocol guards [skip ci]`.

### Task 9: 모든 서비스 주체의 접근 회수와 지속성

**Files:** Create `packages/cloudflare/test/org-service-authority.test.ts`; Modify `packages/cloudflare/src/auth-do.ts`, `packages/cloudflare/src/org/{runner-access,audit}.ts`, `packages/cloudflare/src/native-build-store.ts`(기존 fence 호출 보존).

**Interfaces:** Task 7 `assertService`를 OTA/native/기존 CI 인증 후·각 async 경계·D1 submit/키 이용 전에 적용한다. `serviceActor(kind:'runner'|'webhook'|'system',id:string):ActorRef`를 org/audit에 추가한다. 브라우저 Owner grant로 위장하지 않는다.

- [ ] **Step 1 — RED:** `revoked_personal_runner_denied_on_every_machine_route`, `shared_org_runner_survives_member_departure`, `webhook_policy_is_not_creator_session`, `already_submitted_result_is_retained`, `public_sdk_protocol_unchanged`를 모든 endpoint로 검사한다. source/upload/finalize/credentials/presence·CI admission/checkpoint·자동 rollback도 포함한다.
  ```ts
  assert.equal(grantsAfterPersonalRevocation, 0);
  assert.equal(organizationWebhookJobsContinue, true);
  assert.deepEqual(after.existingJournals, before.existingJournals);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-service-authority.test.ts`.
- [ ] **Step 3 — Implement:** personal sponsor의 mode/orgAccessEpoch/user authEpoch/권한 revision/앱 범위를 현재 값으로 검사하고 missing 행을 Owner 권한으로 추정하지 않는다. 먼저 DO 회수 gate를 확정하고 기존 idempotent revoke의 bounded 후속 조정만 허용한다. 기존 webhook/조직 Runner/자동 rollback은 조직이 승인한 policy로 계속 동작한다. 이미 제출된 결과·미확정 journal을 삭제/재발급/재게시하지 않는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-service-authority.test.ts packages/cloudflare/test/automation-http.test.ts packages/cloudflare/test/native-http.test.ts packages/cloudflare/test/sdk-telemetry-http.test.ts packages/cloudflare/test/automatic-rollback-http.test.ts`. CI/Actions를 실행해 검증하지 않는다.
- [ ] **Step 5 — Commit:** Task 9 파일만 `feat(org): fence service principals without stopping organization automation [skip ci]`.

### Task 10: 조직·초대·계정·PC 승인의 관리 UI

**Files:** Create `packages/cloudflare/public/organization.{js,css,d.ts}`, `packages/cloudflare/public/account-security.{js,d.ts}`, `packages/cloudflare/public/join.{js,css,d.ts}`, `packages/cloudflare/test/org-ui.test.ts`, `scripts/org-access/ui-qa.mjs`, `scripts/org-access/ui-qa.test.mjs`; Modify `packages/cloudflare/public/{admin-routes.js,admin-routes.d.ts,app.js,auth.js,index.html}`, `packages/cloudflare/src/http.ts`, `scripts/build-cloudflare.mjs`.

**Interfaces:** `organization.d.ts`에 `OrgViewModel={status:'loading'|'ready'|'error';principal:OrgSelfView;organization:OrgDisplayView;members:OrgPage<OrgMemberView>;requests:OrgPage<RunnerRequest>}`, `OrgActions={request:(method:'GET'|'POST',path:string,body?:unknown)=>Promise<unknown>;invalidate:()=>void}`를 선언한다(상태에는 비밀 없음). `renderOrganization(root:HTMLElement,model:OrgViewModel,actions:OrgActions):()=>void`, `renderAccountSecurity(root:HTMLElement,model:Pick<OrgViewModel,'status'|'principal'>,actions:OrgActions):()=>void`를 export하고 다른 `.d.ts`는 해당 타입을 import한다. browser module에 서버 runtime import를 넣지 않는다. actions는 기존 authenticated fetch를 사용하며 dispose는 pending rendering을 무효화한다. join은 fragment의 nonce를 메모리로 옮기고 history.replaceState로 주소에서 제거한다. local QA의 `startOrganizationQa(options:{port:number}):Promise<{origin:string;close:()=>Promise<void>}>`는 기존 local workerd fixture 패턴으로 합성 계정만 제공하고 127.0.0.1에 bind한다. test-only seed/control은 이 script/fixture에만 두고 production build가 import하지 않는다.

- [ ] **Step 1 — RED:** `owner_members_and_app_roles_are_clear`, `RF2_late_response_cannot_render_prior_account`, `join_does_not_store_or_leak_nonce`, `viewer_buttons_and_direct_requests_denied`, `runner_claim_token_is_one_time`를 DOM/HTTP 통합과 local rendered QA로 작성한다. 작은 화면·keyboard·logout·role downgrade를 포함한다.
  ```ts
  assert.equal(staleAccountDataVisible, false);
  assert.equal(secretWritesToBrowserStorage, 0);
  assert.equal(unknownResultLabel, '확인 대기');
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cloudflare/test/org-ui.test.ts`.
- [ ] **Step 3 — Implement:** `조직→멤버`, `앱→연결·키`, `앱→Runner`, `계정→보안`을 분리한다. 기존 앱 목록·개요를 관련 없이 재디자인하지 않는다. Owner만 멤버를 관리하고 nonce/token은 한 번 표시·브라우저 저장 없음으로 처리한다. claim의 unknown을 다시 누르면 새 token이 발급되는 UI를 만들지 않는다. 실제 API 거부와 scope 변경에 맞춰 선택 앱과 비밀 입력을 지운다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cloudflare/test/org-ui.test.ts packages/cloudflare/test/admin-navigation.test.ts packages/cloudflare/test/build.test.ts`및 `node --test scripts/org-access/ui-qa.test.mjs`. `node scripts/org-access/ui-qa.mjs --port 4176`의 합성 화면을 Computer Use로 1440px/390px에서 열어 초대·역할별 접근·PC 승인·logout 직후 지연 응답을 확인하고 캡처를 ignored QA 디렉터리에 남긴다. 외부 요청 0·유휴 신규 polling 0을 assert하고 서버를 종료한다. 기존 Actions 전용 capture의 환경 검사를 우회하지 않는다. 합성 계정만 조작하고 운영 초대를 발급하지 않는다.
- [ ] **Step 5 — Commit:** Task 10 파일만 `feat(console): guide organization members and approved PCs [skip ci]`.

### Task 11: 새 PC의 기존 CLI 연결과 사용자 안내

**Files:** Modify `packages/cli/src/setup/runner.ts`, `packages/cli/test/setup-runner.test.ts`, `README.md`, `README.en.md`, `docs/development/native-build-signing.ko.md`; Create `docs/development/organization-access.ko.md`.

**Interfaces:** 기존 `setupRunner(io:SetupIO,signal:AbortSignal):Promise<SetupResult>`, `configureRunner`, `verifyRunnerBinding`, `startConfiguredRunner`와 `RunnerBinding` v1을 유지한다. 조직 로그인·앱 선택·승인/claim은 web에서 수행하고 public binding과 일회 PC token을 현재 hidden 입력으로 전달한다. 새로운 password/OAuth/session을 CLI에 복사하는 경로를 추가하지 않는다.

- [ ] **Step 1 — RED:** `two_private_runner_directories_reuse_one_app_without_reupload`, `revoked_pc_does_not_reenroll_or_start`, `org_error_codes_are_sanitized`, `existing_config_and_journals_are_never_overwritten`를 고정 probe로 작성한다. 중간 abort와 기존 directory 재사용의 bytes/mode/hash를 비교한다.
  ```ts
  assert.equal(credentialUploadRequests, 0);
  assert.equal(secondPcTokenEqualsFirst, false);
  assert.deepEqual(after.privateConfigAndJournals, before.privateConfigAndJournals);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs packages/cli/test/setup-runner.test.ts`.
- [ ] **Step 3 — Implement:** 조직/PC 권한 실패를 고정 code와 다음 조치로 안내하며 Owner flow로 fallback하거나 token을 재발급하지 않는다. OTA CLI와 native CLI를 같은 구성 파일이라고 설명하지 않는다. native는 기존 `packages/ota-runner/dist/native-main.js --daemon --config /절대경로/native.json`과 `NativeConfig` 검증을 사용하며 앱·플랫폼별 새 승인 토큰만 새 0600 구성에 둔다. UULab 고정 경로의 `native-service.mjs`를 다른 PC용 자동 설정이라고 실행하지 않는다. 첫 범위에서 native OS 서비스 설치를 새로 일반화하지 않는다. 새 PC에는 대응하는 Docker/서명 빌드 도구가 필요함을 명시하고, 한 PC의 두 private 환경과 실제 별도 PC를 구분한다. global Codex 설정·LaunchAgent·제공자 로그인을 변경하지 않는다.
- [ ] **Step 4 — GREEN:** `pnpm build && pnpm typecheck && node scripts/test.mjs packages/cli/test/setup-runner.test.ts tests/cli.test.ts`. README에서 web 승인→CLI private 설정→readonly doctor까지 따라갈 수 있어야 한다.
- [ ] **Step 5 — Commit:** Task 11 파일만 `docs(cli): guide approved PCs to existing organization assets [skip ci]`.

### Task 12: 통합·보존·새 환경 검증과 운영 인계

**Files:** Create `tests/organization-e2e.test.ts`, `packages/cloudflare/test/org-preservation.test.ts`; Modify `docs/development/organization-access.ko.md`. 필요한 fixture control은 `test/fixtures/org-entry.ts`에만 둔다.

**Interfaces:** 새로운 product interface를 추가하지 않는다. Tasks 1–11의 실제 API·D1 guard·Vault·실제 인증·기존 Runner protocol을 사용한다. 대상은 합성 Isso/Promise/Reward 상당의 앱 3개, 다른 설치의 같은 appId, 독립 PC token 둘이다. provider/network는 기본 거절한다.

- [ ] **Step 1 — RED:** `two_members_three_apps_two_pcs_share_assets_safely`, `cutover_and_pause_retain_original_rows`, `no_secret_or_fixture_control_in_production_bundle`를 작성한다. Owner/admin/deployer/viewer·전체 권한 표·native/OTA 두 platform·reset/재활성화·before/after-await 회수·동시 claim·게시 결과 불명확·old enrollment delay를 실제 HTTP로 검증한다.
  ```ts
  assert.deepEqual(after.legacyHashes, before.legacyHashes);
  assert.equal(disallowedAppAndKeyAccesses, 0);
  assert.equal(additionalD1AuthorizationQueries, 0);
  assert.equal(newIdlePollers, 0);
  ```
- [ ] **Step 2 — Run RED:** `node scripts/test.mjs tests/organization-e2e.test.ts packages/cloudflare/test/org-preservation.test.ts`. 기존 경로를 성공 mock으로 대체해 GREEN으로 만들지 않는다.
- [ ] **Step 3 — Integrate:** 누락 wiring만 해당 Task 책임 범위에서 수정하고 필요하면 그 Task의 RED를 추가한다. 기능·설계 변경이 필요하면 먼저 범위 변경을 설명한다. 테스트 control·nonce·cookie·비밀 fixture가 production bundle/로그에 없음을 assert한다.
- [ ] **Step 4 — Verify:** Node 24.19.0/pnpm 11.19.0에서 `pnpm check`, `node --test scripts/org-access/preflight.test.mjs scripts/org-access/ui-qa.test.mjs scripts/local-runner/supervisor.test.mjs scripts/local-runner/health.test.mjs`. 이후 새 clone과 별도 store에서 `pnpm install --frozen-lockfile --ignore-scripts`→`pnpm check`→위 MJS 테스트→README smoke, git diff·원본 checkout 보존을 확인한다. 차이가 없는데 전체 suite를 반복하지 않는다.
- [ ] **Step 5 — Commit and handoff:** 전체 branch 독립 리뷰에서 P1/P2를 해결하고 수정 범위를 재검증한다. Task 12 파일만 `test(org): prove scoped reuse and migration preservation [skip ci]`. 테스트명·실행 결과·미검증 tier·source SHA·복귀 절차를 비밀 없이 기록한다.

## Production Checkpoints and Execution Handoff

구현 완료와 운영 active를 구분한다. 실제 멤버 추가·초대 링크 발급·Owner 재인증/비밀번호 입력·키 재등록은 이 계획 작성 승인만으로 실행하지 않는다.

1. **배포 전:** 전체 branch review·새 clone 검사와 기존 Worker/DO/D1 identity, auth epoch/세션·Vault envelope/trust·Runner/lease/job/정책/이력·복구 journal 보존 증거를 준비한다. 실제 비밀 원문을 출력하지 않는다. 기존 pending journal은 그대로 둔다.
2. **owner_only 배포:** 검토 가능한 같은 artifact로 최초 org-aware 코드를 명시적으로 배포한다. D1 migration은 제어 표/guard만 추가하고 기존 업무 행을 바꾸지 않는다. gate 미설정을 active로 추정하지 않는다. Owner 로그인과 기존 API/Runner를 확인하고, 의도하지 않은 변화가 있으면 preparing에 들어가지 않는다.
3. **preparing:** Owner의 명시적 동작으로 D1 blocked barrier 확인→50개 페이지 legacy 대조→ledger_only→DO active 순서로 전환한다. 경계/receipt가 unknown이면 멈춘다. 시간 경과만으로 구버전 요청이 모두 끝났다고 판단하지 않는다.
4. **active 후:** 합성으로 검증한 권한을 제한된 실제 계정/PC에서 확인한다. Isso/Promise/Reward의 기존 자산은 read-only 확인부터 시작하고, 실제 서명/OTA는 별도 승인 채널·고정 commit 작업으로 기록한다. 한 PC의 두 Runner를 실제 다른 PC 성공으로 기록하지 않는다.
5. **문제 시:** org-aware paused로 팀원·개인 PC를 닫고 Owner/기존 조직 자동화와 이력을 보존한다. 최소 protocol보다 오래된 binary로 돌아가지 않고 원래 키를 삭제·재발급하지 않는다. 오래된 backup의 회수 정보를 자동으로 온라인에 되돌리지 않는다.

권장 실행 방식은 앞선 작업에서 선택한 **순차 구현(Native)**을 유지하고, 전체 branch 완료 시 독립 리뷰를 받는 방식이다. 인증·D1 발급·Runner interface가 밀접하므로 Task마다 새 구현자/검토자를 필수로 두지 않으며, 각 Task의 RED/GREEN과 보존 검사는 필수다. 사용자가 이 계획을 확인한 뒤 `superpowers:executing-plans`로 시작한다.
