# 실제 Isso·Promise Android GitHub 자동 OTA 검증

2026-10-13. 상태: 전용 Android API 36 QA 에뮬레이터에서 실제 GitHub 자동 export → 서명된 OTA 게시 → 다운로드 → 적용 → 완전한 프로세스 재시작 검증 완료.

범위는 `codex/flora-ota-integration`, `flora-verification` 채널, `flora-rn0863-v1` 런타임이다. Android API 36 전용 QA AVD `Flora_RealApps_Android_OTA_QA_API36` / `emulator-5560` / 별도 ADB 5038을 사용한다. 기존 Survivor 에뮬레이터와 iOS QA 앱, 원본 Isso·Promise checkout은 변경하지 않는다. 사용자가 공식 ADB 화면·버튼·재시작 검증을 승인했다.

## 고정 소스와 기준 앱

| 앱 | Android Release 기준 소스 (V3) | 자동 OTA 후보 소스 (V4-Android) | package |
| --- | --- | --- | --- |
| Isso | `789b5178ec23b0a221dbccb0c0050f1ea9938fd8` | `1c0ac9511c54580e44a394cf444c3a168ec9b328` | `kr.co.uulab.isso` |
| Promise | `08996ab109e210ce436c29c620fd113f3b3eac1c` | `604ab30d46da728e4e029a82b0cb002cd8bf4e61` | `kr.co.uulab.promise` |

후보 변경은 `src/flora/FloraProductBoundary.tsx`의 JS marker와 검증된 Runner의 workflow pin이다. SDK 0.3.1 / 공개 연결 / native dependency / 앱 버전 / runtime은 기준 소스와 같다. 시작·복구 테스트 Isso 12개 / Promise 9개와 타입 검사를 통과했다. 기준 APK는 별도 detached worktree에서 Expo OSS prebuild / 로컬 Gradle Release로 만든다. QA 기본 키만 쓰며 EAS·스토어 인증서·스토어 업로드는 사용하지 않는다.

## 게시 전 기준과 보존 계획

- 두 Android manifest는 게시 전 204다. 기존 iOS 게시 이력은 앱마다 2개다. 기존 자동 작업은 Isso 4개 / Promise 1개다.
- 공개 CONFIG v1, GitHub 연결 v2와 기존 CI binding v4 이력을 보존하고 CI binding v5에 새 workflow pin을 추가한다. 기존 자동 policy v1은 `ios` / enabled / `flora-verification`이다.
- 단일 플랫폼 정책을 해당 앱에만 Android로 새 버전 저장한 뒤 push한다. 다른 앱의 정책·작업·배포는 유지한다. 검증 후 원래 iOS policy 값으로 새 버전을 저장하여 복원한다. 기존 정책 이력은 삭제하지 않는다.
- 최초 Android QA 설치 전 이 두 package의 기존 데이터가 없는지 확인한다. 기준 APK를 한 번 설치한 뒤 보존 파일을 만들고, OTA 중 앱 삭제 / clear-data / APK 재설치를 하지 않는다.
- 기기 JS 실행의 marker / source / update ID, Android native committed / pending / launching / blocked, 다운로드 캐시의 RSA 서명과 모든 파일 SHA-256, 재시작 전후 PID, 설치 APK 해시와 보존 파일 해시를 대조한다.
- 새 QA 설치의 데이터 보존 증거를 운영 사용자의 기존 기기 데이터나 물리 기기 검증으로 표현하지 않는다.

## 무료 실행 경계

