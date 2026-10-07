# 처음 실행하기

[README](../README.md) · [English quick start](../README.en.md#try-the-local-foundation) · [CLI·데이터 계약 상세](development/local-foundation.ko.md)

## 지금 무엇을 써볼 수 있나요?

지금은 **로컬 Foundation CLI와 보호된 loopback 웹 화면**을 사용할 수 있습니다. 설정·Job/lease를 시험하고, 정적 앱 source snapshot과 반입한 개발 baseline 이력을 봅니다. Foundation artifact는 모의 metadata이며 기본 실행 provider는 blocked입니다.

웹 화면은 현재 컴퓨터의 127.0.0.1에서 엽니다. 공개 접속 서비스·AI 코드 수정·실제 Runner 등록·native build·Store/OTA/Web 배포는 후속 단계입니다. 앱 계정에 로그인하거나 API key, `.env`, 인증서를 넣지 마세요. [웹 AI 상세 설계](proposals/web-ai/next-slice-spec.ko.md)는 검토 대기 중인 다음 단계 제안입니다.

## 1. 준비

- [Node.js **24.19.0**](https://nodejs.org/en/download/archive/v24.19.0)과 함께 제공되는 npm
- [Git](https://git-scm.com/install/), 소스·공개 패키지를 받기 위한 인터넷 연결
- 파일을 쓸 수 있는 작업 폴더와 임시 폴더

별도 pnpm 전역 설치, 관리자 권한 터미널, Docker, Xcode, Java, Apple/Google/Cloudflare/Expo 계정은 이 체험에 필요하지 않습니다. 최신 Node 대신 저장소의 `.node-version` / `.nvmrc`와 같은 **24.19.0**을 사용합니다.

아래 명령은 macOS/Linux 터미널, Windows PowerShell/명령 프롬프트에서 한 줄씩 실행합니다. 한 단계가 실패하면 다음 단계로 넘어가지 말고 아래 문제 해결을 확인하세요. Windows에서 `npm.ps1`이 차단되면 `npm`을 **`npm.cmd`**로 바꾸면 됩니다. PowerShell 실행 정책을 낮추지 않습니다.

## 2. 받아서 검사하기

```sh
node --version
npm --version
git --version
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm --version
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
```

- Node 출력: `v24.19.0`, pnpm 출력: `11.19.0`. `npm --version`은 다른 프로그램의 버전이므로 pnpm 버전과 같을 필요가 없습니다
- `check`는 패키지 build → typecheck → 테스트를 실행합니다. 마지막 요약에서 **0 fail**을 확인합니다. 테스트 개수는 revision·OS에 따라 달라집니다
- clone에는 컴파일된 `dist`가 없습니다. install·check를 마친 뒤 CLI를 실행하세요
- `npm exec`는 지정한 pnpm을 npm cache에서 실행합니다. 전역 pnpm이나 Corepack을 미리 설정할 필요가 없습니다
- 전체 검증을 하려면 “Download ZIP” 대신 **Git clone**을 사용하세요. `verify:clean`은 Git이 추적하는 파일 목록이 필요합니다

## 가상의 앱으로 웹 화면 먼저 열기

설치·check 후 아래 명령을 그대로 실행하면 계정·실제 앱 없이 화면을 체험합니다.

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
node scripts/dogfood-demo.mjs --serve
```

같은 컴퓨터의 브라우저로 출력 URL을 엽니다. demo는 `example/synthetic-app`의 가상 source와 2개 파일/4개 테스트 증거를 반입하고 실제 실행은 하지 않습니다. `operator-import`, `development-baseline`, `isolatedExecution: "not_run"`을 구분하세요. UI의 새 실행 요청은 `blocked`가 정상입니다. URL의 일회용 비밀값을 공유하지 마세요. 종료는 Ctrl+C이며 재시작 후에는 새 URL을 사용합니다.

예제는 홈 profile의 `.flora/dogfood/demo.db`를 사용하고 실제 앱의 기본 `state.db`와 분리됩니다. 현재 한 앱의 여러 flavor를 표시하며 여러 독립 앱의 통합 관리는 아직 지원하지 않습니다. 자신의 자료도 [고정 source·검사 형식](development/dogfood.ko.md#3-자신의-자료-가져오기)을 만족해야 합니다. 한 store는 한 앱에 묶이므로 예제 경로에 다른 앱이 이미 있다면 자동 삭제하지 않고 새 private DB 경로를 선택합니다. [앱 import·private store·안전한 실패 상세](development/dogfood.ko.md)에 정확한 형식과 지원 경로가 있습니다. 이후 단계의 기존 Foundation simulation도 계속 사용할 수 있습니다.

## 3. 환경과 설정 확인하기

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform config validate --file examples/local-workflow.json
```

`doctor`에서 Node의 `supported: true`, pnpm의 `version: "11.19.0"`을 확인합니다. `nativeBuildVerified: false`는 정상입니다. Xcode·Java의 `unavailable`, Linux/Windows의 Xcode `unsupported`는 이 체험의 실패가 아닙니다. doctor는 현황을 보고할 뿐 도구를 설치하거나 native build 준비를 보장하지 않습니다.

예제를 바꾸지 않았다면 config 결과의 `mode`는 `local`이고 `snapshotId`는 다음과 같습니다.

```text
cfg_93168f5527f4bab730a0efbc52230e1130ef4205635765a25c7b620052714747
```

key와 secret **버전 참조**만 출력합니다. 값이 출력되지 않는 것은 의도된 동작입니다. 예제의 `production`, `ios`, `API_TOKEN`은 가상 타깃·참조 이름이며 실제 production이나 비밀값을 읽지 않습니다.

## 4. 정상 처리와 실패 복구를 체험하기

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario happy-path
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario unsafe-expiry
```

세 명령 모두 종료 코드 0과 `mode: "local-simulation"`을 반환합니다. JSON에서 다음 필드를 찾으세요.

| 시나리오 | 확인할 결과 | 의미 |
| --- | --- | --- |
| `happy-path` | `summary.jobs[0].status: "success"`, `attemptCount: 1`, `fence: 1`, artifact 1개 | 모의 Job 정상 완료 |
| `runner-replacement` | Job `success`, `attemptCount: 2`, `fence: 2`, `rejectedOperations[0].code: "LEASE_STALE"` | A의 실행권 만료 후 B가 처리하고, A의 뒤늦은 완료를 거부 |
| `unsafe-expiry` | Job `waiting`, `waitingReason: "reconciliation_required"`, artifact 0개 | 결과를 모르는 Store 작업을 무작정 재실행하지 않음 |

`LEASE_STALE`은 의도한 방어 결과이며, `unsafe-expiry`의 `waiting`도 정상입니다. 실제 다른 PC를 등록하거나 Store API를 호출한 것이 아닙니다. 가상 시간을 진행시키므로 lease가 만료될 때까지 30초를 실제로 기다리는 실험도 아닙니다.

실행할 때마다 Job/attempt ID·시각·artifact digest는 달라집니다. 같은 예제의 config snapshot ID는 같습니다. 각 명령은 별도 임시 SQLite DB를 만들고 종료 시 제거합니다. 터미널 JSON이 결과이며 앱 binary나 지속적인 release DB가 남지 않습니다.

설정을 바꿔보고 싶다면 예제 파일의 사본을 만들고 `CONFIG`인 `API_URL`의 공개 값만 바꿔 검증해보세요. 새 설정은 다른 snapshot digest를 만듭니다. `SECRET`에 실제 `value`를 넣는 것은 거부되며 Vault 기능이 아닙니다.

## 5. 새 설치까지 재검증하기

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm doctor:toolchain
npm exec --yes --package=pnpm@11.19.0 -- pnpm verify:clean
```

첫 명령은 `Toolchain verified: Node 24.19.0 / pnpm 11.19.0`을 출력합니다. `verify:clean`은 Git 추적 파일만 별도 임시 폴더로 복사하고 **빈 pnpm store**에서 frozen install·전체 검사·CLI smoke를 재실행합니다. 원본과 사본의 source hash도 확인합니다. 패키지를 다시 받을 수 있으므로 인터넷이 필요할 수 있습니다.

마지막 JSON의 `cleanInstall: "passed"`, `isolatedStore: true`, `originalUnchanged: true`를 확인하세요. `sourceFiles` 수는 revision에 따라 달라집니다. 임시 사본은 종료 후 제거합니다. 결과를 저장하려면 shell의 출력 저장 기능을 사용하되 실제 비밀값을 입력하지 마세요.

## 막혔을 때

| 증상 | 확인·복구 |
| --- | --- |
| `node`/`npm`을 찾지 못함, Node 버전 불일치 | 공식 Node 24.19.0을 선택하고 터미널을 다시 연 뒤 `node --version` 확인. `engine-strict`를 끄거나 lockfile을 지우지 않음 |
| `pnpm`을 찾지 못함 | 이 문서의 전체 `npm exec --yes --package=pnpm@11.19.0 -- pnpm` 접두어 사용 |
| Windows `npm.ps1` 실행 정책 오류 | 동일 명령에서 `npm`만 `npm.cmd`로 변경 |
| `dist`/workspace module을 찾지 못함 | 저장소 루트에서 pinned install과 `check`를 먼저 완료 |
| `USAGE_ERROR`, 종료 코드 2 | 명령 순서·시나리오 철자 확인. `npm exec --yes --package=pnpm@11.19.0 -- pnpm platform --help` 실행 |
| `INPUT_OR_OPERATION_FAILED`, 종료 코드 1 | 저장소 루트인지, 입력 파일이 존재하는지, 정상 UTF-8 JSON인지 확인하고 원본 예제부터 실행. 도메인 오류는 더 구체적인 안전한 code를 반환할 수 있음 |
| 네트워크·registry 다운로드 오류 | GitHub·패키지 registry 연결을 복구하고 같은 frozen install 재시도. TLS 검증을 끄거나 token을 이슈에 붙이지 않음 |
| `verify:clean`에서 Git 추적 파일을 못 읽음 | ZIP 대신 Git clone 사용. ZIP도 build 후 CLI 실행은 가능할 수 있지만 Git 기반 clean 검증은 불가 |
| `unsafe-expiry`가 `waiting` | 의도한 안전 상태. 명령은 종료되며 다음 실행은 새 simulation임 |

문제가 계속되면 [이슈](https://github.com/uulab-official/flora/issues)에 OS/architecture, Node/npm/pnpm 버전, `git rev-parse HEAD`, 실행 명령, 비밀정보를 지운 오류를 남겨주세요. 계정 key·인증서·실제 secret은 첨부하지 마세요.

## 검증 범위

2026-10-07에 source revision `02269503`을 새로 clone하고, 빈 HOME·npm cache·pnpm data/cache에서 이 문서의 명령을 Linux로 검증했습니다. 이 **과거 Foundation-only revision**의 48검사, 세 simulation, toolchain 검사와 clean install이 통과했습니다. 실제 외부 provider·native build 검증은 아닙니다.

[CI](../.github/workflows/ci.yml)는 같은 npm-exec 설치 경로와 Foundation 검사·CLI 예제·clean 설치를 Linux/macOS/Windows에서 실행합니다. 설정 존재를 성공 증거로 대신하지 말고 [사용 중인 revision의 실제 결과](https://github.com/uulab-official/flora/actions/workflows/ci.yml)를 확인하세요.
