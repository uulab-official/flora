# Flora Installation Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 처음 설치하는 운영자가 CLI와 웹 마법사에서 관리자 등록·GitHub 연결·앱별 공개 SDK 설정·PC Runner 연결·선택한 모든 플랫폼의 첫 OTA 게시를 확인하게 한다.

**Architecture:** 운영자 인프라 권한과 PC private 파일은 로컬 CLI에, 비밀번호·GitHub 승인·앱 관리는 기존 FloraAuth/CSRF 경계에 둔다. 원장에 기록한 새 자원만 bootstrap하고 기존 설치는 로그인 후 이어간다. 첫 게시의 증거는 앱별 작업과 배포를 대조하며 기기 적용과 분리한다.

**Tech Stack:** TypeScript 5.9.3, Node 24.19.0, pnpm 11.19.0, 기존 Wrangler 4.148.0, Cloudflare Workers/SQLite DO/D1, vanilla ES modules, 기존 Flora SDK·Docker PC Runner, Node test runner/Miniflare.

**Spec:** [승인된 상세 설계](../specs/2026-10-18-installation-wizard-design.md), 원문 commit `895b7c467178b3e75436531d86dd787c0946baf9`. 사용자는 2026-10-18에 이 설계를 승인하고 구현 계획 작성을 요청했다. 이 계획은 아직 검토 대기이며 제품 구현/원격 QA를 실행한 기록이 아니다.

## Global Constraints

- 새 설치와 기존 설치를 구분한다. 기존 DB/Worker/owner 인수·재초기화·키 교체·이력/복구 journal 삭제를 하지 않는다.
- 최초 발급은 이 마법사의 새 자원과 내구성 있는 외부 원장에서 1회만: 난수 32바이트, decoded SHA-256, TTL 600,000ms, generation 1, purpose `enroll`.
- 사용·만료·미확정 발급, 원장 유실, 기존/복원된 인증 DB에 generation 1을 다시 발급하지 않는다. 비밀번호 복구 자동화는 범위 밖이다.
- 원장은 비밀을 포함하지 않는다. 비밀 파일 0600·디렉터리 0700·현재 UID·regular single-link file·symlink 없는 canonical 경로를 요구한다. 파일/디렉터리 동기화 보장이 없으면 원격 변경 전에 중단한다.
- 토큰·비밀번호·cookie·GitHub private key·callback code/state를 CLI 인자·환경변수·로그·URL·브라우저 저장소로 옮기지 않는다. 비밀번호는 HTTPS 화면에서만 입력한다.
- Runner는 비 root macOS/Linux + Docker + 2GiB 이상 여유 공간. 이미지 도구는 Node 24.19.0/npm 10.9.8 또는 지원 pnpm 11.10.0. Flora 자체 pnpm 11.19.0과 구분한다.
- 자동 재등록/자동 POST 재전송, localhost bridge, 범용 부팅 서비스 설치, EAS, Actions, R2/유료 전환을 도입하지 않는다.
- 웹 제목은 **Flora 시작하기**, 단계는 **관리자 → GitHub → 앱·SDK → PC Runner → 첫 OTA**. 기존 shell과 관리 페이지의 직접 접근을 보존한다.
- 웹 단계는 실제 현재 API 결과로 도출한다. 모든 선택 플랫폼의 app/SHA/channel/runtime/platform과 deployment ID를 확인해야 게시 완료다.
- 기존 조회 스케줄러 하나만 사용한다. idle/hidden/terminal의 마법사 전용 poller·history/installation fanout·진행 상태용 DB 쓰기를 만들지 않는다.
- 기존 dirty 작업 폴더와 staging을 유지한다. 현재 별도 clone의 설계 브랜치를 이어 사용하거나 플랫폼의 격리 작업 공간을 재사용한다. root checkout에서 reset/stash/pull을 실행하지 않는다.
- 이 계획의 테스트 예시는 앞으로 작성할 테스트다. 기존 1,373건 통과 기록을 새 마법사의 실행 증거로 재사용하지 않는다.
- 기존 TypeScript의 `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`를 유지한다. optional 값은 `undefined`를 넣는 대신 필드를 생략한다.

## Review Focus

1. macOS `/var` alias, symlink/hardlink, 공백 있는 경로와 기존 private 폴더: canonical 경로를 안내하고 기존 파일은 수정하지 않는다 — Task 1/4/5.
2. 터미널 paste의 CRLF, 토큰 내부/뒤 공백, EOF/Ctrl-C/비 TTY: framing만 처리하고 원문 비밀은 출력하지 않으며 TTY를 복원한다 — Task 2/5.
3. 성공 응답이 손실된 DB 생성·deploy·setup 발급·GitHub 변환·Runner 등록: 실제 receipt로 확인 가능한 경우만 재개하고 중복 생성하지 않는다 — Task 3/4/7.
4. 다른 앱의 연결 파일/토큰 혼합, tab 전환과 늦은 응답, logout 후 돌아오기: 첫 claim 전에 거절하고 이전 앱의 완료 상태를 표시하지 않는다 — Task 5/6/7/9.
5. 페이지 밖 과거 배포, 부분 성공, quota/503/외부 설정 drift: 전체 이력을 읽거나 과거 성공을 재사용하지 않으며 확인 대기를 유지한다 — Task 3/8/9/10.

## 작업 환경·검증 명령

실행 단계에서만 설치한다. clone 루트에서 다음 shell 함수를 사용한다. 테스트는 기본 두 file worker를 유지하고 실제 native build와 겹칠 때만 `FLORA_TEST_CONCURRENCY=1`을 사용한다.

```sh
flora_pnpm() { npm exec --yes --package=pnpm@11.19.0 -- pnpm "$@"; }
flora_pnpm install --frozen-lockfile --ignore-scripts
flora_pnpm build
```

각 task의 RED는 먼저 새 테스트를 작성하고 해당 테스트를 실행해 **의도한 미구현/계약 불일치로 실패**하는 것을 확인한다. 환경 오류를 RED로 세지 않는다. 그 task의 코드를 만든 뒤 GREEN 명령을 실행한다. 기존 테스트가 통과했으면 새로운 코드/실패가 없는 한 전체 suite를 반복하지 않는다. 각 commit은 명시한 파일만 `git add -- ...`로 추가하고 `[skip ci]`를 넣는다. 실행 전 원본 hash/index/status 기준을 기록하고 단계 종료 때 비교한다.

