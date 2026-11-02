# Flora 로컬 빌드 콘솔과 실행 Runner

범위: 기존 local build operations 패치 위에 연결한 **단일 로컬 소유자용** UI/API/실행 경로입니다. 운영 Cloudflare UI, D1, 기존 Flora Runner 제어 루프, OTA, 서명 도구, 외부 Provider 계정에는 연결하지 않습니다. UI는 합성 데이터로 렌더링 검증했고, HTTP 서버와 실제 하위 프로세스 통합은 별도 테스트했습니다.

## 1. 준비

Node 24.19.0 및 macOS/Linux를 대상으로 합니다. 이 변경 작성 환경에서 실제 실행한 버전은 Linux Node 22.16.0입니다. Node 24.19와 macOS 실행 결과는 아직 없습니다. Windows는 POSIX 권한·프로세스 그룹 정책 때문에 지원 완료로 표시하지 않습니다.

각 명령은 저장소 루트에서 실행합니다. 상태 폴더의 부모는 본인 소유의 0700 디렉터리여야 합니다. 기존 상태를 초기화하거나 삭제하지 마세요.

```sh
mkdir -m 700 "$HOME/flora-local"
node scripts/artifacts/build-ops.mjs init --state-dir "$HOME/flora-local/state"
node scripts/artifacts/build-console.mjs --state-dir "$HOME/flora-local/state" --apps app-a,app-b
```

시작 출력의 `origin`을 브라우저에서 열고 `approvalFile`을 로컬 편집기로 열어 승인 코드를 입력합니다. 코드를 URL·Git·메신저에 넣지 않습니다. 승인 코드는 10분/1회용이며 실패 5회 후 재시작이 필요합니다. 세션은 고정 30분, 로그아웃·서버 종료 시 다운로드 권한도 철회됩니다. 종료하면 승인 코드 파일을 제거합니다. 크래시로 남은 파일의 코드는 해당 프로세스 종료 후 쓸 수 없습니다.

## 2. 작업 등록과 대기열

웹에서 앱을 선택하고 작업 ID, 저장소(owner/repo), 40자리 커밋 SHA, 플랫폼, Runner ID를 등록합니다. 세부 정보를 확인해 승인하고 대기열에 넣습니다. 이 동작만으로 컴파일을 시작하지 않습니다. 앱 목록은 시작할 때 지정한 허용 목록입니다. 이 목록은 로컬 capability 경계이며 서로 다른 사용자 간 SaaS 인증 모델이 아닙니다.

실행 중인 작업의 취소 버튼은 제공하지 않습니다. 실제 프로세스를 종료하지 않고 취소됐다고 기록하면 안 되기 때문입니다. 대기 작업만 웹에서 취소할 수 있습니다. 실행 중 중지는 Runner의 Ctrl-C/SIGTERM으로 수행합니다.

## 3. 신뢰하는 로컬 빌드 명령 실행

**자신이 검토한 앱 저장소만 실행하세요.** 이 Runner는 샌드박스가 아니며 빌드 스크립트가 로컬 사용자 권한으로 파일·네트워크에 접근할 수 있습니다. 레시피는 서버의 입력이 아니라 운영자가 로컬 파일로 작성합니다. 레시피 파일은 앱 checkout 바깥의 전용 디렉터리에 둡니다.

```json
{
  "appId": "app-a",
  "repository": "owner/my-app",
  "runnerId": "mac-local",
  "platform": "android",
  "cwd": "/ABSOLUTE/PRIVATE/CHECKOUT",
  "executable": "/ABSOLUTE/PATH/TO/node",
  "args": ["scripts/build-preview.mjs"],
  "artifactPath": "/ABSOLUTE/PRIVATE/CHECKOUT/build/preview.apk",
  "format": "apk",
  "timeoutMs": 600000,
  "gitExecutable": "/usr/bin/git"
}
```

`build-preview.mjs`는 **앱이 직접 관리하는 실제 빌드 스크립트**입니다. 위 예제에 해당 스크립트나 서명 자격 증명이 포함되어 있지 않습니다. Gradle/Xcode 등 로컬 도구를 직접 지정할 수도 있습니다. macOS에서 본인의 실제 Git 경로를 확인하세요. 파일 형식은 android=apk/aab, ios=ipa입니다.

```sh
node scripts/artifacts/local-build-runner.mjs \
  --state-dir "$HOME/flora-local/state" \
  --app app-a --job android-preview-001 \
  --recipe "$HOME/flora-local/android-recipe.json" --execute
```

실행 조건: 큐 상태, 앱/저장소/Runner/플랫폼 바인딩, Git HEAD 일치, 실행 전 tracked/untracked 변경 없음, 기존 출력 파일 없음. 실행 후 tracked 변경과 HEAD를 재확인합니다. ignored 파일·의존성·도구 체인 전체의 재현성을 입증하는 hermetic build는 아닙니다. 이미 있는 출력물은 자동 삭제하지 않습니다.

