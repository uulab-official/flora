# Flora 웹 빌드 Provider 선택 및 OTA 연결 (1차)

## 지원 범위

Flora의 단일 소유자 셀프호스팅 콘솔에서 **앱 → 네이티브 빌드** 화면으로 이동하면 빌드 실행 방식을 선택할 수 있다.

| 선택 | 현재 화면 동작 | 실제 작업 소유권 |
| --- | --- | --- |
| **Flora PC Native Runner** | 현재 앱의 Runner 등록 이력, 최근 네이티브 작업, 결과 파일명·SHA-256 메타데이터 확인. 아래 인증된 기존 양식으로 이동해 실제 빌드 작업 큐에 요청 | Flora 서버의 기존 앱별 권한, 사용자의 macOS/Android 빌드 PC |
| **GitHub Actions** | 비공개 저장소에서 호출할 Workflow 예제 제공. 복사·사용자 검토 후 본인 GitHub 저장소에 직접 설치 | 비공개 caller 저장소의 Actions 요금/권한/Artifacts |
| **Expo EAS** | 사용자의 Expo CLI 예제 제공 (dry-run). Flora 웹에서 EAS API 호출 없음 | 개인 Expo 계정/설정, EAS 요금 |
| **Codemagic** | 본인의 앱/Workflow로 입력할 로컬 API CLI 예제 제공 (dry-run) | 개인 Codemagic 계정/API |
| **Bitrise** | 개인 앱/Workflow로 입력할 로컬 API CLI 예제 제공 (dry-run) | 개인 Bitrise 계정/API |

이 UI는 앱/세션 범위를 벗어난 외부 데이터·로그·토큰을 읽지 않는다. 별도 외부 Provider OAuth, 대시보드 원클릭 EAS/Bitrise/Codemagic 실행 또는 스토어 제출을 지원한다고 주장하지 않는다.

## 사용 흐름

