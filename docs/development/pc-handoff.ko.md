# PC 개발 인수인계와 작업 체크리스트

[README](../../README.md) · [최초 실행 가이드](../getting-started.ko.md) · [실제 연동 현황](integration-status.ko.md) · [단계별 로드맵](../roadmap/milestones.ko.md)

2026-10-12 UTC 문서 인수인계. 사용자 PC의 OS는 아직 정해지지 않았다. 다른 PC를 원격 조작하지 않고 GitHub에서 받아 이어갈 수 있게 준비한다. 현재 동작 범위는 한 앱의 정적 자료 반입·조회와 로컬 Foundation이다. 제품 구현·반입 증거·합성 테스트·운영 연결을 구분한다.

## 1. 저장소와 도구 준비

| 도구 | 저장소의 검증 기준 | 확인 위치 |
| --- | --- | --- |
| Node.js | **24.19.0**; engines `>=24.19.0 <25` | [.node-version](../../.node-version), [.nvmrc](../../.nvmrc), [package.json](../../package.json) |
| pnpm | **11.19.0** | packageManager와 frozen lockfile |
| Git/npm | Git, Node에 포함된 npm | `git --version`, `npm --version` |
| Cloudflare 개발 도구 | Wrangler **4.148.0**, Miniflare·workerd/esbuild 고정 의존성 | [cloudflare package](../../packages/cloudflare/package.json), [lockfile](../../pnpm-lock.yaml) |

