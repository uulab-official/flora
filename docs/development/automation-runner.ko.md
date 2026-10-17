# GitHub 자동 배포와 Flora SDK

기본 경로는 GitHub → 고정 커밋 감지 → 앱별 Job → 별도 Runner의 Metro export → Flora OTA → Flora SDK의 네이티브 엔진이다. EAS 계정·API·projectId·Expo 로그인은 사용하지 않는다. Expo 프로젝트는 오픈소스 Expo CLI export 어댑터를 선택할 수 있다. JS 번들 검증·교체·재시작은 앱 바이너리에 탑재된 네이티브 엔진의 책임이다. SDK만 설치해서 기존 바이너리를 업데이트할 수 있다고 가정하지 않는다.

[SDK 사용법](../../packages/ota-sdk/README.md)과 [Runner 실행·격리 조건](../../packages/ota-runner/README.md)을 따른다. 기존 수동 OTA와 source/baseline 반입은 유지한다. 기존 검사 provider의 blocked 상태는 자동 OTA Runner와 별개다.

## 처음 연동할 때

1. 앱을 등록하고 해당 앱의 GitHub 설치·저장소·ref·root를 연결한다.
2. Flora 저장소에서 `pnpm sdk:pack`으로 SDK `.tgz`를 만든다. 출력 JSON의 경로와 SHA-256을 보존한다. 이 명령은 빈 임시 출력에 SDK를 새로 컴파일하고 공개 파일·schema·타입·Apache license만 패키징한다. npm registry에는 발행하지 않는다. 별도 앱 두 프로젝트에 offline install·import를 검증했다.
3. 앱 저장소에 정확한 SDK artifact를 vendor로 두고 상대 `file:` dependency와 lockfile을 체크인한다. 사용자 PC의 절대 파일 경로는 독립 Runner에서 사용할 수 없다. Flora SDK와 네이티브 엔진·설정 bridge의 바이너리 설치는 [SDK 가이드](../../packages/ota-sdk/README.md)에서 구분한다.
4. 앱 root의 `flora.config.json`을 체크인하고 다시 동기화한다. UI의 앱별 준비 목록에서 정적 소스·SDK 설정·Runner 등록·정책 상태를 확인한다. 등록됨은 현재 Runner 접속 상태의 증거가 아니다.
5. 해당 앱 권한으로 Runner를 등록하고 최초 응답의 토큰을 비공개 설정 파일에 저장한다. UI의 설정 템플릿은 origin과 비밀 아닌 placeholder만 포함한다. 검증한 Docker image digest와 격리·cache 조건을 채워 실행한다.
6. 수동 요청 또는 GitHub push 정책을 활성화한 뒤 작업 상세의 시도·이벤트·실패 도움말을 확인한다. 화면은 열린 자동화 패널의 활성 작업만 5초마다 갱신하고 오류 때 10초로 늦춘다. 페이지 숨김·앱 변경·세션 종료·terminal 상태에는 멈춘다. 게시 완료는 설치된 기기에서의 적용 완료와 별개다.

