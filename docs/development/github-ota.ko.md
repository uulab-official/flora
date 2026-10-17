# GitHub 탐지와 자체 호스팅 OTA

Flora SDK와 GitHub push → 고정 SHA → Metro/선택적 Expo CLI export → 자동 OTA 경로는 [자동 배포 가이드](automation-runner.ko.md)를 따른다. EAS 계정·API는 사용하지 않는다. 아래는 기존 수동 OTA 입력과 선택적 Expo Updates 네이티브 엔진 호환 경로다.

앱별 GitHub 연결과 OTA 이력은 기존 source/baseline 반입과 별도 `operations` 저장 포트에 보존한다. 기존 JSON, snapshot, baseline, Runner API를 대체하지 않는다. GitHub 연결은 `expectedVersion` CAS이며 처음 연결할 때 0을 사용한다. 탐지는 연결 버전·앱 루트·조회한 commit SHA를 포함한 변경 불가능한 이력이다.

```json
{"expectedVersion":0,"installationId":42,"owner":"my-owner","repository":"my-app","ref":"main"}
```

GitHub App ID와 RSA 개인 키는 서버 환경 `FLORA_GITHUB_APP_ID`, `FLORA_GITHUB_PRIVATE_KEY` 또는 주입한 credential resolver에서 받는다. 연결 JSON, 공개 CONFIG, 탐지 응답, 저장소에는 토큰·개인 키를 저장하지 않는다. 서버가 RS256 App JWT와 해당 저장소의 Contents read 권한으로 제한한 installation token을 생성한다. 토큰을 영속 저장하거나 GitHub 내용을 수정하지 않는다.

조회는 `https://api.github.com`의 고정 REST 경로만 사용한다. 먼저 ref를 40자리 SHA로 확정하고, 이후 디렉터리·`package.json`·`app.json` 읽기는 모두 해당 SHA를 지정한다. Redirect는 manual로 받고 3xx를 거절한다. 탐지 전체는 30초, 개별 fetch/body는 10초로 제한한다. JSON 응답은 1 MiB, 디코딩한 파일은 256 KiB, 디렉터리 항목은 1,000개 미만이다. 큰 디렉터리의 불완전한 결과를 성공으로 사용하지 않는다. provider HTTP 오류·타임아웃에는 응답 본문이나 credential을 포함하지 않는 안전한 오류를 반환한다.

Expo/React Native dependency와 `expo-updates` dependency, 정적 runtimeVersion·platform·updates 선언을 읽는다. dependency 선언은 설치·native 설정·실제 빌드를 검증한 증거가 아니다. `app.config.js/ts/mjs/cjs`가 있으면 실행하지 않고 `dynamic-required`로 기록한다. 운영자가 별도로 내보낸 resolved JSON을 다음 형식으로 제공할 수 있으며 SHA가 이번 GitHub 조회 결과와 일치해야 한다.

```json
{"commitSha":"40자리_실제_조회_SHA","config":{"runtimeVersion":"native-1","updates":{"url":"https://your-host/updates/APP_ID"}}}
```

원문 config는 탐지 요약에 저장하지 않는다. `resolved-export`는 운영자가 제출한 설정 증거이며 빌드가 그 설정을 사용했다는 검증은 아니다. runtime policy 객체, 누락한 명시적 runtimeVersion, 서로 다른 iOS/Android runtimeVersion 또는 updates override는 publication을 차단한다. 플랫폼별 값은 현재의 단일 탐지 요약과 일치하도록 명시적으로 해결되어야 한다.

## OTA 입력과 공개 범위

OTA는 실행·bundle 생성 없이 이미 내보낸 binary를 받는다. 업로드와 publication은 별도 요청이다. 업로드 직후 asset은 비공개 staging이고, 해당 앱의 성공한 immutable deployment가 참조한 뒤 공개 다운로드할 수 있다. 업로드 메타데이터는 `{key,contentType,fileExtension}`이다. `key`는 Expo export가 생성한 실제 bundler asset key를 그대로 사용한다. SHA-256 ID를 bundler key 대신 만들어 넣지 않는다. Asset ID는 `asset_`와 hex SHA-256, manifest hash는 같은 digest의 Base64URL이다. 같은 binary의 key/MIME/확장자를 바꾸는 요청은 immutable metadata conflict로 거절한다.

