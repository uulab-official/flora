# Flora 네이티브 OTA SDK

`@flora/ota` 0.3.2에는 Flora 자체 iOS/Android 엔진이 포함됩니다. 기본 검증 대상은
bare React Native 0.86.3입니다. Expo 프레임워크, EAS 계정, EAS Update 및 프로젝트
ID가 필요하지 않습니다. `@flora/ota` 코어는 RN을 import하지 않으며 RN peer도
선택 사항입니다. 실제 앱에서는 `@flora/ota/native`를 사용합니다.

Flora 관리자 화면에서 앱을 선택하고 **Flora OTA 서명 → 이 앱의 OTA 서명 준비**를
누른 뒤 **SDK 공개 인증서 다운로드**로 공개 X.509 인증서를 받습니다. 현재 화면은
key ID를 별도로 표시하지 않으므로 브라우저 개발자 도구의 Network에서 해당
`POST /api/apps/<앱 ID>/signing-key` 응답의 `keyId`를 확인합니다. 이 응답은 공개 인증서와
공개 식별 정보만 반환하며 개인키를 포함하지 않습니다. 관리형 키는 앱별로 서버에
보관되며, 앱·저장소·Runner에는 개인키를 넣지
않습니다. 공개 인증서와 같은 key ID만 앱 바이너리에 고정합니다. 자체 엔진은 서명
없는 응답을 거부하므로 실제 배포 전 서명 응답을 확인합니다. 기존 키를 사용하는
앱에서는 인증서를 임의로 교체하지 않습니다.

기존 운영자를 위한 전역 fallback은 서버 secret `FLORA_OTA_SIGNING_PRIVATE_KEY`와
`FLORA_OTA_SIGNING_KEY_ID`입니다. 앱별 관리형 키가 있으면 그것을 우선합니다.
새 설치는 관리형 키를 사용하며, 이 가이드는 개인키를 복사하도록 요구하지 않습니다.

## 설치와 앱 등록

Flora 저장소의 설치·빌드를 마친 뒤 다음 명령으로 SDK를 패키징합니다. npm registry에
공개된 패키지 설치를 전제하지 않습니다. 출력 디렉터리는 아직 존재하지 않는 경로를 선택합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm sdk:pack --out /absolute/new-directory
```

출력된 `flora-ota-0.3.2.tgz`와 SHA-256을 보관하고 각 앱 저장소에 같은 후보를
설치합니다. 기존 출력 파일은 덮어쓰지 않습니다. Runner가 설치할 수 있도록 앱
저장소의 `vendor/`에 tarball을 두고 상대 `file:` 의존성과 lockfile을 커밋할 수 있습니다.

```sh
npm install --ignore-scripts --no-audit --no-fund ./vendor/flora-ota-0.3.2.tgz
```

서로 다른 저장소의 앱을 별도의 Flora 앱 ID로 등록합니다. 앱별 네이티브 설정의
URL은 `https://your-flora.example/updates/app_your_id`입니다. `flora.config.json`에는
동일한 URL, 런타임, 플랫폼과 Metro export recipe를 선언합니다. 네이티브 설정,
서명 인증서 또는 네이티브 의존성을 변경하면 새 바이너리가 필요합니다.

## iOS 연결

SDK의 `FloraOta.podspec`을 RN autolinking으로 연결하고 앱의 `ios/`에서 `pod install`을
실행합니다. 앱 `Info.plist`에 다음 문자열을 컴파일합니다.

| 키 | 값 |
| --- | --- |
| `FloraOTAAppId` | 등록된 앱 ID |
| `FloraOTAUpdateURL` | 앱별 HTTPS 업데이트 URL |
| `FloraOTAChannel` | 예: `production` |
| `FloraOTARuntimeVersion` | 예: `native-v1` |
| `FloraOTACertificate` | 업데이트 서명용 PEM X.509 인증서 |
| `FloraOTAKeyId` | 서버 manifest signer와 일치하는 키 ID |

RN factory delegate의 `bundleURL()`에서 매번 Flora의 선택기를 호출합니다.
초기 실행 때만 선택한 URL을 계속 반환하면 런타임 재시작에서 새 번들이 적용되지 않습니다.

```swift
import FloraOta

override func bundleURL() -> URL? {
  let embedded = Bundle.main.url(forResource: "main", withExtension: "jsbundle")!
  return FloraOTAController.bundleURL(embedded: embedded)
}
```

Release 바이너리에 `main.jsbundle`을 포함합니다. 이 경로는 Metro 개발 서버에
연결하는 개발 모드와 다릅니다. 네이티브 bridge는 `FloraOta`이며 재시작에는 RN의
reload command를 사용합니다.

## Android 연결

SDK Android library를 RN autolinking으로 연결합니다. 앱의
`android/app/src/main/assets/flora_ota_config.json`에 다음 값을 넣습니다.

```json
{
  "appId": "app_your_id",
  "url": "https://your-flora.example/updates/app_your_id",
  "channel": "production",
  "runtimeVersion": "native-v1",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "keyId": "your-signing-key"
}
```

앱의 `reactHost`는 SDK가 제공하는 production host로 생성합니다. 이 host의 동적
delegate가 시작과 각 재시작에서 검증된 번들을 다시 선택합니다.

