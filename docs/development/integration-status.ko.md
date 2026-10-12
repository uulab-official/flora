# 실제 연동 현황

[README](../../README.md) · [PC 개발 인수인계·체크리스트](pc-handoff.ko.md) · [제품 로드맵](../roadmap/milestones.ko.md)

소스 재확인: 2026-10-12 UTC. 이 문서를 작성하기 전 원격 main은 `b2f14736d66560723427ee158f2c9afe4b410ed9`였으며 10월 10일 조사 때와 같다. 문서 변경을 운영 배포나 외부 연동 완료로 세지 않는다.

## 현재 제공되는 기능과 남은 연결

| 영역 | 구현된 것 | 실제 운영 연결·미비점 |
| --- | --- | --- |
| source/config/history | 타깃 identity, 설정 계층과 immutable snapshot, SQLite Job/lease/fence, source/baseline/HEAD 반입·이력 | 일회성 `operator-import`이다. 제품 자체의 지속 GitHub sync·웹훅·범용 repo importer는 없다. |
| Dashboard/CLI | 보호된 loopback UI와 CLI, 단일 앱의 여러 flavor 조회, private store 경계 | 한 store/hosted 배포는 한 repository/root 앱에 묶인다. 독립된 여러 앱의 공통 registry와 조직 로그인/RBAC는 미구현이다. |
| Runner/build | capability/preflight·취소/cleanup 계약, 상태 전이·lease/fence 시뮬레이션 | 제품에는 `createBlockedProvider()`만 등록된다. 원본 downloader·격리 실행 adapter·Runner 등록 daemon·실제 native/Web 빌드가 없다. |
| OTA | runtime 관련 선언·provenance 일부 | `otaDestination`은 `not-evaluated`이다. UpdateProvider·manifest/assets·runtime 적합성·publish/rollback은 미구현이다. |
| Apple/Google | StoreProvider와 release 추적 설계 | App Store Connect/Google Play 상태 sync·upload·processing·submit adapter가 없다. 다른 작업의 API 조회나 게시 권한은 Flora의 지속 접근 권한이 아니다. |
| Cloudflare hosted path | Worker·SQLite `FloraAuth` DO·D1 store, 단일 소유자 비밀번호 로그인, 잠긴 setup, source/baseline 반입·조회 | 로컬 workerd/Miniflare·합성 CI까지 검증했다. 운영 Free 용량·성능, zone/route·DNS/TLS, 소유자 등록·실제 비공개 반입은 미검증이다. hosted API는 `runner: unavailable`이다. |
| Vault·조직 공용 운영 | 기초 identity/config 타입과 설계 | key custody·회전·복구·지속 provider credential·Runner identity·다중 앱 권한 경계는 구현/검증이 필요하다. |

근거: [현재 범위 README](../../README.md), [blocked provider](../../packages/dashboard/src/blocked-provider.ts), [제품 CLI 구성](../../packages/cli/src/dogfood-command.ts), [Runner 계약](../../packages/runner-protocol/src/verification.ts), [hosted API](../../packages/cloudflare/src/hosted-api.ts), [고정 smoke profile](../../packages/dogfood/src/profile.ts).

## 화면은 어떤 데이터를 표시하나?

운영 UI 코드는 인증된 동일 origin 또는 loopback의 `/api/state`·`/api/sources`·`/api/baselines`에서 저장 데이터를 읽는다. 자료를 반입하면 저장·조회는 실제 동작이지만 그 기원은 `operator-import`, 연결 방식은 `one-shot-source-snapshot`이다. 새 앱 테스트를 실행하거나 provider를 실시간 조회한 결과가 아니다. HEAD도 별도 반입 관측이 없으면 최신 여부를 알 수 없다.

demo·렌더링 CI는 공개 synthetic fixture를 사용한다. 예제의 2개 파일/4개 테스트는 가상의 개발 증거다. hosted UI의 배포·오류·수익은 `미연결`, Runner는 미제공이다. 여러 flavor 행을 여러 독립 앱의 운영 연결로 세지 않는다. [UI 구현](../../packages/cloudflare/public/app.js)과 [반입 범위](dogfood.ko.md)를 확인한다.

