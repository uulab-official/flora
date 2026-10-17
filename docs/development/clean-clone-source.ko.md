# 새 clone의 소스 완전성과 독립 설치 검증

이 문서는 검증할 Git URL·revision에서 SDK·Runner를 포함한 소스를 새로 받아 설치·빌드·타입 검사·테스트·CLI까지 확인하는 절차입니다. 절차 자체는 특정 revision의 통과 증거가 아닙니다. 실행 결과에는 source commit, OS·architecture, 도구 버전, 종료 코드, 성공·실패·skip 수를 함께 기록하세요.

## 소스 revision에 포함할 파일

루트 및 각 패키지가 사용하는 모든 `workspace:` 의존 패키지의 manifest·소스·빌드 설정·테스트, 루트 lockfile·workspace 설정, 테스트에 필요한 공개 fixture가 필요합니다. Flora SDK와 Runner의 네이티브 소스·샘플도 사용 경로에 맞춰 포함합니다. 테스트용으로 공개한 인증서 fixture와 실제 서비스 인증서는 구분하세요.

개인키·서비스 계정·인증 세션·`.env`·운영 DB·다운로드 자산·복구 저널·캐시·스크린샷은 소스 검증을 위해 복사할 필요가 없습니다. 기존 운영 경로를 검사 폴더로 사용하거나, 원본 작업 트리의 변경을 지우거나, 추적되지 않는 파일 전체를 일괄 추가하지 마세요. 소스 후보를 별도 Git ref로 만들 때에도 포함 파일을 검토합니다. 로컬 후보 ref 검증은 원격 공개 완료를 뜻하지 않습니다.

## `verify:clean`과 실제 clone의 차이

`pnpm verify:clean`은 Git 추적 목록의 현재 작업 파일을 임시 디렉터리로 복사합니다. 복사 전에 `packages/*/package.json`의 이름이 루트 및 각 패키지의 전이 `workspace:` 의존성을 충족하는지 검사하며, 부족하면 `WORKSPACE_SOURCE_INCOMPLETE`로 중단합니다. 이 검사는 누락된 패키지를 자동 설치하거나 Git에 추가하지 않습니다.

임시 사본에서는 빈 pnpm store의 frozen install, 전체 검사, CLI smoke, 원본·사본의 source hash 보존을 확인합니다. `cleanInstall: "passed"`, `isolatedStore: true`, `originalUnchanged: true`가 모두 있어야 끝까지 성공한 결과입니다. 이 방식은 실제 Git clone이 아니고 전체 HOME·npm cache를 격리하지도 않습니다. 실제로 특정 commit의 소스를 새로 받을 수 있는지는 아래 절차로 따로 확인합니다.

## 실제 clone + 빈 HOME·캐시

다음은 macOS/Linux의 POSIX shell 예제입니다. Node **24.19.0**과 그 npm, Git을 먼저 PATH에 준비합니다. 아래 `FLORA_SOURCE_URL`과 `FLORA_SOURCE_REF`는 운영자가 확인한 저장소 URL과 commit/ref로 설정하세요. URL에 token·비밀번호를 넣지 마세요. 공개 소스 또는 접근 가능한 로컬 소스 후보를 사용하며, 로컬 경로의 경우에도 `--no-local`로 새 clone을 만듭니다.

새 임시 디렉터리만 만들며 자동 삭제하지 않습니다. 검사 로그나 결과를 확인한 뒤 그 임시 디렉터리만 정리하세요. 원본 DB·키·배포 이력에 연결하는 명령은 없습니다.