명령은 shell 없이 argv 배열로 실행합니다. 일반 환경변수·API 토큰은 전달하지 않으며 PATH/HOME/LANG 및 지정된 Java/Android/Gradle/Xcode 경로만 전달합니다. PATH/HOME에 접근 가능한 로컬 자격 증명까지 격리하는 샌드박스는 아닙니다. stdout/stderr 원문은 저장·노출하지 않고 합계 256KiB를 넘으면 중지합니다. 시간 제한은 100ms~1시간입니다. 중지 요청 시 프로세스 그룹에 TERM, 이후 KILL을 보내며 새 세션으로 탈출한 프로세스를 통제한다고 보장하지 않습니다.

동일 상태 저장소의 동일 checkout에는 한 Runner만 실행됩니다. 비정상 강제 종료가 남긴 `.runner-lock-*.lock`은 자동 삭제하지 않습니다. 해당 PID와 실제 프로세스, 원장 상태를 확인한 뒤 수동 복구하세요. **여러 상태 디렉터리에서 같은 checkout을 공유하지 마세요.**

정상 종료+새 산출물+해시 검증 후에만 `succeeded`로 기록합니다. 컴파일 종료 0이어도 파일이 없거나 게시 결과가 불명확하면 `unknown`으로 남기며 자동 재실행하지 않습니다. 원장에 보존된 진단 코드와 원본 파일을 확인해 이전 complete 명령으로 명시적으로 조정합니다. SHA 일치는 코드 서명·실기기 설치·OTA 적용 성공을 의미하지 않습니다.

## 4. 다운로드와 이력

웹에서 목록/상세/감사 이력을 페이지 단위로 확인합니다. 검색·상태 필터·요약 숫자는 현재 페이지 기준입니다. 다운로드는 서버에 바인딩된 60초/1회용 티켓을 **POST 본문**으로 전달합니다. 비밀값은 URL이나 localStorage에 저장하지 않습니다.

출처·Host·세션·CSRF·앱 범위를 검사한 뒤 별도 비공개 staging 파일에 검증 복사하고 열린 파일로 전송합니다. 중단·실패 후에는 새 티켓이 필요하며 Range/이어받기는 지원하지 않습니다. 기본 한도는 활성 다운로드 2개, 미사용 티켓 128개, 각 파일 최대 2GiB입니다. 브라우저는 파일을 받는 네이티브 form POST를 사용하므로 전체 바이너리를 JS 메모리에 적재하지 않습니다. 오류 발생 시 새 탭에 정제된 오류 코드가 표시될 수 있습니다.

다운로드 후 브라우저가 저장한 파일을 표시된 SHA-256과 비교하세요. 서버는 사용자 다운로드 완료나 기기 설치를 자동 확인하지 않습니다. 프로세스 강제 종료로 남은 `console-download-*` 폴더는 자동 정리하지 않으며 활성 전송이 없음을 확인한 후 수동 정리합니다.

## 5. 보안과 배포 경계

- 127.0.0.1만 바인딩합니다. Tunnel, reverse proxy, 외부 hostname, 공유 호스트용으로 노출하지 마세요.
- HTTP loopback이므로 cookie의 Secure 속성을 사용하지 않습니다. HttpOnly/SameSite=Strict 및 별도 CSRF·Origin·Host 검사로 로컬 브라우저 경계를 둡니다. 같은 OS 소유자의 악성 프로세스는 방어 범위 밖입니다.
- 웹 API는 임의 명령, 파일 경로, 가짜 completion 보고, Provider 토큰을 받지 않습니다.
- 오류 응답에 스택·로컬 절대경로·원문 빌드 로그를 보내지 않습니다.
- 리소스 정리나 불명확한 작업을 성공으로 전환하는 자동 조치는 없습니다.

## 6. 검증

```sh
node scripts/artifacts/run-tests.mjs
```

검증 기록에는 전체 관련 테스트의 통과 수, 실제 프로세스 실행, 네트워크 HTTP 테스트, 오프라인 합성 UI 렌더링을 분리해 기록합니다. 브라우저가 실제 로컬 URL을 여는 검사는 환경의 관리자 URL 차단으로 진행하지 못했습니다. 샌드박스나 관리자 정책을 낮추지 않았습니다. 전체 모노레포 build/typecheck, Node 24.19/macOS CI, 실제 APK/IPA 서명·설치, OTA는 별도 릴리스 게이트입니다.

참조: Node 공식 HTTP/child_process 문서와 MDN Sec-Fetch-Site 문서를 확인했습니다. 패키지 의존성은 추가하지 않았습니다.