현재 importer는 `flavors/config.json`, `package.json`, `package-lock.json` 등 고정 파일 집합을 요구한다. baseline은 두 지정 smoke 파일·4개 검사에 고정된다. 임의 Expo·Unity·Web 저장소 URL과 일반 테스트 보고서를 바로 받아들이는 기능은 없다. 형식을 맞추려고 파일명을 바꾸거나 검사 성공값을 꾸미지 않는다.

## 실제 확인된 상태와 확인하지 못한 것

| 관측 시점/대상 | 결과 | 의미와 한계 |
| --- | --- | --- |
| 2026-10-12 원격 main·새 Mac checkout | 둘 다 `b2f14736…`; 새 checkout의 기존 미커밋 변경 없음 | 다른 사람의 작업을 복사하거나 덮어쓰지 않고 문서 변경만 별도로 준비했다. |
| 해당 baseline의 Foundation CI | macOS/Windows/Ubuntu 모두 success | [실제 실행](https://github.com/uulab-official/flora/actions/runs/37701924355). 앱 native build·스토어·OTA·운영 배포 증거는 아니다. |
| 해당 baseline의 화면 CI | 두 synthetic rendering workflow success | [Dashboard](https://github.com/uulab-official/flora/actions/runs/37701924369), [Hosted](https://github.com/uulab-official/flora/actions/runs/37701924393). 운영 계정 데이터가 아니다. |
| 2026-10-10 기존 Wrangler `whoami` | 미인증 | 이번 인수인계에서는 로그인·OAuth·토큰 발급을 재시도하지 않았다. 다른 기기의 인증 여부를 뜻하지 않는다. |
| 2026-10-10 공개 권한 DNS | `flora.uulab.co.kr A`: `NXDOMAIN`, `aa` | 당시 공개 호스트가 존재하지 않았다. 이 문서 작성 시점의 DNS를 새로 조회한 결과는 아니며, account 내부 Worker/DO/D1 부재도 증명하지 않는다. |
| 지정 계정 내부 | zone Active, 자원 존재/공유 여유, route 충돌 미확인 | 유효한 기존 관리 접근을 먼저 확인해야 한다. 과거 수치나 placeholder를 실제 설정으로 간주하지 않는다. |

운영 연결을 표시하려면 provider account·app/project·source SHA·최종 관측 시각·상태/오류와 결과 receipt를 실제로 확인해야 한다. 소스 커밋·dry-run·합성 테스트는 이를 대신하지 않는다.

## 연동 시 필요한 권한과 책임

- GitHub: 우선 선택 repo의 metadata/contents와 필요한 CI 상태 읽기. 현재 개발 도구의 인증을 Flora에 복사하지 않는다.
- Runner: 한 조직/job/attempt에 한정한 machine identity·claim/heartbeat/result와 revoke. 등록과 지속 자격정보 보관은 별도 신뢰 경계다.
- Apple/Google/EAS: 우선 특정 app ID/package/project의 상태 조회부터 구현한다. 다른 작업의 키·로그인을 서버로 옮기지 않는다. 업로드·submit·OTA publish는 별도 capability와 고정 artifact 승인 범위다.
- Cloudflare: 지정 계정·Free 용량·전용 리소스·정확 hostname을 확인한다. 새 지속 grant나 결제/초과과금 약정이 필요하면 해당 단계를 중단한다. R2·Access·유료 fallback을 자동 활성화하지 않는다.
- Flora 최초 소유자: 배포된 Free 성능·인증/저장 gate 후 검증된 HTTPS 화면에서 사용자가 직접 등록한다. 에이전트가 비밀번호·setup 원문을 생성·관찰·저장하지 않는다.

다음 실제 작업의 우선순위·완료 조건은 [PC 개발 체크리스트](pc-handoff.ko.md)에 있다. 모든 앱을 연동한 상태로 보고하지 않는다.
