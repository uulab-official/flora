# Hosted D1 작업공간 384 MiB 용량 변경 검증

2026-10-16. 로컬 검증 후 같은 날 운영 D1에 적용했다. 아래에 두 검증 결과를 구분해 기록한다.

Reward iOS의 실제 PC Runner Export가 완료된 뒤 자산 업로드가 HTTP 409로 거절됐다. 당시 `dist/runner-resume-2026-10-16/evidence/capacity-on-reward-conflict.json`에서 canonical payload는 332,731,713바이트, 기존 상한은 335,544,320바이트로 여유가 2,812,607바이트였다. 물리 DB 크기는 342,970,368바이트였다. 앱별 원본 자산 사용량은 Isso 92,734,735바이트/63개, Promise 88,284,117바이트/74개, Reward 61,153,428바이트/75개로 모두 기존 앱 제한 이내였다.

`0011_workspace_capacity_384mib.sql`은 공유 canonical payload 상한만 335,544,320 → 402,653,184바이트로 늘린다. [Cloudflare D1 공식 제한](https://developers.cloudflare.com/d1/platform/limits/)의 무료 DB당 500MB 안에서 여유를 확보하는 변경이다. canonical payload는 물리 DB 크기가 아니므로 인덱스·회계 메타데이터를 포함한 실제 크기도 확인해야 한다. 요금제·Worker·리소스·앱 정책은 변경하지 않는다.

기존 `0009`의 incremental 회계 방식을 유지한다. CHECK 상한 변경 때문에 `flora_capacity` 1행과 `flora_capacity_ledger` 18행만 새 테이블에 값 그대로 복사한다. 의존 트리거 45개를 동일하게 복원하며, 그중 admission 18개의 상한 숫자만 바꾼다. 전체 원본이나 OTA 파일을 합산하는 회계 트리거로 되돌리지 않는다.

원본·설정·GitHub 연결·자산 bytes·배포·Runner·정책·전환 이력·immutable facts·sequence·인덱스와 수동 롤백 provenance는 유지한다. 앱별 원본 96MiB/128개, 자산당 16MiB, witness 32MiB/262,144개 제한도 동일하다. 키와 복구 저널에 접근하지 않는다.

전제 조건은 `0001`–`0010` 적용, 기존 320MiB CHECK, incremental ledger/index/guard, 96MiB 앱 guard, 수동 롤백 guard다. 기존 counter를 no-op UPDATE해 현재 ledger와 일치하는지도 검사한다. 누락·불일치는 기존 값을 보정하지 않고 전체 transaction을 거절한다.

## 로컬 검증

`packages/cloudflare/test/workspace-capacity-384.test.ts`에서 실제 workerd/D1 **3/3 통과**, 기존 320MiB·앱 96MiB 마이그레이션 인접 회귀 **5/5 통과**, Supervisor·Health **68/68 통과**, TypeScript 및 문법·diff 검사도 통과했다. 검증 출력은 `dist/runner-resume-2026-10-16/evidence/workspace-capacity-384-tests.log`, `capacity-adjacent-tests.log`에 기록했다.

- 18개 charged 테이블 모두 데이터가 있는 fixture에서 원본·이력·counter·fact·ledger·AUTOINCREMENT sequence가 정확히 보존된다. 기존 배포 조회, 자산 bytes 다운로드, Runner 완료 기록, baseline 조회도 유지된다.
- 트리거 177개와 스키마 object 수가 유지된다. 변경된 object는 CHECK 테이블 2개와 admission 트리거 18개뿐이다. 수동 롤백 guard와 나머지 정의는 동일하다.
- 신규 insert의 실제 D1 `rows_read`는 기존 이력을 두 배 늘려도 54 → 54다.
- 실제 320MiB payload를 채운 뒤 마이그레이션을 적용하고 기존 상한 초과 insert를 허용한다. 새 384MiB 정확한 경계에서 경쟁 insert 두 개 중 하나만 성공하고, 거절된 경쟁 요청과 overflow는 모든 이력을 보존한다.
- 이전 상한·앱 guard·롤백 guard·의존 트리거·회계 인덱스가 누락된 경우 전체 스키마·원본·회계가 rollback된다.

정규화한 workerd 스키마 지문(`_cf_METADATA` 포함): 적용 전 `944a03dcd98b9f34ca1ebaefd7b287107e2f361779ce3f739c03c5d95398f1f0`, 적용 후 `aebdb1c536f89c2244ceccc3d427312a6602a5443cbd45d346a6833a62faa28b`.

## 원격 적용 명령

Runner를 안전하게 유휴 상태로 두고 기존 행·회계·스키마 및 물리 크기를 보존해 비교한 뒤, **이 파일 전체만 한 transaction으로** 실행한다. 기존 마이그레이션 전체를 다시 실행하거나 SQL 일부만 실행하지 않는다.

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const sql = await readFile('packages/cloudflare/migrations/0011_workspace_capacity_384mib.sql', 'utf8');
const { stdout } = await promisify(execFile)(process.execPath, [
  'packages/cloudflare/node_modules/wrangler/bin/wrangler.js',
  'd1', 'execute', 'flora-uulab',
  '--config', 'dist/small-sample-rollback-2026-10-16/wrangler.jsonc',
  '--remote', '--command=' + sql, '--json',
], { shell: false, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(stdout);
NODE
```

기존 만료된 Runner 작업의 재시도는 정상 lease 만료·재획득 절차를 사용한다. 자산 삭제·과거 이력 덮어쓰기·임대 우회는 하지 않는다.

## 운영 적용 결과

2026-10-16 14:16 UTC(23:16 KST), 운영 DB의 소유자·DB identity·Time Travel bookmark·기존 snapshot을 확인한 뒤 위 SQL 전체 103개 문장을 한 transaction으로 실행했다. 전부 성공했다.

- canonical payload는 적용 전후 332,731,713바이트로 동일하다. ledger 18행과 기존 배포 116행도 값 그대로 보존됐다.
- 운영 스키마 object 209개 중 바뀐 것은 상한을 담은 20개뿐이다. 수동 롤백 provenance와 기존 immutable guard는 동일하며 foreign key 위반은 0건이다.
- 물리 DB 크기는 342,970,368 → 342,974,464바이트로 한 페이지(4KiB) 증가했다.
- `CONFLICT`·`INVALID_TRANSITION` 제어 코드 보강을 포함한 Supervisor를 14:17 UTC에 설치했다. 기존 Reward lease 만료, publication 부재, 복구 저널 0건을 확인한 뒤 서비스를 정상 시작했다. 실제 후속 OTA 성공 여부는 별도 Runner 검증 기록에서 확인한다.

마이그레이션 SQL SHA256은 `193015c6bb5a190d71c15bb0d5fd5bd62ad3503f068ab69c5541da203f6ac2f3`, 설치한 Supervisor SHA256은 `a2333aa63e30cf67d21f08a1b9a379c13df48e434efd0522a7ad5572f2dd3e84`다.

Supervisor는 서버의 고정 제어 코드 `CONFLICT`, `INVALID_TRANSITION`도 로그에 보존한다. HTTP 409는 계속 안전 중지하며, 이 코드는 informational `compilerCode`와 분리된다. 인증·Claim·Presence·복구 검증을 완화하지 않는다.