SDK 설치 경로는 로컬 배포 방식이며 공개 registry 설치 명령을 제공한다고 가정하지 않는다. [npm pack 공식 문서](https://docs.npmjs.com/cli/v11/commands/npm-pack/)의 local tarball·ignore-scripts 방식을 사용한다.

## 앱 설정과 자동화

GitHub App은 선택한 저장소의 Contents read 권한만 요청한다. 서버는 설치 ID·저장소·ref·앱 root를 연결하고 고정 SHA의 package.json과 flora.config.json을 읽는다. 설정을 코드 실행으로 평가하지 않는다. package.json에 @flora/ota 의존성을 선언하고 앱 root에 아래 파일을 둔다. URL의 앱 ID는 등록 결과로 교체한다.

```json
{
  "schemaVersion": 1,
  "ota": {
    "runtimeVersion": "native-1",
    "platforms": ["android", "ios"],
    "url": "https://your-flora.example/updates/app_REPLACE"
  },
  "export": {
    "bundler": "metro",
    "entryFile": "index.js",
    "nodeVersion": "24.19.0",
    "packageManager": {"name": "pnpm", "version": "11.19.0"}
  }
}
```

Expo export 선택 시 bundler를 expo로 지정한다. 채널·플랫폼은 앱별 자동 배포 정책에서 선택한다. 정책은 기본 비활성이고 version CAS로 갱신한다. 서로 다른 저장소의 앱은 연결·정책·Runner 권한·Job·시도·OTA 이력이 각각 분리된다. branch ref는 main처럼, tag는 refs/tags/v1처럼 지정한다.

FLORA_GITHUB_APP_ID, FLORA_GITHUB_PRIVATE_KEY, FLORA_GITHUB_WEBHOOK_SECRET은 서버 비공개 secret으로 제공한다. Webhook은 정확한 HTTPS origin의 /api/github/webhook이다. Contents read와 push 이벤트를 활성화하고 같은 webhook secret을 GitHub App에 설정한다. HMAC 서명 검증 전에는 앱 자료를 기록하지 않는다. delivery ID는 앱별 멱등 키이고 payload SHA는 GitHub에서 현재 연결된 ref의 SHA와 일치하는지 확인한다. 늦게 전달된 이전 push는 자동 배포하지 않는다. 명시적인 수동 이전 SHA 요청은 허용한다. Cloudflare Free 호스팅은 저장소·ref에 매칭되는 자동화 앱을 요청당 1개로 제한해 D1의 50 query 한도를 지킨다. 서로 다른 저장소의 앱은 각각 자동 배포된다. 같은 저장소·ref에 여러 root 앱을 자동화하면 쓰기 전에 전체 요청을 거절하므로 수동 큐 또는 별도 전달 구조를 사용한다. 로컬 서버는 최대 4개를 허용한다.

Runner 토큰은 등록 응답에서 한 번만 표시되며 DB에는 SHA-256만 저장한다. 권한은 등록한 appIds에 한정되며 회수 즉시 진행 중 쓰기도 차단한다. Runner 토큰을 앱 저장소·export 컨테이너에 넣지 않는다. 소스 다운로드 토큰은 Runner 호스트의 고정 GitHub URL 조회에만 사용한다. 브라우저 session·CSRF와 Runner Bearer 인증은 분리된다.

## 실행과 데이터 보존

Runner는 SHA·root·설정 digest·Node·패키지 관리자 버전을 확인하고 frozen lockfile로 의존성을 설치한다. export 컨테이너에는 발행 권한이 없다. Runner 호스트가 결과 파일의 경로·종류·크기·해시를 검사하고 현재 attempt에 연결된 에셋을 업로드한다. receipt는 번들 메타데이터 digest·SHA·설정·도구 digest를 포함한다. 이것은 인증된 Runner의 보고이며 독립적인 실행 서명이나 제3자 증명이 아니다. 신뢰할 수 있는 Runner 호스트를 사용한다.

배포 ledger와 Job 성공은 하나의 SQLite transaction/D1 batch로 확정한다. 실패한 export·취소·만료·회수된 권한·이전 fence는 배포를 확정하지 않는다. 같은 앱·채널·runtime·플랫폼의 더 새 요청이 있으면 늦은 이전 요청도 거절한다. 이전 SHA로 되돌리려면 새 요청을 명시적으로 만든다. 완료 응답 유실은 동일 receipt로 재시도할 수 있다. 앱 또는 runtime이 다른 업데이트는 선택하지 않는다.

Runner는 첫 발행 전에 origin·원래 lease·receipt만 담은 복구 파일을 export checkout 밖의 0700 디렉터리·0600 파일에 저장하고 fsync한다. 토큰과 소스 내용은 기록하지 않는다. 응답 유실·5xx는 같은 receipt로 최대 3회 재시도하고 확인된 원래 성공에만 파일을 삭제한다. 불확실성이 남으면 파일을 보존하고 새 claim을 중단한다. 재시작 시에도 미확인 복구 파일이 있으면 먼저 처리해야 한다.

```sh
node packages/ota-runner/dist/main.js --config /private/runner/runner.json --reconcile /private/runner/recovery/ORIGINAL_JOB.ORIGINAL_ATTEMPT.json
```

reconcile은 Docker·새 claim·export·upload를 실행하지 않고 기존 idempotent finalize 경로로 원래 receipt만 확인한다. origin/Runner/app/attempt binding, 회수·만료·충돌을 검증하며, 거절되면 파일을 남긴다. CLI가 권한 거절을 네트워크 오류로 무한 재시도하지 않는다. 실제 Metro·SQLite·HTTP 테스트는 두 앱에서 성공 후 응답 유실과 복구를 재현하고 배포가 1개씩만 남는 것을 확인한다.

새 migration은 로컬 SQLite 0005와 D1 0004다. 기존 migration·자료를 삭제하지 않는다. 운영 DB는 백업과 identity 확인 후 정상 migration 절차로 올린다. 정책·작업·권한 이력은 보존하며 용량 초과 시 유료 저장소로 자동 전환하지 않는다.

## 무료 운영 구성

2026-10-12 공식 문서 확인 기준이다. 무료 한도는 계정 전체에 공유되므로 실제 배포 전에 다시 확인한다.

| 구성 | 용도 | 무료 조건 |
| --- | --- | --- |
| Workers + SQLite DO + D1 | 관리·인증·Job·OTA API | Workers Free 100,000 요청/일, front CPU 10ms. DO 기본 CPU 30초와 실제 scrypt·D1 quota·업로드 성능 별도 검증 |
| 기존 장비의 Docker Runner | 기본 export 실행 | self-host 서비스 사용료 없음. 장비·전기·네트워크·운영 비용 별도 |
| GitHub Actions 표준 Runner | 공개 저장소의 선택적 실행 호스트 | 공개 저장소 표준 Runner 무료. 비공개 저장소는 플랜별 quota, larger Runner는 유료 |
| Cloudflare Containers | 격리된 export 실행 | Workers Paid 필수이므로 무료 기본 구성에서 제외 |
| Workers Builds | 관리 서버 CI 배포 | Free 3,000 build분/월, 1 동시 실행, 작업 20분. 상시 앱 export Runner로 구현하지 않음 |

근거: [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/), [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/), [DO 제한](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1 제한](https://developers.cloudflare.com/d1/platform/limits/), [Containers 가격](https://developers.cloudflare.com/containers/platform/pricing/), [GitHub Actions 과금](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/).

유료 Containers·larger Runner·R2·Queues로 자동 fallback하지 않는다. 현재 D1 에셋 저장에는 파일·합계 크기와 SQL query budget 한계가 있으며 대규모 CDN 배포를 무제한 무료라고 보장하지 않는다. 실제 Free 요금제·공유 quota·DB 여유·TLS·수신 webhook·Docker isolation을 운영 전에 확인해야 한다.

## UULab 배포 프로필

[UULab 설정 예제](../../packages/cloudflare/wrangler.uulab.example.jsonc)는 workspaceName UULab, owner email admin@admin.com, 최소 12자리다. 일반 배포는 최소 15자리를 유지한다. FLORA_PASSWORD_MIN_LENGTH=12는 FLORA_WORKSPACE_NAME=UULab일 때만 허용한다. 해시 포맷과 scrypt 비용은 동일하며 기존 verifier를 바꾸지 않는다.

예제에는 비밀번호·GitHub private key·webhook secret·Runner 토큰이 없다. 지정한 초기 비밀번호는 실제 HTTPS 배포의 일회용 소유자 등록에서만 사용한다. [호스팅 준비·출시 검증](password-hosting.ko.md)을 통과해야 한다. 원격 계정의 요금제 조회는 권한 오류여서 Free 활성 여부를 확정하지 못했고 Flora Worker·D1·소유자 계정은 생성하지 않았다.

## 확인 수준

2026-10-12 최종 `pnpm check`에서 build·typecheck가 통과했고 558개 테스트 중 557개 통과, 0개 실패, Windows 전용 1개 건너뛰기를 확인했다. 서로 다른 실제 로컬 Git 커밋 두 개와 실제 Metro 0.84.5 export를 사용해 서명된 synthetic GitHub webhook → HTTP Runner → SQLite 배포 → manifest·PNG 다운로드 해시와 앱별 이력 분리를 검증했다. workerd의 실제 Auth DO/D1 경로에서는 현재 push와 지연 push, 정책·연결 변경, 취소·회수·만료, body admission과 atomic 발행을 별도로 검증했다. 단일 webhook 31 query, 최대 16MiB HTTP 업로드 36 query로 Free의 요청당 50 query 아래였다.

로컬 SQLite·workerd/D1·서명된 synthetic GitHub HTTP·실제 Metro export 검증은 운영 GitHub App 설치·실제 Docker 실행·네이티브 기기 업데이트와 구분한다. 현재 장비에는 Docker가 없어 운영 격리를 실행 검증하지 못했다. 생산 Runner는 Docker 없이 호스트 실행으로 우회하지 않는다. SDK는 엔진 어댑터 계약을 제공하며 기기 엔진의 설치·재시작 검증은 별도로 필요하다.
