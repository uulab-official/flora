# PNPM workspace PC Runner

Reward는 저장소 루트의 `pnpm-lock.yaml`과 `pnpm-workspace.yaml`을 사용하며, Expo 앱은 `apps/app`에 있습니다. Runner의 등록 경로와 설정 digest는 `apps/app`을 그대로 사용합니다. 설치만 저장소 루트에서 하고, Flora 공개 연결정보 검증과 Expo export는 등록된 앱 폴더에서 수행합니다.

현재 지원 범위는 Node 24.19.0, PNPM 11.10.0, lockfile v9와 명시된 workspace importer입니다. 등록 경로에 해당하는 importer가 없거나 lockfile과 package.json의 의존성 선언이 다르면 실행을 중단합니다. 다른 버전·중첩 workspace·Git/임의 URL dependency를 추측해서 설치하지 않습니다.

`dependencyPreparation: "pnpm-registry"`는 기존 격리 resource profile인 `github-hosted`와 compiler network `none` 조합에서만 허용됩니다. 이 profile 이름은 자원 한도를 뜻하며 GitHub Actions를 사용하는 설정이 아닙니다. `scripts/pc-pnpm-runner.Dockerfile`은 기존 npm Runner 이미지와 별도로 빌드합니다. 공식 PNPM 11.10.0 압축파일의 SHA512를 확인한 뒤 lifecycle script 없이 설치하고, 실제 서비스는 완성된 이미지 digest를 고정합니다.

Apple Silicon PC에서는 `scripts/pc-pnpm-arm64-runner.Dockerfile`로 별도 ARM64 이미지를 만들 수 있습니다. 공식 Node 24.19.0 ARM64 이미지 digest와 같은 PNPM SHA512를 고정합니다. 기존 amd64 npm 이미지를 변경하지 않습니다. RN의 Linux Hermes 실행파일은 x86-64이므로 해당 VM의 binfmt 지원도 검증해야 합니다. 테스트 PC에서는 네트워크 없는 ARM64 격리 컨테이너에서 실제 RN 0.86.3 Hermes 컴파일러가 통제한 JS 입력을 362바이트 HBC로 변환한 것까지 확인했습니다. 이 엔진 probe는 앱 전체 export나 배포 완료를 뜻하지 않습니다.

온라인 준비 컨테이너에는 정제한 package.json들, 원본 frozen lockfile, 검증한 패치와 vendored Flora SDK 압축파일만 전달합니다. 앱 소스·app config·npmrc·pnpmfile·인증정보는 전달하지 않습니다. registry package의 SHA512, SDK SHA512, lockfile에 기록된 패치 SHA256와 workspace link의 실제 importer 이름을 확인합니다. 설치는 frozen lockfile, ignore-scripts, ignore-pnpmfile, runtime 다운로드 중단, package manager 자동 교체 중단과 cache integrity 확인을 사용합니다.

PNPM 11은 lockfile의 공급망 정책도 검증하며, 이 검증에는 registry metadata cache가 필요합니다. 콘텐츠 store만 전달하면 패키지 import가 완료된 뒤 정책 검증에서 메타데이터 fetch를 시도할 수 있습니다. Runner는 공식 registry에서 준비한 metadata cache를 `/workspace/cache/pnpm/metadata-cache`에 함께 저장하고 동일한 파일·링크·용량 검증을 적용해 전달합니다. 정책 검증을 끄지 않습니다. compiler에서는 네트워크가 차단되고 fetch retry가 0이므로 필요한 metadata가 없으면 `ERR_PNPM_META_FETCH_FAIL`로 즉시 실패합니다.

PNPM 11.10.0은 cache의 `v11/projects/<32자리 hex>`에 임시 설치 프로젝트를 가리키는 등록 링크를 생성합니다. 전달 전에 정확히 `../../../../seed`이고 대상이 해당 임시 프로젝트인 링크만 제거합니다. 패키지 파일의 링크나 다른 경로·대상은 거부합니다. 120,000개 항목·1 GiB의 cache 한도와 regular file/nlink 검증을 유지합니다. npm 준비 방식과 기존 npm cache 한도는 바뀌지 않습니다.

