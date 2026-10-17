# GitHub Actions 없이 PC에서 실행하는 Flora Runner

GitHub 커밋 이벤트는 Flora 서버가 받습니다. 서버는 앱별 저장소·브랜치·채널·런타임·iOS/Android 자동 배포 정책에 맞는 작업을 큐에 넣고, 켜진 UULab PC의 Runner가 작업을 가져와 격리된 Docker 안에서 export한 뒤 Flora에 OTA를 게시합니다. GitHub Actions나 EAS는 실행하지 않습니다. PC가 꺼지거나 잠들면 큐 처리는 멈추며, 별도 서버의 항상 켜진 실행 환경을 대체하지는 않습니다.

## 실행 구성

`scripts/local-runner/supervisor.mjs`는 등록한 앱 1~10개의 고유한 자격 증명 설정을 순서대로 번갈아 사용하여 기존 Runner CLI를 `--once`로 실행합니다. 동시에 하나의 작업만 실행하며, 각 실행 뒤 최소 10초를 기다립니다. `pollIntervalMs`는 기본 간격이며, 확인된 빈 큐에는 앱별 대기 시간을 적용합니다. 기본 30초 설정은 30 → 60 → 120 → 240 → 300초까지 늘어나고, 실제 작업 성공 또는 일반 export 실패가 확인되면 기본 간격으로 돌아갑니다. 대기 중인 앱은 건너뛰되 순서를 유지하여 다른 앱을 먼저 확인합니다. 1~10개 앱 모두에서 유휴 상태의 앱별 확인 간격은 최대 5분이며, 실행 중인 작업의 실행 시간·서버 장애·알려진 일일 한도 중단은 이 유휴 상한에 포함되지 않습니다. 앱별 토큰·작업 디렉터리·복구 디렉터리는 각각 분리합니다. 자식 `TMPDIR`는 private `scratch`로 고정하며, VM에는 이 디렉터리만 쓰기 가능하게 마운트합니다. 토큰 설정과 복구 journal은 scratch 밖에 두어 VM에 마운트하지 않습니다. 기존 자동 배포 정책은 변경하지 않습니다.

설치 위치는 `~/.flora/pc-runner-uulab`입니다. 디렉터리는 0700, JSON 설정·스크립트·로그는 0600으로 준비합니다. 서비스 설정에는 토큰을 넣지 않고, 앱별 토큰 JSON의 절대 경로만 기록합니다. 저장소에 자격 증명 설정을 추가하지 않습니다.

비밀이 없는 `service.json` 예시입니다. 실제 경로는 설치한 Node 24와 task-local Lima 환경에 맞게 바꿉니다.

```json
{
  "runtimeDirectory": "/Users/USER/.flora/pc-runner-uulab",
  "nodePath": "/ABSOLUTE/NODE24/bin/node",
  "runnerMain": "/ABSOLUTE/FLORA/packages/ota-runner/dist/main.js",
  "runnerConfigs": [
    "/Users/USER/.flora/pc-runner-uulab/isso.json",
    "/Users/USER/.flora/pc-runner-uulab/promise.json",
    "/Users/USER/.flora/pc-runner-uulab/reward.json"
  ],
  "path": "/ABSOLUTE/TASK/BIN:/ABSOLUTE/NODE24/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  "limaHome": "/ABSOLUTE/TASK/LIMA_HOME",
  "dockerHost": "unix:///ABSOLUTE/TASK/LIMA_HOME/VM/sock/docker.sock",
  "pollIntervalMs": 30000,
  "vmStart": ["/ABSOLUTE/TASK/BIN/limactl", "start", "flora-runner", "-y"]
}
```

`vmStart`는 선택 항목입니다. 지정하면 supervisor 시작 때 지정한 VM을 시작하며, 실패하면 서비스를 중단합니다. 임의 shell 명령은 받지 않습니다. 작업 디렉터리는 `scratch/work-isso`, `scratch/work-promise`, `scratch/work-reward`, 복구 디렉터리는 runtime 바로 아래 `recovery-isso`, `recovery-promise`, `recovery-reward`로 미리 준비하고 기존 Runner의 private path 검사도 통과해야 합니다.

## 설치 및 수명 주기