각 asset은 1바이트 이상 16 MiB 이하이다. 앱별 staging과 published asset을 합쳐 128개·64 MiB 이하이고, deployment는 launch asset 1개와 ancillary asset 최대 32개를 참조한다. Asset binary는 publication JSON에 넣지 않는다. Publication 검증은 metadata를 읽으며 모든 binary를 동시에 버퍼링하지 않는다. Hosted 저장소의 전체 128 MiB canonical payload 예산도 적용되므로 앱별 한도가 여유 있어도 업로드를 거절할 수 있다. 이 단계는 staged asset 삭제/garbage collection을 제공하지 않는다.

```json
{"requestKey":"release_001","detectionId":"github_ACTUAL_ID","commitSha":"40자리_실제_조회_SHA","channel":"preview","runtimeVersion":"native-1","platform":"android","launchAssetId":"asset_ACTUAL_HEX_DIGEST","assetIds":[]}
```

신규 publication은 현재 연결의 탐지 SHA, `expo-updates` capability, runtimeVersion, platform, 같은 앱의 업로드 asset을 검사한다. 배포 목적지는 native 설정의 `updates.url`과 `ORIGIN/updates/APP_ID`가 같아야 한다. 선택한 channel과 일치하는 단일 `?channel=` query도 허용한다. 기존 EAS update URL을 가진 native binary가 이 서버를 사용한다고 주장하지 않는다. 목적지·runtime·signing 설정을 바꾸려면 호환 native binary 설정과 별도 빌드/기기 검증이 필요하다. CLI publication은 `FLORA_OTA_ORIGIN`을 요구한다.

같은 앱·requestKey·같은 입력은 기존 publication receipt를 그대로 반환한다. 재연결 후에도 원래 receipt를 회수할 수 있으며 목록 페이지에 없는 오래된 receipt는 전용 lookup으로 조회한다. 입력이 달라지면 idempotency conflict이고, 새 requestKey로 오래된 연결의 탐지를 사용하면 config conflict다. 업로드 binary가 조회 SHA에서 실제로 빌드되었다는 attestation은 제공하지 않는다. SHA binding은 선언한 배포 revision과 GitHub 탐지 revision의 일치 검증이다.

공개 `GET /updates/APP_ID`는 `expo-platform`, `expo-runtime-version`, protocol version 1을 사용한다. Channel은 query, `expo-channel-name`, 기본 `production` 순서로 선택한다. 최신 호환 deployment를 JSON/Expo JSON/multipart로 반환하고 호환 deployment가 없으면 204이다. Manifest ID는 UUID, 생성 시간은 ISO 8601, hash는 Base64URL SHA-256이다. `expo-manifest-filters`와 metadata에는 app/channel을 함께 기록한다. Asset URL은 `ORIGIN/updates/APP_ID/assets/HEX_DIGEST`이고 앱 범위를 확인한 immutable bytes를 제공한다. 다른 앱의 digest를 대신 요청하면 공개하지 않는다.

서명은 별도 `FLORA_OTA_SIGNING_PRIVATE_KEY`, `FLORA_OTA_SIGNING_KEY_ID` 또는 주입한 `createRSAManifestSigner`로 구성한다. GitHub App 키와 별개의 RSA 키다. 반환할 manifest의 정확한 UTF-8 bytes를 RSA PKCS#1 v1.5 SHA-256으로 서명한다. Client의 `expo-expect-signature` 요청에 사용할 signer가 없거나 key ID/algorithm이 맞지 않으면 서명 없는 update를 성공으로 내려보내지 않는다. Native binary에는 대응하는 공개 인증서가 미리 있어야 한다.

## 화면과 CLI에서 사용하기

