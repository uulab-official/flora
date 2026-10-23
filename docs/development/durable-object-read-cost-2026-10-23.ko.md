# Native Runner 유휴 조회의 Durable Object 읽기 비용

기준 소스: `38459a625facbbe3c7e83f31d7a16da2966e731d`.
이 문서는 로컬 합성 데이터 측정이며 운영 요청별 기여도나 운영 사용량 감소를 증명하지 않는다.

## 확인한 경로와 변경

Native daemon은 기본 60초마다 각 앱·플랫폼의 `POST /api/native-runner/pending`을 호출한다.
별도의 60초 presence 타이머는 빌드 실행 중에도 동작한다.
요청은 Worker → FloraAuth의 Origin/본문/권한 검사 → NativeBuildStore.pending으로 이어진다.

기존 pending은 같은 앱의 실행 중 lease와 queued 작업을 각각 JSON 조건으로 검색했다.
`UNIQUE(app_id, request_key)` 인덱스는 앱 범위만 좁혀, 완료된 이력도 매번 읽었다.
queued 검색은 정렬용 임시 B-tree도 사용했다.

NativeBuildStore 생성자에 `CREATE INDEX IF NOT EXISTS` 두 개를 추가했다.

- `flora_native_jobs_pending`: queued 행만 보관하며 앱·플랫폼·createdAt·id 순서를 지원한다.
- `flora_native_jobs_active_runner`: leased/cancel_requested 행만 보관하며 앱·Runner·lease 만료 조건을 지원한다.

후속 수정은 같은 active 인덱스를 사용해 두 번의 불필요한 이력 읽기를 줄인다.
claim의 Runner 중복 실행 검사는 앱 전체 JSON을 읽는 대신 해당 Runner의 미만료 활성 작업 존재만 확인한다.
목록 조회 전 expireStale은 만료 처리 대상인 leased/cancel_requested 작업만 읽는다.
기존 lease 만료 및 2시간 실행 기한, 취소·실패 상태와 이벤트 기록 조건은 유지한다.

FIFO 순서, 권한 fence, credential 검증, 세션 취소, Runner 조회 주기,
heartbeat, 타임아웃은 변경하지 않는다. 완료 이력은 삭제하거나 다른 형식으로 바꾸지 않는다.
인증 캐시는 도입하지 않는다. 작업 목록 자체의 이력 반환은 유지한다.

## 측정 방법과 결과

Node 24.19.0 / pnpm 11.19.0 / 저장소의 고정 Miniflare·workerd를 사용한다.
`native-read-cost-entry.ts`는 테스트에서만 실제 `sql.exec`가 반환한 cursor를 보관하고,
HTTP 처리 후 `rowsRead`와 `rowsWritten`을 합산한다. SQL 인자나 결과를 바꾸지 않는다.
운영 bundle에는 이 fixture가 들어가지 않는다. D1 비용은 이 합계에 포함하지 않는다.

두 앱에 각각 완료 이력 100건을 넣은 **동일 DB**에서 인덱스를 제거해 측정한 뒤,
실제 FloraAuth 생성자로 다시 적용하고 동일한 인증 Runner 요청을 보냈다.

| 같은 DB의 유휴 pending 한 번 | 인덱스 없음 | 인덱스 적용 후 |
| --- | ---: | ---: |
| DO rowsRead | 223 | 21 |
| 작업 검색 rowsRead | 203 | 1 |
| 인증 관련 rowsRead | 17 | 17 |
| SQL 호출 수 | 22 | 22 |
| rowsWritten | 0 | 0 |

이 실행의 감소율은 약 90.6%다. 이력 0/20/200건과 반복 요청 모두 적용 후 21행이다.
무작위 앱 ID의 인덱스 배치 때문에 인덱스 없는 별도 fixture 실행은 221~223행이었다.
쿼리 계획은 queued 전용 인덱스 탐색으로 바뀌고 임시 정렬이 사라졌다.

별도 수정 전후의 같은 논리 시나리오에서는 queued 조회가 230 → 29행이었다.
세션 조회는 13행, presence는 첫 요청 17행/쓰기 1행, 직후 반복은 16행/쓰기 0행으로 유지됐다.
후속 쿼리 수정 전후, 동일한 논리 데이터와 HTTP 요청 시나리오의 측정은 다음과 같다.
각 실행은 새 합성 DB를 사용하므로 앞의 동일 물리 DB 인덱스 비교와 구분한다.

