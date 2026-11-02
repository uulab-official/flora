# Flora 로컬 빌드 운영: 영속 이력·산출물 반입·검증 내보내기

> Historical baseline record for the earlier local-operations patch. The subsequent console/runner integration and its updated verification boundaries are documented in `docs/development/local-build-console.ko.md`. Statements about no HTTP/runner execution or no remote publication below describe that earlier snapshot, not the cumulative feature branch.


## 범위와 상태

PR #15의 메모리 원장과 파일 검증 모듈을 **독립적으로 실행 가능한 로컬 운영 경로**로 연결합니다.
새 런타임 패키지나 클라우드 계정은 필요하지 않습니다. `node:sqlite`와 Node 내장 모듈만 사용합니다.
저장소의 Node 요구사항(`>=24.19.0 <25`)은 변경하지 않습니다.

이 기능이 실제 컴파일러를 실행하거나, 기존 네이티브 Runner에 자동 배포되거나,
Flora 웹 대시보드·Worker/D1에 연결된 것은 아닙니다. 이미 빌드한 파일과 **신뢰하는 로컬
Runner의 실행 보고**를 운영 경로로 반입하는 기능입니다. 호출자는 로컬 OS 계정의 소유자입니다.
공개 HTTP API나 다중 사용자 인증 계층으로 이 모듈을 직접 노출하지 마세요.

| 지원 기능 | 경계 |
| --- | --- |
| SQLite 영속 작업·멱등 응답·감사 이력 | 전용 새 디렉터리. 기존 운영 DB를 지정하지 않음 |
| 프로세스 간 CAS 충돌 방지 | 버전이 바뀌면 실패. 요청을 몰래 재실행하지 않음 |
| 완료 처리와 산출물 메타데이터의 원자적 커밋 | 파일과 DB는 별도 단계이며, 종료 지점에 따라 미등록 파일이 남을 수 있음 |
| 파일 반입·SHA-256 검증·새 파일로 내보내기 | 확장자/format은 선언값이며 APK/AAB/IPA 구조·서명 검사가 아님 |
| 복구 진단 | 불명 상태, 미등록 파일, 임시 파일, 손상 표시. 자동 삭제·자동 재빌드하지 않음 |
| Linux/macOS 소유자 전용 파일 시스템 | Windows ACL 지원 미구현. Windows를 지원한다고 표시하지 않음 |

## 실행

저장소 루트에서 실행합니다. 전용 상위 디렉터리는 자신의 계정이 소유하고, 다른 사용자가
쓸 수 없어야 합니다. 상태·내보내기 디렉터리는 0700을 사용합니다. 경로의 심볼릭 링크는
허용하지 않으므로 macOS의 `/tmp`, `/var` 별칭 대신 `realpath`로 얻은 경로를 사용하세요.

```sh
node scripts/artifacts/build-ops.mjs --help
node scripts/artifacts/run-tests.mjs
# 같은 명령의 package.json 단축키
pnpm run test:artifacts
pnpm run flora:builds --help
```

새 설치만 다음처럼 초기화합니다. `init`를 다시 실행해도 작업을 초기화하거나 삭제하지 않습니다.

```sh
# 아래 경로를 본인이 소유하는, 정규화된 전용 경로로 바꿉니다.
node scripts/artifacts/build-ops.mjs init --state-dir /ABSOLUTE/PRIVATE/flora-builds
```

| 명령 | 추가 옵션 | 결과 |
| --- | --- | --- |
| `create` | `--input job.json` | 불변 앱/작업/저장소/SHA/platform/runner 연결 생성 |
| `transition` | `--input transition.json` | 허용된 상태 전이 및 감사 기록 |
| `complete` | `--input completion.json` | 실행 보고와 파일 검증 후 완료 및 산출물 등록 |
| `list` | `--app ID [--limit 100] [--after-job ID]` | 앱별 작업 페이지 |
| `show` | `--app ID --job ID` | 현재 작업과 산출물 메타데이터 |
| `history` | `--app ID --job ID [--after-sequence 0] [--limit 100]` | 작업별 감사 이력 |
| `export` | `--app ID --job ID --artifact ID --output /ABSOLUTE/PRIVATE/app.apk` | 재검증 후 새 파일로 내보내기 |
| `doctor` | `[--max-bytes 268435456] [--max-entries 1000]` | 제한된 읽기 전용 점검 |

모든 명령에는 `--state-dir /ABSOLUTE/PRIVATE/flora-builds`를 추가합니다. 조회 명령은 경로를
잘못 입력해도 새 원장을 만들지 않습니다. JSON 입력은 최대 64 KiB이며 링크·특수 파일·잘못된
UTF-8·중복/미지원 CLI 옵션을 거부합니다. 정상 JSON 결과에 로컬 절대경로나 임의의 토큰을 넣지 않습니다.

성공은 `{"ok":true,"result":...}` 및 종료 코드 0입니다. 오류는 고정 오류 코드와 종료 코드 1입니다.
`doctor`는 불명 상태·손상·미완료 검사에서도 종료 코드 1을 반환합니다. Node 런타임 자체의 경고는
stderr에 별도로 출력될 수 있습니다.

## 작업과 실행 보고 계약

`create`에 전달하는 `job.json` 예시입니다. 아래 SHA는 예시이며 실제 검증된 소스 SHA로 바꿉니다.

```json
{
  "appId": "sample-app",
  "jobId": "build-001",
  "repository": "owner/private-app",
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "platform": "android",
  "runnerId": "my-mac"
}
```

