# 네이티브 산출물 조회·검사·내보내기

기존 native Runner가 기록한 APK/IPA (호환 형식으로 AAB 포함)를 로컬에서 확인하는 명령입니다. 빌드·서명·업로드 명령이 아닙니다. 서버 요청, 자격 증명 발급, 자동 재실행 또는 복구 파일 삭제를 하지 않습니다.

## 실행

전체 저장소에서 고정 도구체인으로 `pnpm build` 후:

```sh
pnpm flora:native --config /absolute/private/native.json --artifacts
pnpm flora:native --config /absolute/private/native.json --inspect native_job_example.apk
pnpm flora:native --config /absolute/private/native.json --export native_job_example.apk --output /absolute/private/exports/release.apk
```

한 번에 설정 파일 하나만 지정합니다. `--help`와 잘못된 옵션은 설정을 읽기 전에 처리됩니다. 기존 설정 reader가 파일과 도구 경로를 검사하므로 검토한 native 설정을 사용하세요. Python runtime 조회는 기존 reader가 수행하지만 Git·Gradle·Xcode·서명 도구는 실행하지 않습니다. 원래 daemon/--job 동작은 유지됩니다.

`--artifacts`는 로컬 기록 목록, `.pending` 항목 수, 중단 작업 디렉터리 수, 손상·누락·다른 앱/플랫폼/인증서 기록과 검사 한도를 표시합니다. 미확인 기록이 있어도 조회할 수 있습니다. `recoveryRequired`가 true이면 JSON을 stdout으로 출력하고 exit1을 반환합니다. 이 값은 관측된 주의 항목이지 서버 확인이나 실행 잠금이 아닙니다. 목록 전체가 깨끗하다고 빌드를 새로 승인하지 않습니다.

`--inspect`는 선택 파일의 크기와 SHA-256을 현재 다시 검사합니다. `--export`는 같은 열린 원본을 읽어 비공개 임시 파일에 복사하고 검사를 통과해야 새 파일로 게시합니다. 두 명령은 완료 확인을 기록한 같은 앱·플랫폼·파일명·작업 ID·등록 인증서 지문의 receipt만 받습니다. 다른 작업의 `.pending` 때문에 이미 확인된 별도 산출물을 읽지 못하게 하지는 않습니다.

## 표시의 의미

- `completionRecorded`: 과거 로컬 receipt에 완료 확인이 기록되어 있음. 현재 서버 상태나 서명된 원격 증명 아님.
- 목록의 `integrityVerified:false`: 목록은 바이너리 해시를 계산하지 않음. 크기·파일 안전성만 확인하며 문제는 issues에 표시.
- 검사·내보내기의 `integrityVerified:true`: 해당 작업 중 읽은 바이트의 SHA-256/크기를 receipt와 비교했음.
- `signatureRechecked:false`, `installVerified:false`, `remoteRechecked:false`: codesign/apksigner/JDK 서명 재검사, 기기 설치, 원격 완료 재확인은 수행하지 않았음.

receipt·config를 함께 고칠 수 있는 같은 OS 사용자에 대한 변조 방지/인증 체계는 아닙니다. 기존 public 인증서 pin은 별도로 신뢰해야 합니다. 인증서가 회전한 과거 결과는 해당 과거 pin을 보존한 검토된 설정으로 확인해야 하며 현재 설정의 pin을 임의로 낮추지 마세요. 앱 번들 형식/스토어 승인/안전한 앱 코드라는 보증도 아닙니다.

## 파일 보호와 한도

POSIX(Linux/macOS)용 기능입니다. Windows에서는 `NATIVE_ARTIFACT_PLATFORM_UNSUPPORTED`로 거부하며 ACL을 확인했다고 표시하지 않습니다. 저장 디렉터리·내보내기 부모는 이미 존재하는 현재 사용자 소유 canonical0700 경로, receipt·결과 파일은0600 정규 파일이어야 합니다. 링크·FIFO·다른 사용자 파일은 거부합니다. 자동 mkdir/chmod/원본 수정은 없습니다. 부모 경로를 다른 프로세스가 바꾸는 동일 OS 사용자에 대한 완전한 샌드박스는 아닙니다.

receipt128KiB, 파일512MiB, 목록 디렉터리1024항목/receipt200개 한도를 적용합니다. 초과 또는 목록 중 상태 변경은 `truncated`/`snapshotChanged`로 표시하고 주의 상태를 유지합니다. 목록 한도를 넘어도 정확한 파일명으로 개별 검사할 수 있습니다. 바이너리는64KiB 단위로 처리하고 검사 루프의120초 예산을 확인합니다. 멈춘 커널 파일시스템 호출을 강제로 선점하는 기능은 아닙니다.

내보내기 부모는 저장소 밖의 전용 비공개 디렉터리여야 하며 확장자를 바꿀 수 없습니다. 기존 대상과 dangling symlink도 덮어쓰지 않습니다. 임시 파일은 배타적으로 만들고 inode를 확인하여 다른 파일을 대신 게시하거나 삭제하지 않도록 합니다. 무결성을 확인한 복사본을 같은 부모에 no-replace link로 게시하고 디렉터리를 동기화합니다. 게시 전 취소는 소유한 임시 파일만 정리합니다. 게시 후 장애는 `NATIVE_EXPORT_UNCONFIRMED`로 표시하고 존재할 수 있는 결과를 자동 삭제하거나 재전송하지 않습니다. SIGKILL/파일시스템 장애로 임시 파일이 남을 수 있습니다.

공개 JSON에는 token, 설정·출력 절대경로, receipt 원문, lease 원문, entitlements를 넣지 않습니다. 기존 복구 gate/controller를 변경하거나 운영 Worker/D1/OTA를 배포하지 않습니다.

## 검증

새 테스트는 합성 바이트와 명시적 로컬 receipt를 사용합니다. 실제 APK/IPA 서명·기기·스토어 검증이 아닙니다. 전용 CI는 기존90개 통신/세션, 기존 controller HTTP2개, 종료 CLI9개 외에 새 파일/명령/CLI 검사를 실행합니다. Windows에서는 POSIX 검사만 건너뛰며 명시적 거부/파서 검사는 유지합니다. 전체 회귀는 `pnpm check`, 로컬 빌드 산출물 회귀는 `node scripts/artifacts/run-tests.mjs`입니다.