## 파일 구조와 공통 계약

새 production 파일은 아래 책임으로 나눈다. 기존 대형 `app.js`에는 route/controller 연결만 넣는다. Cloudflare bundle에 CLI/fs/child_process가 들어가면 안 된다.

| 파일 | 책임 |
| --- | --- |
| `packages/cli/src/setup/contracts.ts` | 원장·public binding·provider port·공개 결과 타입과 strict schema |
| `packages/cli/src/setup/private-files.ts` | private 경로·exclusive 생성·lock·내구성 있는 원장 교체 |
| `packages/cli/src/setup/terminal.ts`, `runtime.ts` | echo 없는 TTY 입력, pinned 도구 위치, 고정 argv 실행·제한된 출력 |
| `packages/cli/src/setup/cloudflare.ts` | Wrangler adapter·정확한 resource receipt/readback·비밀 없는 provider 결과 |
| `packages/cli/src/setup/provision.ts`, `runner.ts` | 새 서버 상태 기계, 앱별 PC 설정 생성·presence·foreground 실행 |
| `packages/cli/src/setup-command.ts` | `setup` 명령 파서·메뉴·취소·공개 출력 |
| `packages/cloudflare/public/onboarding-model.js`, `onboarding-files.js` | 순수 상태 판정·플랫폼별 게시 판정, 공개 파일 serializer |
| `packages/cloudflare/public/onboarding.js`, `onboarding.css` | 단계 UI·수명 주기·접근성·현재 데이터 조회 연결 |
| `packages/cloudflare/public/onboarding-download.js` | 버튼으로 요청한 공개 매니페스트·시작 번들의 제한된 전송/해시 확인 |
| 위 JS별 `.d.mts` | 공유 UI 타입·테스트에서의 module type 계약 |
| 기존 dogfood operations/service, dashboard operations HTTP | 인증된 publication 단건 조회의 공통 서비스/라우트 |

`contracts.ts`에 다음 이름을 정의하고 뒤 task는 이 이름을 그대로 쓴다.

```ts
type SetupMode = 'new' | 'existing' | 'runner';
type ProvisionStage = 'planned' | 'database-created' | 'schema-ready' |
  'server-locked' | 'https-ready' | 'setup-issued' | 'setup-deployed' |
  'operator-confirmed' | 'setup-removed';
type ActionState = 'pending' | 'confirmed' | 'unknown';
interface PublicRunnerBinding { schemaVersion: 1; origin: string; appId: string; runnerId: string }
interface SetupResult { state: 'ready' | 'needs-operator' | 'unknown' | 'cancelled'; code: string }
interface ResourcePlan {
  installationId: string; accountId: string; workerName: string; databaseName: string;
  hostname: string; zoneId: string; origin: string; ownerEmail: string; ownerId: string; dbIdentity: string;
}
interface ProviderSnapshot {
  accountId: string; workerName: string; databaseId: string | null; namespaceId: string | null;
  deploymentId: string | null; configFingerprint: string | null; routeFingerprint: string | null;
}
interface ActionReceipt { action: string; state: ActionState; expectedFingerprint: string | null;
  resourceId: string | null; observedFingerprint: string | null }
interface SetupJournal {
  schemaVersion: 1; plan: ResourcePlan; stage: ProvisionStage;
  receipts: ActionReceipt[]; setup: null | { digest: string; issuedAt: number;
    expiresAt: number; generation: 1; purpose: 'enroll' };
}
```

원문 token은 위 타입에 없다. 별도 0600 파일의 approved token만 `provision.ts`가 다룬다. Runner token은 기존 `RunnerConfig`에만 들어가고 원장에는 들어가지 않는다. UI의 `PublicationTarget`은 `{appId,commitSha,channel,runtimeVersion,platforms}`이며 플랫폼은 `'ios'|'android'`의 중복 없는 1~2개다.

## Task 1: 재개 가능한 private 설치 원장

**Files:** Create `packages/cli/src/setup/contracts.ts`, `private-files.ts`; Test `packages/cli/test/setup-private-files.test.ts`.

**Interfaces:** `parseJournal(input: unknown): SetupJournal`, `parseRunnerBinding(input: unknown): PublicRunnerBinding`; `createJournal(path: string, value: SetupJournal): Promise<void>`, `readJournal(path: string): Promise<SetupJournal>`, `replaceJournal(path: string, expectedDigest: string, value: SetupJournal): Promise<void>`, `withSetupLock<T>(directory: string, action: () => Promise<T>): Promise<T>`. Digest은 저장된 exact bytes의 SHA-256이며 lock 내부에서 다시 확인한다.

