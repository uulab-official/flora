# Linux 서버에서 OTA Runner 운영하기

Flora 웹 서버와 Runner는 서로 다른 컴퓨터에 둘 수 있습니다. GitHub 이벤트·작업·키·배포 이력은 기존 Flora 서버에 두고, 실행할 Linux 서버에서 별도 Runner를 승인받습니다. 기존 Mac 설정이나 토큰을 복사하지 않습니다. Linux에서도 iOS·Android **OTA JavaScript/자산 export**를 처리할 수 있습니다. iOS 네이티브 빌드·서명에는 macOS와 Xcode가 필요하며, 이 서비스는 OTA Runner용입니다.

## 대상 서버 준비와 앱 연결

systemd 사용자 서비스를 제공하는 Linux, 일반 사용자 계정, Node 24.19.0, pnpm 11.19.0, Git, 동작하는 로컬 Docker와 최소 2 GiB 여유 공간이 필요합니다. 먼저 [README 설치·검증](../../README.md)을 마치세요. root로 Runner를 실행하지 않습니다. Docker socket 접근은 해당 서버 관리 정책으로 준비하고, 원격 TCP Docker 포트를 열지 않습니다.

1. Flora의 **조직 · 멤버 / PC Runner**에서 이 서버용 이름과 앱 범위를 지정해 요청하고 관리자가 승인합니다. 기존 Owner Runner도 앱별 범위를 사용합니다.
2. 승인된 Runner의 공개 `flora.runner-binding.json`과 같은 앱의 `flora.connection.json`을 대상 서버에 준비합니다. 토큰은 해당 서버의 비표시 입력으로 전달합니다. 다른 PC의 private `runner.json`을 복사하거나 앱 키를 다시 업로드하지 않습니다.
3. 대상 서버의 Flora checkout에서 실행합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm flora setup runner
```

새 private 디렉터리를 선택하고 Docker 도구 이미지를 확인합니다. `runner.json`과 `service.json`은 파일 0600·폴더 0700으로 준비됩니다. 기존 디렉터리로 재개하면 승인과 fingerprint를 검증하며 설정·복구 저널을 덮어쓰지 않습니다. 서비스로 운영할 예정이면 마지막 foreground 실행 질문에는 실행하지 않음을 선택합니다.

## 사용자 서비스 설정 생성

대상 서버의 실제 private 경로로 바꿔 실행합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --silent flora runner service-config --service /home/flora/PRIVATE-RUNNER/service.json
```

이 명령은 설정과 실행 파일의 로컬 경로·권한을 확인하고, 같은 디렉터리에 `flora-runner-<12자리 해시>.service` 하나를 0600으로 생성합니다. 해시는 service.json의 절대 경로에서 계산하므로 앱별 디렉터리마다 이름이 구분됩니다. 결과 JSON의 `file`과 `unitName`을 다음 단계에서 사용합니다. `installed: false`, `started: false`가 정상입니다. 서버에 연결하거나 token을 읽어 출력하지 않으며 서비스 설치·시작·Docker 빌드·systemd 설정 변경은 하지 않습니다.

같은 내용이면 `state: "unchanged"`이고 파일을 다시 쓰지 않습니다. 이미 있는 unit이 다르면 `RUNNER_SERVICE_OUTPUT_CONFLICT`로 거절합니다. 기존 unit을 백업하고 차이를 검토한 뒤 별도로 정리하세요. 링크·hardlink·공개 권한의 설정은 거절합니다. Mac의 Lima `vmStart`가 있는 설정은 `RUNNER_SERVICE_VM_START_UNSUPPORTED`로 거절하므로 Linux에서 새로 등록한 설정을 사용합니다. 기존 service.json의 `limaHome` 필드는 호환성을 위해 남지만 `vmStart`가 없는 Linux 실행에는 Lima 설치가 필요하지 않습니다.

생성 파일은 shell을 통하지 않고 Node와 supervisor의 절대 경로를 실행합니다. 일반 오류는 30초 뒤 재시작하며 5분 내 시작 횟수도 제한합니다. 유효한 설정을 읽은 뒤 발생한 치명적인 오류는 기존 `fatal-stop`을 남기고 다음 실행이 정상 종료하므로 무한 재시작하지 않습니다. journal과 중지 표식을 자동으로 지우거나 앱 키·관리자 비밀번호를 unit에 넣지 않습니다. 설정 생성은 Docker 연결·실제 배포 성공을 증명하지 않으므로 다음 진단도 수행하세요.

