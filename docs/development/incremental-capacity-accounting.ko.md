# D1 증분 저장 용량 회계

`0007_incremental_capacity_accounting.sql`은 charged row를 추가할 때마다 기존 이력 테이블 18개의 `SUM(stored_bytes)`를 다시 읽던 동작을 바꾼다. 기존 source·설정·GitHub·OTA·Runner 이력, `flora_capacity` 값, 256 MiB canonical payload 한도와 앱별 64 MiB·128개 자산 한도는 유지한다. 원격 DB 적용 및 Reward Android 재배포 완료 여부는 별도 운영 기록에서 확인한다.

## 보존하는 검증과 새 구조

기존 UPDATE·DELETE·logical-key REPLACE 금지, owner/app 외래키, byte charge, 버전·lease·authority·provenance 검사와 INSERT 용량 검사는 그대로 둔다. 바꾸는 기존 trigger는 INSERT 회계 18개와 `capacity_integrity` 하나다. 기존 `flora_capacity` 관련 trigger 39개가 모두 남는다.

`flora_capacity_facts`는 source row의 **실제 logical PK를 SQLite `json_array`로 직렬화한 key**와 `stored_bytes`만 기록한다. Source JSON·자산·Runner token·인증서·개인키는 복사하지 않는다. `(table_name, record_key)` UNIQUE와 immutable UPDATE·DELETE·REPLACE guard가 같은 row에 대한 재계상을 막는다. 각 fact는 기존 source PK/unique index로 실제 row와 bytes를 확인하고, key가 actual PK의 canonical JSON과 정확히 같은지도 확인한다. 공백이나 정수 `1`을 `1.0`으로 바꾼 key가 같은 source에 두 번째 credit을 줄 수 없다.

`flora_capacity_ledger`는 테이블마다 row 수·payload 합계·witness byte 합계·마지막 fact sequence를 유지하는 고정 **18행**이다. 각 fact의 sequence는 명시적인 `INTEGER PRIMARY KEY AUTOINCREMENT`다. Aggregate를 바꾸려면 실제 최신 fact의 sequence, 이전보다 큰 sequence, 정확히 한 행의 증가와 해당 fact의 bytes 증가가 모두 맞아야 한다. Fact가 생길 때 ledger를 먼저 갱신하고 source의 기존 회계 trigger가 `flora_capacity`를 갱신한다. Counter는 이 18행의 합계 및 inventory/baseline 수와 같아야 한다. 모든 작업이 같은 INSERT transaction 안에서 끝나므로 직접 ledger/counter를 고치거나 이전 fact를 replay할 수 없다.

