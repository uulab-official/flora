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

## 별도 DNS 읽기 인증 보완 — 2026-10-18 승인

실제 계정 사전 검사에서 account·zone·D1·Worker domain·route 조회는 200이지만 DNS 레코드 GET만 403이었다. 고정 Wrangler의 OAuth scope 목록에는 DNS 레코드 읽기가 없으므로 같은 로그인 반복으로 해결한다고 안내하지 않는다. 사용자는 **별도 DNS 읽기 인증 설계**를 승인했다.

- 기존 Wrangler 인증·scope·설정은 유지한다. 별도 토큰은 운영자가 대상 zone의 DNS 읽기만 허용해 준비한다. QA에서는 `uulab.co.kr` 한 zone과 단기 만료로 제한한다.
- DNS GET 403일 때만 CLI의 기존 비표시 `readSecret`으로 한 번 입력받는다. 빈 값·잘못된 형식·거절·취소는 중단하며 자동 재입력을 반복하지 않는다.
- 이 토큰은 해당 provider 호출 수명 동안 메모리에만 보관하고, 같은 zone의 고정 `/zones/{zoneId}/dns_records?name={hostname}&per_page=100&page=1` GET에만 사용한다. 다른 zone·계정·Worker·D1·mutation에는 기존 인증을 사용한다.
- 토큰을 파일·원장·로그·argv·환경변수·Flora·브라우저로 전달하지 않는다. 공개 원장 재개 시 다시 필요한 경우 운영자가 CLI에 입력한다. 토큰 생성 화면의 비밀값은 운영자가 직접 CLI에 붙여넣는다.
- 조회 실패 시 hostname 충돌 검증을 생략하지 않는다. pending mutation은 unknown으로 보존하며 자동 재전송하지 않는다. Ctrl+C/EOF는 종료 코드 130으로 유지한다.


## 만료된 미등록 창의 명시적 갱신 — 2026-10-18 승인

사용자가 `flora setup renew --state`의 짧은 설계를 승인했다. 최초 발급이 한 번이라는 규칙은 유지하며, 자동 재발급 금지의 예외로 **운영자가 명시적으로 갱신을 실행하는 경우만** 추가한다. 최초 generation 1과 이전 코드·설정·발급 이력을 보존하고 다음 generation의 10분 `enroll`만 허용한다. 32개 receipt/16KiB 원장 경계를 유지하기 위해 최대 6회 갱신한다. 기존 schemaVersion 1 원장도 읽을 수 있다.

같은 설치의 source·Worker/D1/DO·배포 fingerprint·immutable identity를 검증하고, 고정 Cloudflare DO SQL 조회로 owner 미등록, epoch 0, 활성 세션 0, 이전 generation 일치와 닫힌 창을 확인한다. 기존 GET 제한의 유일한 추가 예외는 검증된 namespace의 `/query/v2`에 보내는 **하드코딩된 읽기 전용 SELECT POST**다. 공개 identity, `verifier IS NOT NULL` 불리언, epoch/generation/closed, 활성 세션 개수만 읽고 verifier·세션 값·코드 원문은 읽거나 출력하지 않는다. 새 scope/인증을 자동 요청하지 않는다. SQL 조회 전에는 해당 설치의 `/api/auth/session`에 인증값·쿠키 없는 GET(401 예상)을 보내 기존 인증 엔진이 유휴 만료를 반영하도록 한다. 빌드·dry-run 뒤 원격 배포 직전에 같은 검증과 만료 시각 확인을 반복한다.

갱신에도 private 원장의 pending을 먼저 기록한다. 응답 유실/미확정 요청은 자동 재발급·재전송하지 않는다. 원장·이전 코드 유실, 이미 등록된 owner, 상태·설정 불일치, 열린 이전 창은 거절한다. 비밀번호 복구, 기존 서버 인수, 공개 발급 API, CLI 비밀번호 입력, 정책 완화는 추가하지 않는다. 등록 후 기존 resume 경로가 최신 갱신 배포 fingerprint를 기준으로 최초 등록 창만 제거한다.