이 도구는 실행 요청을 받아야 사용자 홈을 수정합니다. 스크립트 작성이나 테스트만으로 LaunchAgent를 설치하지 않습니다. 먼저 `supervisor.mjs`, `service.mjs`, `health.mjs`를 private `bin` 디렉터리에 함께 복사합니다.

```sh
/ABSOLUTE/NODE24/bin/node ~/.flora/pc-runner-uulab/bin/service.mjs install ~/.flora/pc-runner-uulab/service.json
/ABSOLUTE/NODE24/bin/node ~/.flora/pc-runner-uulab/bin/service.mjs start
/ABSOLUTE/NODE24/bin/node ~/.flora/pc-runner-uulab/bin/service.mjs status
/ABSOLUTE/NODE24/bin/node ~/.flora/pc-runner-uulab/bin/service.mjs stop
```

생성하는 파일은 `~/Library/LaunchAgents/kr.co.uulab.flora-runner.plist` 하나입니다. plist에 토큰이나 raw 로그를 넣지 않습니다. `RunAtLoad=true`, `KeepAlive={SuccessfulExit:false}`, `ThrottleInterval=30`, `ExitTimeOut=40`을 사용합니다. 재부팅 후 사용자 로그인 때 시작하며, 프로세스가 비정상 종료되면 launchd가 재시작합니다. 치명적 오류의 중단 표식이 있으면 다음 실행은 정상 종료하므로 무한 재실행하지 않습니다. 시스템 전역 daemon이나 Codex 설정을 수정하지 않습니다.

`status`는 launchd 등록 여부와 실제 프로세스를 구분합니다. 실행 중이면 `{"state":"running","loaded":true,"pid":12345}`, 등록됐으나 실행 중이 아니면 `loaded-idle`, 등록도 없으면 `stopped`입니다. 치명적 중단 파일이 있으면 `fatal-stop`과 허용된 고정 오류 코드만 반환합니다. 응답을 해석할 수 없을 때는 `unknown`으로 표시합니다. 단순히 등록됐다는 이유로 실행 중이라고 표시하지 않습니다.

각 작업을 가져오기 전에 runtime·scratch 파일시스템의 사용 가능한 공간을 확인하며, 둘 중 하나라도 2 GiB 미만이면 `DISK_SPACE_LOW`로 작업 인수를 멈춥니다. 공간 조회 실패는 `DISK_SPACE_UNAVAILABLE`, 제한 시간 안에 Docker 서버 조회가 완료되지 않으면 `ISOLATION_UNAVAILABLE`입니다. 이때 앱별 presence 전송은 계속하고 polling 간격마다 상태를 다시 확인하며, 정상화되면 작업 인수를 재개합니다. 캐시·앱 파일·복구 journal을 자동 삭제하지 않습니다. Docker 서버 조회는 VM 내부 파일시스템의 쓰기 가능 여부를 보증하지 않습니다.

일반 export 실패는 서버의 실패 이력으로 남기고 다음 앱을 처리할 수 있습니다. 인증·충돌·복구·게시 결과 불확실·응답 이상·출력 한도 초과는 즉시 중단하고 private `fatal-stop` 파일을 남깁니다. 다음 로그인도 이 파일이 있으면 작업을 처리하지 않습니다. 복구 journal은 그대로 둡니다. 원인을 확인하고 필요한 게시 복구를 마친 다음 명시적인 `start` 명령으로 중단 표시를 제거합니다. `start`는 journal을 삭제하지 않습니다.

작업을 수신하기 전 Docker 연결 검사만 실패한 경우에는 `runner-initialization/DOCKER_DAEMON_UNAVAILABLE` 진단을 확인해 앱별로 최대 5분의 간격까지 재시도합니다. 작업 수신 후 격리 실패에는 이 재시도를 적용하지 않습니다. Presence 전송의 일시적인 네트워크·429·5xx 실패는 제한된 재시도 후 다음 주기에 다시 확인하며, 성공한 heartbeat를 임의로 기록하지 않습니다. 서버의 마지막 응답 시각이 만료되면 화면에는 오프라인으로 나타납니다.

SIGTERM/SIGINT는 현재 Runner에 SIGTERM을 전달하여 정리하게 합니다. 30초 안에 종료하지 않으면 해당 CLI 프로세스 그룹을 종료합니다. VM을 삭제하거나 기존 앱 데이터를 지우지 않습니다.