실제 GitHub 조직 Free plan, Actions 조직 예산 `0` / `prevent_further_usage=true`를 재확인했다. 게시 전 월별 보고 Actions 순청구액은 0이다. private caller의 포함된 Actions 사용량으로 Ubuntu 자동 export를 실행하며, 포함량 소진 시 중단한다. 지출 한도를 높이거나 유료 Runner / Cloudflare Containers를 켜지 않는다. [GitHub Actions 과금](https://docs.github.com/en/actions/concepts/billing-and-usage), [조직 예산 API](https://docs.github.com/en/rest/billing/budgets).

## 실제 결과

아래는 실제 네이티브 빌드, GitHub 실행, 서버 게시, Android 적용·재시작의 각각 독립된 증거다.

### Android 기준 APK와 최초 실행

두 앱 모두 Gradle Release / Hermes / arm64-v8a / debuggable=false 빌드 후 전용 AVD에서 실제 V3 embedded 실행을 확인했다. APK는 AndroidDebug QA 키로 서명했으며 스토어 배포용 서명이 아니다.

| 앱 | APK SHA-256 | V3 실제 PID | OTA 전 보존 파일 SHA-256 |
| --- | --- | --- | --- |
| Isso | `e47b31d7c27187844cca85bac7ab7ff64a316f8ef251ebe155f18a4b38459dbc` | 2517 | `7e74b90dbefeb18dda54669e04b26040b30e196d47fcf029e04b0344c5c1be2b` |
| Promise | `6d25a6fe6e13160a73441e427b2035b3c60a6b1ee6439a1af49277932550a597` | 4087 | `68d60700faa506edf428dbd4e47108d18f02b05815ab43163a6b80d8f593507a` |

Isso 첫 Gradle 빌드는 Metaspace 부족으로 실패했다. 해당 실패 로그를 보존하고 빌드 명령에만 heap 6GB / Metaspace 1GB / workers 3을 적용해 성공했다. Promise도 같은 제한으로 성공했다. SDK / minify / 의존성 / 전역 Gradle 설정은 바꾸지 않았다. 호스트 QEMU의 SystemUI ANR은 전용 AVD만 Vulkan을 끄고 SwiftShader / 2 cores / RAM 4GB로 재시작해 처리했다. AVD 데이터는 삭제하지 않았다.

### 첫 자동 실행 실패와 수정

[Isso 첫 Android 실행](https://github.com/uulab-official/isso/actions/runs/38337391761)은 `051d053906140c66208265009b43e3d9f9c884fa`를 실제 GitHub에서 export했으나 결과 읽기에서 `ARTIFACT_INVALID`로 거절되었다. 배포하지 않았고 실패 작업 `automation_c862865a-0d77-45c9-99e2-85a229341351`을 보존했다.

원인은 Expo Router의 `arrow_right.xml` / `checkmark.xml` asset 타입이었다. Runner에서 `.xml`을 이미 서버와 설치 SDK가 지원하는 `application/octet-stream`으로 전달한다. XML을 실행하거나 파싱하지 않고 원본 bytes / 키 / SHA-256 / 확장자를 보존한다. path / symlink / count / size / platform 검증도 유지한다. 두 앱은 해당 Toolbar.Menu를 사용하지 않으므로 이번 실제 화면 QA를 XML 메뉴 렌더링 검증으로 표현하지 않는다. 설치된 `@expo/ui` Android 이미지 로더는 XML 내용을 읽어 파싱하며 `.bin` 확장자에 의존하지 않는다.

수정 후 관련 테스트 12/12, 전체 Runner 테스트 66 pass / 1 opt-in 실앱 테스트 skip / 0 fail, build / typecheck / 배포 49개 파일 해시 / bootstrap 3개 테스트가 통과했다. 새 trusted artifact는 `33ad7169b4d7539b98d7f3122cc14539e14cd475`, reusable workflow는 `fb03464659e627bad61bdb9d0f0719f068b6b807`에 고정한다. 앱별 CI binding은 기존 v4에 새 v5를 추가한다. 장기 토큰이나 개인키는 앱 저장소에 추가하지 않았다.

### 실제 GitHub 게시와 Android 적용·재시작

| 앱 | GitHub 실행 | OTA ID | 다운로드 파일 | 적용 PID → 완전 재시작 PID |
| --- | --- | --- | --- | --- |
| Isso | [38339127535](https://github.com/uulab-official/isso/actions/runs/38339127535) | `053b8151-8a17-41e3-bf38-c2ebbac4926b` | 40 (HBC + 39 assets) | 2517 → 5036 |
| Promise | [38339544604](https://github.com/uulab-official/promise/actions/runs/38339544604) | `41a45d38-a1a6-4040-9fb6-83f5182360ba` | 51 (HBC + 50 assets) | 4087 → 6034 |

양쪽 source SHA / app ID / runtime / channel / platform / 자동 작업 requestKey가 배포 레코드와 일치한다. 기준 V3 embedded에서 실제 앱의 OTA 적용 버튼을 누른 뒤 같은 PID에서 V4-Android / source=update / 해당 updateId를 확인했다. 이후 ADB force-stop으로 PID가 없어지는 것을 확인하고 새 PID로 실행해 같은 V4 / updateId를 다시 확인했다. Metro 연결이나 APK 재설치로 만든 결과가 아니다.

설치 APK SHA와 앱 소유 보존 파일 SHA는 위 기준 값과 동일하다. 네이티브 committed는 각 앱의 자기 OTA ID, pending=null, launching=false, blocked=[]다. 저장된 원본 manifest의 RSA-SHA256 서명과 HBC·모든 자산의 SHA-256이 일치하고, 모든 URL은 자기 app ID 아래다. native cache scope도 Isso `5408a2b9…` / Promise `80df9658…`로 다르다.

Isso 홈의 상품 사진 / 글꼴 / 탭 아이콘과 홈 → 지도 → 관심 → 전체 설정 전환을 확인했다. 지도에서는 네이티브 뷰와 마커가 보였으나 배경 지도 타일은 표시되지 않아 외부 지도 서비스 정상 동작까지 완료로 주장하지 않는다. Promise 홈 / 탭 아이콘 / Calendar 게스트 화면을 확인했다. 로그인된 예약 데이터와 OAuth / 알림 / 광고 / 결제 등의 앱 기능 전체를 검증한 결과가 아니다.

### 기존 데이터와 앱 분리

`dist/real-apps-2026-10-13/evidence/android-server-preservation-report.json`에서 아래 비교를 모두 통과했다.

- 기존 공개 설정 4개 row와 정책 v1 row 원본 보존, GitHub 연결 v2와 모든 기존 detection / asset / iOS deployment / 자동 작업 레코드 보존.
- Isso 게시·적용 직후 Promise의 설정·CI binding·정책·작업·배포 전체가 최초 스냅샷과 동일함. Promise 배포 동안 Isso의 설정·참조 asset 메타데이터·배포 식별 정보·자동 작업·CI binding은 유지됨.
- 기존 iOS deployment 2개씩 유지, 신규 Android 1개씩 추가: 양쪽 총 3개. Isso 자동 작업 4→6 (첫 Android 실패 + 성공), Promise 1→2 (성공). 다른 앱의 소스나 배포가 섞이지 않음.
- 검증 후 각 자동 policy를 새 v3에 원래 iOS / enabled / flora-verification 값으로 복원. v1 iOS / v2 Android / v3 iOS 이력 모두 보존.
- 단일 플랫폼 정책이므로 **현재 다음 커밋의 자동 대상은 기존 iOS**다. 검증한 Android OTA는 전달 서버와 기기에 유지된다. 상시 iOS+Android 동시 자동화는 이 결과에 포함하지 않는다.

공개 전달 검증 10개도 통과했다. 양쪽 Android manifest의 RSA 서명·ID 일치(200), 기존 iOS 최신 ID 유지(200), 상대 앱의 고유 Android launch asset 요청 양방향 거절(404), 잘못된 runtime / channel 요청 양쪽 거절(204). 공유 이미지 bytes가 같아도 앱별 자산 소유·URL·배포 관계는 분리된다.

### 호스팅 UI와 무료 사용 경계 재확인

관리 화면의 기본 CI workflow pin도 새 `fb034646…`으로 변경해 배포했다. Worker version `c6266136-3866-407f-bae7-0757b388a20b`; 라이브 서버 코드를 그대로 보존했고 변경 자산은 app.js 하나다. 기존 9개 bindings / vars / D1·DO ID / migration v1 / 자산 라우팅을 보존했다. UI 100/100 / typecheck / build 통과. 인증된 app.js 200, SHA-256 `0d6553dd10d95a57d669f3f6a2986fd3cfbaa3c35afffe4f5d8ea573a74b3c1b`, 새 pin 포함 / 옛 pin 없음도 확인했다.

완료 시 GitHub 조직 Free plan, Actions 예산 0 / prevent_further_usage=true가 그대로이고 월별 보고의 Actions 순청구액은 0이다. 청구 보고에는 반영 지연이 있을 수 있으므로 포함량 소진 후에도 무제한 무료라는 뜻은 아니다. Cloudflare 유료 서비스 / 새 리소스 / 마이그레이션은 활성화하지 않았다. Cloudflare 계정 요금제 자체는 확인 권한이 없어 Free 확정으로 표현하지 않는다.

### 재현 가능한 증거

모든 아래 증거는 `dist/real-apps-2026-10-13/evidence/`에 있으며 쿠키·관리자 비밀번호·장기 토큰·서명 개인키는 기록하지 않았다.

- `*-android-baseline-build.json`, `*-android-apk-manifest.txt`, 성공/실패 Gradle 로그: 소스·APK·공개 native 설정·빌드 도구의 출처.
- `*-android-before.json`, `*-android-inspect.json`, `*-android-restart.json`와 PNG: 실제 V3 / V4 JS, PID, 캐시 서명·hash, APK·보존 파일 동일성.
- `*-android-github-success.log`, 첫 Isso 실패 로그: 실제 GitHub controller export / 게시 실행.
- `android-server-before.json`, `android-isso-applied-only-server.json`, 최종 앱별 operations / automation / automation-ci JSON, `android-server-final-settings-policies.json`: 서버 보존 비교.
- `android-server-preservation-report.json`, `android-delivery-isolation-report.json`: 보존 / 교차 앱 거절 / 기존 iOS 유지 검증 결과.

Promise 게시·적용 이후 Isso를 다시 foreground로 전환해 V4 실행 / 자체 캐시 전체 서명·해시 / APK·보존 파일을 재확인했다.

원본 `/Users/uulab/Documents/workspace/uulab/expo/isso`와 `/Users/uulab/Documents/workspace/uulab/expo/promise`는 여전히 깨끗한 기존 HEAD다. 작업은 별도 검증 worktree / GitHub 검증 branch에서 수행했으며 main merge / 스토어 제출 / 운영 기기 설치는 하지 않았다.