| 요청 | 인덱스만 적용 | 후속 쿼리 수정 | 인증 읽기 | 쓰기 |
| --- | ---: | ---: | ---: | ---: |
| claim | 122 | 22 | 14 → 14 | 4 → 4 |
| 작업 목록 | 324 | 223 | 18 → 18 | 0 → 0 |
| 유휴 pending | 21 | 21 | 17 → 17 | 0 → 0 |

claim의 작업 읽기는 103 → 3행, 목록의 작업 읽기는 302 → 201행이었다.
별도 실행의 무작위 ID 배치에 따라 1–2행 차이가 날 수 있다. 운영 계정의 감소율로 환산하지 않는다.
목록은 요청한 작업과 이벤트를 계속 반환하므로 그 비용은 남는다.

쓰기 비용도 구분한다. 합성 시나리오에서 claim은 3 → 4행, heartbeat는 1 → 2행 쓰기로 증가했다.
기존 완료 이력 200건에 두 인덱스를 처음 만드는 비용은 402행 읽기·2행 쓰기였다.
재시작 시에는 기존 인덱스를 다시 만들지 않았고 인덱스 읽기·쓰기는 0이었다.
queued/active 행이 있으면 최초 생성 쓰기 비용은 더 커질 수 있다.

이력 보존, 동일 createdAt의 id 순서, 기존 queued/active 데이터의 인덱스 생성,
cancel_requested lease 차단, 만료 후 다음 작업 선택을 테스트한다.
기존 테스트는 앱·플랫폼 격리, 철회·owner epoch, 본문 대기 중 철회,
credential 회전, heartbeat·실행 취소 등을 계속 검증한다.
후속 회귀 테스트는 같은 Runner의 leased/cancel_requested 충돌, 다른 Runner 배정,
만료 lease, 절대 실행 기한, 타 앱·종료 이력 보존, 철회된 fence와 이벤트 중복 방지를 검증한다.
클라이언트의 대기·재조회 시간을 늘리지 않았으므로 의도적인 작업 배정 지연은 추가하지 않았다.

## 재현

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
node --test --test-name-pattern='native idle HTTP' packages/cloudflare/test/native-http.test.ts
node scripts/test.mjs packages/cloudflare/test/native-build-store.test.ts packages/cloudflare/test/native-http.test.ts packages/cloudflare/test/auth.test.ts packages/ota-runner/test/native-controller.test.ts
pnpm check
pnpm verify:clean
```

테스트는 localhost 포트와 임시 SQLite 저장소가 필요하다. 원격 계정, 운영 DB,
서비스 credential, 부하 테스트는 사용하지 않는다.

## 별도 승인 후 운영 반영과 롤백

이 변경을 검증하는 과정에서는 운영 배포나 운영 마이그레이션을 실행하지 않는다.
운영 적용 전에는 현재 배포 버전과 소스 일치, 기존 바인딩·DO identity 유지,
현재 UTC 일일 읽기·쓰기 여유 및 최근 오류를 확인해야 한다.
배포가 승인되면 기존 DO가 새 생성자를 실행할 때 additive 인덱스가 만들어진다.
D1 migration이나 새 Durable Object class migration은 필요하지 않다.

표현식 인덱스 생성은 기존 JSON을 읽는다. 손상된 JSON 또는 저장소/용량 오류로 생성이 실패하면
기존 생성자의 오류 처리에 따라 native 기능이 unavailable로 남을 수 있다.
정상 앱 데이터의 로컬 업그레이드만 검증했으며 운영 데이터의 건전성을 추정하지 않는다.
첫 생성 비용과 heartbeat의 추가 쓰기를 배포 전 용량 판단에 포함한다.

승인된 배포 후에는 같은 UTC 기간의 namespace rowsRead/rowsWritten, 오류,
작업 배정 지연, Runner 상태, 취소·철회 반영을 확인한다. 로컬 감소율을 계정 전체 감소율로 쓰지 않는다.
문제 발생 시 직전 검증된 Worker 버전으로 롤백한다. 기존 코드는 추가 인덱스와 호환되며 이력은 유지된다.
코드 롤백만으로 인덱스가 삭제되지는 않는다. 인덱스 쓰기 비용까지 되돌려야 한다면
별도 승인된 운영 SQL 변경으로 두 인덱스를 제거해야 한다. 테이블·이력 삭제는 필요하지 않다.

참고: [Cloudflare SQLite cursor 계측](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Durable Objects 가격과 일일 한도](https://developers.cloudflare.com/durable-objects/platform/pricing/).