컴파일 컨테이너는 cache를 자체 tmpfs로 복사한 뒤 같은 frozen/script-disabled 설치를 `--offline`으로 실행합니다. 온라인 준비는 copy import를 사용하고, offline 설치는 복사한 tmpfs cache 안에서만 hardlink import를 사용합니다. export 코드가 설치 파일을 바꿔도 원본 전달 cache의 바이트나 nlink는 바뀌지 않습니다. 의존성이 없으면 실패하며 네트워크를 여는 대체 경로는 없습니다. 저장소 코드는 이 컨테이너의 export 단계에서만 실행됩니다. 원본 checkout, Runner 인증정보와 Docker socket은 컨테이너 안에 없습니다. 컨테이너는 non-root, read-only root filesystem, capability 제거, CPU·메모리·프로세스 제한을 사용합니다.

별도 전달물에는 `dist/pnpm-dependencies.js`와 `dist/pnpm-yaml.LICENSE`를 포함해야 합니다. YAML parser는 `yaml@2.9.1`을 고정하여 standalone helper로 묶습니다. 저장소 코드나 원본 npmrc를 bundled helper에 넣지 않습니다. 기존 Isso·Promise 서비스의 실행 중인 npm bundle과 이미지 digest는 이 추가로 교체하지 않습니다.

PNPM 경로는 준비·컴파일의 고정 단계만 진단에 남깁니다. 설치가 시간 제한에 걸리면 허용한 PNPM 진행 문구에서 0–2,500 범위의 resolved/reused/downloaded/added 숫자와 완료 여부만 추출합니다. 의존성·소스 경로·출력 원문·인증정보는 오류 진단에 포함하지 않습니다. 고정 단계 진단으로 설치 지연과 cache 검증·복사 지연을 구분하며, 제한 시간이 지난 실패를 export 성공으로 처리하지 않습니다.

작은 실제 Docker 회귀 테스트는 `FLORA_PNPM_DOCKER_IMAGE=<sha256 digest>`로 `packages/ota-runner/test/pnpm-docker.test.ts`를 실행합니다. 고정한 공개 패키지 1개로 metadata가 포함된 offline 설치 성공, metadata 누락 시 빠른 실패, lifecycle script 미실행과 원본 전달 cache의 바이트 보존을 확인합니다. 이미지는 로컬에 준비되어 있어야 하며, 온라인 준비 단계만 공식 npm registry를 읽습니다.

2026-10-13 검증에서는 Reward 커밋 `434aa907a3667364bd4713a5bb5f3a3524ffe918`의 tracked 파일만 복사해 두 native 플랫폼의 실제 Expo CLI export를 완료했습니다. compiler network `none`과 기존 Flora 공개 연결정보/runtime guard를 유지했고 iOS·Android 모두 HBC magic `c61fbc03c103191f`를 확인했습니다. 산출물과 해시 receipt는 `dist/real-apps-2026-10-13/evidence/reward-pnpm-isolated-export.json`, `reward-pnpm-cache-receipt.json`, `reward-pnpm-artifacts/{ios,android}`에 기록했습니다. 기존 Android APK의 소스는 `e09ee8e2c7b46696824ab6ce100ebc372ac43ded`로 구분합니다. 이 결과는 OTA 게시·GitHub 자동 배포·기기 다운로드/적용 결과를 포함하지 않습니다.

공식 동작 근거: [PNPM install](https://pnpm.io/cli/install), [PNPM fetch](https://pnpm.io/cli/fetch). 실제 GitHub 커밋 기반 배포·기기 적용 결과는 해당 앱의 별도 검증 문서에 기록합니다. 이 문서의 안전한 설치/export 경로만으로 OTA 게시나 네이티브 적용 성공을 주장하지 않습니다.