```kotlin
import com.flora.ota.FloraReactHost

override val reactHost: ReactHost by lazy {
  FloraReactHost.create(applicationContext, PackageList(this).packages)
}
```

이 host는 내부적으로 `FloraOTAController.bundleFile()`을 호출하고, 선택기가 `null`을
반환하면 기본 `index.android.bundle` asset을 사용합니다. RN 기본 host의 Release
모드에서는 `setBundleSource()`만으로 새 파일을 적용할 수 없으므로 초기화 시 번들
경로만 넘기는 방식은 충분하지 않습니다. Flora bridge의 업데이트 재시작은
`FloraReactHost` 연결을 요구합니다. 개발 서버 연결은 이 production host에서 비활성화됩니다.

## JS 시작과 배포 적용

```ts
import { createFloraClient } from '@flora/ota';
import { createFloraNativeEngine } from '@flora/ota/native';

const engine = createFloraNativeEngine();
const launch = await engine.getLaunchInfo(); // 현재 JS 실행의 ID를 한 번 캡처
const ota = createFloraClient(await engine.getNativeConfiguration(), engine);

// 앱이 실제로 렌더링되고 필수 초기화가 성공한 뒤 호출
await engine.markLaunchSuccessful(launch.updateId);

const checked = await ota.checkForUpdate();
if (checked.available) {
  const downloaded = await ota.downloadUpdate();
  if (downloaded.downloaded) await ota.reload();
}
```

정상 실행 확인을 늦게 처리하는 이전 JS 콜백이 새 업데이트를 확정하지 않도록,
`markLaunchSuccessful()`에는 해당 시작에서 캡처한 정확한 ID를 전달합니다. 내장
번들의 ID는 `null`입니다. 다운로드는 검증된 후보만 저장하고 적용은 별도 단계입니다.
새 번들의 실행이 확인되지 않은 상태로 프로세스가 다시 시작하면 이전 정상 버전이나
내장 번들로 복구합니다. 복구 정보는 `getLaunchInfo().rollback`에서 확인합니다.

`getLaunchInfo().assets`는 ancillary asset의 bundler key와 로컬 `file://` URI 맵입니다.
이미지에 이 URI를 명시적으로 전달할 수 있습니다. 일반 RN `require()` 이미지의
자동 URI 재매핑은 이 버전에서 제공하지 않습니다.

## 검증과 데이터 경계

네이티브 엔진은 HTTPS만 허용하고 TLS 검증을 유지합니다. TLS 인증서와 manifest
서명 인증서는 서로 다른 역할입니다. 서명 인증서는 바이너리에 고정한 RSA
2048비트 이상 키를 사용하며, JSON 파싱 전에 원본 manifest 바이트의 서명을 검증합니다.
앱, 채널, 런타임, 플랫폼과 파일 해시가 모두 일치해야 합니다. 플랫폼은 서버 manifest의
`extra.flora.platform`에도 포함됩니다. 이 필드는 응답 추가 필드이며 기존 DB 데이터를
변경하는 마이그레이션이 아닙니다.

실행 파일은 앱의 비공개 저장소에 저장하며 완전히 검증한 뒤 상태를 원자적으로
전환합니다. Android/iOS 앱 ID가 다른 두 바이너리는 각자의 OS sandbox와 네이티브
캐시를 사용합니다. 서버도 앱별 배포·이력을 유지합니다. 테스트는 별도의 저장소와
DB를 생성하며 기존 운영 앱이나 DB를 초기화하지 않습니다.

공개 소스의 네이티브 엔진 테스트는 `packages/ota-sdk/ios/Tests/run.sh`와
`packages/ota-sdk/android/tests/run.sh`이며, JS 연결 예제는
[`examples/native-ota/App.tsx`](../../examples/native-ota/App.tsx)입니다. 각 테스트는
Swift 또는 Kotlin/Java 도구가 별도로 필요합니다. 아래 과거 검증에서 사용한 앱 생성·빌드
운영 스크립트는 현재 clone의 제공 도구가 아니므로 그대로 실행할 명령으로 취급하지 않습니다.
테스트 HTTPS 인증서는 전용 시뮬레이터/QA 앱에서만 명시적으로 신뢰합니다.
엔진의 TLS 검증을 끄지 않습니다.

검증은 세 단계로 구분합니다: JS 계약 테스트, 네이티브 서명·저장소·복구 테스트,
실제 시뮬레이터/에뮬레이터의 다운로드·적용·프로세스 재시작. 앞의 두 단계 통과만으로
마지막 단계를 통과했다고 판단하지 않습니다. 실제 기기 결과는 해당 QA 실행의
배포 ID, 화면, 서버 이력과 함께 기록해야 합니다.

2026-10-12에는 서로 다른 RN 저장소 두 개의 iOS·Android Release에서 마지막 단계까지
검증했습니다. 정상 실행 미확인 후보의 다음 시작 롤백도 앱 A의 두 플랫폼에서
검증했습니다. 후보 SHA, 배포 ID, 데이터 보존과 증거 경로는
[검증 기록](native-ota-evidence.ko.md)에 있습니다.
