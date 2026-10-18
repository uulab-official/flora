# 설치 마법사 검증 기록 — 2026-10-18

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

## 새 clone와 원격 검증

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
