# Hosted D1 작업공간 320 MiB 용량 변경 검증

2026-10-15. 이 문서는 로컬 migration 검증 기록이다. 원격 DB 적용은 별도 확인한다.

`0009_workspace_capacity_320mib.sql`은 기존 0001–0008 적용 상태에서 작업공간의 canonical payload 상한만 268,435,456 → 335,544,320바이트로 늘린다. 기존 OTA 파일과 배포 이력을 삭제하거나 재작성하지 않는다. 실제 D1 디스크 크기에는 인덱스와 회계 메타데이터가 추가되므로 이 상한이 물리 DB 크기를 뜻하지 않는다.

SQLite CHECK 변경을 위해 `flora_capacity` 1행과 `flora_capacity_ledger` 18행만 새 테이블에 그대로 복사한다. 두 테이블에 의존하는 45개 트리거는 현재 0001–0008의 최종 정의로 복구한다. 그중 18개 admission 트리거의 상한 숫자만 변경한다. 기존 0006의 전체 이력 합산 트리거를 다시 사용하지 않는다.

`flora_capacity_facts`, 원본·설정·GitHub 연결·OTA·Runner·정책·이력 테이블, 인덱스, 나머지 131개 트리거는 그대로다. 앱별 96 MiB / 128개 파일, 파일별 16 MiB, witness 32 MiB / 262,144개 제한도 유지한다. 인증서와 키는 별도 Durable Object에 있으므로 이 SQL이 접근하지 않는다. 실제 키 보존 여부는 원격 메타데이터 비교로 별도 검증해야 한다.

전제 조건 검사와 기존 incremental 회계 guard 검사가 먼저 실행된다. 전제 조건 누락·회계 불일치 시 기존 값을 고치지 않고 전체 transaction을 거절한다. 이 파일 전체를 하나의 D1 migration transaction으로 실행해야 한다. 기존 번호 전체를 다시 적용하는 명령은 사용하지 않는다.

## 검증 결과

실제 로컬 workerd/D1 테스트 파일 `packages/cloudflare/test/workspace-capacity-320.test.ts` 3/3 통과:

- 18개 charged 테이블 모두 기존 데이터를 가진 fixture에서 모든 원본 행, counter, fact, ledger, AUTOINCREMENT sequence가 정확히 보존됨. 배포 조회·기존 파일 다운로드·Runner 완료 이력·baseline 조회가 유지됨.
- 스키마 object 수와 176개 트리거 유지. 정규화한 변경은 테이블 2개 CHECK와 admission 18개로 정확히 제한됨.
- 새 insert의 실제 D1 rows_read는 이력을 2배 늘려도 54 → 54. 앱 96 MiB, 파일 16 MiB, 파일 수 128 제한 및 원본·회계 불변 보호 확인.
- 실제 256 MiB payload를 채운 뒤 migration 적용. 기존 256 MiB 초과 insert를 새로 허용하고 정확히 320 MiB에서 동시 insert 2개 중 1개만 성공. 실패한 경쟁 요청과 추가 overflow가 원본·fact·ledger를 변경하지 않음.
- 0007 누락, 0008 누락, 의존 트리거 누락 각각 전체 schema·원본·회계 rollback 확인.

전체 suite는 이 변경의 범위에서 재실행하지 않았다. 데이터가 큰 경계 fixture는 SQL 집계로 비교하며, 작은 전체 이력 fixture는 각 원본 행을 정확히 비교한다.

## 스키마 지문

SQL 파일 SHA256: `42207d09c5be505f549f0cdb9c58d773a931958ad36417f52623bb67c4a961c4`.

앱 스키마 지문 계산은 `sqlite_master`에서 `sqlite_%`, `_cf_*`를 제외하고 type/name으로 정렬한 `{type,name,tbl_name,sql}` 목록을 사용한다. SQL의 이중따옴표와 연속 공백을 정규화한 뒤 canonical JSON의 SHA256을 계산한다. object 206개 기준:

- 적용 전: `227e76eee045cde2eee52edbec563fd0f7962f6ca83c4cf16740cdb2d0706f87`
- 적용 후: `cda57d0f1587dda3bb6a9dfe5c88e2b989e583bd53fc84f2cd63e6efc2e052b5`

테스트 workerd의 `_cf_METADATA`까지 포함한 object 207개 지문:

- 적용 전: `00cead8514ba6ab6dae663ce1a4777a54124c8dacdf598da20699b0bef33ccd9`
- 적용 후: `9a77b87829e88605b30a00d65070380f54a7078aaafa070bbc09ebf99c7112ef`

변경된 20개 object 이름: `flora_capacity`, `flora_capacity_ledger`, `application_capacity`, `settings_capacity`, `inventory_capacity`, `baseline_capacity`, `head_capacity`, `github_connections_capacity`, `github_detections_capacity`, `ota_assets_capacity`, `ota_asset_chunks_capacity`, `ota_deployments_capacity`, `ota_deployment_assets_capacity`, `automation_runners_capacity`, `automation_jobs_capacity`, `automation_transitions_capacity`, `automation_guards_capacity`, `automation_asset_refs_capacity`, `automation_policies_capacity`, `automation_publications_capacity`.
