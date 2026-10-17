# Reward의 Flora 연결 진행 기록

2026-10-14 KST: 앱별 PC Runner 등록·운영 presence와 Android 최초 QA 앱의 임베디드 실행을 확인했다. GitHub 설치 접근 추가는 실제 로그인 화면과 CLI 403 때문에 대기하며, 자동 게시·OTA 적용 성공으로 표시하지 않는다. 현재 단계와 데이터·용량 준비는 [GitHub·PC Runner 후속 검증](reward-github-pc-ota-evidence.ko.md)에 있다.

2026-10-13 관리 기능 개선 이후 운영 소스 동기화는 HTTP 404 `GITHUB_REPOSITORY_UNAVAILABLE`로 원인을 구분해 반환한다. 아래 이전 `PROVIDER_UNSUPPORTED` 관측과 구분한다. GitHub App의 Reward 읽기 권한 문제는 남아 있으며, 실패 전후 연결 v1·설정과 비어 있는 게시/작업 이력을 보존했다. [프로젝트 관리 후속 검증](project-management-evidence.ko.md)을 참고한다.

2026-10-13. EAS 프로젝트 등록 한도와 독립적으로 Flora 앱을 등록했다. 원본 Reward의 기존 미커밋 작업은 수정하지 않고 별도 QA worktree를 사용했다.

## 준비한 것

- Flora 앱 ID: `application_1225979e-f858-4cd0-9213-55b201e7e6a5`, 저장소 `uulab-official/reward`, 앱 루트 `apps/app`.
- QA 브랜치 `codex/flora-reward-integration`의 커밋 `e09ee8e2c7b46696824ab6ce100ebc372ac43ded`를 GitHub에 push했다. 16개 파일만 포함하고 생성된 native 디렉터리·APK·개인키·자격 증명은 제외했다.
- Flora SDK 0.3.1 archive를 고정했다. 공개 연결 정보는 앱별 URL·ID·runtime·channel·서명 key ID·공개 인증서뿐이다. 개인키는 서버에 보관한다.
- 런타임 `flora-reward-rn0863-v1`, 채널 `flora-verification`, 앱 버전 1.0.0을 유지한다. 시작 제어에 EAS project ID를 요구하지 않으며 기존 데이터 저장소와 offline 동작을 보존한다.
- 앱·서버 타입 검사와 533개 테스트/36파일, 두 플랫폼 로컬 Hermes export, prebuild를 통과했다. 로컬 export는 GitHub 자동 게시 증거와 구분한다.
- Android 최초 QA Release APK를 빌드하고 native Flora 엔진·공개 연결·Hermes marker `Reward-Flora-V1`을 검사했다. `kr.co.uulab.reward`, versionCode 26100501, 비디버그 arm64이며 QA debug 인증서로 서명했다. 운영 스토어용 서명이 아니다.

APK SHA-256: `4698c7797ad8470e107870f4a90e95b1b008c3d26245481c134483219edb1c81`, 크기 52,454,849 bytes. SDK SHA-256: `139839930cc487bb6f3927872b6157a66d35eed34d23fa42bb8d7501cf91ecb4`.

## 아직 완료하지 않은 것

GitHub App 설치 170528052의 API 접근 범위는 현재 Isso·Promise 두 저장소다. 사용자는 Reward까지 세 저장소를 확인하고 Save를 완료했다고 답했다. 이후 Flora 서버가 새로 발급한 설치 토큰으로 다시 조회했지만 Reward는 반환되지 않았다. 기존 토큰 또는 Flora 목록 캐시를 재사용한 결과는 아니다. 저장 후 GitHub 화면의 실제 상태는 확인하지 못했으므로 차이의 원인을 단정하지 않는다. GitHub App은 허용 저장소에만 접근하며 계정 전체를 검색하는 사용자 OAuth 흐름은 Flora에 구현되어 있지 않다.

Reward는 pnpm 11.10.0 / lockfile v9의 workspace다. Runner에 manifest·SHA512 registry package·vendor·workspace link·패치 검증과 안전한 온라인 seed/offline compiler 준비를 구현했다. 초기 토큰 없는 격리 export 검증은 pnpm 설치 600초 또는 compiler 제한 시간에서 중단됐다. 이후 metadata cache 전달과 공개 runtime을 수정하여 아래 두 플랫폼 실제 export를 완료했다. 임시 tmpfs 복사 안에서만 hardlink를 사용하고 원본 캐시를 보존한다. 이 추가는 기존 Isso·Promise 라이브 npm Runner에 설치하지 않았으며 별도 전달물 54파일의 SHA256SUMS와 YAML 라이선스를 검증했다.

