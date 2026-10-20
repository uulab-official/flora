# 조직의 앱·키를 승인된 PC에서 함께 사용하기

설치당 하나의 조직을 사용합니다. 기존 관리자는 보호된 Owner로 유지하며, 기존 Owner verifier·세션·Vault 암호문과 AAD·앱 ID·배포·Runner·복구 저널은 교체하지 않습니다. 기존 설치는 `owner_only`에서 시작합니다. 이 문서는 조직 기능을 포함한 버전의 절차이며, 운영 활성화는 별도의 명시적 작업입니다.

## 권한 선택

| 역할 | 앱 범위 | 가능한 작업 |
| --- | --- | --- |
| Owner | 조직 전체 | 멤버·초대·조직 접근, GitHub 계정 연결·저장소 교체, 공유 Runner, 모든 앱 관리 |
| 관리 | 명시적으로 할당된 앱 | 앱 설정·키 등록/교체, 배포·빌드, 다른 사람의 PC 승인 |
| 배포 | 명시적으로 할당된 앱 | OTA·빌드·롤백, 개인 PC 요청·본인 요청 수령 |
| 조회 | 명시적으로 할당된 앱 | 상태·배포 이력·키 등록 여부 |

기본 앱 범위는 비어 있습니다. 관리자는 자신이 요청한 PC를 스스로 승인할 수 없고, Owner만 본인 확인 후 자신의 요청을 승인할 수 있습니다. 새 PC 등록은 하드웨어 신원 증명이 아닌 논리적인 서비스 토큰 승인입니다. 키 원문·공급자 비밀번호·조직 공용 토큰 내보내기는 제공하지 않습니다.

## 기존 설치를 안전하게 활성화

1. 원래 설치 식별자·키 버전·배포 및 복구 저널을 보존한 상태에서 조직 기능 버전을 먼저 `owner_only`로 배포합니다. `0014_org_runner_access.sql`은 새 제어 표·guard만 추가하며, 적용만으로 팀 접근을 활성화하지 않습니다.
2. **계정 보안**에서 기존 비밀번호로 본인 확인을 진행합니다. **조직 · 멤버**에서 기존 Runner 보존하며 준비를 선택합니다.
3. D1 `blocked` barrier 확인 후 OTA/native 자격을 50개 단위로 대조합니다. 화면의 다음 대조 단계 확인을 명시적으로 누릅니다. 응답이 유실되면 최신 상태를 조회하며 새 토큰을 발급하지 않습니다.
4. 모든 페이지 대조 및 영구 `ledger_only` gate 확인 뒤 팀 접근 활성화를 선택합니다. 기존 토큰·epoch·lease를 새로 만들지 않습니다. 확인 불가 상태에서는 준비 중으로 남습니다.
5. 같은 앱의 제한된 계정으로 권한과 기존 자동화를 확인합니다. 별도 실제 게시/서명 검증 없이 운영 OTA를 임의로 바꾸지 않습니다.

배포 후보의 `packages/cloudflare/dist/authz-protocol.json`을 기존 org-aware 서버와 대조합니다. 세션 cookie는 CLI 인수·환경변수·파일·로그에 넣지 않고 최대 16 KiB stdin JSON 한 줄로 메모리에만 전달합니다. 명령은 아래 형식이며, 실제 cookie 입력은 로컬의 비표시 입력 수단으로 준비합니다.

```sh
node scripts/org-access/preflight.mjs \
  --origin https://flora.example.com \
  --artifact /absolute/flora/packages/cloudflare/dist/authz-protocol.json \
  --ledger /absolute/private/org-checkpoints
```

stdin의 키는 `sessionCookie` 하나입니다. 외부 원장은 별도 `0700` 디렉터리와 변경 불가능한 `0600` 체크포인트 파일을 사용합니다. 기존 설치/Runner 원장과 같은 디렉터리를 사용하지 마세요. API가 없거나 protocol·identity·revision·회수 epoch·감사 sequence가 미확정/과거이면 배포 검증은 실패합니다. 최초 org-aware 배포 이전에 API가 없다는 사실을 안전의 증거로 쓰지 않습니다.

## 팀원 추가와 새 PC의 OTA 연결