Source의 숨은 rowid는 cache나 witness에 저장하지 않는다. [SQLite rowid 문서](https://www.sqlite.org/rowidtable.html)와 [VACUUM 문서](https://www.sqlite.org/lang_vacuum.html)에 따라 저장소 재구성이 숨은 rowid를 바꿔도 logical PK와 명시적인 fact sequence는 유지된다. 별도 source BEFORE INSERT point lookup은 logical PK가 다른 explicit rowid REPLACE 충돌도 거절한다. [SQLite trigger 문서](https://www.sqlite.org/lang_createtrigger.html)의 BEFORE INSERT 자동 rowid 값은 미정이다. 현재 엔진의 `-1` sentinel과 충돌하는 수동 legacy row가 있으면 최초 indexed preflight가 schema 변경 전에 migration을 중단한다. 신규 actual rowid `-1`도 AFTER INSERT에서 transaction 전체를 거절한다. 정상 API는 rowid를 지정하지 않고 양수로 생성한다. 수동 legacy `-1`이 발견되면 기존 자료를 그대로 보존하고 운영자가 확인하며, 자동 삭제·재번호·수정은 하지 않는다. 다른 negative rowid인 `-10`과 비순차적인 noncolliding rowid는 테스트에서 유지한다.

## 별도로 제한하는 회계 메타데이터

Witness key는 16 KiB, canonical witness payload 합계는 **32 MiB**, witness row 수는 **262,144개**를 넘지 못한다. 이 제한은 기존 userdata의 256 MiB counter와 별도이며 기존 counter 값을 바꾸지 않는다. Key는 normal API의 owner/ID/version/hash PK 필드 범위를 포함한다. 기존 SQL에만 수동으로 기록한 과도한 key나 metadata budget 초과가 있으면 bootstrap 전체가 rollback되며 기존 row를 줄이거나 truncate하지 않는다.

Witness byte charge는 `json_array(table_name, record_key || '', stored_bytes)`의 UTF-8 byte 수다. `|| ''`는 key를 plain TEXT로 고정하여 INSERT에서 남은 JSON subtype과 저장 후 읽은 TEXT 사이의 canonical byte 차이를 없앤다. D1에서 저장한 실제 fixture를 다른 SQLite 연결로 복사한 CHECK 및 VACUUM 테스트에서 이 차이를 검증한다.

32 MiB는 canonical metadata 상한이며 SQLite 물리 파일 크기와 같지 않다. Fact table의 두 index, record/page overhead가 추가된다. Source/history 전체를 복제하지 않고 PK와 charge만 추가하며 row 수와 key 길이도 제한하므로 이 비용도 유한하다. 적용 전후 실제 database size와 metadata row/byte 합계를 함께 기록한다. 새 DB·스토리지·유료 리소스는 만들지 않는다. Metadata admission과 counter 검증은 고정 18행의 합계를 읽고, 매 INSERT마다 전체 facts/history를 COUNT 또는 SUM하지 않는다.

## 로컬 측정과 검증

같은 actual local workerd/D1에서 이력 1,024개를 만든 다음 단일 charged append를 측정하면 legacy는 **1,058 read / 4 write**, 최종 stable witness는 **53 read / 9 write**다. 이력을 2,048개로 늘려도 migrated read는 53으로 같다. Source table의 증분 회계에 필요한 metadata/index write는 추가되지만 누적 history의 전체 조회는 제거된다.

Authenticated synthetic Worker→DO→D1 경로에서 1 MiB 자산을 가진 완료 배포 6개와 transition 90개를 만든 측정은 다음과 같다. 이후 heartbeat fact 64개를 추가해 기존 transition 158개를 유지한 상태에서도 heartbeat read는 72로 같았다. 실제 GitHub Runner·기기 적용 증거와 구분하는 로컬 fixture 측정이다.

| 요청 | legacy read/write | 최종 stable witness read/write |
|---|---:|---:|
| Build claim | 297 / 3 | 87 / 8 |
| Heartbeat | 206 / 3 | 72 / 8 |
| 1 MiB asset | 약 981 / 15 | 285–287 / 39 |

```sh
node --test packages/cloudflare/test/capacity-accounting.test.ts
node --experimental-strip-types --test --test-concurrency=1 --test-name-pattern='complete Runner endpoints retain' packages/cloudflare/test/automation-http.test.ts
```

최종 SQL hash의 회계 suite **17/17**과 해당 파일의 strict TypeScript 검증이 통과했다. 회계 suite는 18개 기존 history와 receipt/counter 보존, 기존 safety trigger 보존, 18개 모두의 신규 운영 fact, fabricated/duplicate/noncanonical/replayed witness 거절, direct counter/ledger tamper 거절, hidden-rowid REPLACE 및 수동 `-1` rollback, zero-charge legacy row, source rowid renumber와 실제 SQLite VACUUM, migration/writer 경쟁, 실패 migration과 concurrent writer의 보존을 검사한다. 실제 charged row로 256 MiB 경계의 두 INSERT 경쟁, 앱별 64 MiB·128개 자산과 앱 100개·inventory 100개·baseline 500개 한도도 확인한다. Oversized manual legacy key의 실패 시 원래 schema·row·counter가 남는지 확인한다. 원격 `0007` 적용은 이 로컬 결과에 포함되지 않는다.

## 적용 순서와 transaction

1. 대상 account/DB/binding identity, `0001`~`0006` schema와 256 MiB CHECK, 마지막 backup/bookmark를 확인한다. 기존 모든 source/history·receipt의 보존 기준과 counter, 물리 크기를 확보하고 key/metadata 사전 집계를 기록한다. `flora_capacity_facts` 또는 `flora_capacity_ledger`가 이미 있는지 확인한다.
2. **전체 신규 SQL 파일 하나를 한 transaction**으로 적용한다. 초기 전체 감사가 현재 counter를 확인하고, 18개 source에서 fact를 bootstrap한 다음 ledger를 만든다. 마지막 전체 source/fact 감사 및 counter self-update가 불일치하면 전체 변경이 rollback된다. 진행 중 INSERT는 migration transaction 앞이나 뒤로 직렬화되어 일부 schema만 보지 않는다. 기존 Runner export나 lease를 취소할 필요는 없다.
3. Migration ledger를 사용하는 DB는 [공식 D1 migration runner](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)를 사용하고 `0007`만 미적용인지 확인한다. 기존 수동 적용 DB는 아래 단일 파일 관리자 경로를 사용한다. 기존 migration들을 재실행하거나 새 migration ledger를 임의로 도입하지 않는다.
4. 완료 후 기존 row/receipt·guard 정의를 보존 기준과 비교한다. 동시에 실제 작업이 진행됐다면 기존 row subset은 그대로여야 하고 새 row 증가는 허용한다. Counter와 source/fact/ledger의 일치는 같은 DB 조회 안에서 확인한다. `PRAGMA foreign_key_check`, 물리 크기, 메타데이터 상한, 실제 read/write 측정 및 Runner 상태를 기록한다.

Ledger가 없는 기존 DB의 관리자 경로는 [D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)의 **하나의 `sql` 값에 파일 전체 내용**을 그대로 전달한다. Wrangler 4.148.0의 `buildMigrationQuery`/`executeRemotely`도 전체 migration SQL을 이 `/query` 요청으로 전달한다. 공식 migration 문서의 실패 rollback 경로와 동일한 전체 SQL 요청이며, 로컬 counterpart는 complete statement들을 하나의 `D1Database.batch()`로 실행한다. `0007` 최종 파일은 58,833 bytes·SQL 128개다. INSERT trigger 안의 SELECT/INSERT/UPDATE를 SQL 하나로 유지해야 하므로 세미콜론 단순 split이나 DROP/CREATE별 개별 요청을 사용하지 않는다. 무료 Worker의 query 개수 제한이 있는 앱 API로 이 파일을 실행하지 않는다.

```text
POST /client/v4/accounts/<verified-account-id>/d1/database/<verified-database-id>/query
{"sql":"<complete contents of 0007_incremental_capacity_accounting.sql>"}
```

응답 최상위 및 각 result의 success와 최종 table/trigger/counter를 확인한다. 적용 결과가 불명확하면 먼저 새 schema와 counter를 읽는다. 이 SQL은 이미 적용된 상태에서 다시 실행하지 않으며, 실패한 중간 statement부터 이어 실행하지 않는다. 전체 실패는 원래 schema·자료로 돌아가므로 원인을 분류한 뒤 전체 transaction을 다시 검토한다. 일일 한도가 남아 있으면 한도 초기화 후 정상 관리자 경로로 진행한다. 이 문서는 한도 우회나 history 삭제를 허용하지 않는다.

최종 SQL SHA-256: `e2ac8fdba56d1f8964cf0b63ee5ea240e899b915d81ba0435d8f245bd7690e38`.
