# 비밀번호 보호 웹 반입 개발 가이드

이 경로는 단일 소유자의 비밀번호 로그인, 한 앱의 원본 source/baseline JSON 반입, 저장된 사실·provenance·반입 이력 조회를 제공한다. 한 앱의 여러 flavor를 표시하며 수십·수백 개 독립 앱의 통합 관리는 아직 지원하지 않는다. [고정 source 구조와 검사 profile](dogfood.ko.md#3-자신의-자료-가져오기)을 만족하는 자료만 반입할 수 있다. 웹에서는 Runner 실행·취소를 사용할 수 없다. 외부 OAuth, Access, R2, 유료 대체 경로, AI·OTA·광고·분석·오류수집 기능은 포함하지 않는다.

로컬 검증과 운영 배포는 별도다. 현재 검증 범위와 아직 열려 있는 출시 조건은 [출시 증거](../release/password-hosting-evidence.md)에 기록한다. 로컬 native scrypt 또는 Miniflare 성공만으로 실제 Workers Free의 CPU·메모리·공유 계정 용량을 통과했다고 판단하지 않는다.

## 로컬 검증

Node.js `24.19.0`, pnpm `11.19.0`, TypeScript `5.9.3`을 사용한다. 공식 도구의 고정 버전은 Wrangler `4.148.0`, Miniflare `5.20261006.0-alpha`, esbuild `0.28.2`, Workers types `5.20261007.1`이다. 정확한 전체 의존성은 `pnpm-lock.yaml`에 고정되어 있다. lifecycle install script를 켜지 않는다.

[처음 실행하기](../getting-started.ko.md)의 Git clone·Node/npm 준비를 마친 뒤 저장소 루트에서 실행한다. 전역 pnpm 설치는 필요 없다. Windows PowerShell이 `npm.ps1`을 차단하면 `npm`만 `npm.cmd`로 바꾼다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm build
node --test packages/cloudflare/test/limits.test.ts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm verify:clean
git diff --check
```

`verify:clean`은 Git 추적 파일만 복사하여 빈 store에 다시 설치하고 전체 검사·CLI smoke를 실행한다. 새 테스트도 검증 복사본에 포함하려면 먼저 Git 추적 대상으로 추가한다. 쓰기 제한 환경에서는 작업별 `XDG_CACHE_HOME`, `XDG_STATE_HOME`과 pnpm의 지원되는 `--store-dir`/`pnpm_config_store_dir`를 사용한다. `HOME`을 바꾸거나 실패한 설치를 완료로 간주하지 않는다.

테스트는 임시 로컬 workerd·SQLite DO·D1을 사용하고 외부 네트워크를 차단한다. 원본 공개 synthetic fixture로 크기·해시가 올바른 envelope를 생성한다. 비공개 pilot 파일, 계정, 실제 이메일, 인증정보, 운영 DB를 테스트 입력으로 사용하지 않는다. 테스트 전용 제어 경로는 운영 Worker bundle에 들어가면 안 된다.

## Self-host 준비 순서

현재는 운영자가 구성하는 preview이며 계정 생성·권한 발급·DB 초기화·소유자 등록을 한 번에 하는 설치 명령은 없다. 아래는 준비·실행 순서다. 로컬 build나 dry-run은 실제 계정 접근·배포 성공을 입증하지 않는다.

1. **실행 대상을 먼저 확정한다.** 현재 Cloudflare 계정의 Free 활성 상태·남은 공유 quota, 본인 소유 HTTPS hostname과 zone, 선택한 Worker 이름, 전용 D1 DB를 확인한다. 관리 UI 로그인과 Wrangler 인증은 별개다. 기존에 허용된 관리 세션이 없으면 먼저 해당 접근을 준비한다. 유료 전환·Access·R2는 필수 의존성이 아니다. 계정 전체 quota이므로 Flora만의 독립 무료 한도가 아니다.
2. **설정을 비공개 위치에 만든다.** [wrangler.example.jsonc](../../packages/cloudflare/wrangler.example.jsonc)를 Git checkout 밖의 `wrangler.private.jsonc`로 복사한다. 예제 자체는 배포 입력이 아니다. 현재 `account_id`, 고유 Worker `name`, 기존 D1의 `database_name`/`database_id`, 아래 네 `vars`를 채운다. D1이 없으면 먼저 선택한 Free 계정에 전용 DB를 생성하고 반환 UUID를 기록한다. 배포 시 자동 provisioning에 맡기지 않는다. `FLORA_OWNER_ID`와 `FLORA_DB_IDENTITY`는 비밀값이 아닌 안정된 식별자(`A–Z`, `a–z`, 숫자, `. _ : -`, 1–256자)이며 이후 바꾸지 않는다. `FLORA_ORIGIN`은 경로·끝 slash 없는 정확한 HTTPS origin이다. 소유자 이메일도 직접 지정한다. 처음에는 `FLORA_SETUP`을 넣지 않는다.
3. **옮긴 설정의 경로를 고친다.** 파일 위치가 바뀌면 상대 경로 기준도 바뀐다. `main`은 checkout의 `packages/cloudflare/dist/hosted/worker.js`, `assets.directory`는 `packages/cloudflare/dist/hosted/public`, `d1_databases[0].migrations_dir`은 `packages/cloudflare/migrations`의 절대 경로로 지정한다. `$schema`도 실제 `packages/cloudflare/node_modules/wrangler/config-schema.json`의 절대 경로로 바꾸거나 편집기용 항목을 제거한다. `build.cwd`는 checkout 루트로, `build.command`는 `node scripts/build-cloudflare.mjs --deployment-config "비공개 설정의 절대 경로"`로 바꾼다. JSON 안의 따옴표·Windows 역슬래시는 JSON 규칙대로 escape한다. 원래 예제의 `wrangler.jsonc` 경로를 그대로 남기지 않는다.
4. **topology를 보존하고 로컬 검증한다.** `workers_dev=false`, `preview_urls=false`, `assets.run_worker_first=true`, 세 binding, `FloraAuth` SQLite migration `v1`을 유지한다. `routes: []`로 시작하고 추가 trigger·공개 origin·외부 binding·요청 내용 logging을 켜지 않는다. build validator는 모든 임의 Wrangler 옵션을 감사하지 않으므로 최종 설정을 검토한다. 아래 `PRIVATE_CONFIG`와 `PRIVATE_OUTDIR`는 같은 컴퓨터의 실제 절대 경로로 바꾼다. 앞의 build가 생성하는 `dist/config.js`가 필요하다.

```sh
node scripts/build-cloudflare.mjs --deployment-config "PRIVATE_CONFIG"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --dry-run --config "PRIVATE_CONFIG" --outdir "PRIVATE_OUTDIR"
```

5. **선택한 원격 DB에 schema와 identity를 따로 준비한다.** 아래 원격 명령은 실제 리소스를 변경하므로 확인한 계정·전용 DB에만 실행한다. `--local` 성공으로 원격 DB 준비를 대신하지 않는다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations list FLORA_DB --remote --config "PRIVATE_CONFIG"
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 migrations apply FLORA_DB --remote --config "PRIVATE_CONFIG"
```

Migration `0001_private_imports.sql`은 schema와 빈 용량 row만 만든다. 소유자 등록도 `flora_deployment` identity도 생성하지 않는다. 비공개 SQL 파일을 준비하여 아래 세 값을 Worker vars와 정확히 맞춘다. origin이 SQL quote를 포함한다면 SQL 규칙대로 escape하며, 예시 문자열을 그대로 실행하지 않는다.

```sql
-- 아래 세 문자열을 실제 FLORA_OWNER_ID / FLORA_ORIGIN / FLORA_DB_IDENTITY로 교체
INSERT INTO flora_deployment(singleton, owner_id, origin, db_identity)
VALUES (1, 'OWNER_ID', 'https://your-flora.example', 'DB_IDENTITY');
```

먼저 `SELECT singleton, owner_id, origin, db_identity FROM flora_deployment;`를 실행해 **row가 없을 때만** 위 INSERT를 한 번 적용한다. 기존 row가 있으면 세 값이 일치하는지 확인하고 INSERT를 건너뛴다. 불일치 DB는 중단한다. UPDATE/REPLACE/삭제로 바꿀 수 없는 marker다. SQL 실행 형식은 다음과 같으며 파일에는 비밀번호·토큰을 넣지 않는다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler d1 execute FLORA_DB --remote --config "PRIVATE_CONFIG" --file "PRIVATE_SQL_FILE"
```

적용 후 같은 SELECT로 marker 1개와 값 일치를 확인하고, `SELECT * FROM flora_capacity;`가 새 DB에서 count/bytes 모두 0인지, `PRAGMA foreign_key_check;`가 비어 있는지 확인한다. 실제 앱에 쓸 DB에 demo를 먼저 넣지 않는다. 첫 앱 반입 후에는 그 repository/root에 묶이고 다른 앱 반입은 충돌한다.

6. **잠긴 Worker와 정확한 hostname을 연결한다.** 설정·배포 파일 hash와 Git SHA를 기록한 후 아래 명령으로 최초 Worker/DO를 배포한다. 아직 route와 workers.dev가 모두 꺼져 있으므로 접속 주소는 없다. 같은 설정에 본인 hostname의 Custom Domain route(`pattern`, 확인한 `zone_id`, `custom_domain: true`)를 추가하고, DNS 충돌·TLS·무료 조건을 확인한 뒤 같은 명령으로 반영한다. Worker 이름·DO namespace·D1 UUID를 바꾸어 새 저장소를 만들지 않는다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm --dir packages/cloudflare exec wrangler deploy --config "PRIVATE_CONFIG"
```

실제 배포 version ID, DO/D1 binding, route, source·asset hash를 보존한다. 무료 quota 초과 시 인증 우회 origin으로 흘려보내지 않고 닫힌 상태로 실패해야 한다. 자동 배포 연결은 별도 결정이며 이 절차가 켜지 않는다.

7. **첫 주소는 `/login`이다.** 인증 없는 GET의 예상값은 `/login` 200, `/` 401, `/api/state` 401, `/index.html` 404다. HEAD 요청은 지원하지 않아 405다. `/`가 로그인 화면으로 redirect한다고 가정하지 않는다. TLS 오류나 다른 hostname으로 이동하면 비밀번호를 입력하지 않는다. 이 결과만으로 D1 정상이나 소유자 등록 완료가 입증되지는 않는다.
8. **등록 전에 배포된 synthetic gate를 통과한다.** [출시 조건 5–6](../release/password-hosting-evidence.md#ordered-production-gates)의 실제 Free CPU·메모리·admission·revocation·응답 유실 복구를 먼저 검증한다. 중요 측정이 불가능하면 등록과 비공개 반입은 대기한다. 테스트 자료로 실제 앱 DB를 선점하지 않도록 검증 자원과 운영 자원을 구분하며, 새 자원·보안 변경은 해당 권한 범위에서만 진행한다.
9. **소유자가 등록 후 실제 흐름을 확인한다.** synthetic gate를 통과한 뒤 아래 등록 절차로 `/setup`에서 직접 등록하고 `/login` 재로그인, 빈 `/api/state` 200, 승인된 호환 source→baseline 반입→이력 조회를 확인한다. 거절된 요청 뒤 정상 요청, 응답 유실 뒤 같은 원본 재반입, 중복 없는 receipt와 기존 자료 보존도 실제 배포에서 확인한다. 한도·성능·전송 복구가 확인되기 전에는 운영 준비 완료로 표시하지 않는다.

공식 명령과 Custom Domain 설정은 [Wrangler D1 명령](https://developers.cloudflare.com/d1/wrangler-commands/)과 [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)를 참고한다. 비공개 설정·SQL·반입 파일은 공개 Git/CI에 올리지 않는다.

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

`/setup`은 입력 화면이며 설정 토큰 발급기가 아니다. 저장소에는 안전한 운영용 발급 CLI가 아직 없다. 소유자 관리 경로에서 원문 토큰을 비공개로 준비하고, **base64url 텍스트가 아니라 decoded 32바이트의 SHA-256**을 계산해야 한다. `vars.FLORA_SETUP`은 문자열이 아닌 JSON object이며 다음 다섯 field만 허용한다.

| Field | 실제 타입과 값 |
| --- | --- |
| `digest` | 소문자 64자리 hex 문자열 |
| `issuedAt` | UTC epoch millisecond 정수 |
| `expiresAt` | `issuedAt + 600000` 정수 |
| `generation` | 이전에 발급한 모든 값보다 큰 양의 safe integer |
| `purpose` | 최초 `enroll`, 등록된 소유자 복구는 `recover` |

설정 배포 지연도 10분 유효기간에 포함한다. 발급한 generation·시각을 DB 백업 밖의 비공개 운영 원장에 기록하고, 실패·만료 후에도 같은 generation을 재사용하지 않는다. 관리 UI가 typed JSON object를 보존하지 못하면 허용된 config 배포 경로가 필요하다. 문자열 secret binding으로 넣어도 JSON으로 자동 해석되지 않는다. 안전한 발급·설정 경로가 없으면 등록은 잠긴 채로 남는다.

유효한 창에서 소유자가 `/setup`의 최초 등록을 선택해 지정 이메일·토큰·비밀번호·확인을 직접 제출한다. 등록 후 `FLORA_SETUP`을 일반 배포에서 제거한다. 응답을 잃으면 새 등록 창부터 열지 말고 먼저 `/login`에서 새 비밀번호를 확인한다. 비밀번호나 원문 토큰을 Worker vars에 넣지 않는다.

실제 설정 토큰과 비밀번호는 사용자가 유효한 HTTPS 화면에서 직접 생성·입력·확인·제출한다. 에이전트가 대신 생성·관찰·회수·저장하거나 채팅·URL·로그·소스에 넣지 않는다.

현재 계정의 실제 Free 활성화·남은 공유 용량부터 확인한다. 비용·결제·유료 plan이 필요하거나 실제 성능 한도를 충족하지 못하면 중단하고 재검토한다. 암호 강도 축소, 다른 로그인 방식, Access/R2, 자동 결제·배포로 우회하지 않는다. 소스 main push 허용은 이후 push마다 운영 자동 배포를 켜는 권한이 아니다.

## 인증 DB 복원 절차

이 절차는 소유자가 관리하는 운영 조건이며 자동 rollback 보호 기능이 아니다. 과거 snapshot에서 복원된 DO만으로는 그 snapshot 이후 발급되거나 소비된 더 높은 generation을 기억할 수 없다. 저장소 복원 자체가 안전하다고 가정하지 않는다.

1. 복원 전에 소유자가 관리하는 배포 경로에서 공개 인증을 잠그고 offline으로 전환한다. 아래 조건을 모두 확인할 때까지 공개 인증을 다시 열지 않는다.
2. 소유자가 관리하는 외부 배포 원장은 **복원 대상 DB/snapshot 밖에서 지금까지 발급한 가장 높은 generation**을 계속 보존해야 한다. 소비·만료 여부와 관계없이 모든 발급을 포함한다. 이 최고값을 입증할 수 없으면 인증을 offline으로 유지한다.
3. 백업이 이전에 등록된 동일 소유자의 **claimed-owner marker를 유지한다는 사실을 검증**한다. 등록 전 백업이나 소유권 상태가 불명확한 백업은 offline 상태로 남긴다. 소유권이 없다는 이유로 초기 `enroll`을 다시 열거나 새 소유권 등록으로 전환하지 않는다.
4. 복원된 모든 세션을 무효화하고, 외부 원장의 최고 발급값보다 **엄격히 높은 generation**의 새 승인된 `recover` 전용 설정을 준비한다. 기존 소유자 marker 확인, 전체 세션 무효화, 더 높은 recover-only generation 준비가 모두 완료된 뒤에만 공개 인증 재개를 검토한다. 새 발급값도 외부 원장에 보존하며, 사용자의 토큰·비밀번호 직접 처리 경계는 그대로 적용한다.

현재 코드에는 공개 인증을 닫은 상태에서 복원된 DO 세션을 모두 무효화하는 관리 CLI/API가 없다. 위 4단계를 수행할 검증된 운영 경로가 없다면 복원은 offline으로 유지한다. DO SQLite는 D1과 다르므로 D1 SQL로 인증 세션을 지우거나 D1 Time Travel로 이 조건을 대신할 수 없다.
