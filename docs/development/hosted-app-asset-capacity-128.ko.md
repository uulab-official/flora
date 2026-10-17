# Hosted D1 앱별 자산 128 MiB 용량 변경 검증

2026-10-16 작업 기록. 로컬 검증과 독립 검토를 거쳐 운영에 적용했다.

실제 자동 OTA 검증 후 Isso의 원본 자산은 97,447,100바이트였다. 기존 앱 상한 100,663,296바이트에서 여유 3,216,196바이트는 다음 약 4.7MB 번들보다 작았다. Promise는 93,041,803바이트로, 여유 7,621,493바이트가 다음 두 플랫폼 약 9.3MB보다 작았다. 따라서 공유 작업공간에 여유가 있어도 다음 커밋의 배포가 앱별 제한에서 막힐 상태였다.

`0012_hosted_app_asset_capacity_128mib.sql`은 `ota_app_capacity` 한 트리거의 앱별 원본 자산 합계 상한만 **96 → 128MiB(134,217,728바이트)**로 늘린다. 자산 수 128개, 자산당 16MiB, 공유 canonical payload 384MiB는 유지한다. 여러 앱의 메타데이터와 base64 chunk 등 canonical payload 합계는 공유 guard에서도 별도로 검사한다. [Cloudflare D1 무료 DB당 500MB 제한](https://developers.cloudflare.com/d1/platform/limits/)과 물리 DB 공간은 그대로 적용된다. 요금제·Worker·앱 정책·조회 주기는 변경하지 않는다.

이 SQL은 전제 조건용 작은 임시 테이블을 만들고 기존 96MiB/128개 앱 guard, `0011`의 384MiB counter/ledger CHECK와 자산 admission, incremental 회계를 확인한다. 그 뒤 앱 guard 하나만 교체하고 임시 테이블을 제거한다. 기존 원본·설정·GitHub 연결·OTA 파일·배포·Runner 이력·counter·ledger·facts·sequence·키·복구 저널은 복사하거나 수정하지 않는다. 전체 파일을 한 transaction으로 실행해야 한다.

## 로컬 검증

실제 workerd/D1 테스트 `packages/cloudflare/test/hosted-app-asset-capacity-128.test.ts` **3/3 통과**. TypeScript 검사도 통과했다. 실제 출력은 `dist/runner-resume-2026-10-16/evidence/hosted-app-asset-capacity-128-tests.log`에 저장했다.

- Isso·Promise·Reward fixture의 기존 설정·GitHub 연결·완전한 기존 자산 bytes, 모든 행·counter·ledger·fact·sequence가 보존된다. 전체 스키마에서 변경되는 것은 앱 guard 한 개이며 공유 용량·수동 롤백·나머지 트리거 정의는 동일하다. 재적용도 값을 변경하지 않고 거절한다.
- 원본 자산 합계가 정확히 128MiB가 되는 경쟁 insert 두 개 중 하나만 성공한다. 추가 overflow와 128개 초과, 16MiB 초과 자산, immutable 행 변경은 거절한다. Isso가 가득 차도 Promise·Reward의 독립 범위는 유지된다.
- 이전 workspace 상한, 앱 guard 누락, 잘못된 기존 앱 byte/count 상한, 잘못된 workspace 자산 admission이면 전체 transaction과 임시 스키마 변경이 rollback된다.

용량 경계는 합법적인 upload staging 메타데이터로 검증했다. 해당 fixture는 chunk를 만들지 않았으므로 배포되거나 다운로드 가능한 파일로 간주하지 않는다. 기존 완전한 1바이트 자산의 bytes 조회만 별도로 검증했다. 공유 384MiB 전체를 다시 채우는 대형 fixture는 이 변경에서 반복하지 않았다.

## 적용 방법

운영 identity·현재 앱 guard·384MiB 공유 guard·counter/ledger와 기존 배포/자산 메타데이터를 확인해 보존한 뒤, 이 SQL 전체 5문장을 한 transaction으로 실행한다.

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const sql = await readFile('packages/cloudflare/migrations/0012_hosted_app_asset_capacity_128mib.sql', 'utf8');
const { stdout } = await promisify(execFile)(process.execPath, [
  'packages/cloudflare/node_modules/wrangler/bin/wrangler.js',
  'd1', 'execute', 'flora-uulab',
  '--config', 'dist/small-sample-rollback-2026-10-16/wrangler.jsonc',
  '--remote', '--command=' + sql, '--json',
], { shell: false, timeout: 60_000, maxBuffer: 1024 * 1024 });
process.stdout.write(stdout);
NODE
```

적용 후 기존 행·회계와 공유 guard를 대조한다. 기존 `0011` SQL은 변경하거나 다시 적용하지 않는다. `0012` SHA256은 `f52f24a332954026be9c7563a06113f71a8ff402a9649e70a982a9db7402a190`이며, `0011` SHA256은 기존 `193015c6bb5a190d71c15bb0d5fd5bd62ad3503f068ab69c5541da203f6ac2f3` 그대로다.

## 운영 적용 결과

2026-10-16 14:35 UTC(23:35 KST), 최신 Time Travel bookmark와 기준 snapshot을 확보한 뒤 전체 5문장을 단일 관리자 트랜잭션으로 적용했다. 모두 성공했으며 일회성 적용의 읽기는 1,520행, 쓰기는 4행이었다.

적용 전후 canonical payload 355,280,893바이트·원장 18행·배포 원문 120건이 동일했다. 스키마 209개 중 앱 guard 한 정의의 상한만 바뀌었다. Foreign key 오류는 0건이며 물리 DB 크기는 366,141,440바이트로 동일하다. 공유 상한까지의 여유 47,372,291바이트는 앱별 여유의 합계와 구분한다. Runner 중단이나 Worker 재배포는 필요하지 않았다.

실제 여섯 자동 OTA 게시·다운로드 검증 및 기존 데이터 대조는 [PC Runner 복구 기록](runner-resume-2026-10-16.ko.md)을 참고한다.
