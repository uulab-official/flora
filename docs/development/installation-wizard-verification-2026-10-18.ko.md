# 설치 마법사 검증 기록 — 2026-10-18

## 2026-10-19 기존 UULab 서버의 실제 GitHub·PC Runner 검증

사용자가 연결 대상을 `https://flora.uulab.co.kr`로 지정했다. 기존 GitHub App의
저장소 전체 읽기 설치에서 새 비공개 저장소 두 개를 확인하고 별도 앱으로 등록했다.
이 결과는 기존 설치의 연결 경로 검증이다. 별도 새 QA 서버의 최초 관리자 등록과
새 설치 전체 완료를 대신하지 않는다.

| 앱 / GitHub 저장소 | 실제 자동 배포 커밋 | iOS 게시 | Android 게시 |
| --- | --- | --- | --- |
| Flora QA A / `uulab-official/flora-qa-13836a78-a` | `d928ad242242660ee15be0d0b31d64abde28b8c3` | `47cc38aa-6997-46a6-91b2-aac25df17090` | `ff360944-bcb4-4503-903d-6f1209fb9a0a` |
| Flora QA B / `uulab-official/flora-qa-13836a78-b` | `aba265d4bd334fa64ae251f3b9532a836299b3da` | `eb42428c-4870-4638-8e04-b285cbf21375` | `86be924f-48cc-47ed-aa01-6848cccd8282` |

두 앱은 RN 0.86.3, Flora SDK 0.3.2, Node 24.19.0/npm 10.9.8, Metro,
`qa-onboarding` 채널과 `qa-native-1` 런타임을 사용한다. 서로 다른 앱 ID·공개 서명
인증서·SDK URL·private Runner 토큰과 작업/복구/자산 캐시를 사용한다. iOS/Android
네이티브 호스트의 연결 소스와 공개 설정은 각 저장소에 포함했다. 새 네이티브
바이너리의 빌드·설치·기기 적용·재시작은 이번 검증 범위에 포함하지 않았다.

실제 GitHub push가 `hook_…_ios` / `hook_…_android` 작업을 생성했고 PC Docker가
온라인 npm 의존성 준비 후 네트워크 없는 export를 수행했다. 네 작업은 각각 한 번의
시도로 게시됐으며 queued → claimed → heartbeat → succeeded 상세 이력이 있다.
수동 queue 요청이나 EAS를 사용하지 않았고 두 저장소의 Actions run 수는 각각 0이다.

공개 `scripts/onboarding-download-qa.mjs`로 각 앱의 두 플랫폼을 순차 검증했다.
RSA 서명·인증서·앱/채널/런타임/플랫폼/커밋/배포 ID와 전체 자산 SHA-256이 모두
일치했다. 네 자산의 실제 다운로드 해시는 private 게시 캐시의 `github-ota-v3`
커밋 표식이 포함된 번들과도 일치한다. 이는 서명된 HTTPS 다운로드 증거이며
실제 기기의 다운로드·적용 보고로 집계하거나 채택률로 해석하지 않았다.

앱 A 설정 저장 후 앱 B 설정이 그대로임을 확인하고 두 앱에 서로 다른 공개 QA
설정을 저장했다. A Runner로 B 소스를 요청하면 403, A 경로에서 B 작업 상세 또는
자산을 요청하면 404다. B manifest를 A 인증서로 검증하면 거절된다. Flora 화면에서
각 앱의 양 플랫폼 게시·온라인 상태·실패/취소/성공 이력이 분리되어 보인다.

실행 중 발견한 PC 설정 오류도 수정했다. 일반 PC 토큰에 CI 전용
`publicationRecovery: "remote-checkpoint"`를 지정하면 `CI_SESSION_REQUIRED`로
중지되므로 설치 CLI는 기존의 durable local recovery journal을 사용한다.
회귀 테스트의 실패를 확인한 뒤 수정했고 CLI/복구 집중 검사 11건이 통과했다.
기존 서버는 GitHub Releases 자산 저장소를 사용하므로 새 Runner에도 같은 private
저장소와 별도 캐시를 연결했다. 최초 게시의 428 실패와 대기 작업 취소 기록, 이전
설정·중지 표식은 보존했고 새 커밋으로 재검증했다.

