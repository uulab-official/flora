# 로컬 빌드 실행·중지·재시도

기존 로컬 콘솔의 별도 실행 단계에 **검토한 preset 기반 웹 실행**을 추가합니다. 기본값은 실행 비활성입니다. Cloudflare Hosted UI나 기존 OTA Runner를 교체하지 않습니다.

## 사전 조건

Linux/macOS, 프로젝트의 Node 24.19.0, 이미 초기화된 private 상태 디렉터리, 본인이 검토한 Git checkout이 필요합니다. Windows 파일 권한/프로세스 제어는 지원하지 않습니다. Runner는 OS·네트워크·파일 자격 증명을 격리하는 샌드박스가 아니므로 외부의 신뢰하지 않는 저장소를 실행하지 마세요.

다음은 자신의 경로로 수정하는 예시입니다. `.git`의 HEAD가 작업에 등록한 40자리 sourceSha와 같아야 하며, 커밋되지 않은 파일과 기존 산출물을 자동 삭제하지 않습니다. Android preview 예시는 서명 준비나 스토어 제출을 보장하지 않습니다.

```json
{
  "presets": [{
    "id": "android-preview",
    "label": "Android preview APK",
    "recipe": {
      "appId": "app-a",
      "repository": "owner/private-app",
      "runnerId": "my-mac",
      "platform": "android",
      "cwd": "/ABSOLUTE/REVIEWED/CHECKOUT",
      "executable": "/ABSOLUTE/PINNED/NODE/bin/node",
      "args": ["scripts/build-preview.cjs"],
      "artifactPath": "/ABSOLUTE/REVIEWED/CHECKOUT/output/preview.apk",
      "format": "apk",
      "timeoutMs": 600000
    }
  }]
}
```

설정 파일과 부모 디렉터리는 본인 소유의 private 경로여야 합니다(파일 0600, 부모 0700). 실제 경로의 권한을 먼저 확인하고, 공유 디렉터리나 다른 사용자의 권한을 일괄 변경하지 마세요. 소유자 명령이므로 레시피에는 비밀 토큰을 넣지 않습니다. 설정은 시작 시 한 번 읽고 복사하며 웹에서 수정할 수 없습니다.

```sh
# 조회/작업 준비/다운로드: 프로세스 실행 비활성(기존 기본값)
node scripts/artifacts/build-console.mjs --state-dir /PRIVATE/STATE --apps app-a

# 본인이 설정을 검토한 뒤 선택적으로 활성화
node scripts/artifacts/build-console.mjs --state-dir /PRIVATE/STATE --apps app-a \
  --enable-execution --presets /PRIVATE/CONFIG/presets.json --max-concurrent 1
```

출력된 origin에서 일회용 승인 코드 파일의 값을 입력합니다. URL에 코드나 토큰을 넣지 않습니다. 세션은 기존과 같이 30분이며, 로그아웃은 실행 중인 빌드를 취소하지 않습니다. 서버 정상 종료는 자신이 관리하는 빌드를 중지하고 종료 결과를 기다립니다.

## 화면 사용 흐름

1. 앱·작업을 등록하고 source SHA·플랫폼·Runner를 검토한 뒤 승인/대기열에 등록합니다.
2. 일치하는 preset을 선택해 **빌드 실행 → 확인하고 실행**을 누릅니다. HTTP는 preset ID와 작업 버전·요청 키만 받습니다. executable/argv/cwd/파일 경로는 받지 않습니다.
3. 실행 중 **실행 중지 요청**은 이 콘솔이 관리하는 프로세스에만 적용합니다. 중지 요청과 취소 완료를 구분하고 실제 프로세스가 끝난 후 원장에 기록합니다. 완료가 먼저 확정되는 경합에서는 성공 상태를 취소로 덮어쓰지 않습니다.
4. 실패·취소된 작업의 **새 작업으로 다시 준비**는 동일 source SHA·repository·platform·Runner로 새 미승인 작업을 만듭니다. 원본 이력은 보존하고 새 작업에 parentJobId를 남깁니다. 다시 승인해야 하며 자동 실행하지 않습니다. running/unknown/succeeded 작업은 이 경로로 재시도할 수 없습니다.
5. 완료 파일은 기존 단일 사용 티켓·무결성 검증 다운로드 경로를 사용합니다. 파일 해시 확인은 코드 서명·설치 성공이 아닙니다.