등록 앱을 선택하고 **GitHub 연결**에서 설치 ID·owner·repository·ref를 입력한다. GitHub App 생성·저장소 설치는 운영자가 먼저 수행한다. **소스 동기화**는 수동 인식 갱신이다. 서명된 push webhook과 앱별 자동화 정책으로 Runner export·OTA 발행을 연결하는 경로는 [자동 배포 가이드](automation-runner.ko.md)를 따른다. `app.config.ts` 등 동적 설정은 신뢰하는 해당 커밋의 개발 환경에서 `npx expo config --type public --json > expo-public.json`으로 내보내 화면에 제공한다. 화면이 SHA wrapper를 만든다. runtime 정책 객체가 남으면 명시적 native runtime 정보를 해결하기 전 배포를 차단한다.

실제 native binary에 `expo-updates`, Flora의 `updates.url`, 동일 runtime과 필요한 채널(`updates.requestHeaders`의 `expo-channel-name`)을 설정해 빌드·설치해야 한다. 업데이트 주소는 `https://실제호스트/updates/실제APP_ID`다. Expo export는 신뢰하는 저장소의 개발 환경에서 `npx expo export --platform android --output-dir dist` 등으로 수행한다. 화면의 OTA 패널에서 플랫폼에 맞는 실제 launch bundle과 필요한 ancillary assets를 업로드한다. 파일명/key는 export metadata를 유지한다. 이 문단의 expo-updates 경로는 선택적 엔진 어댑터다. 일반 RN은 Flora SDK와 교체 가능한 엔진 계약을 사용할 수 있으며 SDK 설치 패키지와 엔진의 범위는 [SDK 가이드](../../packages/ota-sdk/README.md)를 따른다.

```sh
pnpm flora dogfood github-connect --app APP_ID --file connection.json
pnpm flora dogfood operations --app APP_ID --json
pnpm flora dogfood ota-upload --app APP_ID --file dist/bundle.hbc --key bundle --file-extension .hbc --content-type application/octet-stream
pnpm flora dogfood ota-publish --app APP_ID --file publication.json
```

관리 API는 `GET /api/apps/:id/operations`, `POST /api/apps/:id/github`, `POST /api/apps/:id/github/sync`, `POST /api/apps/:id/ota/assets?key=...&contentType=...&fileExtension=...`, `POST /api/apps/:id/ota/deployments`다. Assets만 raw `application/octet-stream`, 다른 POST는 JSON이다. 기존 세션·Origin·CSRF·mutation fence를 유지한다. 화면에는 최근 인식/배포 각20건을 표시하며 DB에 보존된 오래된 receipt도 전체 request-key lookup으로 재조회한다.

로컬 `0004_operations.sql`과 hosted `0003_github_ota.sql`을 추가한다. 기존 checksummed migration·source·baseline·설정·실행 이력·hosted capacity counter는 유지한다. 원격 운영 DB migration/배포는 실행하지 않았다. SQLite CLI publication이 별도 D1으로 자동 복사되지 않으며 hosted publication은 해당 서버 화면/API를 이용한다. Loopback serve는 같은 SQLite를 확인하는 QA용이고 모바일 원격 배포 호스트가 아니다.

## 검증 결과의 의미

Focused domain tests는 ref pinning, JS config 미실행, 플랫폼 override 차단, 지연 provider body deadline, secret-safe 실패, asset/SHA/app binding, receipt 재조회, content negotiation, 204와 manifest filters, 정확한 manifest bytes의 RSA 검증을 확인한다. 로컬 workerd 통합 테스트는 실제 JWT/resolver와 Auth DO/D1을 synthetic GitHub transport에 연결해 Expo·React Native 두 앱의 업로드·publication·조회·교차 앱 거절을 확인한다.

이 결과는 실제 GitHub 계정/설치 권한, 운영 edge 배포, 실제 Expo export artifact, signed native binary, 기기 다운로드·재시작·cache/channel 전환의 검증을 대체하지 않는다. 관리 Worker는 앱 코드를 실행하지 않는다. 별도 Runner가 고정 커밋을 export하는 코드는 구현되어 있고 실제 Metro는 신뢰된 테스트 executor로 검증했다. 실제 Docker·운영 GitHub·기기 설치는 별도 검증이다.

기준 문서: [GitHub App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [GitHub repository contents](https://docs.github.com/en/rest/repos/contents), [Expo Updates v1](https://docs.expo.dev/technical-specs/expo-updates-1/).