- [ ] **RED:** 위 테스트에 `exclusive_creation_keeps_existing_bytes`, `private_path_rejects_alias_symlink_hardlink_shared_parent`, `crash_before_rename_preserves_journal`, `concurrent_writer_and_digest_drift_reject`를 작성한다. 핵심 assertions: 기존 bytes/hash 불변, 새 디렉터리 `mode & 0o777 === 0o700`, 파일 `=== 0o600`, 동시 writer 1개만 성공, 지원하지 않는 fsync는 원격 콜 0회다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cli/test/setup-private-files.test.ts`; 의도한 RED를 확인한다.
- [ ] Implement strict allowed keys/크기 16KiB/현재 UID/단일 link/O_NOFOLLOW·open 전후 inode 검사를 넣는다. lock은 exclusive 생성하며 stale하다는 이유로 자동 삭제하지 않는다. temp 생성 → file sync → rename → directory sync 순서를 구현하고 실패한 원장/비밀·pending 기록을 자동 정리하지 않는다. 기존 `private-store.ts`의 DB 전용 의미를 바꾸지 않는다.
- [ ] 위 명령 GREEN. malformed/truncated JSON은 비밀을 포함한 원문 대신 고정 오류 코드만 반환한다.
- [ ] Commit named files: `feat: add private installation journal [skip ci]`.

## Task 2: 엄격한 setup CLI와 비밀 입력

**Files:** Create `packages/cli/src/setup-command.ts`, `setup/terminal.ts`, `setup/runtime.ts`; Modify `packages/cli/src/main.ts`; Test `packages/cli/test/setup-command.test.ts`, `setup-terminal.test.ts`, `setup-terminal-pty.test.ts`; Create test-only `packages/cli/test/fixtures/setup-terminal-pty.py`, `setup-terminal-child.ts`.

**Interfaces:** `SetupIO`는 `choose(label:string, choices:readonly string[]): Promise<string>`, `readPublic(label:string): Promise<string>`, `readSecret(label:string, signal:AbortSignal): Promise<string>`, `confirm(summary:string): Promise<boolean>`, `report(result: SetupResult): void`를 가진다. `SetupRuntime`은 `{root,nodePath,wranglerEntry,dockerPath,supervisorMain}`의 검증된 절대 경로다. `resolveSetupRuntime(root: string): Promise<SetupRuntime>`; `runBoundedTool(executable: string,args: readonly string[],options:{cwd:string,timeoutMs:number,maxBytes:number,signal:AbortSignal}): Promise<{exitCode:number;stdout:string}>`; `runSetupCommand(argv:readonly string[],io:SetupIO,deps:SetupCommandDeps):Promise<number>`. `SetupCommandDeps`는 `newInstall(io,signal)`, `existing(io,signal)`, `runner(io,signal)`, `resume(path,io,signal)`, `inspect(path,io,signal)` handler를 주입하며 모두 `Promise<SetupResult>`를 반환한다. `path:string`, `io:SetupIO`, `signal:AbortSignal`이며 real handler 연결은 Task 4/5에서 한다.

- [ ] **RED:** `setup_command_accepts_only_approved_forms`, `inspect_never_calls_provider`, `cancel_never_mutates`, `secret_paste_framing_and_tty_restore`를 작성한다. 승인된 인자는 spec의 네 command form뿐이며 `--token`, `--password`, 중복 인자·임의 `--exec`는 exit 2다. `readSecret`은 토큰 내부/뒤 공백을 trim하지 않고 후속 validator가 거절하게 한다. CRLF line framing, Ctrl-C/EOF/비 TTY에서 출력에 synthetic secret이 없고 raw mode가 복원되는지 검사한다. 실제 PTY 회귀는 Python 표준 `pty`/`termios` helper로 Node child를 열고 echo bytes와 종료 후 TTY flags를 검사한다. Python은 테스트 보조 도구이며 제품 의존성이 아니다. Windows/Python 미설치의 명시적 skip을 실제 PTY 통과로 세지 않는다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cli/test/setup-command.test.ts packages/cli/test/setup-terminal.test.ts packages/cli/test/setup-terminal-pty.test.ts`; RED 확인.
- [ ] Implement Node 기본 TTY/fs/child_process만 사용한다. 새 prompt dependency를 넣지 않는다. 고정 Node executable + pinned Wrangler entry, `shell:false`, timeout, byte cap, process-group 취소를 적용한다. child 환경은 도구별 고정 allowlist로 만들고 token/임의 `NODE_OPTIONS`/사용자 shell 초기화 코드를 전달하지 않는다. Wrangler에는 운영자의 기존 HOME/XDG 인증 경로만 유지하며 credential 파일을 읽거나 복사하지 않는다. Docker에는 검증한 Unix socket과 기존 supervisor가 요구하는 경로만 전달한다. 도구 stdout은 parser에만 전달하고 사용자 오류에는 raw body/argv를 넣지 않는다. provider login은 Wrangler의 표준 브라우저 경로로 인계한다.
- [ ] 위 GREEN 및 `node scripts/test.mjs packages/cli/test/doctor.test.ts tests/cli.test.ts`. 첫 두 UI handler wiring 전에는 `needs-operator`를 반환하고 ready를 가장하지 않는다.
- [ ] Commit named files: `feat: add guided setup CLI entry and safe prompts [skip ci]`.

## Task 3: 고정 Wrangler adapter와 새 자원 확인

**Files:** Create `packages/cli/src/setup/cloudflare.ts`; Test `packages/cli/test/setup-cloudflare.test.ts`, `fixtures/setup-cloudflare/`의 공개 synthetic 출력 fixture.

**Interfaces:** `SetupProvider`는 `inspect(plan,signal):Promise<ProviderSnapshot>`, `createDatabase(plan,signal):Promise<{databaseId:string;databaseName:string}>`, `migrate(plan,databaseId,signal):Promise<void>`, `readIdentity(plan,databaseId,signal):Promise<null|{ownerId:string;origin:string;dbIdentity:string}>`, `insertIdentity(plan,databaseId,signal):Promise<void>`, `deploy(plan,configPath,expected:ProviderSnapshot|null,signal):Promise<ProviderSnapshot>`를 제공한다. `createWranglerProvider(runtime:SetupRuntime):SetupProvider`. 인자는 `ResourcePlan`을 포함하며 arbitrary args·URL·SQL을 받지 않는다.

