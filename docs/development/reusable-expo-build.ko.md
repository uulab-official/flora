# Flora: 비공개 Expo 앱의 GitHub Actions 네이티브 빌드 (MVP)

> 상태: 선택형 **재사용 Workflow + 비공개 호출 저장소 템플릿 + Expo 빌드 예제**.
> Flora 웹에서 클릭하여 자동으로 workflow_dispatch하는 SaaS 기능은 아직 구현되지 않았다.
> 기존 Flora OTA / PC Runner / 네이티브 서명 / Cloudflare 운영 DB는 변경하지 않는다.

## 목적과 신뢰 경계

- 공개 `uulab-official/flora`는 빌드 정의만 제공한다. **실제 소스 checkout과 컴파일은 Workflow를 호출한 비공개 앱 저장소의 GitHub Actions 실행 컨텍스트에서 이루어진다.**
- 비공개 저장소의 실행 분은 **비공개 호출 저장소에 과금/쿼터 적용**된다. 공개 Flora 저장소의 무료 실행 분을 타인의 비공개 프로젝트 빌드 팜으로 우회하지 않는다.
- 설치된 GitHub App에 `Contents: read` 권한만 있으면 기존 OTA 소스 감지는 가능하나, **웹에서 GitHub workflow_dispatch를 호출하려면 별도 Actions 권한과 명시적 설치 승인이 필요**하다. 이번 변경에서는 승인 없이 권한을 확대하지 않는다.
- GitHub-hosted Actions는 EAS 무료 무제한 빌드 서버가 아니다. macOS 시간은 특히 비싸며, 고객별 쿼터와 청구는 GitHub 플랜을 확인한다.
- 공개 Workflow는 사용자가 검토한 **40자리 Git commit SHA**로 고정한다. workflow 자체의 action dependencies도 전체 SHA로 고정한다.
- GitHub Actions의 수집된 빌드 산출물은 **호출한 비공개 저장소의 실행 기록**에 남는다. 현재 Flora 서버에 업로드되거나 스토어에 자동 제출되지 않는다.

## 구성 파일

- `.github/workflows/reusable-expo-build.yml`: 다른 저장소에서 `workflow_call`로 실행. `android`는 Ubuntu, `ios`는 macOS; Node/Java, npm/pnpm 잠금 설치, 검증된 경로 내 고정 `flora:build:<platform>` script 실행, IPA/APK/AAB와 SHA256 receipt 업로드.
- `examples/github-actions/private-expo-build.yml`: 비공개 호출 저장소에 복사할 `workflow_dispatch` 예제. 앱 저장소에서 실행하며 `contents: read`만 요청.
- `examples/github-actions/flora-expo-build.mjs`: Expo CLI/Gradle/Xcode 예제. 계정 없이 기본 로컬 네이티브 컴파일; **Android preview APK**, **iOS 서명 IPA** 예제 제공. Android production 서명은 앱별 스크립트에서 별도 구현해야 한다.
- `tests/reusable-expo-build.test.ts`: Workflow 호출 범위, SHA pin, 경로 제한, 최소 권한, 개인정보/비밀값 회피 계약 검증.

## 비공개 Expo 프로젝트에 연결하기

1. Flora에서 기존 앱을 GitHub 저장소 및 OTA 채널에 연결한다. 이 단계는 별도이며 Actions 실행과 혼동하지 않는다.
2. 예제 `private-expo-build.yml`을 **비공개 앱의** `.github/workflows/flora-build.yml`에 복사한다. `@FLORA_COMMIT_SHA`를 이 Workflow가 포함된 실제 Flora commit의 **40자리 SHA**로 교체한다. 여러 레포와 모노레포는 각각 `project-directory`, `install-directory`를 조정한다.
3. `flora-expo-build.mjs`를 비공개 앱의 `scripts/flora-expo-build.mjs`에 복사한다.
4. 비공개 앱의 `package.json`에 아래 scripts를 **기존 scripts를 보존하면서** 추가한다.

```json
{
  "scripts": {
    "flora:build:android": "node scripts/flora-expo-build.mjs android",
    "flora:build:ios": "node scripts/flora-expo-build.mjs ios"
  }
}
```

5. Expo 앱 lockfile(`package-lock.json` 또는 `pnpm-lock.yaml`)을 함께 커밋한다. pnpm은 설치 루트의 `package.json`에 `"packageManager": "pnpm@X.Y.Z"`가 필요하다. Node 및 Gradle/Expo/AGP 버전은 호출 앱에서 맞추고 Workflow의 `node-version` 입력으로 Node를 고정한다.
6. 비공개 저장소의 **Actions → Flora native build → Run workflow**에서 `android`, `preview`를 선택한다. 성공 시 *해당 비공개 실행*의 Artifacts에서 APK와 `flora-build-receipt.json`을 받는다. Expo/SDK/네이티브 의존성에 따라 Android SDK/NDK 또는 Java 버전 조정이 필요할 수 있다.

### iOS 서명 IPA

Apple Developer 배포 인증서, 해당 앱의 프로비저닝 프로파일, Xcode export options plist가 준비되어야 한다. 비공개 호출 저장소의 GitHub Actions Secrets에 아래 **4개만** 등록한다. 공개 Flora 저장소나 Flora 데이터베이스, app config에는 올리지 않는다.