1. Owner가 **조직 · 멤버**에서 이메일·역할·사용할 앱을 명시하고 일회 초대 링크를 만듭니다. 링크는 별도의 안전한 경로로 전달합니다. Flora가 이메일을 자동 발송하지는 않습니다.
2. 팀원은 링크의 `/join` 화면에서 본인 이메일과 새 비밀번호를 입력합니다. 코드는 fragment에서 메모리로 옮긴 뒤 주소에서 지우며, 브라우저 저장소에 쓰지 않습니다. 초대/재활성화는 24시간, 재설정은 15분입니다. 응답이 유실되면 일반 로그인으로 이미 등록됐는지 확인합니다.
3. 새 PC에서 로그인하고 앱의 **PC Runner → 내 PC에서 기존 자산 사용**에서 이름·OTA·플랫폼을 선택해 요청합니다.
4. 해당 앱 관리자 또는 Owner가 본인 확인 후 승인합니다. 요청은 24시간, 승인 후 수령은 10분입니다. 요청자 본인이 한 번만 토큰을 수령합니다.
5. 같은 화면에서 **공개 PC 연결 파일 다운로드**로 `flora.runner-binding.json`을 저장하고, 앱의 기존 공개 `flora.connection.json`을 준비합니다. 공개 binding에는 서버·앱·Runner ID만 있고 토큰은 없습니다. 토큰은 비공개 설정을 위한 CLI의 비표시 입력에만 붙여 넣습니다.
6. 새 PC의 별도 Flora checkout을 설치·빌드하고 Docker를 준비한 뒤 다음을 실행합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup runner
# 공개 binding 절대 경로 → 공개 connection 절대 경로 → 새 private 디렉터리
# Docker 도구 이미지 확인 → 이 PC의 일회 OTA token을 비표시 입력
npm exec --yes --package=pnpm@11.19.0 -- pnpm --silent flora doctor \
  --runner-service /absolute/private-runner/service.json --strict --json
```

`setup runner`는 root가 아닌 macOS/Linux 사용자·로컬 Docker 소켓·2 GiB 이상 여유 공간을 확인합니다. 웹 세션·비밀번호·OAuth credential을 CLI로 옮기지 않습니다. 새 디렉터리는 `0700`, token이 있는 설정은 `0600`입니다. 다른 PC의 private Runner 설정·토큰을 복사하지 마세요. 각 PC를 별도로 승인하며 기존 앱의 키를 재업로드하지 않습니다.

`doctor`는 읽기 전용이며 서버 요청·서비스 설치·재시작을 하지 않습니다. presence는 연결 증거이고 export/게시/기기 적용 성공 증거가 아닙니다. 설치 CLI는 새 OS 자동 시작 서비스를 설치하지 않습니다. 검토된 일반 Runner 서비스 설치 방법과 기존 서비스를 구분하세요.

## 네이티브 빌드는 별도로 연결

OTA binding/`runner.json`과 네이티브 `NativeConfig`는 서로 다른 형식과 토큰입니다. 앱·플랫폼별 **네이티브 빌드·서명** PC 요청을 승인받고, 각 새 token을 새 비공개 `0600` native JSON에 입력합니다. `NativeConfig`의 필수 필드는 서버 origin·token·appId·platform·sourceDirectory·artifactDirectory·expectedCertificateSha256·tools이며, iOS workspace/scheme/appName 또는 Android directory/apkPath와 해당 서명 도구가 필요합니다.

네이티브 컨트롤러는 현재 macOS sandbox 격리·신뢰한 Git checkout·대응하는 Xcode/Android SDK/서명 도구가 필요합니다. 기존 [네이티브 빌드·서명 안내](native-build-signing.ko.md)와 `packages/ota-runner/src/native-controller.ts`의 `readNativeConfig` 검증을 따릅니다. 이 단계에서 다른 PC용 OS 자동 시작을 일반화하지 않습니다. UULab 경로가 고정된 `native-service.mjs`를 다른 사람의 PC 자동 설정으로 실행하지 마세요.

```sh
node packages/ota-runner/dist/native-main.js --daemon \
  --config /absolute/private/native-android.json