- [ ] **RED:** `create_is_new_only_and_requires_exact_account`, `output_requires_one_uuid_then_exact_readback`, `lost_create_reply_never_adopts_name_or_reposts`, `drift_stops_before_deploy`, `unknown_free_or_domain_evidence_blocks`를 작성한다. fixture의 403/404/HTML/잘린 JSON/복수 UUID/이름 불일치·provider secret 문자열은 구분된 고정 결과를 내고 원문을 노출하지 않는다. `--update-config=false`와 checkout 밖 cwd를 고정한 호출만 허용한다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cli/test/setup-cloudflare.test.ts`; RED 확인.
- [ ] Implement pinned 4.148.0 계약에 대한 command table과 parser를 만든다. `d1 list --json`, `d1 info FLORA_DB --json`, `deployments list --name <worker> --json`, `versions view <versionId> --name <worker> --json`에 account가 고정된 private `--config`를 붙인다. DB 생성 전에는 name/account만 있는 새 bootstrap config를 사용하고, 생성 후 실제 binding을 넣은 설정에서 info/readback한다. **`d1 create`에는 JSON flag가 없으므로 추가하지 않는다.** `d1 create <고유이름> --update-config=false --config <private path>`의 고정 config 출력에서 정확히 한 이름/UUID만 파싱하고 readback한다. 이 응답이 유실되면 이름 조회만으로 소유권 receipt를 만들지 않는다. `d1 migrations list/apply FLORA_DB --remote`, `d1 execute FLORA_DB --remote --file <exclusive private SQL>`와 deploy는 고정 template에서 만든다. [D1 공식 명령](https://developers.cloudflare.com/workers/wrangler/commands/d1/)과 설치된 pinned command metadata를 기준으로 하며 일반 API용 `cf-wrangler`나 비공개 SDK export가 있다고 가정하지 않는다.
- [ ] 계정·도메인·무료 quota 정보는 읽기 가능한 provider 근거만 `verified`로 기록한다. pinned 도구가 특정 정보를 제공하지 않으면 공식 dashboard 확인으로 인계하고 사용자 확인을 **operator-confirmed**로 구분한다. 필요한 확인 자체가 없으면 `needs-operator`로 멈춘다. 어떤 경우도 `whoami` 성공만으로 hostname 가용성/무료 여유량을 증명하지 않는다. mutation 전후 실제 binding/version/config/route를 대조할 수 없는 adapter는 배포를 진행하지 않는다. 자동 결제/권한 확대는 없다.
- [ ] 위 GREEN. readback의 필수 필드나 pinned CLI 기능이 없으면 안전 오류가 나야 하며, 내부 비공개 Wrangler 함수나 credential extraction을 대신 사용하지 않는다. 실제 계정에서 이 capability gate를 통과하기 전에는 Task 10의 live 경로를 성공으로 세지 않는다.
- [ ] Commit named files: `feat: add guarded setup provider adapter [skip ci]`.

## Task 4: 새 서버 구성·최초 발급·재개

**Files:** Create `packages/cli/src/setup/provision.ts`; Modify `setup-command.ts`; Test `packages/cli/test/setup-provision.test.ts`.

**Interfaces:** `provisionNew(plan:ResourcePlan,journalPath:string,provider:SetupProvider,io:SetupIO,signal:AbortSignal):Promise<SetupResult>`, `resumeProvision(journalPath:string,provider:SetupProvider,io:SetupIO,signal:AbortSignal):Promise<SetupResult>`, `inspectSetup(journalPath:string):Promise<SetupJournal>`. `renderPrivateConfig(plan,databaseId,root):Record<string,unknown>`는 example의 topology를 유지한다. `issueFirstSetup(journalPath:string,now:number):Promise<{approvalFile:string;configPath:string}>`는 원문을 반환하지 않는다.

- [ ] **RED:** `fresh_install_runs_once_in_order`, `every_mutation_has_durable_intent_first`, `crash_resume_checks_receipts_not_steps`, `first_setup_exact_bytes_ttl_and_single_generation`, `existing_install_never_bootstraps`, `close_setup_preserves_other_fields`를 작성한다. 발급 파일에서 읽은 test bytes에 대해 decoded length 32, digest 일치, `expiresAt-issuedAt===600000`, generation 1을 assert한다. 만료/발급 pending/유실 원장/기존 경로에서는 두 번째 난수·mutation 콜이 0회다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cli/test/setup-provision.test.ts`; RED 확인.
- [ ] Implement Task 1 lock과 pending/confirmed/unknown 원장을 사용한다. 전용 이름 접미사·절대 artifact/migration 경로·`workers_dev:false`·`preview_urls:false`·SQLite DO·D1 identity를 유지한다. SQL 문자열은 검증된 UUID와 canonical origin을 안전하게 encode하며 임의 SQL 입력을 받지 않는다. schema/identity/잠긴 배포/HTTPS 확인을 끝낸 뒤에만 발급한다. approval file과 발급 메타데이터가 durable해진 다음 setup를 배포한다. 원장과 별도 secret 생성 사이 crash는 재발급 대신 unknown으로 남긴다.
- [ ] 기존 설치 handler는 HTTPS login URL 안내만 수행한다. 최초 등록 응답 유실은 login부터 확인한다. operator-confirmed 후 최신 fingerprint를 다시 검사하고 `FLORA_SETUP`만 제거한다. provider가 drift하면 이전 full config로 덮어쓰지 않는다. Inspector는 path/비밀을 포함한 원문 config를 출력하지 않는다.
- [ ] 위 GREEN와 `node scripts/test.mjs packages/cloudflare/test/auth.test.ts packages/cloudflare/test/config.test.ts`. 이 단계의 provider fake 성공을 원격 배포 성공으로 표시하지 않는다.
- [ ] Commit named files: `feat: guide first owner provisioning with durable resume [skip ci]`.

## Task 5: 앱에 묶인 PC Runner 구성과 실행

**Files:** Create `packages/cli/src/setup/runner.ts`; Modify `setup-command.ts`, `packages/cli/package.json`, `pnpm-lock.yaml`; Test `packages/cli/test/setup-runner.test.ts`.

**Interfaces:** `configureRunner(binding:PublicRunnerBinding,connectionFile:string,runtimeDirectory:string,io:SetupIO,runtime:SetupRuntime,signal:AbortSignal):Promise<{runnerPath:string;servicePath:string;bindingPath:string}>`, `verifyRunnerBinding(paths,signal):Promise<void>`, `startConfiguredRunner(servicePath:string,signal:AbortSignal):Promise<number>`. `paths`는 위 세 경로다. CLI에 기존 workspace `@flora/runner` dependency만 추가하고 public `readRunnerConfig`/`createRunnerClient`를 사용한다. lockfile 변경은 이 workspace 링크에 한정한다.

