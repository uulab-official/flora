# 비밀번호 보호 웹 반입 개발 가이드

이 경로는 단일 소유자의 비밀번호 로그인, 한 앱의 원본 source/baseline JSON 반입, 저장된 사실·provenance·반입 이력 조회를 제공한다. 웹에서는 Runner 실행·취소를 사용할 수 없다. 외부 OAuth, Access, R2, 유료 대체 경로, AI·OTA·광고·분석·오류수집 기능은 포함하지 않는다.

로컬 검증과 운영 배포는 별도다. 현재 검증 범위와 아직 열려 있는 출시 조건은 [출시 증거](../release/password-hosting-evidence.md)에 기록한다. 로컬 native scrypt 또는 Miniflare 성공만으로 실제 Workers Free의 CPU·메모리·공유 계정 용량을 통과했다고 판단하지 않는다.

## 로컬 검증

Node.js `24.19.0`, pnpm `11.19.0`, TypeScript `5.9.3`을 사용한다. 공식 도구의 고정 버전은 Wrangler `4.148.0`, Miniflare `5.20261006.0-alpha`, esbuild `0.28.2`, Workers types `5.20261007.1`이다. 정확한 전체 의존성은 `pnpm-lock.yaml`에 고정되어 있다. lifecycle install script를 켜지 않는다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node --test packages/cloudflare/test/limits.test.ts
pnpm check
pnpm verify:clean
git diff --check
```

`verify:clean`은 Git 추적 파일만 복사하여 빈 store에 다시 설치하고 전체 검사·CLI smoke를 실행한다. 새 테스트도 검증 복사본에 포함하려면 먼저 Git 추적 대상으로 추가한다. 쓰기 제한 환경에서는 작업별 `XDG_CACHE_HOME`, `XDG_STATE_HOME`과 pnpm의 지원되는 `--store-dir`/`pnpm_config_store_dir`를 사용한다. `HOME`을 바꾸거나 실패한 설치를 완료로 간주하지 않는다.

테스트는 임시 로컬 workerd·SQLite DO·D1을 사용하고 외부 네트워크를 차단한다. 원본 공개 synthetic fixture로 크기·해시가 올바른 envelope를 생성한다. 비공개 pilot 파일, 계정, 실제 이메일, 인증정보, 운영 DB를 테스트 입력으로 사용하지 않는다. 테스트 전용 제어 경로는 운영 Worker bundle에 들어가면 안 된다.

## 데이터와 인증 경계

얇은 Worker는 정확한 HTTPS origin, 허용 경로·메서드를 검사하고 원래 요청을 고정 DO `flora-owner-v1`에 한 번 전달한다. Worker에서 전체 body를 읽거나 복제·해싱하지 않는다. 비공개 asset도 DO의 현재 세션 확인을 거친다. DO는 인증·입력 제한·parser·D1 쓰기 제출을 소유한다. 인증 상태는 DO SQLite, 앱 사실·반입 이력은 D1에 저장한다.

필수 배포 입력은 `FLORA_ORIGIN=https://flora.example.test`, `FLORA_OWNER_ID=<owner-id>`, `FLORA_OWNER_EMAIL=<owner-email>`, `FLORA_DB_IDENTITY=<deployment-marker>`다. 이 예시는 실제 계정·주소·리소스가 아니다. `FLORA_AUTH`, `FLORA_DB`, `ASSETS` binding과 D1의 소유자·origin·DB marker가 일치해야 한다. 설정 누락·불일치·저장 장애는 닫힌 상태로 실패하며 HTTP 요청이 자원이나 소유자를 자동 생성하지 않는다.

