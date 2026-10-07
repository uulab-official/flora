# 로컬 앱 가져오기와 검사 이력

[처음 실행하기](../getting-started.ko.md) · [README](../../README.md) · [기존 Foundation CLI](local-foundation.ko.md)

이 단계는 한 앱의 **정적 source snapshot과 사용자가 반입한 검사 결과**를 개인 저장소에 보관하고, 현재 PC의 loopback 웹 화면에서 보는 기능입니다. 실제 앱 source를 실행하거나 native build·스토어 등록·배포를 하지 않습니다. 기본 실행 provider는 미지원 상태를 기록할 뿐 source나 일반 subprocess를 실행하지 않습니다.

## 1. 설치와 검사

Node **24.19.0**, Git, Node에 포함된 npm을 준비하고 저장소 루트에서 실행합니다. macOS/Linux 터미널과 Windows PowerShell/명령 프롬프트에서 같은 명령을 사용합니다. Windows에서 `npm.ps1`이 차단되면 `npm`만 `npm.cmd`로 바꿉니다.

```sh
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood --help
```

`check`가 build·strict typecheck·전체 테스트를 통과한 뒤 다음으로 진행합니다. 테스트 개수는 revision과 OS에 따라 달라질 수 있으며 실패가 0인지 확인합니다. 실제 macOS/Windows/Linux 실행 여부는 [해당 revision의 CI](https://github.com/uulab-official/flora/actions/workflows/ci.yml)에서 확인합니다. 워크플로 파일만으로 세 OS 성공을 주장하지 않습니다.

## 2. 가상의 앱으로 바로 체험

다음 명령을 그대로 실행합니다. 예제는 홈 profile의 `.flora/dogfood/demo.db`를 사용하며 실제 앱의 기본 `state.db`는 생성하거나 변경하지 않습니다. 조직 계정, 실제 저장소, API key, `.env`, 인증서는 필요 없습니다.

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
node scripts/dogfood-demo.mjs --serve
```

첫 명령은 공개된 `examples/dogfood-source.synthetic.json`과 `examples/dogfood-baseline.synthetic.json`만 가져옵니다. 반환한 `inventory_…` ID를 자동으로 baseline import에 전달하므로 ID를 수동으로 맞출 필요가 없습니다. 결과는 `mode: "synthetic-dogfood-demo"`, `baselineState: "passed"`, `files: 2`, `tests: 4`, `evidenceOrigin: "operator-import"`, `isolatedExecution: "not_run"`입니다. **가상의 테스트 증거**이며 실제 테스트를 새로 실행한 결과가 아닙니다.

demo script의 `--serve`는 실제 `flora dogfood serve --db <demo-path>`를 호출합니다. 서버는 현재 컴퓨터의 `127.0.0.1`에만 연결하고, 운영체제가 비어 있는 포트를 선택합니다. 터미널에 한 번 출력되는 bootstrap URL을 **그 컴퓨터의 브라우저**에서 여세요. URL의 일회용 비밀값은 5분 뒤 만료되므로 공유하거나 로그/이슈에 붙이지 않습니다. 브라우저는 이 값을 fragment에서 읽은 뒤 주소에서 제거합니다. 정상 재로딩은 HttpOnly 세션 cookie를 사용합니다. 서버 재시작 후에는 새 URL이 필요합니다.

화면에서 snapshot·flavor·runtime 선언·source pointer·수집 시각·검사 이력을 확인합니다. 선택 flavor는 관람 대상입니다. 고정 검사가 그 flavor의 모든 동작을 실행했다는 뜻이 아닙니다. 실행 버튼을 눌렀을 때 기본 provider 결과가 `blocked`/`PROVIDER_UNSUPPORTED`가 되는 것이 현재의 정상 동작입니다. 기존 imported development baseline의 4/4 결과와 새 isolated-runner-result는 별도 이력으로 남습니다.

종료는 서버 터미널에서 Ctrl+C입니다. 서비스의 처리/정리를 기다리고 서버와 DB를 닫습니다. 살아 있는 서버가 같은 store를 소유하면 두 번째 serve는 `STORE_IN_USE`로 실패하며 진행 중인 이력을 복구하거나 덮어쓰지 않습니다.

## 3. 자신의 자료 가져오기

**현재는 정해진 앱 구조를 위한 반입 경로입니다.** 임의 Expo·Unity·Web 저장소를 URL만으로 연결하거나 자동 분석하는 기능이 아닙니다. 한 앱의 여러 flavor를 표시하며, 수십·수백 개의 독립 앱을 한 화면에서 관리하는 기능은 아직 없습니다. 아래 형식에 맞지 않는 앱을 연결하려고 파일명을 바꾸거나 테스트 성공값을 꾸미지 마세요. 별도 importer/profile 지원이 필요합니다.

Source bundle은 rootDirectory 기준으로 다음 10개 파일을 모두 포함해야 합니다. `src/core/experience/types.ts`만 선택적으로 추가할 수 있고 다른 파일은 거부합니다. 정확한 validation은 [source.ts](../../packages/dogfood/src/source.ts), envelope 필드는 [types.ts](../../packages/dogfood/src/types.ts)에 있습니다.

```text
package.json
package-lock.json
flavors/config.json
src/core/config/runtime.ts
src/core/experience/runtime.ts
config/experience-contract.json
vitest.config.mts
tsconfig.json
tests/config/runtime.test.ts
tests/config/experience-runtime.test.ts
```

Baseline도 [config-runtime-smoke-v1](../../packages/dogfood/src/profile.ts)에 고정되어 있습니다. 위 두 test file에서 각각 2개씩 총 4개 검사를 실행한 정확한 argv·보고서·원본 hash가 필요합니다. 범용 테스트 결과 변환기나 GitHub에서 bundle을 생성하는 CLI는 아직 없습니다. 형식을 준비하기 전에는 2절의 공개 demo만 체험할 수 있습니다.

한 store는 한 repository/root 앱에 묶입니다. 기본 demo.db와 실제 앱용 state.db가 분리되므로 예제 이후 자신의 앱을 기본 CLI로 가져올 수 있습니다. 예제 경로가 이미 다른 앱에 묶여 있다면 `CONFLICT`로 멈추며 기존 이력을 삭제하지 않습니다. 새 private 경로를 선택해 `node scripts/dogfood-demo.mjs --db <private-path>`로 가져온 뒤 `--status`/`--serve`에도 같은 `--db`를 전달하세요. 서로 다른 실제 앱에도 별도 private DB를 사용합니다. 기존 store를 자동 삭제하거나 다른 앱으로 바꾸는 명령은 없습니다.

기본 DB는 `node:os.homedir()` 아래 `.flora/dogfood/state.db`입니다. source checkout 안에 만들지 않습니다. POSIX에서 custom DB는 이미 현재 사용자 소유의 0700 parent 안 또는 새로 만드는 전용 0700 leaf 안에만 둘 수 있습니다. 여러 단계의 임의 parent를 자동 생성하지 않습니다. Windows custom DB는 사용자 profile의 `.flora/dogfood` 하위만 지원합니다. shared/network 폴더나 profile 밖 경로를 우회 지원하지 않습니다.

가져올 파일을 준비했다면 다음 형식을 사용합니다. 아래 `source-bundle.json`/`baseline-bundle.json`은 자신의 파일명으로 바꾸고, baseline의 snapshot ID는 첫 명령이 반환한 **`inventory_` 접두사를 포함한 전체 ID**로 바꿉니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood import-source --file source-bundle.json
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood import-baseline --snapshot inventory_00000000-0000-0000-0000-000000000000 --file baseline-bundle.json
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora dogfood status --json
```

위 0으로 채운 ID는 설명용입니다. 신규 사용자는 2절의 demo script부터 실행하면 실제 반환 ID를 자동으로 연결합니다. 웹 화면에서도 JSON 파일을 선택해 source와 baseline을 가져올 수 있습니다.

SourceBundleV1은 schemaVersion, repository 식별/visibility, commitSha, rootDirectory, fetchedAt, selectedFlavor, 허용 파일들의 path/gitBlobSha/sha256/contentBase64를 포함합니다. 공개 synthetic source 파일과 `packages/dogfood/src/types.ts`를 형식 예제로 참고하세요. importer는 byte/hash와 선언된 JSON field만 읽습니다. `.env`, executable config, scripts/hooks, TypeScript module을 평가하지 않습니다. 일회성 snapshot import는 지속적인 GitHub 연결이나 최신 HEAD 조회가 아닙니다.

BaselineBundleV1은 해당 snapshot의 sourceDigest/commit/profile/attempt, 실행 platform/architecture, 정확한 argv, runtime 버전, 실제 시작·종료 시각/duration/exit code, 원본 report byte/hash, source 전후 hash, bounded log를 연결합니다. 공개 synthetic baseline은 schema 예제입니다. 자신의 실행 증거를 만들 때는 실제 원본 byte/hash·시각·exit code를 보존하고 sample 결과를 재사용하지 않습니다. importer는 2개 test file·4개 고유 assertion을 비롯한 내부 일치성을 검증합니다. plausible false pass, source/profile/attempt 불일치, 손상된 report는 통과 결과가 되지 않습니다.

source와 baseline 입력은 각각 최대 **2 MiB**입니다. reader는 초과를 확인할 한 byte까지만 추가로 읽습니다. 기존 `config validate`/`job simulate` workflow의 파일 읽기와 decode 한도는 각각 **1 MiB**로 그대로입니다. source bundle은 별도의 decoded 파일별/총량 제한도 만족해야 합니다. 초과 input은 DB를 만들거나 변경하기 전에 거절합니다.

## 증거를 읽는 방법

- `operator-import`: 사용자가 반입한 증거입니다. hash는 입력 내부 일치성을 확인합니다. live GitHub 조회, 실행의 독립 검증, sandbox 인증을 뜻하지 않습니다
- `development-baseline`: 반입한 개발 환경의 검사 결과입니다. 실제 isolated Runner 결과와 합치지 않습니다
- `isolated-runner-result`: Flora의 실행 요청 이력입니다. 현재 기본 경로는 `not_run` 또는 `blocked`입니다
- `freshness_unknown`: 최신 여부를 모릅니다. 새 SHA snapshot을 반입해도 다른 snapshot을 자동으로 최신이라고 인증하지 않습니다. 해당 source와 연결된 유효한 newer-head 관측이 있을 때 오래된 snapshot을 stale로 표시합니다
- browser OS와 execution OS/SDK는 별개입니다. Windows/Mac에서 화면이 열린다고 iOS 실행 준비가 된 것은 아닙니다. iOS에는 검증된 macOS/Xcode Runner가 필요합니다

## 개인 저장소와 안전한 실패

POSIX는 생성 전 process umask077, 새 디렉터리0700/DB0600을 사용합니다. 기존 디렉터리·DB·journal/WAL/SHM의 owner, mode, regular-file/single-link 여부를 검사하고 symlink ancestry/대상/sidecar와 hardlinked DB를 거절합니다. 기존 unsafe 권한을 chmod/chown해서 통과시키지 않습니다. Windows는 전용 profile 경로와 상속된 접근권한을 사용하며 ACL을 수정하거나 POSIX mode가 Windows ACL 보장이라고 표시하지 않습니다.

`PRIVATE_STORE_UNSAFE`이면 공유 경로나 기존 권한·link를 확인하고 별도의 private 전용 경로를 선택하세요. 오류에 나온 code 외에 private 경로나 비밀값을 공개 이슈에 추가하지 마세요. `INPUT_TOO_LARGE`는 입력 byte 한도 초과입니다. `STORE_IN_USE`는 살아 있거나 생존 여부를 확정할 수 없는 owner가 있음을 뜻합니다. 시간 경과만으로 소유권을 빼앗지 않습니다. 같은 host의 기록된 PID가 signal0에서 ESRCH를 반환할 때만 새 serve가 owner를 획득하고 미완료 기록을 명시적으로 중단 처리합니다. import/status는 owner 획득이나 startup recovery를 실행하지 않습니다.

API는 exact Host/Origin, session, CSRF를 검사하고 bootstrap replay, cross-site 요청, 과대 payload를 차단합니다. loopback 인증은 production 인증의 대체가 아닙니다. URL 공개, LAN bind, tunnel, port forwarding, cloud hosting은 이 명령이 수행하지 않습니다. Cloudflare 배포에는 사용자 private 접근 경로, 인증, 환경/수명/storage 적합성, 권한 확인이 별도로 필요합니다.

## 검증 범위

`pnpm check`에는 synthetic SQLite/HTTP E2E, false-pass/report 검증, lease/cancel/late-result 계약, owner/private-store/input 경계, HTTP 보안과 UI 주입 테스트가 포함됩니다. `pnpm verify:clean`은 staged/tracked source 사본에서 같은 검사를 반복하고 원본 변경 여부를 확인합니다. UI 자동화와 실제 3 OS CI의 결과는 별도로 기록해야 하며 API 테스트나 fake DOM만으로 실제 브라우저 검증 완료를 주장하지 않습니다. 실제 private source·결과·로그·스크린샷은 Git이나 공개 CI artifact에 넣지 않습니다.
