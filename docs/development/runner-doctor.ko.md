# PC Runner 자가진단과 복구 순서

Runner가 오프라인으로 보이면 먼저 PC의 로컬 준비 상태를 확인합니다. 이 진단은 macOS/Linux의 기존 서비스 설정과 로컬 Unix Docker 소켓을 대상으로 합니다. 설정·복구 저널·프로세스를 변경하거나 클라우드에 요청하지 않습니다.

Flora 저장소에서 Node 24.19.0과 고정 pnpm으로 설치·빌드한 뒤 실행합니다. 예시 경로는 자신의 private 서비스 파일 절대 경로로 바꿉니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --silent flora doctor --runner-service /absolute/private-runner/service.json --strict --json
```

`--silent`는 pnpm이 서비스 파일 경로를 포함한 명령을 다시 출력하지 않게 합니다. 진단 결과에는 토큰·키·원문 경로·로그를 넣지 않습니다. 비밀 설정 파일이나 원본 로그를 공개 이슈에 첨부하지 마세요.

## 결과 읽기

- `readiness.ready`: Node·pnpm·Git과 선택한 Runner 검사가 모두 통과했는지 나타냅니다.
- `runner.ready`: 아래 로컬 Runner 검사만 통과했는지 나타냅니다.
- `runner.checks.runners[].runnerIndex`: private `service.json`의 `runnerConfigs` 순서에 대응하는 0부터 시작하는 번호입니다. 앱별 설정과 저널을 바꾸어 연결하지 마세요.
- `readiness.issues`: 고정 오류 코드, 복구 안내, 해당하는 경우 `runnerIndex`를 제공합니다.
- 종료 코드: `--strict` 검사 실패는 1, 잘못된 옵션은 2입니다. strict를 생략하면 준비 실패도 보고 후 0을 반환합니다.

`serverOnlineVerified: false`와 `nativeBuildVerified: false`는 정상입니다. 로컬 검사 통과만으로 서비스 실행·로그인 후 자동 시작·서버 온라인·배포 성공을 판단하지 않습니다. [로컬 서비스의 status](local-pc-runner.ko.md#설치-및-수명-주기)와 Flora의 마지막 응답·작업 이력을 별도로 확인합니다. 이 진단에는 상태를 갱신하는 polling이 없습니다.

## 오류별 확인 순서

| 코드 | 확인할 내용 |
| --- | --- |
| `RUNNER_SERVICE_INVALID` | 절대 경로, 서비스 스키마, 같은 사용자 소유의 private 일반 파일과 디렉터리, scratch 디렉터리를 확인합니다. symlink나 공개 권한을 사용하지 않습니다. |
| `RUNNER_CONFIG_INVALID` | 표시된 번호의 앱 설정 스키마·소유권·private 권한을 확인합니다. 토큰을 화면이나 공개 로그로 출력하지 않습니다. |
| `RUNNER_DOCKER_UNAVAILABLE` | 로컬 Unix 소켓과 Docker 데몬의 상태·접근 권한을 확인합니다. 진단은 원격 TCP 연결이나 VM 시작으로 우회하지 않습니다. |
| `RUNNER_DOCKER_TIMEOUT` | 로컬 Docker 응답이 2초 안에 완료되지 않았습니다. 데몬과 PC 부하를 확인한 뒤 진단을 다시 실행합니다. |
| `RUNNER_DISK_LOW` | runtime과 scratch 파일시스템 모두 사용 가능한 공간이 2 GiB 이상인지 확인합니다. 진단은 캐시·파일을 자동 삭제하지 않습니다. |
| `RUNNER_DISK_UNAVAILABLE` | 해당 파일시스템의 공간 조회가 가능한지 확인합니다. 알 수 없는 공간을 충분하다고 판단하지 않습니다. |
| `RUNNER_FATAL_STOP_PRESENT` | 기존 안전 중지 표식과 private 운영 로그를 보존하고 중지 원인을 확인합니다. 표식만 지워서 통과시키지 않습니다. |
| `RUNNER_FATAL_STOP_UNKNOWN` | 안전 중지 상태를 읽을 수 없습니다. 로컬 경로와 접근 권한을 확인하기 전에는 실행 준비로 간주하지 않습니다. |
| `RUNNER_RECOVERY_PENDING` | 앱별 게시 복구 저널이 있습니다. [기존 게시 결과 조정 절차](../../packages/ota-runner/README.md#lease-and-failure-handling)를 먼저 확인합니다. |
| `RUNNER_RECOVERY_UNKNOWN` | 복구 폴더는 같은 사용자 소유의 정확한 `0700`이어야 합니다. symlink·예상 밖 항목·검사 상한 초과도 원인일 수 있습니다. 파일을 삭제하거나 폴더를 교체하지 말고 기존 증거를 보존해 확인합니다. |

서비스 실행이나 복구 조정은 진단과 별개의 작업입니다. 특히 게시 결과가 불확실하면 새로운 배포로 덮지 말고 원래 job·attempt와 저장된 receipt를 사용해 결과를 확인해야 합니다. 복구 저널은 검증된 기존 절차에서만 정리합니다. [Runner 운영 및 안전 중지](local-pc-runner.ko.md), [상태 보고 지연 처리](runner-presence-recovery.ko.md)를 함께 참고하세요.

진단은 로컬 상태의 한 시점만 읽습니다. 설정 검증기의 두 번째 읽기는 같은 사용자가 동시에 파일을 변경하는 상황에서 원자적 스냅샷을 보장하지 않습니다. 설정 변경 중인 상태에서는 작업이 끝난 뒤 다시 실행하세요.