- [ ] **RED:** `two_apps_produce_disjoint_private_paths`, `mixed_app_receipt_or_token_rejects_before_claim`, `resume_checks_binding_fingerprint`, `existing_runtime_and_journals_stay_unchanged`, `presence_does_not_mean_job_success`를 작성한다. wrong app/origin/runner prefix는 claim/export 호출 0회, presence ID 불일치는 supervisor 시작 0회, 기존 token·recovery·fatal-stop bytes/hash 불변을 assert한다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cli/test/setup-runner.test.ts`; RED 확인.
- [ ] Implement no-echo token 입력 뒤 binding/SDK public origin/app와 prefix를 비교한다. readRunnerConfig 및 기존 supervisor `readConfig`로 설정을 검사한다. nonroot·Docker·디스크 2GiB·고정 이미지·supported dependency path를 확인하고 `runner.json`, `runner-binding.json`, `service.json` 및 scratch/work/recovery를 exclusive 생성한다. 기본 pollIntervalMs는 30000이며 기존 supervisor의 adaptive idle 최대 300000ms를 유지한다. `@flora/runner`의 default daemon을 idle presence loop로 사용하지 않는다. workspace dependency 추가 후 `flora_pnpm install --lockfile-only --ignore-scripts` → `flora_pnpm install --frozen-lockfile --ignore-scripts` 순서로 링크를 준비하고 비의도 version diff가 없는지 확인한다.
- [ ] Docker endpoint는 고정 `docker context inspect --format '{{.Endpoints.docker.Host}}'` 또는 명시된 `DOCKER_HOST`에서 읽고 실제 소유권/접근 가능성을 확인한 `unix://` socket만 허용한다. 원격 TCP daemon/불명확한 context는 진행하지 않는다. 일반 Docker 사용에 Lima 기동을 요구하지 않으며 기존 supervisor schema에 필요한 경로는 새 runtime 경로로 제한한다. 고정 Dockerfile build를 선택하면 공개 digest/도구 버전을 확인하며 도구 stdout/환경에 token을 싣지 않는다. expected runner ID의 presence 확인 후 사용자 동작으로 foreground supervisor를 실행한다. Ctrl-C는 생성한 child만 종료하고 기존 Runner/VM/LaunchAgent는 건드리지 않는다. 재개는 fingerprint와 prefix를 재확인하며 새 token을 발급하지 않는다.
- [ ] 위 GREEN, `node --test scripts/local-runner/health.test.mjs scripts/local-runner/supervisor.test.mjs`, `flora_pnpm typecheck`.
- [ ] Commit named files: `feat: configure app scoped PC runners from guided setup [skip ci]`.

## Task 6: 인증된 웹 마법사의 route·화면·수명 주기

**Files:** Create `packages/cloudflare/public/onboarding.js`, `onboarding.css`, `onboarding.d.mts`, `onboarding-model.js`, `onboarding-model.d.mts`; Modify `public/admin-routes.js`, `index.html`, `app.js`, `auth.js`, `src/http.ts`, `scripts/build-cloudflare.mjs`; Test `test/onboarding-ui.test.ts`, existing `admin-http.test.ts`, `admin-navigation.test.ts`, `build.test.ts` (모두 cloudflare package 아래).

**Interfaces:** `deriveOnboardingState(input:OnboardingInput):OnboardingState`는 순수 함수다. `OnboardingInput`은 `{authenticated:boolean,appId:string|null,connection:GitHubStatus|null,operations:OperationsState|null,automation:OnboardingAutomation|null,target:PublicationTarget|null}`이다. `GitHubStatus`는 기존 status의 `{configured:boolean,source:'managed'|'environment'|null,appId:string|null,appSlug:string|null,installationUrl:string|null}`다. `OnboardingAutomation`은 기존 `AutomationState` + 각 runner의 optional `{presence:{status:'online'|'offline',lastSeenAt:number|null}}`다. `OnboardingState.steps`는 `{id:'owner'|'github'|'sdk'|'runner'|'publication',status:'needed'|'working'|'approval'|'unknown'|'verified'|'failed',reason:string}` 배열이다. `createOnboarding(env,context):{enter(appId:string|null):Promise<void>;leave():void;expire():void}`의 context는 기존 authenticated `api(path:string,body?:string):Promise<unknown>`, `isCurrent():boolean`, `getSnapshot():OnboardingInput`, `refreshData({operations:boolean,automation:boolean}):Promise<void>`, `setActiveJobPolling(active:boolean):void`, `navigate(path:string):void`를 제공한다. 기존 active app/epoch guard와 scheduler를 이 adapter로 연결하며 독립 fetch/timer 전역을 만들지 않는다.

