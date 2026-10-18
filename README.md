# Flora

[한국어](README.md) · [English](README.en.md) · [Apache-2.0](LICENSE)

**내 앱, 내 GitHub, 내 PC로 운영하는 오픈소스 앱 관리·OTA 플랫폼.**

Flora 웹에서 앱과 GitHub 저장소를 연결하고, 켜 둔 PC Runner가 커밋을 export해 앱별 OTA를 게시합니다. 앱에는 자체 iOS·Android 엔진을 포함한 Flora SDK를 설치합니다. **EAS 계정·API와 GitHub Actions는 필요하지 않습니다.**

```text
GitHub push → Flora의 앱별 정책·작업 큐 → 내 PC의 Docker export
            → Flora OTA 게시 → 설치된 앱의 다운로드·적용·재시작 → 앱별 상세 이력
```

현재는 단일 소유자 셀프호스팅 preview입니다. SDK는 npm에 게시되지 않았고, 첫 관리자 등록은 수동 운영 절차입니다. 아래 기본 경로는 **D1 자산 저장 + 독립 PC Runner**입니다. UULab 전용 GitHub Release 저장소와 LaunchAgent를 일반 설치 기능으로 가정하지 않습니다.

## 첫 OTA까지 따라하기

| 단계 | 끝났는지 확인할 것 |
| --- | --- |
| 1. Flora 설치 | build 성공, doctor `readiness.ready: true` |
| 2. 웹 서버 준비 | 본인 HTTPS 주소에서 소유자 로그인, 프로젝트 목록 표시 |
| 3. GitHub·앱 등록 | 허용한 저장소와 앱 root가 정확히 연결됨 |
| 4. SDK·네이티브 연결 | 공개 설정을 넣은 Release 바이너리가 설치됨 |
| 5. PC Runner 등록 | 앱 전용 토큰·Docker 이미지 준비, 실제 presence 수신 |
| 6. 자동 배포 | 새 커밋의 iOS·Android 작업이 각각 `OTA 게시 완료` |
| 7. 기기 확인 | 같은 배포 상세에 다운로드·적용·재시작 결과 표시 |

여기서는 이미 개발 중인 **React Native 0.86.3 앱**을 연결합니다. 다른 RN 버전을 지원한다고 가정하지 마세요. Expo 57 앱은 선택적 plugin을 쓸 수 있지만 EAS를 사용하지 않습니다. 새 앱 생성·스토어 계정 발급은 이 설치 절차에 포함하지 않습니다.

### 1. Flora 받아서 빌드하기

Node **24.19.0**과 npm, Git, 인터넷 연결을 준비합니다. 전역 pnpm은 필요 없습니다. 아래는 저장소 루트에서 실행하며, 실패하면 다음 단계로 넘어가지 않습니다.

```sh
node --version
npm --version
git --version
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm build
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora doctor --strict --json
```

Node 출력은 `v24.19.0`입니다. doctor의 `readiness.ready: true`와 종료 코드 0을 확인합니다. `nativeBuildVerified: false`는 정상이며 클라우드 연결·네이티브 빌드 성공을 뜻하지 않습니다. Windows에서 `npm.ps1`이 차단되면 `npm.cmd`를 쓰고 실행 정책은 낮추지 마세요. 웹·CLI 체험은 Windows에서도 가능하지만 PC export 컨트롤러는 root가 아닌 **macOS/Linux 사용자 + 동작하는 Docker**가 필요합니다. 아래 배포·Runner의 shell/heredoc 예제는 macOS/Linux용입니다.

계정 없이 화면만 먼저 보려면 `node scripts/dogfood-demo.mjs --serve`를 실행하고 출력된 일회용 URL을 엽니다. 이 가상 체험은 실제 GitHub·OTA가 아니며 `blocked` 실행이 정상입니다. 원래 운영 DB 대신 별도 demo DB를 사용합니다. 종료는 Ctrl+C입니다.

### 2. Flora 웹 서버와 소유자 로그인

이미 운영자가 준 Flora 주소·계정이 있다면 `https://본인-Flora-주소/login`에 로그인하세요. `flora.uulab.co.kr`은 UULab의 기존 설치이며 누구나 로그인할 수 있는 공개 demo가 아닙니다. 공용 기본 관리자 비밀번호는 없습니다.