등록된 연결을 나중에 바꿀 수 없습니다. 재빌드는 **새 jobId**로 등록합니다. 같은 앱/작업 생성 요청은
`BUILD_JOB_ALREADY_EXISTS`를 반환하며 기존 이력을 덮어쓰지 않습니다.

전이 입력 예시: 생성 직후 버전은 0이며, 각 단계는 고유한 32~64자리 소문자 hex 요청 키를 씁니다.

```json
{
  "scope": { "appId": "sample-app", "jobId": "build-001" },
  "expectedVersion": 0,
  "event": {
    "status": "authorized",
    "idempotencyKey": "11111111111111111111111111111111"
  }
}
```

`authorized → queued → running`을 차례로 기록합니다. 같은 요청을 재전송하면 **원래 응답**과
`replayed:true`가 반환됩니다. 현재 상태를 확인하려면 `show`를 사용하세요. 같은 키로 버전이나
의미가 다른 요청을 보내면 `BUILD_IDEMPOTENCY_CONFLICT`입니다. 오래된 버전은
`BUILD_VERSION_CONFLICT`이며, 최신 버전으로 무조건 재실행해서는 안 됩니다.

`complete` 입력에는 다음을 전달합니다.

- `scope`, `expectedVersion`, `idempotencyKey`: 독립적으로 등록한 작업의 연결과 버전.
- `manifest`: 그 작업과 같은 `appId/jobId/repository/sourceSha/platform`, 실제 `byteCount/sha256`.
- `execution`: 같은 5개 연결 필드, 등록된 `runnerId`, 숫자 `exitCode:0`.
- `format`: Android는 `apk` 또는 `aab`, iOS는 `ipa`.
- `sourcePath`: Runner의 통제된 정규 파일 절대경로.

`execution`은 **신뢰하는 Runner 어댑터**가 실제 프로세스 종료 결과에서 만들어야 합니다.
임의 요청 본문에서 `exitCode:0`을 받아 성공 증거로 쓰는 공개 서버 구현은 금지합니다.
이 로컬 모듈은 보고의 연결을 확인할 뿐, 보고 작성자의 정직성이나 원격 실행의 진위를
암호학적으로 입증하지 않습니다. 단순 `transition`의 성공 boolean으로는 완료 처리할 수 없습니다.

`unknown`은 명시적인 상태 확인/동일 작업 실행 보고로만 해소합니다. 불명 상태에서 빌드를
새로 실행하거나, 취소된 작업을 성공으로 바꾸는 동작은 없습니다.

## 파일 저장·내보내기와 복구

파일은 앱/작업별 전용 디렉터리에 저장됩니다. 크기와 digest를 검증하고 같은 열린 파일
디스크립터에서 복사하는 동안 다시 해시를 계산합니다. BigInt 기반 inode/mtime/ctime 및
링크 수를 비교합니다. 내보내기는 같은 파일 시스템의 임시 파일을 동기화한 뒤, 기존 파일을
덮어쓰지 않는 방식으로 게시합니다. 권한 검사와 파일 디스크립터는 같은 UID의 공격자나
악의적인 커널/파일 시스템을 격리하는 샌드박스가 아닙니다.

SQLite 한 트랜잭션에는 작업 버전, 요청 영수증, 감사 이력, 산출물 메타데이터가 함께 들어갑니다.
파일 게시 후 DB 커밋 전에 프로세스가 종료되면 미등록 파일이 남을 수 있지만 성공 작업으로
노출하지 않습니다. 명확히 롤백된 충돌의 임시 결과는 정리하고, I/O 오류로 커밋 결과가
불명확하면 함부로 지우지 않습니다. `doctor`는 원장 참조와 파일을 비교해 이를 알립니다.

`doctor`의 기본 해시 검사 예산은 합계 256 MiB, 원장 목록은 최대 100개 산출물, 디렉터리
항목은 1,000개입니다. 검사 예산·목록 범위를 초과하면 `complete:false`, `ready:false`를 표시합니다.
`--max-bytes`는 최대 2 GiB, `--max-entries`는 최대 10,000까지 지정할 수 있습니다. 대규모 저장소의
페이징 복구·보관 정책/GC는 후속 범위입니다. `ready:true`도 로컬 점검 통과일 뿐 실제 앱 준비 상태가 아닙니다.

최종 필드는 무결성, 코드 서명, 설치를 분리합니다. 현재 `signatureVerified` 및 `installVerified`는
항상 false입니다. 웹 다운로드 토큰/API, 외부 Provider 계정 연결, 실제 앱 서명/설치/OTA 검증은
이 변경에 포함하지 않습니다. 기존 Flora 웹 UI와 실제 PC Runner 연결부는 별도 통합 검증이 필요합니다.

## 검증과 적용 주의

이번 작업은 GitHub 쓰기/푸시 도구가 없는 환경에서 원격 base의 파일 blob을 대조하고,
별도 로컬 작업 공간에서 만든 패치입니다. 원격 커밋/PR 수정/main 병합/운영 배포를 수행하지 않았습니다.
검증 환경은 Linux Node 22.16.0이며, 전체 모노레포가 아닌 해당 경로의 추출 snapshot입니다.
저장소가 요구하는 Node 24.19.0, macOS, 전체 build/typecheck/Hosted Chrome/기기 검증을 대신하지 않습니다.
CI 정의에는 Linux/macOS Node 24.19.0 검증을 추가하지만 실제 실행 결과는 아직 없습니다.

기술 참고: Node 공식 SQLite 및 파일 시스템 문서 (`https://nodejs.org/api/sqlite.html`,
`https://nodejs.org/api/fs.html`).