QA 전용 LaunchAgent 두 개를 기존 운영 서비스와 다른 이름으로 등록했다.
컨트롤러를 PC의 private 영속 경로에 번들링했고 둘 다 launchd `running` 및 실제
presence 응답을 확인했다. RunAtLoad는 사용자 로그인 시 시작하며 기존 Docker VM을
사용한다. 물리적인 PC 재부팅은 수행하지 않았다. 일반 설치 마법사의 foreground
기본 동작이나 기존 세 앱의 자동 시작 서비스는 변경하지 않았다.

전체 `pnpm check`: **1,459 pass / 0 fail / 3 skip / 0 cancelled**, 607.11초, exit 0.
생략은 Windows, 명시적인 Expo 앱 환경, 명시적인 PNPM Docker 이미지 환경 각 1건이다.
최초 전체 검사에서는 native HTTP 테스트의 응답 본문 중복 읽기가 실패했다.
해당 테스트의 bounded JSON 응답을 다음 요청 전에 완전히 읽고 독립 Response로
반환하도록 보완했고, 집중 6건과 최종 전체 검사가 통과했다. 실패 로그도 보존했다.

기존 Isso·Promise·Reward의 GitHub/OTA 상태·정책·Runner 목록·작업 이력과 앱 목록
요약을 작업 전과 대조해 모두 일치했다. 기존 키를 교체·반출하거나 DB를 초기화하지
않았다. 원본 작업 폴더 559개 파일 hash, HEAD, index, staging과 전체 untracked 상태도
그대로다. 검증 산출물은 원본의 무시된 `dist/installation-wizard-implementation-2026-10-18/`
아래 보존했다. 구현 브랜치 변경을 운영 Worker 배포나 Flora main 병합으로 보고하지 않는다.

## 2026-10-18 새 설치 경로의 이전 검증

승인된 설계와 구현 계획에 따라 독립 브랜치에 구현하고 최종 로컬 검증을 마쳤습니다. 기존 UULab 운영 앱·키·DB·서비스를 새 설치로 교체하지 않습니다. 이 기록은 현재 단계의 증거이며 원격 설치 완료를 뜻하지 않습니다.

## 확인한 범위

- 로컬 private journal: 소유권·0700/0600·symlink/hardlink·동시 실행·원자 교체 검증.
- CLI 시작/취소/허용 argv/실제 PTY 숨김 입력과 복원 검증.
- Cloudflare adapter: 고정 Wrangler 인자·리소스 충돌·계정/도메인·설정 drift·응답 유실 시 중복 생성 방지. 합성 HOME의 고정 Wrangler `auth token --json` 실행에서 디스크 로그 비활성 확인. 실제 사용자 인증값으로 원격 배포한 증거와 구분.
- 최초 등록: HTTPS 확인 전 승인 코드 발급 금지, 32-byte 난수·10분·generation 1, 원장 pending 우선 기록, 불명확한 요청 재전송 금지, 등록 확인 후 FLORA_SETUP만 제거.
- Runner: 두 앱의 새 private 경로·token prefix·SDK origin/app 일치, 로컬 Unix 소켓·이미지 버전·2GiB 확인, fingerprint 재검증, 기존 키·복구 journal·fatal-stop 보존. supervisor/health 보조 테스트 68건 통과.
- 웹: private `/onboarding`, 세션·앱 전환 시 응답 fence, GitHub 응답 유실 시 조회 확인, 공개 SDK·Runner 파일, 모든 선택 플랫폼 게시 확인, 별도 중복 poller 없음.
- 실제 local workerd/D1/auth/signing/HTTP/controller: 서로 다른 두 fixture 저장소/root 앱, 다른 서명 키·단일 앱 Runner, iOS/Android 4개 배포 조회·서명/전체 자산 다운로드. 소스·export·작업 완료는 명시적인 fixture이며 실제 GitHub/Docker 완료로 표시하지 않음.
- 오래된 배포의 point 조회는 24개 최신 배포가 더 생겨도 4 queries / 7 rows read / 0 writes로 동일. SDK 집계나 과거 이력을 쓰지 않음.
- 별도 공개 다운로드 QA 도구는 raw manifest RSA-SHA256/expected key ID와 모든 자산 SHA-256을 검증. unsigned·다른 앱/키·손상·과대 응답을 거절하며 코드를 실행하거나 기기 적용 완료로 표시하지 않음.