새 서버를 직접 운영하면 먼저 이 README의 [새 서버 준비](#새-서버를-직접-운영할-때)를 완료한 뒤 돌아옵니다. GitHub 연결은 외부에서 접근 가능한 정확한 HTTPS origin과 webhook 주소가 필요합니다. 로컬 demo의 loopback URL을 공개 서버 주소로 사용하지 않습니다.

**준비 완료:** 로그인 후 `/projects`가 열립니다. 기존 설치는 그대로 사용하고 새 DB·새 owner·새 키로 다시 초기화하지 마세요.

### 3. GitHub 연결과 프로젝트 등록

1. **프로젝트 → GitHub 연결하기 → GitHub에서 연결 앱 만들기**를 선택합니다. 개인 계정이면 조직 이름을 비웁니다.
2. GitHub에서 본인이 로그인·재인증하고 App 생성을 완료합니다. 콜백에서 **Flora에서 연결 완료**를 누릅니다. 콜백 URL의 `code`·`state`를 공유하지 않습니다.
3. **저장소 접근 허용**에서 관리할 저장소만 설치 범위에 추가합니다. Flora App은 Contents·Metadata 읽기와 push 이벤트를 사용합니다. GitHub 로그인과 App에 허용한 저장소 범위는 서로 다릅니다.
4. Flora로 돌아와 **새 프로젝트 → GitHub 연결 확인 → 선택한 저장소 사용**으로 저장소를 선택하고 프로젝트 이름·root를 입력해 등록합니다. 단일 앱 저장소는 `.`, monorepo는 `apps/mobile` 같은 앱 폴더입니다.
5. 앱의 **GitHub · 소스**에서 검증용 브랜치/ref를 지정합니다. 이미 사용하는 운영 브랜치·설정을 덮어쓰지 말고 별도의 앱/검증 채널로 먼저 확인하세요. 두 저장소는 **서로 다른 Flora 앱**으로 등록합니다.

저장소가 안 보이면 GitHub의 **Settings → Applications → Installed GitHub Apps → Flora App → Configure**에서 기존 선택을 유지한 채 저장소를 추가하고 저장한 뒤 목록을 새로 확인합니다. OAuth처럼 계정의 모든 private 저장소를 자동 조회하는 방식이 아닙니다.

### 4. SDK와 앱 설정을 커밋하고 첫 바이너리 만들기

**Flora 저장소에서** SDK tarball을 만듭니다. 출력 디렉터리는 새 경로여야 합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm sdk:pack --out /ABSOLUTE/NEW/sdk-packages
```

출력 JSON의 archive 경로·SHA-256을 확인합니다. **앱 저장소의** `vendor/`에 `flora-ota-0.3.2.tgz`를 복사하고 앱이 쓰는 package manager로 설치합니다. 아래는 npm 앱 예시입니다.

```sh
# 앱 저장소 루트에서 실행
npm install --ignore-scripts --no-audit --no-fund ./vendor/flora-ota-0.3.2.tgz
```

`package.json`의 SDK 의존성이 상대 `file:vendor/...`를 가리키는지 확인하고 **tarball·manifest·lockfile을 함께 커밋**합니다. 개인 PC의 절대 `file:/Users/...` 경로나 Flora workspace 의존성을 앱에 넣으면 독립 Runner에서 설치할 수 없습니다. 기존 pnpm/Yarn 앱을 npm으로 전환하거나 lockfile을 지우지 마세요. 아래 Runner 지원 표에 맞는 경로를 선택합니다.

앱의 **OTA 배포 → 이 앱의 OTA 서명 준비**를 누르고 공개 인증서를 받습니다. 현재 UI는 key ID를 별도 표시하지 않습니다. 브라우저 개발자 도구의 Network에서 이 동작의 `POST /api/apps/앱ID/signing-key` **응답 JSON의 `keyId`**를 확인하세요. 응답은 `appId`, `keyId`, `certificate`, `createdAt`이며 개인키가 아닙니다. 요청 cookie·header·토큰을 복사하지 마세요.

앱 root에 공개 `flora.connection.json`을 만듭니다. 다음 예시의 앱 ID·URL·인증서·key ID를 **선택한 앱의 실제 값**으로 바꿉니다. `certificate`는 내려받은 PEM 전문을 JSON 문자열로 넣습니다. 개인키·토큰은 이 파일에 넣지 않습니다.

```json
{
  "appId": "app_REPLACE_WITH_REGISTERED_APP_ID",
  "url": "https://YOUR_FLORA_HOST/updates/app_REPLACE_WITH_REGISTERED_APP_ID",
  "channel": "preview",
  "runtimeVersion": "native-v1",
  "certificate": "PASTE_COMPLETE_PUBLIC_PEM_CERTIFICATE",
  "keyId": "COPY_PUBLIC_KEY_ID_FROM_RESPONSE"
}
```

같은 root에 `flora.config.json`을 만듭니다. 아래 기본 예시는 **npm 10.9.8·Metro·index.js** 앱입니다. 실제 entry file·도구 버전·root lockfile이 선언과 일치해야 합니다. `@flora/ota`와 Metro가 앱의 lockfile에 포함돼야 합니다.

```json
{
  "schemaVersion": 1,
  "ota": {
    "runtimeVersion": "native-v1",
    "platforms": ["ios", "android"],
    "url": "https://YOUR_FLORA_HOST/updates/app_REPLACE_WITH_REGISTERED_APP_ID"
  },
  "export": {
    "bundler": "metro",
    "entryFile": "index.js",
    "nodeVersion": "24.19.0",
    "packageManager": { "name": "npm", "version": "10.9.8" }
  }
}
```

**SDK 설치만으로 OTA 엔진이 기존 바이너리에 생기지 않습니다.** bare RN 앱에는 다음 네이티브 연결을 적용하고 기존 Xcode/Gradle Release 빌드 절차로 새 바이너리를 설치합니다. iOS 빌드는 Mac·Xcode·CocoaPods, Android 빌드는 앱에 맞는 JDK·Android SDK가 필요합니다. OTA export 자체는 Xcode·스토어 서명 키가 필요하지 않습니다.

| 위치 | 설정 |
| --- | --- |
| iOS `Info.plist` | `FloraOTAAppId`, `FloraOTAUpdateURL`, `FloraOTAChannel`, `FloraOTARuntimeVersion`, `FloraOTACertificate`, `FloraOTAKeyId`를 공개 connection과 같게 설정 |
| iOS RN delegate | `import FloraOta`; `bundleURL()`이 매번 `FloraOTAController.bundleURL(embedded: embeddedBundleURL)`를 반환하도록 연결. SDK autolinking 후 `pod install`, embedded JS bundle 포함 |
| Android `android/app/src/main/assets/flora_ota_config.json` | `flora.connection.json`과 동일한 6개 필드 |
| Android `reactHost` | `FloraReactHost.create(applicationContext, PackageList(this).packages)` 사용. 시작 때만 bundle 경로를 바꾸는 연결로는 Release 재시작이 동작하지 않음 |

JS에서는 첫 화면과 필수 초기화가 성공한 뒤 한 번 아래 흐름을 실행합니다. 다운로드 전에 실행을 정상으로 확인하며, 업데이트 처리는 엔진 하나가 전담해야 합니다.

```ts
import { createFloraClient } from '@flora/ota';
import { createFloraNativeEngine } from '@flora/ota/native';

export async function updateAfterAppIsReady() {
  const engine = createFloraNativeEngine();
  const launch = await engine.getLaunchInfo();
  const ota = createFloraClient(await engine.getNativeConfiguration(), engine);
  await engine.markLaunchSuccessful(launch.updateId);
  const checked = await ota.checkForUpdate();
  if (!checked.available) return;
  const downloaded = await ota.downloadUpdate();
  if (downloaded.downloaded) await ota.reload();
}
```

실제 앱에서는 실패를 앱 UI에 표시하고 다음 확인 기회를 제공하세요. 렌더링·필수 초기화 전에 무조건 실행 성공으로 표시하거나 자동으로 무한 재시도하지 않습니다. Expo 57은 같은 공개 설정에 `@flora/ota/plugin`과 `disableExpoUpdates: true`를 적용하고 새 바이너리를 빌드합니다. 완전한 Swift/Kotlin 예제와 Expo 예제는 [SDK 연결 상세](docs/development/native-ota.ko.md), [SDK README](packages/ota-sdk/README.md)에 있습니다.

앱 저장소의 **검증용 브랜치**에 SDK·공개 설정·lockfile·네이티브/JS 변경을 검토해 커밋·push합니다. 개인키는 추가하지 않고 `git add .`는 쓰지 않습니다. Actions를 생략하려면 커밋 메시지에 `[skip ci]`를 넣습니다. Flora의 push webhook은 별도 경로입니다. Flora에서 **GitHub 소스 동기화 · 앱 인식**을 눌러 해당 SHA·runtime·platforms와 중립 export 설정이 인식되는지 확인합니다.

### 5. PC Runner 등록하고 실행하기

컨트롤러는 root가 아닌 macOS/Linux 사용자로 실행합니다. Docker daemon이 이미 동작해야 합니다. [Docker 설치](https://docs.docker.com/engine/install/)·계정별 무료 사용 조건은 별도 확인하세요. PC의 공개 포트·Tunnel·GitHub 인증서·EAS 로그인은 필요 없습니다.

| 앱의 의존성 준비 | 현재 지원 조건 |
| --- | --- |
| 아래 npm 기본 경로 | Node 24.19.0 / npm 10.9.8, 앱 root의 v3 `package-lock.json`; 고정 npm registry tarball 및 검증된 `vendor/*.tgz` |
| pnpm workspace 경로 | Node 24.19.0 / **pnpm 11.10.0**, `dependencyPreparation: "pnpm-registry"`, 저장소 root의 lock/workspace 및 지원되는 앱 importer |
| 기타 | 기본 offline cache 경로를 운영자가 준비해야 함. 임의 pnpm 버전·Yarn 준비가 자동으로 된다고 가정하지 않음 |

Flora 저장소용 pnpm **11.19.0**과 pnpm 앱 Runner용 **11.10.0**은 서로 다릅니다. 아래 이미지는 npm 기본 경로와 지원되는 pnpm 경로용 도구를 넣습니다. 앱 source·개인키·토큰은 이미지에 넣지 않습니다.

```sh
# Flora 저장소에서 실행; root 권한으로 Runner를 실행하지 않습니다.
docker info
docker pull node:24.19.0-bookworm-slim
FLORA_BASE_IMAGE=$(docker image inspect node:24.19.0-bookworm-slim --format '{{index .RepoDigests 0}}')
docker build --build-arg BASE_IMAGE="$FLORA_BASE_IMAGE" --build-arg PNPM_VERSION=11.10.0 -f packages/ota-runner/examples/Dockerfile -t flora-export:local packages/ota-runner/examples
docker image inspect flora-export:local --format '{{.Id}}'
docker context inspect --format '{{.Endpoints.docker.Host}}'
```

이미지의 실제 `sha256:64자리` ID를 보관합니다. 컨트롤러는 tag·`latest`를 거부하고 이미 로컬에 있는 고정 이미지로만 실행합니다. 기본 socket이 아닌 `DOCKER_HOST`를 사용한다면 context 출력 대신 실제 사용 중인 `unix://...` 주소를 아래에 넣습니다.

앱의 **PC Runner → 현재 앱에 Runner 등록**을 누릅니다. **한 번만 표시되는 토큰**은 checkout 밖의 private `runner.json`에 저장합니다. 다른 앱에는 별도의 Runner 토큰과 경로를 사용합니다.

```sh
# 새 경로를 선택합니다. 이미 있으면 중단하고 기존 설정을 보존합니다.
FLORA_PC_DIR="$HOME/.flora-first-pc"
(umask 077; mkdir "$FLORA_PC_DIR" && mkdir "$FLORA_PC_DIR/scratch" "$FLORA_PC_DIR/scratch/work" "$FLORA_PC_DIR/recovery")
```

아래 JSON을 `$FLORA_PC_DIR/runner.json`에 **로컬 편집기로** 저장하고 `chmod 600 "$FLORA_PC_DIR/runner.json"`을 실행합니다. 토큰을 shell 명령·환경변수·Git·채팅에 넣지 않습니다. `origin`은 경로 없는 HTTPS origin입니다.

```json
{
  "origin": "https://YOUR_FLORA_HOST",
  "token": "PASTE_ONE_TIME_APP_RUNNER_TOKEN_PRIVATELY",
  "dockerImage": "sha256:REPLACE_WITH_INSPECTED_LOCAL_IMAGE_ID",
  "resourceProfile": "github-hosted",
  "dependencyPreparation": "npm-registry",
  "workDirectory": "/ABSOLUTE/.flora-first-pc/scratch/work",
  "recoveryDirectory": "/ABSOLUTE/.flora-first-pc/recovery"
}
```

`github-hosted`는 현재 코드의 컨테이너 리소스 프로필 이름입니다. 이 설정으로 PC에서도 실행하며 Actions를 연결하지 않습니다. npm/pnpm 준비 컨테이너가 공개 registry의 검증된 패키지만 준비하고, 실제 앱 코드·install script·export는 네트워크 없는 별도 컨테이너에서 실행합니다. Runner 토큰·GitHub 토큰·Docker socket을 export 컨테이너에 넣지 않습니다.

무료 조회량을 줄이고 idle 상태도 보고하려면 foreground supervisor를 사용합니다. `$FLORA_PC_DIR/service.json`에 아래 공개 설정을 저장하고 0600으로 보호합니다. `nodePath`, `runnerMain`, `path`는 실제 절대 경로, `dockerHost`는 위에서 확인한 socket입니다. Lima를 사용하지 않으면 `limaHome`에는 `runtimeDirectory`와 같은 경로를 넣습니다.

```json
{
  "runtimeDirectory": "/ABSOLUTE/.flora-first-pc",
  "nodePath": "/ABSOLUTE/TO/node",
  "runnerMain": "/ABSOLUTE/TO/flora/packages/ota-runner/dist/main.js",
  "runnerConfigs": ["/ABSOLUTE/.flora-first-pc/runner.json"],
  "path": "/ABSOLUTE/DOCKER/BIN:/ABSOLUTE/NODE/BIN:/usr/bin:/bin:/usr/sbin:/sbin",
  "limaHome": "/ABSOLUTE/.flora-first-pc",
  "dockerHost": "unix:///ACTUAL/DOCKER/SOCKET",
  "pollIntervalMs": 30000
}
```

```sh
chmod 600 "$FLORA_PC_DIR/service.json"
node scripts/local-runner/supervisor.mjs "$FLORA_PC_DIR/service.json"
```

별도 터미널을 열어 앱의 PC Runner 상태를 확인합니다. supervisor는 실제 presence를 별도로 보내며 빈 큐 확인 간격은 최대 5분까지 늘립니다. `node packages/ota-runner/dist/main.js --config ... --once`는 1회 진단용이고 idle presence를 자동 전송하지 않습니다. 앱 화면의 **온라인**은 연결 확인이며 배포 성공을 뜻하지 않습니다. Docker·디스크 2GiB 여유·오류 코드를 함께 확인하세요.

종료는 Ctrl+C입니다. PC가 꺼지거나 잠들거나 터미널이 닫히면 작업을 처리하지 못합니다. 재부팅 자동 시작용 `service.mjs`는 현재 UULab 이름·경로의 macOS LaunchAgent이며 이 일반 절차는 설치하지 않습니다. 필요한 운영자는 [서비스 가이드](docs/development/local-pc-runner.ko.md)를 검토하세요. `fatal-stop`·복구 journal은 원인을 확인하기 전에 삭제하지 않습니다.

### 6. 커밋으로 iOS·Android OTA 게시하기

1. 앱의 **PC Runner** 화면에서 **GitHub push 시 자동 OTA**를 켜고 `iOS + Android`, `preview` 채널을 선택한 뒤 **GitHub push 정책 저장**을 누릅니다. source 감지·활성 Runner가 준비되지 않았다면 먼저 그 원인을 해결합니다.
2. 네이티브 설정을 바꾸지 않고 앱의 화면 문구 같은 JS를 변경합니다. 선택한 root·ref·runtime·채널이 4단계의 설치 바이너리와 같아야 합니다.
3. 아래는 `App.tsx`와 `flora-onboarding` 브랜치를 쓰는 앱의 예시입니다. 실제 파일·Flora에 연결한 브랜치로 바꾸고 **해당 변경만** 추가합니다.

```sh
git add -- App.tsx
git diff --cached --stat
git commit -m "feat: verify Flora OTA [skip ci]"
git push origin HEAD:flora-onboarding
```

Flora의 **PC Runner**에서 해당 SHA의 iOS·Android 작업을 각각 확인합니다. 정상 흐름은 `Runner 대기 → Runner 작업 중 → OTA 게시 완료`입니다. 브랜치를 강제로 갱신하지 않습니다. GitHub의 [공식 실행 생략 규칙](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)을 사용하며 워크플로를 수동 실행하지 않습니다.

### 7. 배포와 기기 적용을 따로 확인하기

설치한 Release 앱을 열고 4단계의 업데이트 흐름을 실행합니다. **OTA 배포 → 해당 배포**에서 앱·플랫폼·SHA·runtime·채널을 먼저 확인한 뒤 설치별 다운로드·적용·재시작 결과를 봅니다. `OTA 게시 완료`만으로 기기 적용을 완료했다고 판단하지 않습니다.

실패하면 같은 상세 화면의 실패 원인과 이후 복구 이력을 확인합니다. `NETWORK_UNAVAILABLE`/`TIMEOUT`은 연결을 복구한 뒤 다시 확인하고, `SIGNATURE_INVALID`/`ASSET_HASH_MISMATCH`는 인증서·다운로드 무결성을 해결하기 전 적용하지 않습니다. 기기 보고가 없으면 성공률을 추정하지 않습니다. 문제가 있는 배포는 기존 성공 배포로 롤백할 수 있으며 원래 실패·복구 이력은 남습니다.

두 앱을 연결할 때에는 프로젝트 ID·서명 설정·Runner 토큰/경로·정책을 각각 만들고, 한 앱의 OTA가 다른 앱의 목록·기기에 나타나지 않는지 확인합니다. 실제 적용 검증에는 호환 바이너리가 설치된 각 플랫폼의 기기가 필요합니다.

## 새 서버를 직접 운영할 때

이미 소유자 로그인이 되는 설치가 있으면 이 절차를 다시 실행하지 않습니다. 현재는 **운영자가 관리하는 수동 preview**이며 안전한 범용 setup-token CLI·인증 DB 복구 도구는 아직 없습니다. 아래 최초 등록 절차는 **새 전용 DB·새 Worker의 첫 소유자**만 대상으로 합니다. 기존 설치는 [운영·복구 가이드](docs/development/password-hosting.ko.md)를 따릅니다.

Cloudflare 계정과 본인이 관리하는 활성 zone/HTTPS hostname을 준비합니다. Workers Free의 SQLite DO·D1 사용 가능 여부와 계정 전체 무료 한도를 확인하세요. 유료 전환·R2 구독·결제는 필수가 아닙니다. [DO 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 명령](https://developers.cloudflare.com/d1/wrangler-commands/), [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) 기준으로 본인 계정을 확인합니다. 도메인·PC 전력·개발자 계정·할당량까지 무료·무제한이라고 보장하지 않습니다.

**서버 A — 개인 설정과 전용 DB.** Flora 저장소에서 Wrangler에 본인이 로그인하고 전용 D1을 만듭니다. 생성 이름은 본인 계정에서 고유하게 정합니다. 기존 DB에 이 예제를 적용하지 마세요.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler login
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler whoami
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 create flora-first
export FLORA_PRIVATE="$HOME/.flora-first-server"
```

다음 문서용 recipe는 새 private 폴더와 설정만 만듭니다. 이미 존재하는 경로에서는 중단합니다. 본인이 실행한 뒤 편집기로 `name`을 계정에서 사용하지 않는 새 Worker 이름으로 바꾸고, account ID·D1 이름/UUID·owner 이메일·사용 중이지 않은 정확한 HTTPS hostname/origin을 채우세요. 예제 이름 `flora-first`를 기존 Worker에 덮어쓰지 않습니다. owner/DB identity UUID는 생성 후 바꾸지 않습니다.

```sh
node --input-type=module <<'JS'
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = resolve(process.env.FLORA_PRIVATE);
const checkout = resolve('.');
if (dir === checkout || dir.startsWith(checkout + sep)) throw Error('PRIVATE_CONFIG_OUTSIDE_CHECKOUT_REQUIRED');
await mkdir(dir, { mode: 0o700 }); // recursive를 쓰지 않음: 기존 경로 거부
const cfg = JSON.parse(await readFile('packages/cloudflare/wrangler.example.jsonc', 'utf8'));
delete cfg.$schema;
delete cfg.build; // 아래에서 빌드를 명시적으로 실행
cfg.name = 'flora-first';
cfg.account_id = 'REPLACE_WITH_ACCOUNT_ID';
cfg.main = resolve('packages/cloudflare/dist/hosted/worker.js');
cfg.assets.directory = resolve('packages/cloudflare/dist/hosted/public');
cfg.d1_databases[0].migrations_dir = resolve('packages/cloudflare/migrations');
cfg.d1_databases[0].database_name = 'REPLACE_WITH_CREATED_D1_NAME';
cfg.d1_databases[0].database_id = 'REPLACE_WITH_CREATED_D1_UUID';
cfg.vars = { FLORA_ORIGIN: 'https://YOUR_FLORA_HOST', FLORA_OWNER_EMAIL: 'OWNER@YOUR_DOMAIN',
  FLORA_OWNER_ID: randomUUID(), FLORA_DB_IDENTITY: randomUUID() };
cfg.routes = [];
await writeFile(join(dir, 'wrangler.json'), JSON.stringify(cfg, null, 2), { mode: 0o600, flag: 'wx' });
JS
```

**서버 B — schema와 immutable identity.** 값을 채운 후 아래를 실행합니다. `--remote`는 본인의 실제 리소스를 변경합니다. 에러가 있으면 중단하고 같은 리소스의 원인을 해결합니다.

```sh
node scripts/build-cloudflare.mjs --deployment-config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --dry-run --config "$FLORA_PRIVATE/wrangler.json" --outdir "$FLORA_PRIVATE/dry-run"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations list FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations apply FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 execute FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json" --command 'SELECT singleton,owner_id,origin,db_identity FROM flora_deployment;'
```

marker row가 **없는 새 DB일 때만**, private `identity.sql`에 아래 세 값을 `wrangler.json`의 `FLORA_OWNER_ID`/`FLORA_ORIGIN`/`FLORA_DB_IDENTITY`와 똑같이 넣습니다. 기존 row가 있으면 일치 여부만 확인하고 INSERT를 건너뜁니다. 하나라도 다르면 중단하고 deploy나 식별자 변경을 하지 않습니다. UPDATE·REPLACE·삭제로 바꾸지 않습니다.

```sql
INSERT INTO flora_deployment(singleton, owner_id, origin, db_identity)
VALUES (1, 'ACTUAL_OWNER_UUID', 'https://ACTUAL_FLORA_HOST', 'ACTUAL_DB_IDENTITY_UUID');
```

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 execute FLORA_DB --remote --config "$FLORA_PRIVATE/wrangler.json" --file "$FLORA_PRIVATE/identity.sql"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --config "$FLORA_PRIVATE/wrangler.json"
```

첫 deploy는 아직 route가 없어 공개 주소가 없습니다. private 설정의 `routes`에 본인 origin의 Custom Domain 한 개를 넣고 다시 deploy합니다. 예: `[{"pattern":"ACTUAL_FLORA_HOST","zone_id":"ACTUAL_ZONE_ID","custom_domain":true}]`. `workers_dev: false`, `preview_urls: false`, `run_worker_first: true`, SQLite DO binding/migration은 유지합니다. `/login` 200·인증 없는 `/api/state` 401을 확인하세요. HEAD 대신 GET을 사용합니다.

**서버 C — 첫 소유자 등록.** DNS/TLS 준비 후 본인이 로컬에서 아래 recipe를 실행합니다. 토큰은 출력하지 않고 private 파일에만 쓰며 10분 동안만 유효합니다. `generation: 1`은 이 새 설치의 첫 발급에만 사용합니다. 이미 발급/등록한 설치·만료 재발급에 재사용하지 않습니다.

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const file = join(process.env.FLORA_PRIVATE, 'wrangler.json');
const cfg = JSON.parse(await readFile(file, 'utf8'));
if (cfg.vars.FLORA_SETUP !== undefined) throw Error('SETUP_WINDOW_ALREADY_PRESENT');
const bytes = randomBytes(32), issuedAt = Date.now();
const setup = { digest: createHash('sha256').update(bytes).digest('hex'), issuedAt,
  expiresAt: issuedAt + 600000, generation: 1, purpose: 'enroll' };
await writeFile(join(process.env.FLORA_PRIVATE, 'first-owner.json'),
  JSON.stringify({ token: bytes.toString('base64url'), setup }, null, 2), { mode: 0o600, flag: 'wx' });
cfg.vars.FLORA_SETUP = setup;
await writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
JS
node scripts/build-cloudflare.mjs --deployment-config "$FLORA_PRIVATE/wrangler.json"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --config "$FLORA_PRIVATE/wrangler.json"
```

10분 안에 본인의 HTTPS `/setup`에서 **최초 등록**, 지정 owner 이메일, 로컬 편집기로 확인한 `first-owner.json`의 token, **15자 이상**의 새 비밀번호와 확인을 직접 입력합니다. 계정·토큰·비밀번호를 채팅·URL·공개 로그에 넣지 않습니다. 원문 token이 아니라 decoded 32바이트의 SHA-256이 서버 설정에 들어갔는지 recipe가 보장합니다.

로그인 성공 후 private 설정에서 **`vars.FLORA_SETUP` 한 항목만 제거**하고 build·deploy합니다. 비공개 발급 기록은 보존합니다. 응답을 잃었으면 재등록하지 말고 먼저 `/login`을 확인합니다. 10분 만료·기존 generation·auth DB 복구는 자동 초기화로 우회하지 않고 [등록·복구 절차](docs/development/password-hosting.ko.md#등록복구와-운영-중단-조건)를 따릅니다. `/setup`은 토큰 발급 화면이 아닙니다.

처음에는 외부 자산 변수·R2 binding 없이 기본 D1 저장소를 사용합니다. 각 파일 최대 16MiB이며 앱별/공유 저장 상한과 D1 무료 일일 quota가 있습니다. `GitHub Releases` 대용량 저장 경로는 현재 UULab 저장소에 고정된 preview이므로 임의 저장소를 지원한다고 안내하지 않습니다. 한도 오류 시 기록을 삭제하거나 자동 유료 전환하지 않습니다.

이제 [2단계](#2-flora-웹-서버와-소유자-로그인)로 돌아가 GitHub를 연결합니다. 실제 Free 계정의 CPU·메모리·사용량 및 공개 DNS/TLS는 로컬 테스트와 별도로 확인해야 합니다.

## 문제 해결과 검증 범위

| 증상 | 확인할 것 |
| --- | --- |
| `PNPM_NOT_VERIFIED` / strict doctor 실패 | 전체 고정 `npm exec ... pnpm` 접두어, Node·Git 버전. lockfile 삭제나 TLS 우회 금지 |
| `WORKSPACE_SOURCE_INCOMPLETE` / `dist` 없음 | 기본 main을 clone했는지, install·build를 완료했는지 |
| GitHub 저장소가 없음 | App 설치 범위·조직 승인·선택한 ref/root. 설치 권한 변경 후 목록 새로 확인 |
| `INVALID_RUNNER_CONFIG` | 이미지 실제 ID, HTTPS origin, 토큰, JSON 허용 필드, 파일 0600·상위 폴더 0700·symlink 없음 |
| 작업이 대기하거나 Runner가 오프라인 | PC/daemon 실행, presence·Docker socket·2GiB 여유. `--once` 성공만으로 온라인을 추정하지 않음 |
| `DEPENDENCY_*` / export 실패 | 앱 lockfile·지원 package manager 버전·vendor tarball·이미지 버전·Metro entry·지원 workspace importer |
| `CONFIG_CHANGED` / 배포 차단 | 고정 SHA의 config와 설치 바이너리의 URL·app ID·채널·runtime·공개 인증서 일치 |
| 게시됐지만 앱 변화가 없음 | 최초 SDK 바이너리 설치 여부, Release 모드, 원래 배포와 다른 새 SHA, 상세 기기 보고 |
| 일일 quota / `fatal-stop` | 화면의 실패 코드·초기화/복구 안내. journal·기존 이력·키 삭제 금지 |

문서·소스를 검증하려면 Flora 루트에서 `npm exec --yes --package=pnpm@11.19.0 -- pnpm check`를 실행합니다. `verify:clean`은 추적 파일의 사본 검사이며 실제 clone 검증은 [새 환경 절차](docs/development/clean-clone-source.ko.md)로 구분합니다.

이 README의 계정 인증·설치 승인·공개 배포·최초 네이티브 바이너리 설치는 운영자가 수행하는 단계입니다. 로컬 fixture 성공만으로 이 실제 단계들을 완료했다고 보고하지 않습니다. 기존 UULab 앱 6개 Simulator/Emulator 조합의 과거 OTA·네트워크 복구 증거는 [2026-10-17 기록](docs/development/github-release-ota-network-2026-10-17.ko.md)에 있으며 물리 기기나 현재 서비스 건강을 보장하지 않습니다.

## 더 보기

- [로컬 체험·CLI·기존 데이터](docs/getting-started.ko.md), [PC Runner 운영](docs/development/local-pc-runner.ko.md), [SDK](packages/ota-sdk/README.md)
- [제품 의도](docs/product/intent.ko.md), [통합 계획](docs/product/integrated-plan.ko.md), [요구사항](docs/product/requirements.ko.md), [로드맵](docs/roadmap/milestones.ko.md)
- [기여·개발 인계](docs/development/pc-handoff.ko.md), [라이선스](LICENSE), [NOTICE](NOTICE), [문제 보고](https://github.com/uulab-official/flora/issues)

Core·CLI·Dashboard·SDK·Runner·공식 Adapter·보안·감사·셀프호스팅 코드를 공개하는 방향입니다. 실제 앱에 없는 기능은 문서나 로컬 시뮬레이션만으로 출시됐다고 표시하지 않습니다.