1. 소유자로 로그인하고 **프로젝트 → 대상 앱 → 네이티브 빌드**로 이동한다.
2. **빌드 실행 환경**에서 Provider를 선택한다.
3. **내 PC · Flora Native Runner**를 선택하면 기존 PC Runner의 앱 범위 권한으로 설정·실행한다. 외부 Provider를 선택하면 잘못된 Native 요청을 방지하도록 아래 로컬 빌드 양식은 숨기며, PC Runner를 다시 선택하면 복구한다. 활성 iOS 인증서/프로파일 또는 Android Keystore, 고정된 GitHub commit SHA와 앱 ID를 확인하고 **이 앱의 네이티브 빌드 요청**을 누른다. 작업이 서버에 큐잉되면 PC가 가져가며, 실제 서명 결과는 별도 검증 대상이다.
4. **GitHub Actions / EAS / Codemagic / Bitrise**를 선택하면 별도 계정에 연결하는 안내와 안전한 예제만 표시한다. **실행 예제 복사**는 기본 dry-run 명령만 복사하며 \`--execute\`, API 토큰, 결제·빌드 실행 요청은 포함하지 않는다. 실제 계정 권한과 비용 한도를 검토한 뒤 본인 PC/비공개 저장소에서 명시적으로 실행한다.
5. 빌드가 성공하더라도 **OTA 배포와 적용 현황**을 통해 기존 Flora OTA 채널, runtime 및 기기 적용을 별도로 확인한다. OTA는 JS/assets 업데이트이며 네이티브 코드 변경에는 새 바이너리가 필요하다.

## 네이티브 빌드 취소

기존 Flora 네이티브 빌드 화면의 앱별 **대기/Runner 처리 중** 작업에 취소 버튼을 추가했습니다. 대기 작업은 즉시 `cancelled`로 전환하고, Runner가 이미 임대한 작업은 `cancel_requested`로 바뀌므로 **취소 요청이 실제 실행 중단을 보장하지는 않습니다**. 사용자가 명시적으로 클릭했을 때에만 기존 인증·CSRF·앱 범위 서버 API를 호출합니다. 응답을 잃으면 중복 취소 요청 없이 이력 다시 확인을 요구합니다. 완료한 작업은 취소할 수 없고, 버튼은 표시하지 않습니다.

## 보안과 정합성

- 기존 \`/api/apps/:id/native\`, \`/api/apps/:id/native/jobs\` 관리 API와 \`/api/apps/:id/credentials\`가 실제 네이티브 작업의 권한을 통제한다. 이 변경에는 외부 빌드 트리거 API나 새 비밀 저장소가 없다.
- Provider 선택은 **브라우저 메모리에서만** 관리된다. 앱 전환·로그아웃/세션 만료·라우트 이동 시 기존 앱 상태와 명령 복사 결과를 비운다. 새 계정/조직 기능을 동작한다고 표시하지 않는다.
- 최근 Native Runner 응답의 \`appId\`는 최상위 데이터, 각 Runner, 각 Job 모두 현재 앱과 일치해야 한다. 외부 앱의 레코드가 포함되면 화면을 표시하지 않는다.
- 마지막 연결 시각은 '연결 이력'이며 실시간 온라인 증거가 아니다. Runner와 PC는 꺼져 있을 수 있다.
- 같은 빌드 화면에는 **Flora OTA 플랫폼별 게시 이력 건수**도 표시한다. 게시 성공은 기기 적용·재시작 성공이 아니며, 해당 상세 화면에서 확인해야 한다.
- 파일명·SHA-256은 서버에 기록된 Runner 보고 메타데이터다. 실제 APK/IPA는 현재 PC/선택한 외부 공급자가 보관한다. **Flora 웹에서 바이너리 파일을 내려받을 수 있다고 표시하지 않는다.**
- \`/build-provider-panel.js\`는 세션을 확인하는 **private asset**으로 분류해 인증 전 제공하지 않는다.
- \`summarizeNativeBuilds\`는 앱별 레코드와 상태를 검증한다. 잘못된 응답이 오면 다른 앱의 이력을 노출하지 않고 미확인 상태로 처리한다.

## 미완성 및 후속 작업

- 외부 Provider의 웹 계정 연결, 명시적 승인/권한 변경, Provider가 발행한 작업 ID의 검증된 이력 동기화
- 앱별 서명 산출물의 안전한 별도 다운로드 (본인 BYOC 스토리지·요청 서명·만료 URL·아티팩트 검증 필수)
- 사용자별 외부 Provider 할당량/비용 표시 및 취소, 빌드 성공 후 서명·스토어 제출 결과 검증
- 완전한 self-hosted PC Native Runner 범용 설치/OS matrix 및 실제 기기의 앱 설치 → OTA → 롤백 종단간 시험
- 기존 브라우저 QA 실패 이슈 #4는 별개로 재현하고 수정해야 하며 이 기능의 정적/합성 테스트 성공과 구분

참고: [개인 PC·외부 Provider 가이드](build-provider-options.ko.md), [플랫폼/Runner 설계](../architecture/control-plane-and-runners.ko.md), [GitHub private caller](reusable-expo-build.ko.md), [남은 작업 이슈 #3](https://github.com/uulab-official/flora/issues/3).

## 비공개 GitHub Actions 결과와 로컬 검증 (추가)

연결된 앱의 GitHub owner/repository와 소스 동기화로 확인한 40자리 commit SHA가 있으면, 빌드 Provider의 **GitHub Actions** 화면에서 해당 비공개 저장소의 Actions 링크를 제공합니다. 화면은 외부 GitHub 저장소의 run/상태/Artifact API를 읽지 않으며, GitHub의 비공개 저장소 로그인 권한으로 직접 실행 페이지에서 다운로드해야 합니다.

Actions ZIP을 직접 압축 해제한 뒤 **검증 명령 복사**로 본인 PC에서 SHA-256 검사를 수행할 수 있습니다. 정확한 Run ID를 확인한 뒤 선택 입력으로 붙이기를 권장합니다. 이 결과는 파일 무결성만 의미하며, GitHub의 서명 증명이나 스토어 배포·기기 OTA 성공을 의미하지 않습니다. [오프라인 검증 안내](github-native-artifact-integrity.ko.md)를 참고하세요.

## Native Runner 영수증·파일 검증

자체 PC Runner에서 실제 빌드하고 서명된 APK/AAB/IPA의 성공 Job에는 **검증 영수증 JSON 받기** 링크가 표시됩니다. 바이너리는 사용자 PC에 그대로 남으며 Flora에 업로드되지 않습니다. 다운로드한 영수증과 해당 PC의 바이너리를 한 폴더에 두고 [로컬 SHA-256 검증](native-artifact-integrity.ko.md)을 실행합니다. `runnerReported: true`는 Runner 보고이며, 플랫폼 서명이나 실제 기기 OTA 적용을 독립 검증한 것이 아닙니다.