## 초기 새 clone와 원격 검증

검증한 코드 revision은 `1c1542e76bea4de1aff6bad74f9427a67fb2e41d`입니다. `codex/installation-wizard-design-20261018`의 독립 로컬 후보를 실제 `git clone --no-local`로 받았습니다. 원격 main URL의 해당 기능 배포를 검증한 것으로 표시하지 않습니다.

- macOS arm64, Node 24.19.0 / npm 10.9.8 / pnpm 11.19.0.
- 새 빈 canonical HOME·npm cache·pnpm store·XDG·npm user/global 설정으로 frozen install 통과. 패키지 257개, 이전 store 재사용 0개.
- `pnpm check`: build·typecheck 완료, 테스트 **1,439 pass / 0 fail / 5 skip / 0 cancelled**, 전체 명령 exit 0 (734.61초).
- 조건부 생략: Windows junction/ACL 1건(macOS 실행), `FLORA_RUNNER_EXPO_TEST_APP`가 필요한 실제 Expo export 1건, 새 HOME에 Android SDK build-tools가 없어 APK 서명 2건, `FLORA_PNPM_DOCKER_IMAGE`가 필요한 실제 Docker 정책 metadata 1건. 이 5건은 통과로 계산하지 않았습니다.
- SDK 0.3.2 pack: exit 0, 45,686 bytes, SHA-256 `a27a99a31b303deab5cad56ca77edee39b336ef860a03a7d1f47c7bd4c593463`.
- strict doctor: exit 0 / `readiness.ready: true` / `nativeBuildVerified: false`.
- 마법사 비대화형 시작은 TTY 미충족으로 예상 exit 1, 허용하지 않은 argv는 예상 exit 2이며 입력값을 출력하지 않음. 실제 PTY 시작·취소·숨김 입력·설정/원장 tests 20건 통과. standalone `setup inspect --state ... --json`도 한 공개 JSON, exit 0, 원장 bytes 불변, privileged call 0.
- health/supervisor 보조 검사 68 pass / 0 fail / 0 skip.
- 새 clone의 추적 source 559개 hash 불변·Git status clean. 원본 폴더도 별도 baseline의 559개 hash·HEAD·index·staging entries·status 불변을 재확인.
- 앞선 후보의 전체 검사는 최종 검토 수정으로 대체되어 중지했으며, 통과로 보고하지 않았습니다. 위 결과는 수정 후 최종 코드의 새 clone 검사입니다.

별도 전체 코드 검토에서 P1 1건·P2 4건을 확인해 모두 수정했습니다. 부모 디렉터리 fsync, 정확한 checkout 경계, 성공한 재시도 표시, 최근 20개 밖 known job point 조회, 현재 origin SDK 검증을 회귀 테스트로 확인했습니다. 조회 실패는 자동 반복하지 않고 수동 확인으로 이어갑니다. 보류한 Minor 지적은 없습니다.

첫 검증 시에는 Mac 잠금·GitHub 인증·Wrangler 인증이 차단됐으나, 후속 읽기 전용 확인에서는 Mac 잠금 해제, `bonjin-app` GitHub 인증, 공식 Wrangler 계정 조회가 정상으로 확인됐습니다. Cloudflare 화면의 현재 Workers 플랜은 Free였고 D1은 5/10 DB, 78.75k/5M 일일 읽기, 18/100k 쓰기, 371.61MB/5GB로 관찰됐습니다. 이 값은 해당 확인 시점의 계정 전체 사용량이며 예약된 여유나 영구 보장은 아닙니다. 구독 API 403은 무료/유료 판별 증거로 사용하지 않았습니다.