Node의 사전 로딩·TLS 우회 설정과 동적 로더 주입 환경변수는 unit에서 제거합니다. 실행 파일뿐 아니라 상위 경로도 root 또는 실행 사용자 소유인지, 다른 사용자가 쓸 수 없는지 검사합니다. root 소유 sticky 임시 디렉터리는 허용합니다. 이 검사는 실행할 소스 자체에 대한 전자서명·공급망 감사를 대신하지 않습니다.

Node 자체 실행 실패 또는 `service.json` 파싱 전 오류에는 일반 Linux 디렉터리에서 새 `fatal-stop`을 기록하지 못할 수 있습니다. 이 경우에도 5분 동안 최대 3회 시작 후 systemd 시작 제한으로 멈춥니다. `systemctl --user status`와 `flora doctor`로 파일·도구 문제를 확인하고 수정한 뒤, 운영자가 `systemctl --user reset-failed flora-runner-HASH.service`와 `systemctl --user start flora-runner-HASH.service`를 실행하세요. 유효한 설정에서 이미 생성된 중지 표식은 계속 보존·준수하며, `reset-failed`가 Flora의 표식을 지우지는 않습니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --silent flora doctor --runner-service /home/flora/PRIVATE-RUNNER/service.json --strict --json
```

## 확인 후 활성화

아래 `HASH`와 경로는 생성 결과의 실제 값으로 바꿉니다. 먼저 unit 내용을 검토하고, 같은 Runner를 foreground와 서비스에서 동시에 실행하지 않도록 확인하세요. 이 단계부터 해당 서버의 사용자 서비스를 등록·시작합니다.

```sh
systemd-analyze --user --generators=no --man=no verify /home/flora/PRIVATE-RUNNER/flora-runner-HASH.service
systemctl --user enable --now /home/flora/PRIVATE-RUNNER/flora-runner-HASH.service
systemctl --user status flora-runner-HASH.service
```

사용자 서비스는 기본적으로 사용자 로그인과 함께 실행됩니다. **로그인 없이 재부팅 직후부터 계속 실행**하려면 서버 관리자가 해당 계정의 lingering을 별도로 승인·설정해야 합니다. `loginctl show-user 사용자명 -p Linger`로 상태를 확인하고, 필요한 경우 관리자가 `loginctl enable-linger 사용자명`을 실행합니다. Flora CLI는 이를 자동 설정하거나 root 권한을 요청하지 않습니다. Docker 자체도 재부팅 후 해당 계정에서 사용할 수 있어야 합니다. 배포판의 [systemd 사용자 서비스·재시작 설정](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)과 [loginctl lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)을 참고하세요.

실제 프로세스는 `systemctl --user status`, 서버 수신 상태는 Flora 앱의 **PC Runner**, export·게시 결과는 해당 commit의 iOS·Android 작업 이력으로 각각 확인합니다. private `runner.log`는 기존 고정 오류 코드·제한된 용량 정책을 유지합니다. 온라인만으로 OTA 게시나 기기 적용이 완료됐다고 판단하지 않습니다.

중지는 `systemctl --user stop flora-runner-HASH.service`입니다. 새 서버로 옮길 때는 새 서버의 별도 승인·테스트를 마친 뒤 이전 서비스를 명시적으로 중지하고, 필요하면 기존 Runner 접근을 회수하세요. 기존 복구 journal이 있으면 게시 결과를 먼저 대조하고 기록을 보존합니다. 토큰·journal을 복사해 중복 실행하거나, 미확정 작업을 새 서버에서 무조건 다시 게시하지 않습니다. 수동 복구가 끝난 후에만 중지 표식을 운영자가 처리하며, 서비스 재시작 자체는 표식을 지우지 않습니다.

## 비용과 검증 범위

GitHub Actions·EAS·R2 구독은 필요하지 않습니다. 기존 Flora 호스팅 한도와 사용하는 서버의 전력·호스팅 비용은 별개입니다. 이 명령은 특정 클라우드 업체 계정을 만들거나 서버를 유료 주문하지 않습니다.

Linux 컨테이너의 일반 UID에서 설정 생성·권한·기존 파일 보존 테스트를 실행할 수 있습니다. systemd 파서 검증, 서비스 실행·재부팅, 실제 앱의 OTA 다운로드·적용은 서로 다른 검증 단계입니다. 새 물리 서버에서 첫 커밋을 게시·다운로드하기 전에는 서버 이전이 완료됐다고 판단하지 마세요.