앱 전체 통계와 전체 작업 검색/상태 필터를 지원합니다. 목록은 cursor pagination이며 검색어나 상태를 바꾸면 첫 페이지부터 조회합니다. 통계는 필터링한 페이지 개수가 아니라 선택 앱 전체 기준입니다.

## 실패와 재시작

- `BUILD_SOURCE_DIRTY`: 본인의 미커밋·미추적 파일을 보존/정리한 뒤 재확인합니다. 자동 stash/reset/clean은 없습니다.
- `BUILD_SOURCE_SHA_MISMATCH`: 등록한 SHA와 체크아웃을 맞춥니다. 원본 작업의 불변 sourceSha를 덮어쓰지 않습니다.
- `BUILD_OUTPUT_EXISTS`: 기존 출력물을 별도로 보존하고 PC에서 정리합니다. 웹에서 삭제하지 않습니다.
- `BUILD_RUNNER_NOT_MANAGED`: 다른 CLI/콘솔이 실행한 작업입니다. PID만으로 추정해 중지하지 않습니다.
- `BUILD_RESULT_RECONCILIATION_REQUIRED`: 실행 결과를 직접 확인합니다. unknown 상태를 자동 재시도하지 않습니다.

시작 요청의 중복 응답 캐시는 콘솔 프로세스 안에서 최대 256개이며, 동시 실행은 1~4개입니다. **영속 실행 큐나 상시 daemon이 아닙니다.** SQLite의 queued→running 버전 비교가 실제 중복 실행을 막습니다. 재시작 시 이전 작업을 자동 실행/재시도하지 않습니다. 시작 전 실패 원인의 화면 표시와 활성 프로세스 제어권은 프로세스 메모리에 있고, 확정된 작업 상태·원장·실패 진단·재시도 계보는 DB에 보존됩니다. 강제 종료 후 남은 잠금은 자동 삭제하지 않습니다.

## API / CLI

기존 loopback/Host/Origin/세션/CSRF/앱 허용 목록을 모두 적용합니다.

- `GET /api/presets?app=...`: 경로/argv 없는 허용 설정 요약
- `GET /api/overview?app=...`: 앱 전체 상태·산출물 수·바이트 합계
- `GET /api/jobs?app=...&search=...&status=...&after=...&limit=25`
- `POST /api/jobs/:app/:job/execute`: presetId, expectedVersion, idempotencyKey
- `GET /api/jobs/:app/:job/execution`: 관리 중 실행 상태(재시작 후 null 가능)
- `POST /api/jobs/:app/:job/stop`: expectedVersion
- `POST /api/jobs/:app/:job/retry`: newJobId, expectedVersion, idempotencyKey

`build-ops.mjs retry --input /PRIVATE/retry.json`와 `overview --app app-a`도 제공하며 항상 `--state-dir`를 지정합니다. 재시도 입력의 scope는 기존 앱/작업을 가리켜야 합니다. source/Runner 변경은 허용하지 않습니다.

## 검증 경계

합성 파일을 만드는 실제 Node 하위 프로세스로 HTTP 실행→DB 완료→다운로드, 취소/서버 종료, 중복 요청, 두 앱 격리, 재시도 재시작과 검색을 시험했습니다. Gradle/Xcode 빌드·서명·기기 설치·OTA/rollback 및 외부 Provider 계정 실행은 별도 검증입니다. 라이브 브라우저 localhost 탐색은 관리자 URL 정책으로 차단되었으며, 합성 응답을 넣은 화면 컴포넌트 검사와 혼동하지 않습니다.