Worker와 DO를 함께 내보내는 설정에는 `limits.cpu_ms`를 지정하지 않는다. 이 설정은 DO의 CPU 예산도 바꾸므로 front 전용 10ms 제한으로 쓰지 않는다. 실제 Free front의 plan 제한과 DO 기본 30초를 각각 별도로 검증한다. [DO CPU 설정](https://developers.cloudflare.com/durable-objects/platform/limits/#can-i-increase-durable-objects-cpu-limit)과 [Workers CPU 제한](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)을 출시 시 재확인한다.

소스 digest는 검증된 파일 목록의 canonical digest이며 envelope 전체 해시가 아니다. `fetchedAt` 또는 입력 파일 순서만 달라지면 같은 receipt와 최초 provenance를 돌려준다. Baseline `evidenceDigest`는 원본 envelope 바이트 전체의 SHA-256이다. 같은 시도 키에 다른 바이트를 보내면 conflict다. 개발 baseline은 사용자 반입 증거이며 실제 실행·격리 검증을 뜻하지 않는다. 별도 HEAD 관측이 없으면 최신 여부는 알 수 없다.

DO와 D1에는 공유 transaction이 없다. logout·복구·만료는 다음 쓰기 제출을 막지만 이미 D1에 제출된 쓰기는 완료될 수 있다. 응답을 잃으면 같은 원본을 다시 보내서 저장된 immutable receipt를 확인한다. 자동 이력 삭제나 용량 초과 시 유료 저장소 전환은 없다.

현재 용량 거부와 다른 앱 충돌은 모두 `409/CONFLICT`로 응답할 수 있다. 이 응답만으로 원인을 특정하거나 저장 한도를 올리지 말고 선택한 앱·원본·이력과 용량을 확인한다.

## 고정 제한

| 경계 | 값과 실패 동작 |
| --- | --- |
| 비밀번호 | 15–128 Unicode codepoint, UTF-8 ≤1,024바이트; surrogate 오류 거부; trim·정규화·잘라내기 없음 |
| scrypt v1 | `N=32768,r=8,p=3,keylen=32,saltBytes=16,maxmem=67108864`; 상수시간 비교 |
| 인증 body | ≤8,192바이트 |
| source / baseline / HEAD body | ≤1,048,576 / 131,072 / 4,096바이트; 초과 413 |
| body 읽기 | 절대 10,000ms; 만료 408; 요청 범위 timer만 사용 |
| 무거운 작업 | DO 전체 KDF 또는 반입 1개; 이미 진행 중이면 409/BUSY, Retry-After 1 |
| 인증 admission | 고정 900,000ms 창에 5회; KDF는 고정 3,600,000ms 창에 60회; 초과 429, 창 종료까지 제한된 Retry-After |
| 세션 | 절대 3,600,000ms, 최대 5개; 6번째 로그인은 가장 오래된 세션 취소 |
| row / JSON 응답 | ≤524,288 / 1,048,576바이트 |
| 목록 | keyset page 최대 20개, SELECT 21개로 다음 page 확인; 전체 report/log를 목록에서 읽지 않음 |
| 로그 | 정제된 UTF-8 ≤65,536바이트와 JSON overhead; 펼칠 때만 조회 |
| 앱 저장 상한 | snapshot 100개, baseline 500개, 계산된 payload 합계 134,217,728바이트; 새 row만 거부하고 기존 receipt 조회 유지 |

세션·CSRF는 독립적인 32바이트 난수이며 hash만 영속 저장한다. 두 `__Host-` cookie 모두 `Secure; HttpOnly; SameSite=Strict; Path=/`, Domain 없음이다. 변경 요청에는 정확한 Origin과 세션에 결합된 `X-Flora-CSRF`가 필요하다. 요청 body·비밀번호·설정 토큰·cookie·CSRF·비공개 내용·원문 SQL 오류는 로그에 남기지 않는다.

## 등록·복구와 운영 중단 조건

등록은 기본 잠김이다. 소유자가 승인한 관리 경로의 `FLORA_SETUP`만 digest, 발급시각, 발급 후 정확히 600,000ms 만료, 증가하는 generation, `enroll` 또는 `recover` 용도를 설정한다. 원문 토큰은 32바이트 난수의 base64url 43자다. 사용·만료된 같은 generation이나 오래된 배포로 등록을 다시 열 수 없다. 복구는 비밀번호 교체·setup 소비·기존 세션 전체 취소를 함께 수행한다.

실제 설정 토큰과 비밀번호는 사용자가 유효한 HTTPS 화면에서 직접 생성·입력·확인·제출한다. 에이전트가 대신 생성·관찰·회수·저장하거나 채팅·URL·로그·소스에 넣지 않는다. 인증 DB 복원은 인증을 멈추고 새 관리 승인과 전체 세션 무효화 절차를 거친다.

현재 계정의 실제 Free 활성화·남은 공유 용량부터 확인한다. 비용·결제·유료 plan이 필요하거나 실제 성능 한도를 충족하지 못하면 중단하고 재검토한다. 암호 강도 축소, 다른 로그인 방식, Access/R2, 자동 결제·배포로 우회하지 않는다. 소스 main push 허용은 이후 push마다 운영 자동 배포를 켜는 권한이 아니다.