```

키는 승인된 작업의 현재 앱·플랫폼·lease·키 버전 검사 후에만 전달합니다. OTA token으로 native 키를 요청할 수 없고, APNs/FCM/스토어 제출 키는 네이티브 서명 경로에 전달하지 않습니다. 각 PC에는 빌드 도구가 필요하지만 같은 앱의 키를 다시 등록할 필요는 없습니다.

## 중지·회수·복구

| 고정 CLI 코드 | 다음 조치 |
| --- | --- |
| `SETUP_RUNNER_ACCESS_DENIED` | 웹의 본인 계정·앱 범위·PC 승인 상태 확인 |
| `SETUP_RUNNER_ACCESS_REVOKED` | 기존 토큰이 살아난다고 가정하지 않고 명시적인 새 PC 승인 요청 |
| `SETUP_ORG_ACCESS_NOT_ACTIVE` | Owner에게 준비/팀 접근 중지 상태 확인 |
| `SETUP_RUNNER_ACCESS_NOT_READY` | 발급·회수의 확인 대기 이력을 조회하고 토큰·복구 저널 보존 |
| `SETUP_RUNNER_UNAVAILABLE` | 네트워크와 웹 상태 확인. 원시 공급자 오류·키는 출력하지 않음 |

웹 로그아웃이나 세션 만료만으로 PC가 중지되지는 않습니다. 요청자/승인자의 권한·비밀번호·활성 상태 변경, PC 해제, 조직 중지는 개인 PC의 후속 접근을 차단합니다. 권한 재부여나 팀 접근 재개만으로 예전 token/승인이 되살아나지 않습니다. 기존 조직 Runner·서명된 webhook·자동 롤백은 사람의 로그인 세션에 의존하지 않습니다.

응답 유실은 **확인 대기**이며 토큰 재조회·자동 재발급·게시 재생으로 해결하지 않습니다. 이미 제출된 작업 결과는 사실대로 기록합니다. 로컬 `fatal-stop`·`recovery`·설치 원장은 지우지 않고, 기존 설정을 재사용할 때 바이트/모드/해시를 검증합니다.

문제 시 org-aware **paused**로 팀원과 개인 PC를 닫습니다. 이전 비조직 바이너리로 돌아가거나 키를 재발급하지 않습니다. 오래된 백업은 공개 인증을 오프라인으로 두고 기존 설치 generation/identity와 최신 외부 회수 체크포인트를 먼저 대조합니다. 이 원장은 자동 백업/복원 엔진이 아니며, 임의로 옛 서버를 직접 배포하는 운영자의 행위까지 차단한다고 보장하지 않습니다.

## 검증 범위

합성 계정·앱 3개·한 PC의 독립 private 환경 두 개는 조직/앱/토큰 격리의 로컬 증거입니다. 실제로 다른 PC 두 대, 제공자 권한, 실제 서명 빌드·기기 적용·스토어 제출은 각각 별도 증거가 필요합니다. EAS·GitHub Actions 없이 검증하며 기존 운영 설치나 제공자 권한을 자동으로 변경하지 않습니다.

### 로컬 통합 검증을 재현하기

Node 24.19.0과 pnpm 11.19.0을 사용합니다. 새 clone에서는 별도 저장소로 고정 설치를 먼저 수행합니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts --store-dir /absolute/private/flora-pnpm-store
pnpm check
node --test scripts/org-access/preflight.test.mjs scripts/org-access/ui-qa.test.mjs \
  scripts/local-runner/supervisor.test.mjs scripts/local-runner/health.test.mjs
```

`tests/organization-e2e.test.ts`는 로컬 workerd/D1과 실제 HTTP 인증으로 세 앱의 역할 범위, 독립 PC 두 개, 한 번만 가능한 수령, OTA/native 토큰 분리, 승인자 접근 회수, 재설정·재활성화를 검사합니다. 네이티브 키 전달은 합성 암호문과 실제 lease 검사를 사용하며 공급자의 빌드 성공을 대신하지 않습니다.

`packages/cloudflare/test/org-preservation.test.ts`는 실제 전환·중지·재개 전후에 기존 DO/D1 업무 행의 해시를 비교합니다. 기존 Owner 인증, Vault 암호문, OTA 서명 자산과 원래 Runner 행을 포함합니다. 별도 설치의 같은 앱 ID와 Owner 이메일에도 다른 설치의 세션·토큰을 사용할 수 없는지 확인합니다. 공급자 내부 메타데이터는 업무 행 보존 비교에서 제외합니다.

회수와 await 경계·응답 유실은 `org-service-authority`, `org-runner-registration`, `org-migration`, `org-runner-gate` 테스트가 추가로 검사합니다. UI 검증은 별도 합성 상태를 사용하며 운영 초대나 실제 비밀키를 만들지 않습니다. 이 검증을 통과해도 운영 서버의 팀 접근이 자동으로 활성화되지는 않습니다.
