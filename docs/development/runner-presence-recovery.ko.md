# PC Runner의 늦은 상태 응답 복구

상태 보고(`--presence`)는 배포 작업을 획득하지 않는다. PC의 일시 정지나 과부하로 supervisor의 제한 시간이 지난 뒤 정상 응답을 출력하고 종료할 수 있다. 이 결과를 전체 Runner의 치명 오류로 처리하면 다른 앱도 함께 중지된다.

자체 제한 시간이 실제로 발생했고, 출력 초과가 없으며, 종료 코드가 `0`, `1`, `null` 중 하나이고, 정확한 형식의 presence 한 건만 있는 경우에는 성공을 기록하지 않는다. `presence-deadline-expired`와 허용된 종료 코드만 기록하고 기존 5초 간격·최대 세 번 재시도를 적용한다. 재시도가 소진되면 `presence-unavailable`로 남기고 다음 앱과 다음 주기로 진행한다. 온라인 상태를 합성하지 않는다.

외부 종료, 권한 거절, 복수·잘못된 presence, 업무 단계 혼입, 출력 초과, 게시·복구 판단은 이 예외에 포함되지 않는다. Claim·lease·finalize·복구 저널의 규칙과 무료 조회 예산도 변경하지 않는다.

검증은 실제 SIGTERM 자식의 회수, 제한 재시도와 다른 앱의 정상 진행, 늦은 성공 로그 미생성, 기존 설정·저널 보존 및 권한·게시 오류의 안전 중지를 포함한다.

```sh
node --test scripts/local-runner/supervisor.test.mjs scripts/local-runner/health.test.mjs scripts/local-runner/usage-collector.test.mjs scripts/local-runner/usage-service.test.mjs
```

운영 복구 전에 설치 스크립트·설정·원래 중지 표식·저널을 비공개 디렉터리에 백업한다. 실행 중 작업과 미확정 게시가 없는지 대조한 뒤 검증한 supervisor만 교체하고 기존 서비스 절차로 재개한다. 원인 확인 없이 중지 표식이나 저널을 자동으로 삭제하지 않는다.

macOS LaunchAgent의 `RunAtLoad`는 사용자 로그인 시 실행한다. `KeepAlive.SuccessfulExit=false`는 비정상 종료의 재실행을 담당한다. 안전 중지 표식이 있으면 자동 재시작으로 이를 우회하지 않는다. 설정·서비스 재등록 검증과 실제 PC 재부팅 검증은 별도 증거로 기록한다.

## 자산 저장소의 일시적 음성 응답

인증된 GitHub 자산 저장소 GET이 404를 반환하면, 같은 기존 인증으로 UUID 쿼리와 `Cache-Control: no-cache`를 붙여 한 번만 재확인한다. 계속 404이면 원래 실패 판단을 유지한다. 모든 새 응답은 기존 저장소·자산·작업 식별 검증을 거친다. POST·PATCH·업로드를 이 전송 계층에서 다시 실행하지 않으며 권한이나 자격 증명을 바꾸지 않는다.

GET의 첫 404 뒤 재조회 200과 지속적인 404를 실제 자식 프로세스 대역으로 검증한다. 기존 쿼리 유지, 최대 두 번의 조회, 쓰기 요청 미반복, 토큰 환경변수 비전달과 업로드 저널 보존도 확인한다. 이 검사는 실제 일시적 404의 원인이 캐시였다고 확정하는 증거는 아니다.