Foundation 체험에는 Docker/Xcode/Java/Apple/Google/Expo/Cloudflare 계정이 필요하지 않다. [공식 Node 설치 경로](https://nodejs.org/en/download/archive/v24.19.0)로 고정 버전을 준비한다. 버전이 다르면 `engineStrict`를 끄거나 lockfile을 지우지 않는다. 아래 `npm exec`는 지정 pnpm을 다운로드/cache에서 실행하며 전역 설치를 요구하지 않는다.

새 PC에서 받기:

```sh
node --version
npm --version
git --version
git clone https://github.com/uulab-official/flora.git
cd flora
git rev-parse HEAD
git status --short
npm exec --yes --package=pnpm@11.19.0 -- pnpm --version
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
```

기존 checkout이라면 먼저 `git status --short`로 자신의 변경을 확인한다. clean 상태에서 `git pull --ff-only`로 갱신한다. 변경이 있으면 직접 보관·커밋 여부를 결정하거나 별도 clone을 사용한다. 다른 작업을 자동 stash/reset/삭제하지 않는다. 실제 작업은 `git switch -c work/<작업명>`으로 분리할 수 있다. 시작 시 `git rev-parse HEAD`를 기록한다.

설치 후 `check` 마지막 요약의 **0 fail**을 확인한다. clone에는 `dist`가 없으므로 CLI 실행 전 build/check가 필요하다. 테스트 수는 revision과 OS에 따라 달라진다.

## 2. 로컬에서 지금 실행할 수 있는 것

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform --help
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood --help
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform config validate --file examples/local-workflow.json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario happy-path
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario unsafe-expiry
npm exec --yes --package=pnpm@11.19.0 -- pnpm doctor:toolchain
```

예상 결과: doctor의 지원 Node/pnpm 버전 일치와 `nativeBuildVerified: false`; config의 `mode: local`; simulation의 `mode: local-simulation`. Runner 교체는 `attemptCount: 2`, `fence: 2`, 오래된 작업의 `LEASE_STALE` 거절이다. `unsafe-expiry`는 `waiting/reconciliation_required`가 정상이며 스토어 요청을 재실행하지 않는다. 실제 PC 등록·앱 binary·배포 결과가 아니다.

계정 없이 synthetic 자료를 반입하고 상태를 보는 명령:

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
```

본인 PC의 브라우저에서 UI를 확인하려면 다음 서버를 실행한다. 현재 인수인계 작업에서는 다른 담당자가 사용하는 Chrome를 열지 않았다.

```sh
node scripts/dogfood-demo.mjs --serve
```

출력된 bootstrap URL은 같은 컴퓨터에서만 열고 공유하지 않는다. Ctrl+C로 종료하며 재시작하면 새 URL이 필요하다. demo는 사용자 home의 `.flora/dogfood/demo.db`를 쓰고 실제 앱 기본 `state.db`와 분리된다. 실제 자료는 고정 [source/baseline 형식](dogfood.ko.md#3-자신의-자료-가져오기)을 먼저 확인한다. 다른 앱과 충돌하면 기존 DB를 삭제하거나 성공값을 꾸미지 않는다.

## 3. 환경 변수·설정 예시

로컬 Foundation/demo는 **`.env`, API token, 인증서, provider 로그인 없이** 실행한다. `examples/local-workflow.json`의 CONFIG는 공개 값이며 SECRET/FILE/CREDENTIAL은 버전 참조만 허용한다. 실제 비밀값을 예제에 넣지 않는다.

별도 hosted 개발 경로는 [Wrangler 예제](../../packages/cloudflare/wrangler.example.jsonc)의 `vars`를 사용한다. 아래 값은 비밀 없는 placeholder이며 바로 배포하는 설정이 아니다. `.env` 파일을 만들거나 환경 변수로 export한다고 Worker vars·binding이 자동 연결되지는 않는다.

```json
{
  "vars": {
    "FLORA_ORIGIN": "https://flora.example.invalid",
    "FLORA_OWNER_ID": "replace-owner-id",
    "FLORA_OWNER_EMAIL": "owner@example.invalid",
    "FLORA_DB_IDENTITY": "replace-database-identity"
  }
}
```

운영 config는 검토된 비공개 위치에 보관하고, 실제 account/zone·전용 D1 UUID·DO/ASSETS binding·DB identity marker와 일치를 확인해야 한다. `workers_dev=false`, `preview_urls=false`, 인증을 먼저 거치는 topology와 기본 잠긴 setup을 유지한다. 비밀번호·토큰·키·원문 setup 값은 코드/README/vars에 넣지 않는다. [호스팅 가이드](password-hosting.ko.md)와 [실제 출시 gate](../release/password-hosting-evidence.md)를 통과하기 전 운영 연결 완료로 표시하지 않는다.

## 4. Windows PC와 Mac의 차이

| 항목 | Windows | Mac |
| --- | --- | --- |
| Foundation·snapshot·loopback UI | 같은 Node/pnpm 명령 지원 | 같은 명령 지원 |
| PowerShell 실행 정책 | `npm.ps1`이 차단되면 명령의 `npm`만 `npm.cmd`로 변경. 실행 정책을 낮추지 않음 | 터미널의 `npm` 사용 |
| private DB custom 경로 | 사용자 profile의 `.flora/dogfood` 하위만 지원 | 사용자 소유 0700 parent 또는 전용 private leaf; 자세한 경계는 dogfood 문서 |
| iOS native build | 로컬 Xcode 불가; 향후 검증된 조직 Mac Runner 필요 | macOS/Xcode가 필요하지만 현재 Flora의 실제 Runner/native adapter는 없음 |
| Android/Web 실행 | 필요한 toolchain과 실제 adapter 구현 후 검증 | 같은 조건. Mac이라는 이유만으로 준비 완료 아님 |
| 다른 기기의 인증 | 기존 키·브라우저 세션·`.env`를 복사해 해결하지 않음 | Keychain 등 기존 자격정보를 다른 환경이나 웹앱으로 복사하지 않음 |

PC OS를 정한 뒤 해당 OS에서 install/check/CLI를 직접 실행한 결과를 남긴다. CI 결과를 그 PC에서 직접 실행한 결과로 표현하지 않는다. 기존 native 빌드·Unity·다른 앱의 runner나 process를 재사용·중단하지 않는다.

## 5. 검사 기록과 완료 조건

| 검사 | 확인된 증거 | 이번 Mac 문서 작업의 범위 |
| --- | --- | --- |
| baseline build/typecheck/tests·CLI·clean install | `b2f14736…`의 [Foundation CI](https://github.com/uulab-official/flora/actions/runs/37701924355), macOS/Windows/Ubuntu 모두 success | Node 22.23.2/pnpm 11.10.0으로 확인되어 고정 버전 검사는 로컬 미실행. 호환 조건을 낮추지 않음 |
| synthetic UI | [Dashboard CI](https://github.com/uulab-official/flora/actions/runs/37701924369), [Hosted CI](https://github.com/uulab-official/flora/actions/runs/37701924393) success | 브라우저 UI를 열지 않음 |
| 인수인계 문서 | 상대 파일 링크·고정 버전·CLI 예시를 소스와 대조, `git diff --check` | 문서 검증; 앱 테스트를 실행한 것으로 세지 않음 |
| 실제 native/build/store/OTA/provider sync | 증거 없음 | 미실행·미완료 |
| 운영 Worker/D1/DO·DNS/TLS·소유자 등록 | 출시 gate 미검증; 마지막 공개 DNS/auth 관측은 [현황 문서](integration-status.ko.md) 참조 | 새 로그인·리소스·DNS·별도 자동 배포 없음 |

이번 문서 커밋의 실제 검사 결과는 [Actions](https://github.com/uulab-official/flora/actions)에서 **사용 중인 SHA**로 확인한다. Foundation는 일반 push에서 실행된다. Hosted rendering은 README와 지정된 코드/호스팅 문서 변경에서, Dashboard rendering은 지정된 코드/harness 변경에서 실행된다. 경로 필터에 걸리지 않은 workflow는 미실행으로 기록하며 성공으로 간주하지 않는다. workflow 파일 존재·다른 SHA의 성공·fixture 렌더링을 현재 운영 성공으로 대체하지 않는다.

새 기능/수정 후 기본 검사:

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm doctor:toolchain
npm exec --yes --package=pnpm@11.19.0 -- pnpm verify:clean
git diff --check
git status --short
```

`verify:clean`은 Git 추적 파일만 임시 사본으로 만들고 빈 store에서 다시 설치·검사한다. 새 파일도 반영하려면 본인 작업 파일을 검토해 index에 올린 뒤 수행한다. 의존성을 다시 받을 수 있으므로 시간·디스크·네트워크를 확보한다. 실제 비밀 자료를 테스트에 쓰지 않는다.

## 6. 미비점과 우선순위 체크리스트

### P0 — PC에서 현재 기능을 재현

- [ ] OS/architecture·source SHA·Node/pnpm 버전을 기록하고 frozen install/check 성공.
- [ ] CLI 세 simulation의 정상·실패 복구 결과를 확인하고 synthetic 실행으로 표시.
- [ ] synthetic demo 상태 조회와 자신의 PC loopback UI 확인. bootstrap URL은 증거에 남기지 않음.
- [ ] 실제 provider 없이도 import/blocked/error UI가 정확한 상태를 표시하는지 확인.

완료 조건: 같은 SHA에서 0 fail, 지원 도구 버전, 반입 provenance와 실행 차단을 구분한 비밀 없는 기록. 실제 서비스 인증은 필요하지 않다.

### P1 — 앱 하나의 읽기 전용 GitHub 연결 (다음 첫 구현)

- [ ] 한 repo·root·타깃을 선정하고 현재 고정 importer/profile의 호환성을 먼저 확인.
- [ ] 기존 승인 설계의 SourceProvider 경계를 사용해 repo ID·고정 commit·허용 파일·CI 상태 읽기 어댑터 구현.
- [ ] 일반 저장소가 고정 형식에 맞지 않으면 별도 importer/profile을 설계하고 coverage를 명시. 테스트 성공값 변조 금지.
- [ ] provider 응답의 안전한 정규화·수집 시각·stale/error·rate limit을 UI와 이력에 기록.
- [ ] 공개 fixture contract test와 권한 부족/응답 유실 테스트 후, 필요한 경우 선택 repo의 최소 읽기 scope만 사용자에게 설명.

완료 조건: 앱 하나의 실제 읽기 결과를 source SHA와 시각으로 추적하고 `operator-import`/`provider-observed`를 구분한다. 지속 권한·키 보관 경로가 없으면 fixture 검증까지만 완료로 표시한다. 현재 개발 도구의 자격정보를 Flora로 복사하지 않는다.

### P2 — 검증된 Runner와 실제 artifact

- [ ] 원본 source fetch/digest 재검증과 격리된 job workspace adapter 구현.
- [ ] CPU/메모리/PID/디스크/출력 제한·network 정책·전체 process 취소·cleanup을 실제 검증.
- [ ] 조직/job/attempt/fence에 묶인 등록·claim/heartbeat/result·revoke 구현. 새 machine credential은 직접 승인 필요.
- [ ] smoke job → Web 타깃 build 순서로 확대하고 source/config/toolchain/adapter·artifact hash 기록.
- [ ] lease 만료·중복 요청·취소·runner 교체·cleanup 실패를 fail closed로 검증.

완료 조건: 실제 adapter의 preflight와 bounded 실행·cleanup 증거. contract test용 provider나 일반 subprocess fallback을 제품 Runner로 등록하지 않는다. 본인 PC가 켜져 있다는 사실만으로 완료되지 않는다.

### P3 — Flora 호스팅과 Web 파일럿 배포

- [ ] 유효한 기존 관리 인증과 지정 Free 계정·zone·공유 여유·hostname 충돌 확인.
- [ ] 검증본 Worker/SQLite DO/전용 D1·identity·정확 endpoint를 확인하고 실제 Free 성능 gate 수행.
- [ ] hostname 연결 뒤 DNS → TLS → HTTP → 인증 → 저장/복구를 단계별로 확인.
- [ ] 소유자가 유효한 HTTPS 화면에서 직접 초기 비밀번호·setup 등록을 수행.
- [ ] 파일럿 Web artifact의 deployment receipt·source/asset hash·rollback 경로 확인.

완료 조건: 정확한 계정·호스트·version과 접속/복구 증거. Node/SQLite 로컬 성공이나 dry-run으로 완료하지 않는다. 이전 거절된 OAuth를 재시도·우회하지 않는다. 새 권한·리소스/보안 변경·법적 동의가 필요하면 정확한 항목에서 중단한다. R2/Access/유료/초과과금 fallback 금지. 일반 main push만으로 새 자동 운영 배포를 켜지 않는다.

### P4 — Apple/Google/EAS 상태와 native/OTA 확장

- [ ] 선택 app ID/package/project의 상태 조회 어댑터부터 구현하고 마지막 관측 시각·error 표시.
- [ ] 다른 작업의 API 키·서명 파일·로그인을 Flora에 이전하지 않고 제품 credential 경계를 설계.
- [ ] Mac iOS/Android 타깃의 실제 build·서명·artifact provenance 검증.
- [ ] upload receipt → provider processing → TestFlight/Play 테스트 배포 → submit/release를 분리.
- [ ] OTA runtime 적합성·manifest/assets·publish/history/rollback·실기기 결과 검증.

완료 조건: 각 provider의 최소 scope·target과 credential reference가 승인되고 실제 결과 receipt가 남는다. 다른 작업의 Apple 앱 조회/EAS 접근·Play 게시 성공을 Flora 연동으로 세지 않는다.

### P5 — 다중 앱과 조직 공용 운영

- [ ] multi-app registry·repo/root/target mapping 및 앱별 store/이력 분리.
- [ ] 조직 로그인·action별 RBAC·tenant isolation·audit/reconciliation 구현.
- [ ] Vault key custody·회전·backup/restore·credential revoke 검증.
- [ ] 조직 Runner pool·다른 PC 요청·유일한 Mac offline·복구 경로 검증.

완료 조건: 두 조직/복수 앱의 교차 접근 거부와 PC 교체 후 동일 입력의 검증 가능한 실행. 기존 단일 앱 DB의 한계를 일반 설정만으로 해결했다고 표시하지 않는다. 이 경계는 여러 앱에 production 권한을 부여하기 전에 준비한다.

## 7. 다음 개발자의 첫 작업

먼저 P0으로 자신의 PC에서 기준 상태를 재현한다. 그 뒤 **P1의 한 repo/root를 읽는 SourceProvider 어댑터와 import/profile 호환성 검사**부터 시작한다. 실제 build/store/OTA 버튼을 한꺼번에 추가하지 않는다. 현재 UI가 운영값을 얻을 수 있는 첫 연결 고리를 만든 뒤 Runner와 Web 파일럿으로 확대한다.

작업 기록에는 OS·SHA·명령·pass/fail/미실행·변경 파일·다음 blocker를 남긴다. 새 인증/권한이 필요하면 서비스·앱/프로젝트·읽기/쓰기 목적을 구체화하고 사용자 직접 입력/승인 단계로 넘긴다. source 커밋·푸시와 실제 운영 배포는 서로 다른 결과로 보고한다.