```sh
# 검증할 값으로 설정한 뒤 실행합니다.
# export FLORA_SOURCE_URL='https://github.com/OWNER/REPOSITORY.git'
# export FLORA_SOURCE_REF='검증할-commit-또는-ref'
: "${FLORA_SOURCE_URL:?Set the source URL without credentials}"
: "${FLORA_SOURCE_REF:?Set the source commit or ref}"
FLORA_CLONE_QA=$(mktemp -d "${TMPDIR:-/tmp}/flora-clone-qa.XXXXXX")
mkdir -p "$FLORA_CLONE_QA/home" "$FLORA_CLONE_QA/npm-cache" \
  "$FLORA_CLONE_QA/pnpm-store" "$FLORA_CLONE_QA/xdg-cache" \
  "$FLORA_CLONE_QA/xdg-data" "$FLORA_CLONE_QA/xdg-config"
env -i PATH="$PATH" HOME="$FLORA_CLONE_QA/home" \
  npm_config_cache="$FLORA_CLONE_QA/npm-cache" \
  XDG_CACHE_HOME="$FLORA_CLONE_QA/xdg-cache" \
  XDG_DATA_HOME="$FLORA_CLONE_QA/xdg-data" \
  XDG_CONFIG_HOME="$FLORA_CLONE_QA/xdg-config" \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  GIT_TERMINAL_PROMPT=0 \
  FLORA_CLONE_QA="$FLORA_CLONE_QA" \
  FLORA_SOURCE_URL="$FLORA_SOURCE_URL" FLORA_SOURCE_REF="$FLORA_SOURCE_REF" \
  sh -eu <<'QA'
test "$(node --version)" = v24.19.0
git clone --no-local -- "$FLORA_SOURCE_URL" "$FLORA_CLONE_QA/source"
cd "$FLORA_CLONE_QA/source"
git checkout --detach "$FLORA_SOURCE_REF"
git rev-parse HEAD
node --version
node -p 'process.platform + "/" + process.arch'
npm exec --yes --package=pnpm@11.19.0 -- pnpm --version
npm exec --yes --package=pnpm@11.19.0 -- pnpm install \
  --frozen-lockfile --ignore-scripts --store-dir "$FLORA_CLONE_QA/pnpm-store"
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --strict --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform config validate \
  --file examples/local-workflow.json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate \
  --file examples/local-workflow.json --scenario runner-replacement
git status --porcelain
QA
```

`sh -eu`는 실패한 명령 뒤의 검사를 중단합니다. 설치는 lockfile을 고정하고 lifecycle script를 실행하지 않습니다. `check`가 빌드·타입 검사·전체 테스트를 실행한 뒤 doctor의 `readiness.ready: true`와 종료 코드 0을 확인하세요. simulation은 `mode: "local-simulation"`, Job `success`, `attemptCount: 2`, `fence: 2`, 오래된 실행권을 거부한 `LEASE_STALE`이 예상 결과입니다. 마지막 `git status --porcelain`은 추적 소스의 변경이 없는지 확인하는 자료이며 검사 결과를 대신하지 않습니다.

빈 HOME에는 기존 Git 자격 증명·SSH key가 없습니다. 비공개 원격 저장소 인증 실패를 우회하려고 실서비스 key를 이 폴더에 복사하지 마세요. 공개된 검증 ref나 검토한 로컬 후보 URL로 검사할 수 있습니다. 네트워크 오류는 TLS 검증을 유지한 채 원인을 해결하고 다시 실행합니다. Windows에서는 전용 임시 폴더와 별도 환경 변수를 사용해 같은 격리 조건을 구성하고 `npm.cmd`를 사용할 수 있지만, 위 shell 명령 자체의 Windows 실행을 검증한 것은 아닙니다.

## 이 검사가 증명하는 범위

- 성공한 source commit과 해당 OS에서, 기존 node_modules·HOME·패키지 캐시에 기대지 않고 공개 의존성을 받아 설치·빌드·테스트·로컬 CLI를 실행했다는 증거입니다. skip된 검사는 별도로 적습니다.
- 패키지 registry 게시, 원격 branch 공개, Cloudflare 배포, 네이티브 binary 빌드·서명, 실제 기기 적용은 각각 별도 검증입니다. EAS·GitHub Actions·운영 Runner 실행은 이 검사에 필요하지 않습니다.
- Isso·Promise·Reward의 기존 iOS Simulator·Android Emulator 6개 조합 OTA·네트워크 복구 증거는 [2026-10-17 기록](github-release-ota-network-2026-10-17.ko.md)에 있습니다. 새 clone의 테스트가 그 실제 앱 검증을 재실행하거나 물리 기기 증거로 바꾸지는 않습니다.

시작 명령과 문제 해결은 [시작 가이드](../getting-started.ko.md), 실제 OTA 구성은 [PC Runner](local-pc-runner.ko.md)와 [GitHub Release 자산 저장소](github-release-ota-storage.ko.md)를 따릅니다.
