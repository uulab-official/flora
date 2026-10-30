# Flora 빌드 Provider: 내 PC · GitHub Actions · 외부 서비스

> 기준: **UULab 운영 데모는 단일 소유자 유지**. 오픈소스 사용자는 자신의 인프라에 Flora를 설치하고 본인의 PC/서버 또는 본인 계정의 외부 빌드 서비스를 선택한다. 별도의 중앙 유료 Build Farm은 필수가 아니며 자동으로 구독하거나 결제하지 않는다.

## 현재 실제 지원 수준

| Provider ID | 실행 위치 | 상태 | 지원 범위 |
| --- | --- | --- | --- |
| `flora-pc-ota` | 사용자의 Linux/macOS + Docker | 기존 실행 엔진 | GitHub 고정 SHA를 export한 뒤 iOS/Android OTA 발행 (최초 SDK 바이너리는 별도) |
| `flora-pc-native` | 신뢰하는 macOS + Xcode/Android tools | 수동 설정 preview | 로컬 소스/인증서가 준비된 환경에서 iOS/Android 네이티브 빌드·서명; 다른 사용자 PC 간단 설치 마법사는 미완성 |
| `github-actions-native` | **호출하는 비공개 앱 저장소**의 GitHub-hosted 또는 사용자 self-hosted Runner | 재사용 Workflow 예제 | Android preview debug APK 또는 iOS 인증서 기반 IPA 예제, 아티팩트 Actions 보관. Flora 웹 실행 버튼 아직 없음 |
| `expo-eas` | 사용자 Expo 계정 | 미연동 | EAS Build / EAS Update API 어댑터 설계 예정 (계정/사용량/과금 사용자 책임) |
| `codemagic` | 사용자 Codemagic 계정 | 미연동 | API 기반 빌드/로그/아티팩트 설계 예정 |
| `bitrise` | 사용자 Bitrise 계정 | 미연동 | API 기반 빌드/로그/아티팩트 설계 예정 |

`flora providers list --json`은 정적인 **플러그인 목록 및 구현 성숙도**만 출력한다. PC 온라인, 계정 로그인, 인증서 적합성 또는 빌드 성공은 의미하지 않는다. `packages/core/src/integration-providers.ts`를 참고한다.

## A. 내 PC의 Flora OTA Runner 연결 (현재 엔진)

1. 자체 Cloudflare/D1 환경에 Flora 컨트롤 플레인을 설치한다. 소유자 등록과 인증은 [README](../../README.md)의 `flora setup` 경로를 따른다. 다른 사용자의 계정을 UULab 운영 데모에 추가하지 않는다.
2. 본인의 Expo/React Native 앱에 [Flora OTA SDK](../../packages/ota-sdk/README.md)를 연결한 **호환 Release 바이너리**를 먼저 빌드/설치한다. SDK 변경, 새로운 runtime 및 네이티브 코드 변경은 바이너리 교체가 필요하다.
3. 앱을 GitHub App으로 연결하고, Flora의 온보딩 UI에서 앱 범위를 지정한다. 공개 SDK 설정/Runner binding을 다운로드한다.
4. Linux 또는 macOS에서 **로컬 Docker Unix 소켓**과 Node 24.19.0, Git, pnpm 11.19.0을 준비하고 `flora setup runner`를 실행한다. 민감한 토큰은 앱 저장소가 아닌 권한 0700 폴더, 0600 설정 파일에만 보관한다.
5. `flora doctor --runner-service /absolute/private/service.json --strict --json`으로 도구/Runner 설정 상태를 확인한 후 활성 Runner/OTA 게시/실제 기기 적용을 **각각 별도로** 검사한다.

Runner가 켜져 있지 않으면 작업을 처리할 수 없다. Mac/Windows 사용자의 도커 구성, 앱 의존성 이미지, 네이티브 SDK 통합은 프로젝트 버전에 따라 다르다. 현행 일반 Runner setup은 Linux/macOS 지원 경로다. Windows 원격 Docker와 Windows 자체 서비스 실행을 검증 없이 지원한다고 표시하지 않는다.

## A-2. GitHub Actions 없이 자신의 PC에서 네이티브 APK 만들기 (수동 예제)

Cloudflare Runner를 준비하지 않아도 **본인이 소유한 Expo 프로젝트의 로컬 컴퓨터**에서 Android Debug APK 빌드 스크립트를 실행할 수 있다. 이 경로는 기존 Flora 서버 Job과 연결된 자동 빌드가 아니며, 빌드 성공/배포 완료를 자동으로 보고하지 않는다.

1. [예제 빌드 스크립트](../../examples/github-actions/flora-expo-build.mjs)를 비공개 Expo 앱의 `scripts/flora-expo-build.mjs`에 복사한다.
2. 해당 앱의 잠금 파일 기준으로 `npm ci` 또는 `pnpm install --frozen-lockfile`을 실행한다. Expo CLI, Android SDK/Java, Gradle이 설치되어야 한다.
3. 앱 루트에서 `FLORA_PROFILE=preview node scripts/flora-expo-build.mjs android`를 실행한다. Android `assembleDebug`를 사용하고 실제 output은 `dist/flora/*.apk`에 저장된다.
4. macOS/iOS는 Xcode/CocoaPods와 실제 Apple 서명 자료가 필요하다. `FLORA_IOS_EXPORT_OPTIONS_PLIST` 등 별도 서명 설정이 준비되기 전에는 IPA가 만들어지지 않는다.

