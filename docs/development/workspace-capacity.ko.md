# Flora 작업공간 저장 용량

`0005_workspace_capacity_192mib.sql`은 128→192 MiB 확장의 기존 migration이며 파일을 수정하지 않는다. 후속 `0006_workspace_capacity_256mib.sql`은 현재 192 MiB의 canonical payload 한도를 **256 MiB(268,435,456 bytes)**로 늘린다. 기존 앱들의 자료를 보존하면서 서로 다른 앱 세 개의 iOS·Android OTA 여섯 개를 함께 저장하기 위한 제한된 확장이다. 앱별 자산 한도 **64 MiB·128개**, 단일 자산 16 MiB, 작업공간 앱 100개·source 100개·baseline 500개 한도는 유지한다.

2026-10-14 확인한 [Cloudflare D1 공식 제한](https://developers.cloudflare.com/d1/platform/limits/)은 Free 데이터베이스당 500 MB, 계정 전체 5 GB다. Flora payload는 SQLite의 실제 파일 크기와 별개이며 base64 자산과 JSON 메타데이터를 포함한다. 256 MiB는 Flora가 정한 canonical payload 상한이며 500 MB 물리 파일 한도와 동일하지 않다. 테이블·인덱스·SQLite 페이지 여유를 포함한 실제 database 크기를 적용 전후에 확인한다. 일일 읽기·쓰기 사용량과 계정의 다른 데이터베이스 사용량은 별도로 확인한다. 새 데이터베이스·R2·유료 리소스는 추가하지 않는다.

SQLite는 기존 CHECK 제한을 직접 바꿀 수 없어 `flora_capacity`의 단일 행만 새 CHECK를 가진 테이블로 복사한다. 모든 데이터·설정·GitHub·OTA·Runner 이력 테이블은 그대로 둔다. 이 counter를 참조하는 trigger 39개를 기존 정의대로 복원하며, INSERT 용량 검사 18개의 workspace 한도만 변경한다. 마지막 self-update는 기존 counter를 고치지 않고 전체 합계와 동일한지 검사한다. 불일치하면 migration 전체가 실패한다.

## 적용 순서

1. 대상 계정·데이터베이스 identity, 기존 `flora_capacity` 값, 테이블별 행 수·stored-byte 합계·앱별 최신 receipt를 읽어 보존 기준을 확보한다. Runner의 진행 중 작업을 정리하고 적용 중 새 업로드가 시작되지 않도록 한다.
2. 기존 설정 파일의 `FLORA_DB` binding과 실제 database ID를 확인한 뒤 migration ledger를 조회한다. `0001`~`0005`가 이미 적용·기록되어 있고 **`0006_workspace_capacity_256mib.sql`만 미적용인지** 확인한다. Ledger가 없는 수동 적용 DB는 아래의 단일 파일 관리자 경로를 사용하며, 기존 SQL을 재실행하거나 이번 작업에서 ledger를 도입하지 않는다.

```sh
pnpm --dir packages/cloudflare exec wrangler d1 migrations list FLORA_DB --remote --config "$FLORA_PRIVATE_CONFIG"
pnpm --dir packages/cloudflare exec wrangler d1 migrations apply FLORA_DB --remote --config "$FLORA_PRIVATE_CONFIG"
```

3. [D1 migration runner](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)로 **전체 파일을 한 migration transaction**으로 적용한다. 실패 시 해당 migration이 rollback된다. 중간 DROP/CREATE를 개별 호출로 실행하거나 무료 Worker의 50-query 요청 경로에 넣지 않는다. 이전 migration 파일은 수정하지 않는다.
4. 적용 직후 counter·모든 기존 행·receipt가 기준과 같은지 비교한다. `sqlite_master`의 table CHECK와 18개 INSERT 검사에 `268435456`가 들어갔고, 이전 `201326592` 검사가 남지 않았는지 확인한다. `PRAGMA foreign_key_check` 결과가 비었는지 확인하고 Runner를 재개한다.

### Ledger가 없는 기존 DB의 단일 파일 관리자 적용

이 경로는 운영 담당자가 대상 DB의 backup과 schema `0001`~`0005`를 확인한 뒤 실행한다. 파일은 **`0006_workspace_capacity_256mib.sql` 하나만** 사용한다. SQL 83개를 분리된 API 호출로 실행하지 않는다.

[D1 관리자 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)는 한 `sql` 값에 세미콜론으로 연결된 SQL을 batch로 받는다. 관리자 연결에서 다음 **단일 요청**의 `sql`에 신규 파일 전체 내용을 그대로 전달한다. 기존에 승인된 관리 연결을 사용하고 토큰을 파일·로그에 쓰지 않는다.

```text
POST /client/v4/accounts/<verified-account-id>/d1/database/<verified-database-id>/query
Content-Type: application/json

{"sql":"<complete contents of 0006_workspace_capacity_256mib.sql>"}
```

Wrangler 4.148.0의 `--command`를 통해 같은 관리자 요청을 실행할 때는 SQL 주석의 첫 `--`가 옵션으로 해석되지 않도록 **`"--command=" + sql`을 한 argv 값**으로 전달한다. 셸 치환을 사용하지 않는다.

```js
spawn(nodePath, [
  wranglerPath, "d1", "execute", "FLORA_DB", "--remote",
  "--config", privateConfig, "--command=" + sql, "--json"
], { shell: false });
```

보존 snapshot은 counter 조회, 20개 테이블의 개별 COUNT·stored-byte 조회, schema 조회, FK 검사로 구성한다. 큰 `UNION ALL` 대신 개별 SELECT 20개를 사용하며 결과는 총 23개다. Counter는 결과 0, 테이블 집계는 1~20, schema는 21, FK 검사는 22에서 비교한다.

로컬 검증은 동일한 전체 SQL을 `D1Database.batch()`의 한 transaction으로 실행하고, 마지막 SQL이 실패하면 table 교체와 모든 trigger까지 원상 복구되는 것을 확인한다. 관리자 endpoint의 단일 batch 실행으로 적용 후 전체 `result[].success`와 최상위 `success`를 확인하고, 위 4번 보존 비교를 완료한다. 실패한 경우 중간 SQL부터 이어 실행하지 않는다. 적용 파일 SHA-256, 응답 결과, 적용 전후 기준을 운영 evidence에 기록하며 ledger 변경은 이 migration의 범위에 포함하지 않는다.

## 로컬 검증

```sh
node --test packages/cloudflare/test/capacity-migration.test.ts
```

실제 local workerd/D1에서 20개 테이블 모두에 기존 자료를 넣고 전체 행·counter·receipt 보존, trigger 정의 보존, 반복 적용, 마지막 SQL 실패의 전체 rollback, REPLACE·삭제·가짜 counter 거절을 검증한다. 기존 0005의 192 MiB와 신규 0006의 256 MiB를 각각 실제 charged row로 채운 마지막 두 INSERT 경쟁은 하나만 성공해야 하며, 한도 초과 후에도 기존 배포·수입 receipt가 읽혀야 한다. 앱별 64 MiB·128개 자산 한도도 실제 업로드로 확인한다. 0006은 0001~0005 적용 상태에서 검증하며 0005의 바이트와 동작도 함께 보존한다. 이 문서는 원격 적용이나 기기 OTA 적용 완료를 의미하지 않는다.
