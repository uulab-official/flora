# Flora 운영 대시보드 검증 — 2026-10-15

실제 서비스: https://flora.uulab.co.kr/projects

프로젝트 목록에 앱별 GitHub 저장소, iOS·Android 최신 OTA 게시, 적용 검증 근거, PC Runner 연결 상태를 함께 표시한다. 상단에는 등록 앱 수와 플랫폼별 최신 게시 슬롯, 온라인 Runner 앱 수, Cloudflare 계정 전체의 D1 읽기·쓰기 사용량과 잔여량·집계 시각·다음 초기화 시각을 표시한다. 긴 식별자는 앱 상세의 접힌 기술 정보에 유지한다.

## 조회 비용과 상태 신뢰성

- 프로젝트 목록과 앱 개요는 `/api/projects` singleflight 캐시를 공유한다. 수동 클릭·focus·자동 조회도 최소 60초 간격이며 숨김·페이지 이탈·로그아웃 시 polling을 중단한다. 앱 개요를 위해 앱마다 전체 배포·작업 이력을 추가 조회하지 않는다.
- 기존 FloraAuth DO에서 프로젝트의 제한된 D1 projection을 60초 캐시한다. 캐시 사용 중에도 현재 owner 세션과 DB identity를 확인하며 Runner presence는 현재 DO 기록으로 다시 계산한다. 변경·게시·권한 폐기는 캐시를 무효화한다.
- 120초보다 오래된 클라이언트 요약 또는 조회 실패가 발생하면 현재 Runner 연결을 미확인으로 표시한다. 과거 온라인 상태로 현재 연결을 보장하지 않는다.
- PC의 `kr.co.uulab.flora-usage` LaunchAgent가 10분마다 계정 D1 집계를 수집한다. `RunAtLoad`로 사용자 로그인 후 자동 시작하고 비정상 종료 시 다시 실행한다. 기존 OTA Runner 서비스는 그대로 유지한다. 물리적인 PC 재부팅은 이번 검증에 포함하지 않았다.
- 기존 Wrangler keyring 로그인을 공식 `auth token --json` 명령으로 사용한다. stdout은 자식 프로세스 메모리에서만 소비하며 `WRANGLER_WRITE_LOGS=false`로 진단 로그 기록을 차단한다. 최초 검증 호출에서 생성된 로그의 인증 토큰 값 7건도 삭제했다. Cloudflare 인증 토큰을 Worker, export 컨테이너, 일반 로그에 전달하거나 별도 파일로 저장하지 않는다.
- PC는 `{day, observedAt, rowsRead, rowsWritten}`만 전달한다. 기존 Isso Runner를 지정 보고자로 제한하고 현재 credential을 두 번 확인한다. 계정 ID·reporter ID·URL·키·앱 선택자 등 caller scope는 받지 않는다. 기존 DO에 최신 측정값만 보관하며 새 D1 테이블·유료 리소스·Actions·EAS를 만들거나 사용하지 않는다.
- 수집 실패나 날짜 변경 시 이전 측정값은 남겨 두고 현재 잔여량은 미확인으로 표시한다. 측정 연결이 없다고 사용량을 0으로 만들지 않는다. 계정 전체 집계에는 Flora 외 D1 사용량도 포함된다.
- Cloudflare adaptive analytics는 지연·정정될 수 있다. 이 값은 운영 표시용이며 실제 quota enforcement를 변경하지 않는다. 공급자가 서명한 값이 아니라 인증된 PC 보고자가 조회한 값이다. D1 한도 소진 시 보고자의 credential 확인도 실패할 수 있어 마지막 성공 측정값에 stale 표시가 필요하다.

공식 근거: [Wrangler auth token](https://developers.cloudflare.com/changelog/post/2025-12-18-wrangler-auth-token/), [D1 무료 한도](https://developers.cloudflare.com/d1/platform/pricing/), [analytics sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/).

## 적용 검증의 범위

SDK는 현재 사용자 기기의 적용 결과를 서버에 보고하지 않는다. 사용자 적용률이나 설치 기기 수는 집계하지 않으며 화면에 `사용자 적용 보고 미수집`을 표시한다.

소유자 세션과 CSRF가 필요한 `/api/apps/:appId/ota/verification`은 이미 게시된 배포의 앱·플랫폼·runtime·채널·commit을 확인하고 검증 시각·기기 종류·receipt digest를 기존 DO에 추가 기록한다. 기록은 수정·삭제되지 않으며 동일 receipt 재전송은 idempotent하다. 다른 앱이나 배포의 기록을 최신 배포에 붙일 수 없다.

실제 Reward Android 배포 `ba0ded11-d92f-4d64-b8e0-a98bc5693fee`에 기존 검증 receipt를 등록했다. Android 에뮬레이터의 OTA 다운로드 57개 파일 검증, 서명 확인, 적용된 bundle 재실행, PID 변경과 native committed 상태, APK·QA 데이터 보존이 확인된 기록이다. 최신 Isso·Promise 양 플랫폼 및 Reward iOS에는 이 배포와 일치하는 적용 기록이 없어 미확인으로 유지한다. 에뮬레이터 검증을 실기기나 사용자 전체 적용으로 표시하지 않는다.

## 검증 결과

- 전체 TypeScript 테스트: **1,019 통과 / 실패 0 / 기존 조건부 skip 3**. Windows 전용 준비, 선택 실행하는 실제 Expo CLI export, 실제 pnpm offline 준비 테스트가 기존 조건에 따라 생략됐다. build와 typecheck도 통과했다.
- PC Runner 스크립트: **65 통과 / 실패 0**. 인증된 보고자 분리, 공급자 오류·집계일 변경·누락 값을 0으로 만들지 않는 동작, credential의 두 서버 간 분리와 인증 로그 차단을 포함한다.
- 실제 Workerd/SQLite 검증: 앱 두 개의 receipt와 Runner를 분리하고 현재 세션·CSRF·revocation·cache expiry·D1 identity를 확인했다. UUID가 숫자로 시작하는 실제 배포도 조회·등록 가능하다.
- 실서비스에서 다른 앱으로 Reward receipt를 등록하면 **404**, 같은 Reward receipt 재등록은 **200**이다. 세 앱 Runner 모두 온라인이며 최신 iOS·Android 배포 6개가 앱별로 분리되어 표시된다.
- 데스크톱 1,200px·모바일 390px 화면을 확인했다. 모바일 document scroll width는 390px이다. 캐시 유효 중 연속 수동 조회와 Reward 앱 개요 전환으로 `/api/projects`, operations, automation 이력을 다시 요청하지 않았다. 앱 개요 전환의 기존 `/api/state` 조회만 발생했다.
- 기존 OTA 24건, 자동 작업 38건, GitHub 연결 버전, 배포 정책, 최신 배포 ID·commit을 전후 비교해 보존을 확인했다. Isso·Promise의 인증서/키 각 6개와 교체 이력을 기존 baseline과 정확히 비교했다. Reward 키 미등록 상태도 유지했다. 세 PC Runner config SHA-256도 그대로다.

Worker `28241082-3443-43a9-bd8e-68f17309a21e`가 100% 배포됐다. 기존 D1, FloraAuth namespace, 10개 binding과 Vault Secret은 유지했으며 보고자와 계정 ID의 plain binding 2개만 추가했다. Cloudflare provider 권한이나 요금제는 바꾸지 않았다.

검증 파일: `dist/admin-operations-2026-10-15/verification.json`. 화면: 같은 폴더의 `evidence/desktop.png`, `evidence/mobile.png`. 파일에는 인증 토큰·세션 cookie·개인키를 포함하지 않는다.