- [ ] **RED:** `onboarding_is_private_canonical_route`, `enroll_only_redirects_to_fixed_wizard`, `late_response_cannot_revive_old_app_or_session`, `hidden_leave_logout_cancel_reads`, `wizard_keyboard_and_narrow_layout`를 작성한다. `/onboarding`만 허용하고 `/onboarding/`, setup returnTo/unknown query는 거절한다. recover redirect는 기존 동작을 유지한다. 기존 harness에서 모든 단계의 올바른 초점/상태 text와 page당 보이는 section 1개를 확인한다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cloudflare/test/onboarding-ui.test.ts packages/cloudflare/test/admin-http.test.ts packages/cloudflare/test/admin-navigation.test.ts packages/cloudflare/test/build.test.ts`; RED 확인.
- [ ] Implement 기존 panel factory/context 패턴으로 모듈을 만들고 `startClient`의 render/load/leave와 연결한다. 최초 enroll 성공에만 `/onboarding` 고정 이동을 사용한다. `/login?returnTo=%2Fonboarding`은 canonical allowlist로 처리한다. private JS/CSS도 명시적으로 assets 목록과 route에 추가하고 auth 없이 받지 못하게 한다.
- [ ] 관리자/GitHub/앱/Runner/첫 OTA 단계, 상태 6개, 본문 주 동작·오류·상세 링크를 구현한다. 저장소에는 현재 app/step 편의 값만 허용하고 완료 boolean/CSRF/secret은 저장하지 않는다. 로그아웃·pagehide·app 전환 때 pending과 화면 비밀을 지운다. 기존 프로젝트/앱 화면을 강제로 우회하지 않는다.
- [ ] 위 GREEN. hosted bundle은 CLI/node:fs/child_process/test route를 포함하지 않아야 한다. 같은 검증을 TypeScript declarations와 `flora_pnpm typecheck`에 반영한다.
- [ ] Commit named files: `feat: add authenticated first run wizard page [skip ci]`.

## Task 7: GitHub 이어가기와 공개 SDK/Runner 파일

**Files:** Create `packages/cloudflare/public/onboarding-files.js`, `onboarding-files.d.mts`; Modify `onboarding.js`, `onboarding-model.js`, `app.js`, `index.html`, `src/http.ts`, `scripts/build-cloudflare.mjs`; Test `packages/cloudflare/test/onboarding-files.test.ts`, `onboarding-ui.test.ts`, existing `hosted-ui.test.ts`, `managed-connections.test.ts`.

**Interfaces:** `buildPublicFiles(input:{appId:string;origin:string;channel:string;runtimeVersion:string;platforms:('ios'|'android')[];bundler:'metro'|'expo';entryFile:string;nodeVersion:string;packageManager:{name:'npm'|'pnpm'|'yarn';version:string}},signing:{appId:string;keyId:string;certificate:string}):{connection:string;config:string}`; `buildRunnerBinding(origin:string,appId:string,runner:RunnerSummary):PublicRunnerBinding`. 모두 strict allowlist serializer이며 원문 API 응답을 그대로 다운로드하지 않는다.

- [ ] **RED:** `public_files_match_real_parsers_and_contain_no_secrets`, `draft_is_declared_until_pinned_source_matches`, `existing_connections_and_keys_are_reused`, `manifest_lost_reply_is_not_replayed`, `runner_lost_reply_is_not_reenrolled`, `callback_hint_is_fixed_and_secret_free`를 작성한다. JSON은 Node의 `parseFloraConfig`, SDK public native configuration validator, CLI `parseRunnerBinding`으로 교차 검증한다. keyId 누락/불법 문자·잘못된 app/origin·unknown form key는 거절하고 fixture privateKey/token/cookie field가 출력에 없음을 assert한다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cloudflare/test/onboarding-files.test.ts packages/cloudflare/test/onboarding-ui.test.ts packages/cloudflare/test/hosted-ui.test.ts packages/cloudflare/test/managed-connections.test.ts`; RED 확인.
- [ ] Implement public form와 고정 RN preset을 **사용자 선언**으로 표시한다. 현재 API가 없던 `flora.config.json`의 exporter 값을 이미 탐지했다고 주장하지 않는다. browser serializer의 schema validation을 실제 Node parser와 parity-test하며 최종 source sync에서 서버 parser를 통과해야 확인됨이다. Node 의존 dogfood barrel을 browser에서 직접 import하지 않는다. 새 validator-only 서버 endpoint를 만들지 않는다.
- [ ] 기존 GitHub manifest/install/repository/project handler를 context로 재사용한다. sessionStorage에는 정확한 `onboarding` 힌트만 쓰고 완료 시 고정 route로 돌아간다. 변환 응답 유실은 connection 재조회만 한다. `configured:false`라도 새 manifest/code 재전송은 하지 않는다. repository/root가 기존 앱과 같으면 기존 앱으로 이어간다.
- [ ] 서명 응답은 keyId까지 검사하고 기존 키를 유지한다. Runner 등록은 한 번만 호출하고 단일 app scope·정확한 ID를 현재 automation 응답으로 확인한 뒤 secret 없는 binding 다운로드를 제공한다. 결과 unknown은 명시적 목록 확인/정확한 orphan 폐기로 해결하고 자동 재등록하지 않는다. SDK 커밋과 첫 native build 단계는 실제 사용자 동작/증거로 구분한다.
- [ ] 위 GREEN와 `flora_pnpm typecheck`; Commit named files: `feat: guide GitHub connection and public OTA configuration [skip ci]`.

## Task 8: 이력 스캔 없는 publication 단건 API

**Files:** Modify `packages/dogfood/src/operations.ts`, `packages/dashboard/src/operations-http.ts`, `packages/dashboard/src/service.ts`, `packages/cloudflare/src/hosted-api.ts` (필요한 dispatch 연결만); Test `packages/dogfood/test/operations.test.ts`, `packages/dashboard/test/operations-http.test.ts`, Create `packages/cloudflare/test/publication-http.test.ts`.

**Interfaces:** Export `OTAPublicationView = {appId:string;deploymentId:string;deployment:{id:string;platform:'ios'|'android';channel:string;runtimeVersion:string;commitSha:string;createdAt:number}}`와 `OperationsService.getPublication(appId:string,deploymentId:string):Promise<OTAPublicationView>`. `ManagementRoute.action`에 `'ota/publication'`과 optional `deploymentId:string`을 추가한다. `GET /api/apps/{appId}/ota/deployments/{uuid}/publication`, body/query 없음. 기존 `getOTADeployment` port는 바꾸지 않는다.