## 로그와 검증 범위

`runner.log`에는 고정된 진단 단계·오류 코드·HTTP 상태·작업 상태·형식이 맞는 작업/배포 ID·플랫폼만 남깁니다. raw stdout/stderr, 토큰, 복구 경로, 임의 오류 메시지는 버립니다. 로그는 현재/직전 두 파일만 보존하며 각각 최대 1 MiB입니다. 자식 출력은 256 KiB를 넘으면 실행을 중단합니다.

```sh
/ABSOLUTE/NODE24/bin/node --test scripts/local-runner/supervisor.test.mjs scripts/local-runner/health.test.mjs
```

테스트는 앱별 순차 실행, 최소 polling 간격, secret 제거, 파일 권한 및 symlink 거부, 실제 자식 프로세스 SIGTERM, 출력 한도, 로그 회전, LaunchAgent 설정 및 lifecycle, 실제 상태 해석, 공간 부족·Docker 조회 실패 때 작업 인수 중단 및 회복을 검증합니다. 이 테스트 결과만으로 실제 GitHub 커밋의 OTA 배포나 기기 적용을 성공했다고 주장하지 않습니다. 실제 설치·등록한 각 앱의 iOS/Android 배포 결과는 별도 실행 증거가 필요합니다. 2026-10-13 관리 기능 개선과 실제 서비스 재시작 결과는 [프로젝트 관리 검증 기록](project-management-evidence.ko.md)에 있습니다.

GitHub Actions 실행 비용은 발생하지 않는 구성이지만, PC 전력·네트워크 및 Flora 호스팅 사용량은 남습니다. 무료 범위 여부는 사용하는 계정의 실제 한도와 사용량으로 확인합니다.

D1 무료 일일 조회 한도에 도달하면 서버 presence와 작업 조회도 거절될 수 있습니다. 이때 로컬 서비스 실행 상태를 서버 온라인 상태와 구분하고, 화면의 한도 초기화 시각을 확인합니다. 일일 한도는 00:00 UTC(한국 오전 9시)에 초기화됩니다. 유휴 큐는 앱별 최대 5분까지 적응형 backoff를 적용합니다. 세 앱·기본 30초 설정의 결정적 가상 시계 테스트에서 한 시간의 claim 요청은 기존 120회에서 44회(Isso 15 / Promise 15 / Reward 14)로 줄었습니다. 이는 claim 호출 수 검증이며 실제 D1 조회 행 수나 Cloudflare 청구 측정은 아닙니다. Presence는 별도 루프에서 60초 간격을 유지합니다. 서버의 온라인 판정 창이 120초이고 presence 저장 간격이 60초이므로, 빈 큐 backoff가 presence를 늦추지 않습니다. 작업 수신 전 일반적인 일시적 서버 실패에는 기존 제한된 backoff를 적용합니다. 서버가 정확히 `D1_DAILY_READ_LIMIT` 또는 `D1_DAILY_WRITE_LIMIT`를 HTTP 503으로 반환하고 아직 작업을 받기 전임이 확인된 경우에는 claim과 presence가 다음 00:00 UTC까지 함께 중단됩니다. Presence에서도 이 정확한 한도 오류에는 즉시 5초 재시도를 하지 않습니다. 중단은 종료 신호로 취소할 수 있으며, 재시작 시에는 첫 요청의 실제 응답으로 한도 상태를 다시 확인합니다. 오류 원문·토큰을 저장하지 않고 고정된 한도 코드와 재개 시각만 기록합니다. 이때 마지막 실제 presence는 만료되어 오프라인으로 표시될 수 있으며 성공 상태를 만들지 않습니다. 알 수 없는 503, 인증·권한·복구 오류를 이 일일 한도로 추정하지 않습니다. 작업을 받은 뒤 발생한 오류, heartbeat·finalization·게시 결과 불확실성에는 이 대기 정책을 적용하지 않고 기존 중단·복구 절차를 유지합니다. 2026-10-14 실제 복구·GitHub 커밋 검증과 남은 작업은 [복구 검증 기록](pc-runner-recovery-2026-10-14.ko.md)에 있습니다.