수동 APK 빌드 결과를 OTA 자동 게시와 혼동하지 않는다. OTA 배포는 앱에 Flora SDK가 포함된 네이티브 바이너리를 먼저 설치하고, 별도 Runner가 각 채널과 runtime에 맞는 번들을 게시해야 한다.

## B. 내 PC를 GitHub Actions의 self-hosted 러너로 사용하기

비공개 저장소의 [Flora native build Workflow](reusable-expo-build.ko.md)에서 입력 `runner-type: self-hosted`를 선택할 수 있다. 코드는 그대로 **비공개 앱 저장소에서 체크아웃**하고, 컴파일을 본인의 PC에서 수행한다. 이 경로는 기존 `@flora/runner` 데몬과 **별도 선택지**다.

- **Android:** Linux PC 또는 GitHub self-hosted Runner로 정상 등록된 Linux 환경. GitHub 기본 `self-hosted`, `Linux` 라벨과 사용자 정의 `flora-android` 라벨이 모두 필요하다.
- **iOS:** Xcode, CocoaPods 및 올바른 Apple 인증서를 가진 Mac. GitHub 기본 `self-hosted`, `macOS` 라벨과 사용자 정의 `flora-ios` 라벨을 등록한다.
- 자체 Runner는 반드시 신뢰하는 전용 PC/계정에서 실행한다. PR·fork 등 신뢰할 수 없는 코드를 Runner에서 실행하면 인증서·키·환경변수 유출 위험이 있다. 운영 보호 브랜치 정책과 승인된 Workflow 사용을 권장한다.
- 자체 PC Runner도 전기, 디스크, 네트워크, 소프트웨어 라이선스 비용은 발생한다. GitHub-hosted 실행 분은 사용하지 않지만 Actions/저장소 사용량 및 아티팩트 보관 비용 정책은 확인해야 한다.

비공개 프로젝트 예제:

```yaml
jobs:
  build:
    uses: uulab-official/flora/.github/workflows/reusable-expo-build.yml@REVIEWED_40_CHARACTER_SHA
    with:
      platform: android
      profile: preview
      runner-type: self-hosted
      project-directory: .
      install-directory: .
    secrets:
      FLORA_IOS_P12_BASE64: ${{ secrets.FLORA_IOS_P12_BASE64 }}
      FLORA_IOS_P12_PASSWORD: ${{ secrets.FLORA_IOS_P12_PASSWORD }}
      FLORA_IOS_PROFILE_BASE64: ${{ secrets.FLORA_IOS_PROFILE_BASE64 }}
      FLORA_IOS_EXPORT_OPTIONS_BASE64: ${{ secrets.FLORA_IOS_EXPORT_OPTIONS_BASE64 }}
```

`@REVIEWED_40_CHARACTER_SHA`는 예제이므로 실제 검증한 Flora 커밋 전체 SHA로 바꿔야 한다. iOS 서명용 Secrets는 비공개 호출 저장소에만 등록한다.

## C. 외부 서비스 / Provider Plugin 확장

Flora는 오픈소스이므로 사용자의 **자체 API 계정**을 별도 adapter로 연결하도록 확장한다. 권장 구조는 다음과 같다.

```text
Flora Control Plane (Cloudflare) — 사용자 권한, 설정/작업 이력
  ├─ Local OTA / Native provider  → 사용자의 PC/Mac
  ├─ GitHub Actions provider      → 호출한 비공개 저장소 / 사용자 Runner
  └─ External API adapters        → 사용자 EAS / Codemagic / Bitrise / 기타
                                     (후속 개발; 현재 목록만 존재)
```

새 플러그인은 코드 리뷰를 거친 adapter만 설치한다. 제3자 manifest는 **데이터만 등록하며 실행 권한을 주지 않는다**. `parseProviderManifest`는 ID, 버전, 기능, 플랫폼, 인증 유형, 문서 경로를 검증하고, 외부 항목이 스스로 `existing-runtime`이라고 주장하면 거절한다. 실행 전 `requireIntegrationAdapter`는 코드로 등록된 adapter ID를 다시 요구한다.

Adapter 구현 시 반드시 포함할 계약: 검증된 provider API origin, 앱/조직/토큰 권한 범위, 키 Vault 복호화와 주입 경계, 요청 idempotency, 제한된 timeout/retry, 실패 redaction, build ID/artifact SHA 검증, provider revoked/usage exhausted 상태. 앱 저장소의 민감 정보나 운영자를 위한 공개 Flora 서비스 토큰을 외부 provider로 전달하지 않는다.

외부 SaaS 서비스는 API 지원·계정 비용·이용약관이 다르므로, 각 사용자 자신의 계정에서 명시적으로 활성화해야 한다. 외부 서비스를 연결하지 않아도 로컬 Runner와 OTA로 운영할 수 있어야 한다.

## 향후 우선순위

1. 자체 설치에서 **Android 로컬 PC 빌드와 iOS Mac 빌드** 등록 마법사 개선, 작업 로그·산출물 로컬/선택적 BYOC 보관.
2. Flora 웹에서 설치한 Provider 선택 → 상태/비용 추정 → 실행 → 실시간 로그/산출물/취소 제공. 현재 CLI의 catalog는 실행 연결이 아니다.
3. 검토된 EAS/Codemagic/Bitrise 플러그인 별도 PR, 최소 권한 및 mock + 실제 계정 검증. 연결하지 않은 Provider는 `planned` 상태로 유지.
4. 별도 공개 호스팅형 멀티테넌트 SaaS는 이후 선택 과제. 모든 사용자가 UULab 단일 소유자 인스턴스에 로그인하도록 기존 인증을 우회하지 않는다.
