# 설치 마법사: Cloudflare 조회 인증 경계 보완

2026-10-18 사용자가 **메모리에서 공식 인증 사용**을 승인했다. 원 설계의 인증값 추출 금지에서 다음 공식 조회 경로만 예외로 둔다.

- 고정 Wrangler 4.148.0의 공개 `auth token --json` 명령을 private subprocess로 실행한다. 인증 파일이나 비공개 Wrangler 모듈을 직접 읽지 않는다.
- 결과는 CLI 메모리에서 고정 `https://api.cloudflare.com/client/v4` 조회 API의 Authorization 헤더에만 사용한다. 새 권한을 요청하거나 자동 확대하지 않는다.
- 원문 인증값을 파일·원장·로그·명령 인자·환경변수·Flora 서버·브라우저로 옮기지 않는다. 응답과 오류 원문을 사용자에게 출력하지 않는다.
- Wrangler는 일반 출력을 기본적으로 파일에 기록하므로 child의 `WRANGLER_WRITE_LOGS=false`, `WRANGLER_SEND_METRICS=false`를 고정한다. 합성 인증을 둔 별도 HOME에서 실제 pinned CLI를 실행해 토큰 로그가 생기지 않는 것을 검증한다.
- 계정·zone·D1·Worker 설정·배포·hostname·DNS 조회는 검증된 계획의 ID/이름으로만 생성한다. GET만 허용하고 redirects·과대 응답·누락된 필드·권한 부족은 거절한다.
- 자원 생성·migration·identity INSERT·배포는 기존 승인 범위의 고정 Wrangler 명령만 사용한다. CLI와 운영 DB 사이에 인증값 전달 경로를 추가하지 않는다.
- 무료 플랜·사용량을 읽어 증명할 수 없으면 운영자의 공식 대시보드 확인을 별도로 받는다. 이는 operator-confirmed이며 provider-verified로 표시하지 않는다.

추가 구현 결정: provider factory는 checkout 밖 private directory를 명시적으로 받는다. 새 Worker 설정의 shell build hook 대신 고정 Node build 및 dry-run을 실행하고, 그 직후 설정 drift를 다시 읽어 확인한다. 원 설계의 기존 데이터/키/이력 보존·최초 1회 발급·응답 유실 시 비재전송 규칙은 유지한다.

근거: [공식 auth token 명령](https://developers.cloudflare.com/workers/wrangler/commands/general/#auth-token), 프로젝트에 설치된 4.148.0 command metadata 및 logger의 `WRANGLER_WRITE_LOGS` 처리.