고정 GET 사전 검사에서는 account·zone·D1·Worker domain·route가 200이고 DNS 레코드만 403이었습니다. 새 자원 생성 요청 전에 멈췄습니다. 사용자가 승인한 [별도 DNS 읽기 인증 보완](../superpowers/specs/2026-10-18-installation-wizard-auth-amendment.md)에 따라 비표시 입력·같은 zone 고정 DNS GET만 사용·메모리 전용·오류/취소 보존을 추가했습니다. 실제 토큰은 운영자가 생성 화면에서 CLI에 직접 붙여넣어야 합니다. 기존 Wrangler 인증이나 scope를 교체하지 않았습니다. 기존 Flora GitHub App 키를 새 QA 서버로 복사하거나 기존 앱으로 대신 완료 처리하지 않습니다. 새 Worker/D1/hostname 실제 생성·DNS/TLS, 새 소유자 HTTPS 등록, 실제 signed webhook → PC Docker export → 4개 원격 게시·다운로드·화면 확인은 아직 미완료입니다.

실제 PC Docker에서는 별도 공개 PNPM fixture로 온라인 cache 준비 → 오프라인 설치, metadata 누락 시 거절, lifecycle 미실행, host cache hash 불변 검사가 1 pass / 0 fail / 0 skip으로 통과했습니다. 기존 Lima가 공유하는 scratch 아래 새 QA 임시 폴더만 사용했습니다. 최초 실행은 VM에 공유되지 않은 macOS 임시 경로 때문에 `EXECUTION_FAILED`였으며, 기존 VM 설정을 바꾸지 않고 공유된 QA 경로와 arm64 이미지로 재검증했습니다. 이 결과는 실제 Docker 정책 검증이며 원격 앱 OTA export나 기기 적용 증거가 아닙니다.

## DNS 인증 보완 후 로컬 검증

코드 commit `7ac2055b50262ed7b892aeeaaf57942df78c4c20`의 전체 `pnpm check`는 build·typecheck와 **1,448 pass / 0 fail / 3 skip / 0 cancelled**, exit 0으로 완료했습니다(1,154.62초). 생략은 Windows 1건, 명시적인 Expo 앱 환경 1건, 명시적인 PNPM Docker 이미지 환경 1건입니다. Docker 검사는 위의 실제 daemon 별도 실행으로 확인했습니다. 사용자 승인으로 인증 구현이 바뀌던 중간 후보의 전체 검사는 그 실행 소유의 11개 프로세스만 중지했고 통과로 보고하지 않았습니다.

이 commit을 다시 실제 `git clone --no-local`로 받아 새 canonical HOME·npm cache·pnpm store·XDG·개별 빈 npm user/global 설정으로 확인했습니다. frozen install은 257 packages / reused 0이고 build·typecheck·provider/provision/command/실제 PTY 테스트 **27 pass / 0 fail / 0 skip**이 모두 exit 0입니다. 이 두 번째 clone에서는 전체 suite를 반복하지 않았으며 전체 suite 결과는 위 독립 구현 폴더의 실행 결과입니다. clone Git status는 clean입니다.

공식 Community CLI로 만든 새 RN 0.86.3 앱 FloraOnboardingA/B는 별도 lockfile·node_modules에서 각각 `npm ci --ignore-scripts`(867 packages), TypeScript 검사, SDK 0.3.2 모듈 로딩이 통과했습니다. vendor SDK는 위 pack SHA-256과 일치합니다. 이 결과는 설치 준비이며 서버 SDK 설정·GitHub 연결·native build·원격 OTA 증거가 아닙니다. 원본 작업 폴더 559개 파일 hash·HEAD·index·staging·전체 untracked 상태는 baseline과 일치합니다. 원격 main push·운영 배포·EAS·Actions 실행은 하지 않았습니다.

새 바이너리를 설치·실행하지 않은 경우 다운로드 검증을 OTA 적용·재시작이나 실제 사용자 채택률로 해석하지 않습니다. EAS·GitHub Actions workflow는 이 구현에서 추가하거나 실행하지 않습니다. QA 리소스를 자동 삭제하거나 기존 데이터를 초기화하지 않습니다.

## 재현 명령