- [ ] **RED:** `publication_requires_session_app_and_exact_uuid`, `missing_or_other_app_is_404`, `publication_projects_only_metadata`, `publication_read_budget_is_constant_with_long_history`를 작성한다. 실제 Worker/D1에서 old ID가 최근 20개 목록 밖이어도 정확히 조회되고 telemetry가 없어도 성공해야 한다. 401/404/409/503, POST/HEAD/extra query/body 거절, asset/private/telemetry 필드 없음, D1 write 0을 assert한다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/dogfood/test/operations.test.ts packages/dashboard/test/operations-http.test.ts packages/cloudflare/test/publication-http.test.ts`; RED 확인.
- [ ] Implement service에서 기존 `app(appId)` guard → `getOTADeployment(appId,id)` → public projection·metadata validation을 한다. managementRoute/dispatch를 기존 hosted 경로로 연결하고 local dashboard `service.ts`의 `operation()` wrapper에도 `getPublication`을 같은 방식으로 노출한다. `auth-do.ts`의 operations-only enrichment/SDK telemetry initialization을 호출하지 않는다. resource identity 충돌은 409, dependency 실패는 503으로 기존 error boundary에 맞춘다.
- [ ] 위 GREEN와 `flora_pnpm typecheck`. schema/동일 앱의 history·asset·event row가 byte/hash 기준 유지되고, 이력 증가 전후 같은 D1 query/rowsRead 상한을 갖는지 계측한다. 끝난 테스트를 매번 전체 suite로 반복하지 않는다.
- [ ] Commit named files: `feat: expose bounded OTA publication metadata [skip ci]`.

## Task 9: 모든 플랫폼의 첫 OTA와 저조회 완료 판정

**Files:** Modify `packages/cloudflare/public/onboarding-model.js`, `onboarding-model.d.mts`, `onboarding.js`, `app.js`; Create `public/onboarding-download.js`, `onboarding-download.d.mts`, `packages/cloudflare/test/onboarding-publication.test.ts`, `onboarding-download.test.ts`; Modify `src/http.ts`, `scripts/build-cloudflare.mjs`의 private module 자산 목록; Extend `onboarding-ui.test.ts`. `public/`는 모두 cloudflare package 아래다.

**Interfaces:** `freezePublicationTarget(input:PublicationTarget):PublicationTarget`; `evaluatePublications(target:PublicationTarget,jobs:AutomationJob[],publications:OTAPublicationView[]):{status:'waiting'|'partial'|'published';platforms:Array<{platform:'ios'|'android';jobId:string|null;deploymentId:string|null;verified:boolean}>}`. `probeLaunchDownload(origin:string,target:PublicationTarget,platform:'ios'|'android',deploymentId:string,deps:{fetch:typeof fetch;subtle:SubtleCrypto},signal:AbortSignal):Promise<{kind:'web-download-hash';deploymentId:string;launchHash:string;bytes:number}>`. `createOnboarding`는 target을 사용자 동작으로 고정하고 기존 scheduler에 active job 여부만 전달한다. `renderAutomation`의 readiness도 같은 판정을 사용해 한 플랫폼 성공 bug를 없앤다.

- [ ] **RED:** `only_ios_is_partial_for_both`, `old_sha_other_app_or_channel_never_completes`, `deployment_id_must_exist_and_match_job`, `ref_change_does_not_repin_target`, `outside_twenty_uses_one_publication_lookup`, `idle_hidden_terminal_have_no_extra_poller`, `download_is_bounded_and_not_device_evidence`를 작성한다. 기본 assertion: 두 플랫폼 선택 + iOS 성공 1개면 `partial`; 같은 SHA의 matching jobs/deployments 2개면 `published`. failure/404/503는 `published`가 아니며 동일 key에 중복 point fetch를 하지 않는다. reload 후에는 저장된 완료 flag 대신 새 target 확인을 요구한다. 다운로드는 잘린/초과 body·URL redirect·다른 origin·hash 불일치·취소·네트워크 실패에서 확인됨이 아니며 새 publish나 자동 재시도를 호출하지 않는다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs packages/cloudflare/test/onboarding-publication.test.ts packages/cloudflare/test/onboarding-download.test.ts packages/cloudflare/test/onboarding-ui.test.ts packages/cloudflare/test/hosted-ui.test.ts`; RED 확인.
- [ ] Implement target-app/SHA/channel/runtime/platform/job.deploymentId 대조. 최근 operations/automation 데이터를 먼저 재사용하고 알려진 ID가 없을 때만 Task 8을 읽는다. 성공 metadata는 그 immutable key로 캐시하고 실패는 새로 확인 동작 전까지 무한 retry하지 않는다. 진행 중 job은 기존 5초 scheduler, idle/push 대기는 버튼으로 확인하며 hidden/terminal 때 중지한다. 기존 30초 idle Runner 페이지와 마법사 timer를 동시에 실행하지 않는다.
- [ ] 선택적 **매니페스트·시작 번들 다운로드 확인**은 플랫폼별 버튼 동작에서 public GET 2회만 한다. JSON manifest를 `Accept: application/expo+json`, `expo-protocol-version:1`, platform/runtime/channel headers로 요청해 최대 1MiB를 읽고 id/runtime/metadata.channel/extra.flora의 app/platform/SHA를 확인한다. 시작 asset은 같은 origin의 `/updates/{appId}/assets/{64 hex}`만 허용하고 최대 16MiB stream cap·요청당 20초 timeout·`credentials:omit`·`redirect:error`를 적용한다. Web Crypto SHA-256을 manifest의 base64url hash 및 URL digest와 대조한다. 이 결과는 **웹 전송·해시 확인**이며 서명 검증/기기 설치·적용·재시작 증거가 아니다. 기존 SDK JS facade는 네이티브 엔진에 다운로드를 위임하므로 browser fetch helper로 직접 사용하지 않는다. browser probe는 파일 실행·저장·reload를 하지 않는다.
- [ ] 위 GREEN와 `flora_pnpm typecheck`; Commit named files: `feat: verify first OTA for every selected platform [skip ci]`.

## Task 10: 새 환경·실제 첫 OTA·보존 검증과 README

**Files:** Create `tests/onboarding-e2e.test.ts`, `tests/onboarding-download-qa.test.ts`, `scripts/onboarding-qa.mjs`, `scripts/onboarding-download-qa.mjs`, `docs/development/installation-wizard-verification-2026-10-18.ko.md`; Modify `README.md`, `README.en.md`, `docs/getting-started.ko.md`, `packages/ota-runner/README.md`. 실행 결과 시각은 실제 실행일로 기록하고 실행 전 통과 문구를 쓰지 않는다.

**Interfaces:** `onboarding-e2e.test.ts`는 새 CLI/웹 controller와 실제 Miniflare를 테스트하고 provider/GitHub 응답을 명확히 fixture로 분리한다. `onboarding-qa.mjs`는 공개 resource/job/deployment ID·asset hash·query count·보존 hash만 기록하는 CLI다. 허용 argv는 `--record <public-receipts.json> --out <new-directory>`다. `onboarding-download-qa.mjs`는 `--connection <public-connection.json> --target <public-target.json> --out <new-directory>`만 받으며, target은 PublicationTarget+platform별 deploymentId다. 공개 인증서/expected keyId를 사용해 signed JSON manifest의 raw bytes를 Node `crypto.verify('RSA-SHA256',...)`로 확인하고 선택한 배포의 자산을 순차 다운로드해 SHA-256을 대조한다. manifest 1MiB·개별 asset 16MiB·최대 65개 URL·배포당 합계 64MiB·요청 timeout 20초·동일 origin/redirect 거절·unsigned 응답 거절로 제한한다. 한도 초과는 미완료이며 조용히 생략하지 않는다. 두 도구 모두 cookie/token/password/privileged endpoint를 받지 않는다. 실제 원격 조작과 본인 인증은 설치 CLI/브라우저를 그대로 사용한다.

