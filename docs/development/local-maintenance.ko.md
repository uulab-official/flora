# 로컬 빌드 운영 진단 · 검증 백업 · 새 경로 복원

기존 로컬 콘솔의 실행/중지/재시도/다운로드에 운영 진단과 CLI 백업·복원을 추가합니다. Cloudflare Hosted/D1/OTA/서명 키/외부 Provider는 변경하지 않습니다. Linux/macOS의 로컬 소유자 전용 기능입니다.

## 웹에서 선택 앱 진단

콘솔의 **선택 앱 진단**을 누르면 현재 허용된 앱의 원장·산출물만 검사합니다. 요청은 인증 세션, Origin/Host, CSRF, 앱 허용 목록을 확인합니다. 서버는 한 번에 한 진단만 수행하고 5초 간격을 요구합니다. 자동 새로고침은 파일 해시 검사를 실행하지 않습니다.

- 기본 검증 한도: 64 MiB / 1,000개 항목. HTTP 최대: 128 MiB / 2,000개 항목.
- `complete:false`는 불완전한 검사입니다. 정상으로 간주하지 않습니다.
- DB 구조 무결성 검사 자체는 인스턴스 전체이지만, 작업 수·산출물 수·원장 revision·파일 식별자·진단 항목은 선택 앱 범위입니다.
- 실행 중/결과 불명 작업, 원장에 없는 파일, 임시 파일, 누락·변조 파일, 검사 중 원장 변경을 구분합니다.
- 원장에 `running`이 있다고 실제 프로세스 생존을 보증하지 않습니다. `liveProcessVerified:false`이며 서명·기기 설치 검증도 별도입니다.
- 진단 JSON은 해당 앱의 진단 결과만 저장합니다. 실제 저장소 경로·토큰·승인 코드·명령 인자는 포함하지 않습니다.
- 앱 전환/로그아웃 후 늦게 도착한 응답은 버리고 이전 진단 결과도 지웁니다.

더 큰 검사는 PC에서 수행합니다.

```sh
node scripts/artifacts/build-ops.mjs doctor --state-dir /PRIVATE/STATE --app app-a --max-bytes 1073741824 --max-entries 10000
```

CLI에서 `--app`을 생략하면 소유자의 전체 인스턴스를 검사합니다. 파일·잠금을 자동 삭제하거나 실행 상태를 임의 복구하지 않습니다.

## 검증 백업

```sh
node scripts/artifacts/build-ops.mjs backup --state-dir /PRIVATE/STATE --output /PRIVATE/NEW-BACKUP
node scripts/artifacts/build-ops.mjs verify-backup --backup /PRIVATE/NEW-BACKUP
```

두 경로는 절대 경로이며 새 백업의 부모는 현재 사용자 소유의 private 디렉터리여야 합니다. 기존 경로는 덮어쓰지 않습니다. 원본 상태 폴더 내부에는 백업을 만들지 않습니다.

SQLite online backup API로 일관된 DB 복사본을 만든 후, **그 복사본**이 참조하는 파일만 원장 메타데이터와 대조·스트리밍 복사합니다. 살아 있는 DB를 일반 파일 복사로 백업하지 않습니다. 현재 원장이 이후 바뀌어도 백업은 특정 시점의 독립된 복사본이며 최신 상태를 보장하지 않습니다.

승인(`authorized`), 대기(`queued`), 실행(`running`) 작업이 복사본에 있으면 거부합니다. 승인 작업은 미승인으로 되돌리고, 대기 작업은 취소하거나 실제 실행을 종료한 후 다시 백업하세요. `unknown`은 그대로 보존하며 `requiresReconciliation:true`로 보고합니다. 실패/취소 이력·재시도 계보·멱등 요청 기록·감사 기록도 보존합니다.

기본 총 용량은 DB+참조 파일 합계 1 GiB, 최대 설정 16 GiB입니다. DB 자체 상한은 256 MiB입니다. 작업/산출물 수의 기본 상한은 각각 1,000개, 최대 10,000개입니다. `--max-bytes`, `--max-entries`로 지정할 수 있습니다. 한도 초과는 조용한 누락이 아니라 실패입니다.

백업 구조:

```text
NEW-BACKUP/
  .flora-backup
  manifest.json
  builds.sqlite
  artifacts/<appId>/<jobId>/<artifactId>.bin
```

세션·승인 코드·명령 레시피·Runner 잠금·다운로드 임시 폴더·서명 키는 복사하지 않습니다. `.flora-backup`이 있는 폴더는 운영 상태로 직접 열 수 없습니다. 실패하면 이번 호출이 새로 만든 대상만 정리합니다. 프로세스 강제 종료/전원 차단 시 남는 `.flora-incomplete` 표식은 자동으로 제거하지 않으며 검증/운영 열기를 차단합니다.

## 기존 데이터를 건드리지 않는 복원

```sh
node scripts/artifacts/build-ops.mjs restore --backup /PRIVATE/NEW-BACKUP --state-dir /PRIVATE/NEW-STATE
node scripts/artifacts/build-ops.mjs doctor --state-dir /PRIVATE/NEW-STATE
```

복원 전 manifest·DB 해시·SQLite schema/application ID·구조/외래 키 무결성·작업/산출물 연결·파일 크기/해시·정확한 폴더 구조를 검사합니다. 모르는 schema를 자동 마이그레이션하거나 SQL 텍스트를 실행하지 않습니다. 파일/디렉터리 링크, 추가 파일, 누락, 해시 불일치를 거부합니다. digest는 원본 발급자의 신원이나 전자서명을 보증하지 않습니다. **본인이 생성·관리하는 신뢰 가능한 백업만** 사용하세요.

기존 경로로의 복원은 항상 거부됩니다. 새 상태 폴더를 독립적으로 검증한 후 운영자가 별도 콘솔 설정을 검토해 열어야 합니다. 기존 콘솔·Runner를 재연결하거나 빌드를 자동 재개하지 않습니다. 상태 `unknown`도 그대로 남아 자동 재시도가 차단됩니다. 기존 운영 상태와의 병합·자동 failover·in-place 교체 기능이 아닙니다.

## 검증 경계

테스트는 합성 unsigned 파일을 사용합니다. 백업/복원 성공이 APK/IPA 서명·설치·OTA 적용 성공을 뜻하지 않습니다. 현재 사용자와 같은 권한의 악성 프로세스, OS 관리자, 하드웨어 오류까지 방어하는 샌드박스는 아닙니다. private 부모 경로와 원본 checkout/state는 운영자가 통제해야 합니다.

```sh
node scripts/artifacts/run-tests.mjs
```

SQLite 참고: https://www.sqlite.org/backup.html
Node pinned-compatible API: https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html#sqlitebackupsource-db-destination-options