고정 Node 24.19.0으로 build 후 실행합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
node --test scripts/local-runner/health.test.mjs scripts/local-runner/supervisor.test.mjs
node scripts/onboarding-download-qa.mjs --connection /ABSOLUTE/PUBLIC/flora.connection.json --target /ABSOLUTE/PUBLIC/target.json --out /ABSOLUTE/NEW/download-receipts
node scripts/onboarding-qa.mjs --record /ABSOLUTE/PUBLIC/receipts.json --out /ABSOLUTE/NEW/public-evidence
```

다운로드 target은 `{appId,commitSha,channel,runtimeVersion,platforms,deployments:{ios:deploymentId,android:deploymentId}}`이며 선택한 플랫폼만 포함합니다. 공개 설정의 expected certificate/keyId를 사용하며 쿠키·토큰·개인키·비밀번호 입력 인자를 지원하지 않습니다. manifest 1MiB, 자산 각각 16MiB, 최대 65개, 플랫폼당 총 64MiB, 요청 20초, 동일 origin·redirect 거절로 제한합니다. 한도 초과는 미완료이며 자산을 생략해 통과 처리하지 않습니다. 대상을 읽기 전용으로 재확인하며 실패 후 자동 재게시하지 않습니다.


## 후속 실제 QA 서버 준비와 등록 창 갱신

연결된 Cloudflare 도구에서 대상 DNS GET이 200으로 확인돼 별도 DNS 토큰 없이 새 전용 D1·schema·immutable identity·Worker·custom domain/HTTPS·최초 등록 설정 배포를 완료했습니다. 실제 Wrangler remote SQL 파일 실행이 SELECT 행 대신 import 요약을 반환하는 차이는 고정 SELECT `--command`로 수정했고 관련 28개 검증이 통과했습니다. 기존 운영 서버에 설치 마법사를 배포한 증거는 아닙니다.

새 QA 관리자 등록/로그인 완료 응답을 받았지만, 실제 QA 브라우저는 로그인으로 이동했습니다. 정확한 QA namespace의 Cloudflare 읽기 전용 SQL에서 미등록, epoch 0, 활성 세션 0, 만료되어 닫힌 generation 1을 확인했습니다(rows_written=0). verifier나 세션 값은 조회하지 않았습니다. 등록 완료로 잘못 처리하거나 창을 임의로 제거하지 않았습니다.

두 새 비공개 저장소 `uulab-official/flora-qa-13836a78-a`와 `-b`에 SDK를 포함한 연결 전 RN 템플릿을 커밋했습니다. 저장소 ID는 각각 1424400453/1424400811, 첫 commit은 `19fbc38b734716459b616f6fc28325b76e1a8f00`/`ea38fa387f3c48969df3b35a1b87dbb7b39c343c`이며 Actions 실행은 각각 0입니다. PC Docker 29.9.0과 고정 npm arm64 이미지도 확인했습니다. 새 private QA scratch만 준비했으며 Runner token·프로세스·기존 launch agent는 변경하지 않았습니다.

사용자가 승인한 명시적 `setup renew` 보완의 첫 targeted 검증은 CLI/provider/provision/실제 workerd 인증 64 pass / 0 fail입니다. 이는 구현 중간 단계의 결과이며 최종 전체 검사와 실제 갱신 배포는 별도 기록합니다. 관리자 등록·GitHub App 승인·PC Runner 연결·두 앱 × 두 플랫폼 자동 OTA 게시·다운로드는 여전히 완료 전입니다.


### 명시적 갱신의 최종 로컬 검증

독립 보안 검토에서 조회 중 만료, 유휴 만료 반영, 조회 중 취소 3개 P2 경계 조건을 확인했습니다. 각각 회귀 테스트 실패를 확인하고 수정했습니다. 최종 관련 테스트 35 pass, 전체 `pnpm check`는 build·typecheck와 **1,459 pass / 0 fail / 3 skip / 0 cancelled**, exit 0(테스트 538.44초)입니다. 조건부 생략은 Windows, 별도 실제 Expo 앱, 별도 PNPM Docker 이미지의 3개 환경 검사이며 통과로 세지 않습니다. 서버 인증 엔진의 실제 workerd 검사도 만료된 미등록 창의 다음 generation 등록·로그인, 이전 코드 및 등록 후 재사용 거부를 확인합니다. 실제 QA 갱신 배포·사용자 등록은 이 로컬 결과와 별도 증거입니다.