- [ ] **RED:** `fresh_owner_to_both_platforms_with_two_scoped_apps`, `interrupted_existing_install_keeps_keys_and_history`, `download_qa_requires_expected_signer_and_all_bounded_assets`를 작성한다. 새 private HOME·두 repo/root·두 signer/Runner scope를 사용하고 위 task들의 실제 route/controller를 연결한다. 한 앱의 토큰·배포·실패가 다른 앱으로 나타나지 않으며 crash/timeout 뒤 같은 원장을 재개한다. 잘못된 signer/keyId·다른 앱·unsigned·부족한 asset·과대 응답은 QA 통과가 아니다. fixture 실행은 실제 provider/기기 증거라고 출력하지 않는다.
- [ ] Run `flora_pnpm build && node scripts/test.mjs tests/onboarding-e2e.test.ts tests/onboarding-download-qa.test.ts`; RED 확인 후 필요한 integration wiring만 수정하고 GREEN으로 만든다. test 전용 제어 endpoint가 production bundle에 들어가지 않게 한다.
- [ ] README의 첫 경로를 `flora setup`으로 교체하고 new/existing/Runner 선택·private 승인 코드 확인·GitHub 본인 승인·공개 파일·첫 native binary·foreground 시작·부분 게시·확인 필요 상태를 한국어/영어로 맞춘다. 운영자의 JSON 편집/DevTools keyId 확인은 주 경로에서 제거하되 기존 수동/복구 reference는 남긴다. Commit named files: `test: cover installation wizard and first OTA flow [skip ci]`.
- [ ] 후보 commit을 **실제 새 clone** + 빈 canonical HOME/npm cache/pnpm store/XDG와 별개 빈 npm user/global 설정에서 받는다. pinned frozen install → `flora_pnpm check` → SDK pack → `flora setup` 시작/취소/inspect → Runner/supervisor `.mjs` 보조 테스트를 실행한다. Node/pnpm/npm/OS/commit과 pass/fail/skip·source hash 불변을 기록한다. 기능상 필요한 Docker 테스트는 fixture로 대체하지 않는다.
- [ ] 실제 QA 자원은 새 private 경로·고유 QA Worker/D1/hostname과 별도 GitHub RN 0.86.3 저장소 두 개다. 기존 Isso·Promise·Reward 및 운영 GitHub App/서명 키를 교체하지 않는다. 사용자 인증·MFA·계정 권한·무료 여유 확인이 필요한 지점에서만 인계한다. 권한/quota 확인이 안 되면 그 단계는 미완료로 기록한다.
- [ ] 마법사로 최초 owner → GitHub App/저장소 승인 → 공개 SDK 설정/standalone SDK tarball을 앱에 commit → 앱별 Runner 파일 생성/presence/foreground 실행 → 자동 정책을 진행한다. 두 QA 앱에서 각각 새 JS commit을 `[skip ci]`로 push하고 **실제 signed webhook → PC Docker export → iOS/Android 4개 배포**를 추적한다. 새 GitHub 저장소에는 Actions workflow를 만들지 않고 EAS/API를 호출하지 않는다.
- [ ] 네 배포의 app/SHA/channel/runtime/platform/job/deployment와 manifest/launch asset hash를 확인하고 웹 완료/상세 링크를 직접 확인한다. 다운로드 단절은 재게시 없이 다시 확인하도록 하며 원래 실패 로그를 남긴다. binary를 설치·실행하지 않았다면 적용/재시작은 미검증으로 남긴다. 이 단계는 원격 첫 게시/다운로드 검증이며 앞선 가상 fixture 성공과 따로 기록한다.
- [ ] 원본 작업 폴더 hash·HEAD/index/staging/status, 기존 설정/서비스/복구 journal 보존과 QA 앱별 이력 분리를 확인한다. 해당 push commit의 Actions 실행 0건을 readback하고 실행 로그/skip/남은 수동 단계까지 기록한다. QA 자원을 자동 삭제하지 않는다. 다음 milestone의 원격 게시/배포는 검토된 변경 범위에서만 진행하며 main을 force push하지 않는다.
- [ ] `git diff --check`, 관련 한국어/영어 링크와 예제의 parity, 최종 source diff·최종 별도 검토의 지적 사항을 확인한다. 변경 후 전체 검사를 다시 돌릴 필요가 생긴 경우만 반복하고, 실제 검증 기록을 문서 commit으로 남긴다: `docs: record wizard installation and OTA verification [skip ci]`.

## 자체 검토 결과·실행 인계

설계 §1–4/5.1은 Task 1–4/6, §5.2는 Task 3–4/6, §5.3은 Task 6, §5.4–5.5는 Task 7, §5.6은 Task 5/7, §5.7은 Task 8–10, §6은 Task 1/3–5/7, §7은 Task 6/8–9, §8–9는 위 파일 구조와 Task 10으로 연결했다. Review Focus의 5개 항목은 각 owner task에 RED/GREEN 검사를 배치했다. public API/CLI/브라우저 file 계약의 이름을 task 간 동일하게 사용하고, 자동 복구·재발급·scope 확대를 추가하지 않았다.

권장 실행 방식은 **Native: 본체 순차 구현 + 마지막 별도 전체 검토**다. 이 기능은 private 원장/provider/CLI/UI 간 계약이 이어져 있고 사용자는 불필요한 사용량 감소와 어려운 작업의 신중한 검증을 원한다. Native에서는 모든 task를 본체가 구현하고 task별 검증을 유지한다. 좁은 read-only 탐색에 위임이 유용하면 fast_scan을, 인증/파일 안전성을 포함한 마지막 별도 전체 검토에는 deep_worker를 사용한다. 대안인 Subagent-driven에서는 bounded 구현을 routine_worker에, 어려운 인증/안전성 작업을 deep_worker에 배정한다. 자동 역할 선택은 사용자 AGENTS 지침을 따르고 재귀 위임하지 않는다.

사용자가 더 독립적인 검토를 선택하면 **Subagent-driven**으로 각 task마다 구현자와 별도 검토자를 배정한다. 둘 다 원본 보존과 위의 실제 QA 완료 조건은 같다. 계획 검토·실행 방식 확인 전에 제품 코드·의존성·새 원격 리소스 작업을 시작하지 않는다.
