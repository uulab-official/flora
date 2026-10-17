# 실제 앱 인증서와 PC 네이티브 빌드

2026-10-14 KST. 운영 화면: [Flora](https://flora.uulab.co.kr/) → 앱 선택 → 설정 → **인증서 · Google 키 · 푸시 키**, **네이티브 빌드 · 서명**.

## 연결한 기존 키

| 앱 | Flora에 등록한 기존 자격 증명 |
| --- | --- |
| Isso · `kr.co.uulab.isso` | iOS 배포 인증서·프로비저닝, Android Keystore, Google Play 서비스 계정, Firebase Android 설정, UULab 팀 공유 APNs |
| Promise · `kr.co.uulab.promise` | iOS 배포 인증서·프로비저닝, Android Keystore, Google Play 서비스 계정, 기존 App Store Connect API 키, UULab 팀 공유 APNs |

기존 로컬 파일을 사용했고, APNs는 사용자가 허용한 Expo 계정 조회로 기존 Apple 팀 `N99FMBQ662`의 키를 복구했습니다. Expo에서 빌드·업데이트·워크플로 실행, 프로젝트 생성, 키 발급·폐기·수정은 하지 않았습니다. 원본 키와 앱 환경 파일의 바이트를 전후 SHA256으로 확인했고, 원본 앱 저장소는 수정하지 않았습니다. 같은 제공자 키를 공유하더라도 앱마다 암호화 binding과 등록·사용 이력이 따로 저장됩니다. 제공자의 팀 전체 권한이 앱별 권한으로 축소되는 것은 아닙니다.

Firebase Android 설정 파일은 FCM 서버 개인키가 아닙니다. 로컬·Downloads·두 Expo 계정에서 대상 앱의 FCM 서버 키는 찾지 못했습니다. Promise의 기존 프로파일에는 `aps-environment`가 없습니다. 키 등록은 푸시 제공자 권한이나 실제 전송을 검증한 것이 아니며, 푸시 전송·제공자 권한 변경은 수행하지 않았습니다. Google Play·App Store Connect 권한과 스토어 제출도 별도 단계입니다.

## 빌드와 최소 권한

Flora에서 플랫폼·GitHub commit SHA·앱 식별자·서명 키 버전을 고정해 요청합니다. 서버는 연결된 저장소의 현재 commit을 확인합니다. 일반 OTA Runner와 네이티브 Runner의 토큰은 별개이며, 네이티브 Runner는 자신의 앱과 플랫폼의 작업만 가져옵니다.

1. PC의 검토된 별도 checkout에서 저장소·commit·변경 여부를 확인합니다.
2. macOS sandbox에서 unsigned Release 빌드를 실행합니다. `.credentials`, `.flora`, 원본 키, Keychain, 서명 임시 폴더, 비공개 로그를 컴파일 과정에서 읽지 못하게 합니다. 빌드에는 허용한 공개 클라이언트 설정만 제공합니다.
3. 산출물을 새로운 비공개 inode로 복사하고 hash·소스·entitlement를 재확인합니다. 이후에만 유효한 lease로 서명 키를 요청합니다.
4. iOS에는 배포 인증서와 프로파일, Android에는 Keystore만 전달합니다. Google Play·ASC·APNs·FCM 키는 이 작업에 전달하지 않습니다.
5. 앱·팀·인증서·프로파일·만료·개인키 일치 여부를 검사하고, iOS 임시 Keychain / Android 임시 작업 폴더에서 서명합니다. iPhoneOS arm64와 실제 Android package를 확인하며, 기존 associated domains entitlement를 보존합니다. iOS 앱·프레임워크의 Info.plist는 XML 또는 binary 형식이어야 합니다. 서명 후 실제 embedded entitlement가 프로파일로 제한한 앱·팀·푸시·도메인·Keychain 값과 정확히 일치하는지 확인합니다.
6. Flora 완료 응답 이후에만 로컬 signed artifact와 확인된 receipt를 공개합니다. 응답이 불명확하면 산출물은 비공개 `.pending`에 보존하고 후속 자동 처리를 멈춥니다. 키·임시 Keychain은 정리합니다.

ExpoModulesJSI가 중첩 SwiftPM 빌드를 수행할 때 macOS sandbox가 두 번 적용되는 문제는 공식 Swift CI의 `-IDEPackageSupportDisableManifestSandbox=YES` 설정으로 해결했습니다. 임시 고정 wrapper와 `BASH_ENV`가 Xcode 빌드 단계의 PATH 재작성 및 Expo의 `env -i`를 통과해 이 옵션과 unsigned 설정을 전달합니다. **바깥 Flora sandbox는 유지**하며, helper 수정과 보호 경로의 상위 폴더 이동도 차단합니다. 전역 Xcode defaults를 바꾸지 않습니다. [공식 Swift 소스](https://github.com/swiftlang/swift-source-compat-suite/blob/main/project.py#L434)

Xcode 27의 SwiftUI 매크로도 중첩 sandbox 때문에 실패했습니다. 실제 iPhoneOS `@State` 컴파일과 기존 Swift 플래그를 검사하는 Xcode 타깃에서 `OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox`를 검증했습니다. 기존 플래그와 바깥 Flora의 인증 정보 접근 차단은 유지됩니다. 매크로 검증을 생략하거나 전역 설정을 변경하지 않습니다. [Swift 매크로 실행 소스](https://github.com/swiftlang/swift/blob/main/lib/AST/PluginRegistry.cpp#L177)

Android 서명 설정은 AGP의 `androidComponents.finalizeDsl` 단계에서 비웁니다. AGP 9.1.1 실제 검증에서 늦은 `projectsEvaluated` 변경은 이미 생성된 서명 검증 작업을 제거하지 못했습니다. 컴파일에는 원본 Keystore나 debug 키를 제공하지 않으며, unsigned APK 생성 후 해당 앱에 고정한 키만 받아 별도로 서명합니다.

heartbeat는 유효한 lease 안에서 통신·5xx·429·명확한 BUSY만 최대 3번 재시도합니다. 권한 취소·작업 취소·lease 만료는 계속 중단합니다. 오래된 키 버전으로 대기 중인 작업은 기존 입력과 이력을 남기고 실패 처리한 후 다음 유효 작업을 진행합니다.

Flora의 산출물 metadata는 `runner_reported`입니다. 서버가 IPA/APK를 검사했다고 표시하지 않습니다. 독립 확인 도구 `scripts/verify-native-artifact.mjs`가 실제 로컬 파일을 `codesign` / `apksigner` / `aapt2`로 검증합니다. 앱별 빌드·키 전달 이력에는 원문 키가 포함되지 않습니다. 실패·취소 이력도 삭제하지 않습니다.

## PC 자동 시작과 운영 범위

`scripts/local-runner/native-service.mjs install|start|stop|status`로 네이티브 서비스 `kr.co.uulab.flora-native-runner`를 관리합니다. 기존 OTA 서비스 `kr.co.uulab.flora-runner`와 별도입니다. 네이티브 설정 네 개는 `~/.flora/native-runner-uulab/`의 0600 파일이며, plist에는 키·토큰이 들어가지 않습니다. 검증된 로컬 컨트롤러 복사본으로 실행합니다.

macOS 사용자 LaunchAgent의 `RunAtLoad`는 로그인 후 시작입니다. 재부팅만 하고 로그인하지 않은 상태에서 실행되는 시스템 daemon은 아닙니다. 한 supervisor가 앱·플랫폼을 순환하며 네이티브 빌드는 한 번에 하나씩 실행하고, 상태·대기 작업을 주기적으로 확인합니다. 권한 취소·완료 불명확 상태에서 자동 재시작을 반복하지 않습니다.

네이티브 소스 준비는 현재 운영자가 검토한 checkout을 사용합니다. 새로운 GitHub commit은 해당 checkout과 네이티브 프로젝트를 준비한 후 빌드할 수 있으며, commit이 다르면 키를 받기 전에 거절합니다. 기존 GitHub 커밋 기반 iOS·Android **OTA 자동 export/배포** 정책은 그대로 유지됩니다. 모든 커밋에서 네이티브 바이너리까지 자동 생성된다고 표시하지 않습니다.

산출물은 PC의 `~/Library/Application Support/Flora/native-artifacts/<앱>-<플랫폼>/`에 보관합니다. Flora 웹은 작업·hash·서명 식별자·전달 이력을 보여주며 바이너리를 Cloudflare에 업로드하지 않습니다. 최초 설치·TestFlight·Google Play 제출·기기 QA는 별도입니다. 기존 앱 설치를 삭제하거나 사용자 데이터를 초기화하지 않았습니다.

Cloudflare의 기존 Worker·D1·DO·Vault KEK를 유지했습니다. 네이티브 빌드는 기존 PC의 Xcode/Gradle에서 실행하며 EAS·Actions·신규 유료 리소스를 사용하지 않습니다. 상태 조회 주기와 기존 Cloudflare 전체 사용량에 따라 서비스의 무료 한도 내 사용량은 운영 시 확인해야 합니다.

## 검증 자료

`dist/native-signing-2026-10-14/`의 credential import·iOS operator preflight·entitlement preflight·public config preservation·Worker deployment receipt를 사용합니다. 실제 산출물 검증 자료는 앱·플랫폼별 `*-artifact-verification.json`으로 저장합니다. 비밀 원문과 Runner 토큰은 저장하지 않습니다. 이번 바이너리 빌드·서명 검증은 기기 적용·재시작이나 스토어 제출 증거와 구분합니다.

### 실제 앱 최종 결과

| 앱 | 고정 GitHub 소스 | Android | iOS |
| --- | --- | --- | --- |
| Isso | `d9a1389de8244b9de6b19ff5a91200c8635a541f` | Release APK 서명·독립 검증 통과 | iPhoneOS arm64 IPA 서명·독립 검증 통과 |
| Promise | `56fb88d37994e148fc64f8f573a2df1ddd4f147f` | Release APK 서명·독립 검증 통과 | iPhoneOS arm64 IPA 서명·독립 검증 통과 |

APK는 실제 package·기존 앱별 인증서 지문·서명·16KB 정렬을 확인했습니다. IPA는 기존 팀 인증서, 앱별 프로파일 UUID, 앱·팀 식별자, Universal Links·Keychain 범위, debug 권한 비활성화를 확인했습니다. Isso는 기존 프로파일이 허용한 production APNs를 포함하고, Promise는 기존 프로파일에 없는 APNs 권한을 추가하지 않았습니다.

운영 웹에서도 두 앱 각각의 iOS·Android 완료 기록과 서명 키 전달 이력을 확인했습니다. 실제 Runner 토큰의 다른 앱·다른 플랫폼 작업 접근 및 소유자 키 목록 접근 거부 6건이 통과했습니다. 기존 세 앱의 상태·연결·게시 이력·OTA 정책은 유지됐고, OTA manifest 6개의 ID·내용·서명이 작업 전과 동일했습니다. 원본 키·환경 파일 14개의 해시가 일치합니다. 등록한 12개 키는 버전 1을 유지하며 제공자 키 발급·폐기·푸시 전송은 0건입니다.

요약 증거는 `dist/native-signing-2026-10-14/final-verification.json`입니다. 실제 산출물을 만든 immutable Runner bundle의 해시와 현재 운영 bundle을 구분해 기록합니다. PC에는 기존 OTA 서비스와 새 네이티브 서비스가 모두 실행 중이며, 새 서비스는 unsigned 컴파일 후 필요한 서명 키만 받아 작업합니다.

최근 변경 검증은 signer 19개, SwiftUI/SwiftPM 집중 검증, 실제 AGP 9.1.1 unsigned 재현, 플랫폼별 실제 앱 빌드·서명으로 수행했습니다. 앞선 전체 직렬 실행은 883개 중 880개 통과·옵트인 3개 제외였습니다. 이후 native 집중 실행의 Miniflare HTTP 연결 종료 1건은 해당 파일을 단독 재실행해 6개 모두 통과했습니다. 최신 전체 `pnpm check`가 통과했다고 기록하지 않습니다.