추가 진단: 공식 Node 24.19.0 ARM64 이미지에서 같은 정적 x64 Hermes 엔진의 HBC 생성을 확인했다. 호스트/VM 연결 이상과 겹친 초기 제한 시간 실패와 구분하여, 정상 환경에서 온라인 의존성 설치·캐시 검사·전달이 완료되는 것을 확인했다. 이후 1개 공개 패키지만 사용하는 작은 오프라인 재현에서 pnpm 11의 공급망 정책 검사에 필요한 registry metadata가 content store 밖에 저장됨을 확인했다. `ERR_PNPM_META_FETCH_FAIL` 재시도 때문에 설치가 제한 시간을 넘겼다. 메타데이터를 검증된 캐시 안에 준비하고 함께 전달하도록 수정했다. 작은 격리 fixture에서 오프라인 설치·정책 검사 성공, metadata 누락 시 빠른 실패, lifecycle canary 미실행과 원본 캐시의 바이트 보존을 확인했다. 정책과 네트워크 격리는 유지했다.

Flora의 Reward GitHub 연결 정보 v1은 저장했지만 소스 조회가 PROVIDER_UNSUPPORTED로 중단되어 앱 인식은 남아 있다. PC Runner 등록·두 플랫폼 자동 정책·실제 커밋 자동 게시, 다운로드·적용·재시작도 남아 있다. 기존 설치 앱이 새 native 엔진을 이미 포함한다고 가정하지 않는다. SDK를 포함한 최초 바이너리 설치가 먼저 필요하다. iOS native QA binary·물리 기기·스토어 배포도 이번 결과에 포함하지 않는다.

수정 후 실제 Reward 소스의 오프라인 pnpm 설치는 완료됐고 export 설정 검사에서 `CONFIG_CHANGED`를 반환했다. 좁은 컨테이너 공개 설정 검사로 Expo runtime `1.0.0`과 Flora runtime `flora-reward-rn0863-v1`의 차이만 확인했다. 플랫폼 목록 ios/android/web, 비활성 Expo Updates, Flora 플러그인·앱 ID·URL·채널·runtime·서명 키 ID·공개 인증서의 일치는 확인했다. 공개 runtime 바인딩과 명시적 ios/android/web 목록을 커밋 `434aa907a3667364bd4713a5bb5f3a3524ffe918`으로 QA 브랜치에 push했다. 설정 회귀 테스트 2개와 앱 타입 검사, development/production 공개 설정 조회를 통과했다. 앱 버전·기존 환경 검사·web export·공개 연결 정보는 보존했고 Runner 검사를 완화하지 않았다. 기존 APK는 `e09ee8e`에서 만든 산출물이며 새 커밋의 빌드 증거로 바꾸지 않았다.

## 실제 격리 export 결과

동일한 커밋 `434aa907…`의 추적 파일을 검증해 Runner production entrypoint로 iOS·Android export를 실행했다. GitHub App의 소스 다운로드·자동 Job·OTA 게시를 거친 실행은 아니다. 컨테이너 network=none, read-only root, 비루트, capability 제거를 유지했다. compiler 이미지는 `sha256:dd627dc85a04653231698b1631aa6b0d2f1de3760fcfc063099bc7f6c66e4ee0`이다.

| 플랫폼 | HBC bytes | Launch SHA-256 | 에셋 |
| --- | ---: | --- | --- |
| iOS | 3,321,144 | `84fc30a96e043fd8c17ff73b6606e64b91bd261b7e28137020a8b5fc0ce54925` | 52개 / 18,202,006 bytes |
| Android | 3,613,895 | `63ebfe0bbc4eeff367e3911bc814d0ab6c34ad7910a4a1ce6ab8a9ccdbdedc34` | 56개 / 19,168,164 bytes |

두 실제 산출물의 Hermes magic `c61fbc03c103191f`, launch 파일 해시·크기와 에셋 파일 수·총 크기를 독립적으로 다시 확인했다. source digest는 `9930ad71b77105f684d9fa1f66aeae9f39bf35b3c9eb49d14e392c3979cc2446`, 검증된 cache manifest digest는 `7944c35aa2924bd7f0b91e5272c62b1ad367d08cb1508d2d19f768de40a4de16`이다. 캐시는 lock·manifest 변경이 없는 이전 `e09ee8e`의 seed에서 준비했으며 새 소스 커밋과 구분해 기록했다. Runner suite는 108개 중 106개 통과·opt-in 2개 제외, 별도 실제 pnpm Docker 회귀 1개와 Runner 타입 검사를 통과했다.

증거: `dist/real-apps-2026-10-13/evidence/reward-pnpm-isolated-export{,-ios,-android}.json`, `reward-pnpm-cache-receipt.json`, `reward-pnpm-artifacts/{ios,android}/`. QA 브랜치의 GitHub Actions 실행 조회는 빈 배열이다. 최종 새 설치 토큰 조회도 Isso·Promise만 반환해 Reward 자동 게시·기기 적용을 완료로 표시하지 않는다.