| Actions secret | 값 |
| --- | --- |
| `FLORA_IOS_P12_BASE64` | P12 파일의 base64 (줄바꿈 제거) |
| `FLORA_IOS_P12_PASSWORD` | P12 암호 |
| `FLORA_IOS_PROFILE_BASE64` | mobileprovision base64 |
| `FLORA_IOS_EXPORT_OPTIONS_BASE64` | ExportOptions.plist base64 |

공유 Workflow의 iOS 전용 단계가 일시적인 Keychain과 프로비저닝 프로파일을 설정하고, 완료 또는 실패 시 삭제한다. 선택한 Xcode Scheme이 `.xcworkspace`와 다르면 비공개 프로젝트의 `flora:build:ios` script에서 `FLORA_IOS_SCHEME=... node ... ios`로 명시한다. `flutter`나 모든 Expo 버전/네이티브 템플릿을 자동으로 지원한다는 뜻은 아니다.

**Android production:** 제공된 예제는 의도적으로 production 빌드를 거절한다. 각 앱의 서명 정책/키와 `bundleRelease` 태스크를 검증해, 비공개 앱의 `flora:build:android` script가 실제로 서명된 AAB를 `dist/flora`에 남기게 해야 한다. 키는 해당 앱 Secrets/보안 Runner에 보관한다. 공개 템플릿이나 Flora OTA SDK에 Keystore 원문을 넣지 않는다.

### 아티팩트와 로그

- 각 앱의 build script는 자신의 프로젝트 루트에 `dist/flora/*.apk`, `*.aab` 또는 `*.ipa` 중 해당 플랫폼 파일을 **1~10개** 생성해야 한다. 다른 파일·심볼릭 링크는 아티팩트로 가져가지 않는다.
- `flora-build-receipt.json`은 소스 SHA, 호출 저장소, run ID, 플랫폼·프로필, 파일별 SHA256을 기록한다. `signingVerified: false`는 **서버가 독립 검증하지 않았음**을 뜻하며, 스토어 업로드 적합성을 증명하지 않는다.
- 파일과 실행 로그는 GitHub 비공개 저장소에 속한다. Artifacts는 기본 7일 보존이며 Actions 및 저장소 권한 정책을 따른다.
- `pull_request`, `pull_request_target`에서 서명된 실행을 요청하지 않는다. 예제는 **기본 브랜치에서 수동 실행**만 허용한다. 추가 push 트리거는 GitHub가 보호된 branch로 표시한 경우에만 실행된다. 다른 ref에서 호출하면 Job은 건너뛴다.

## OTA와의 관계

Flora OTA는 기존 `@flora/ota` SDK와 채널/고정 SHA/실제 기기 재시작 검증을 계속 사용한다. 위 Actions Workflow는 **네이티브 바이너리**를 빌드하는 독립 경로다. SDK 및 iOS/Android 기본 바이너리를 최초 한 번 설치하지 않으면 OTA가 작동하지 않는다. 네이티브 코드·모듈·앱 식별자·서명 인증서·업데이트 URL/runtime 변경 시에는 새 네이티브 빌드가 필요하다.

기존 `packages/cloudflare/src/managed-ci.ts`, `github-oidc.ts`의 OIDC는 **UULab 운영의 제한된 OTA CI 세션**용이며 일반 고객용 워크플로 실행 토큰이 아니다. 이를 범용 SaaS 권한으로 해석하지 않는다.

## 완성까지 남은 통합

1. **계정 / 조직 분리:** 기존 단일 소유자의 설치를 유지하며 별도 인증·권한 모델을 단계적으로 이행. 계정·조직·프로젝트·App·credential·artifact·Runner의 모든 조회/쓰기 scope 검증.
2. **GitHub App Actions 연결:** 설치 시 repo 선택, Actions 권한 추가에 대한 사용자 승인, 인증된 `workflow_dispatch`, 허용 workflow/branch/SHA와 실행 ID를 앱 Job에 결합. 권한이 없는 경우 명확한 안내.
3. **빌드 관측:** Actions run ID 확인, 상태/실패 로그 수집, SHA+app binding, 아티팩트 해시 검증, 다운로드/보존 정책. 비공개 build artifact를 공개 Flora 저장소나 다른 사용자에게 전달하지 않음.
4. **서명 및 배포:** Android Keystore, iOS 권한/Keychain, 스토어 API 키의 테넌트별 vault; 서명/증명 검증을 마친 결과만 스토어 제출. 중복 실행/작업 회수/재시도 일관성.
5. **OTA 고객별 격리:** 사용자별 OTA 앱/채널/runtime/매니페스트 서명, BYOC 저장소·쿼터·역할별 롤백; 공개 HTTPS 다운로드는 scoped immutable assets로 제공. 이전 앱의 설치/배포 이력을 유지.
6. **실제 검증:** 외부 비공개 Expo 앱으로 Android preview와 서명된 iOS IPA 실행, 최초 설치→동일 runtime OTA→기기 적용→롤백. 합성 테스트와 실제 기기 검증을 구분.

## 출시 판단

이 변경은 **Actions에서 비공개 앱의 네이티브 빌드를 실행하는 기반**을 구현한 것이다. 아직 Flora 대시보드의 원클릭 네이티브 Actions 빌드, 멀티테넌트 로그인, 공개 npm OTA SDK, 완전한 EAS Build 대체품이라고 표시해서는 안 된다. 기존 PC 네이티브 빌드와 OTA 서비스는 우선 경로로 유지한다.
