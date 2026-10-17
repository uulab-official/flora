# SDK·Runner 소스 정리와 새 clone 검증 — 2026-10-17

## 검증한 소스

- 소스 commit: `0d253be693476bac3c1e75f69a7eea4bc6f9637c`
- 소스 tree: `82690a3f7db703a7e2e49f740657d7497ac7b3e8`
- 검증 브랜치: `codex/clean-clone-sdk-runner-20261017`. 원본 작업 폴더의 `main`과 기존 스테이징은 유지합니다.
- 소스 516개: SDK `@flora/ota` 0.3.2, Runner `@flora/runner` 0.1.0의 manifest·TypeScript·iOS/Android 네이티브 소스·plugin·테스트·PC 서비스 스크립트와 전이 workspace 의존성을 포함합니다.
- 실행 환경: macOS / arm64, Node 24.19.0, pnpm 11.19.0, npm 10.9.8.

로컬 Git 후보를 `git clone --no-local --single-branch`로 새로 받았습니다. 별도의 빈 HOME·npm cache·pnpm store·XDG 디렉터리와 서로 다른 빈 npm user/global 설정을 사용했습니다. 기존 설치 폴더나 Git·npm 인증 정보는 복사하지 않았습니다. 공개 의존성 다운로드에는 네트워크를 사용했습니다.

## 실행 결과

| 검사 | 결과 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts --store-dir <새 store>` | 종료 코드 0 |
| `pnpm check` — 전체 workspace build·타입 검사·테스트 | 1373 pass / 0 fail / 5 skip, 총 1378건 |
| PC Runner·bootstrap·사용량 수집·테스트 실행기 추가 검사 | 89 pass / 0 fail |
| `pnpm flora doctor --strict --json` | 종료 코드 0, `readiness.ready: true` |
| `pnpm flora dogfood --help` | 종료 코드 0 |
| `pnpm flora config validate --file examples/local-workflow.json` | 종료 코드 0 |
| `pnpm flora job simulate --file examples/local-workflow.json --scenario runner-replacement` | 종료 코드 0 |
| clone의 Git 상태와 추적 소스 hash | 변경 없음 |

추가 검사는 전체 빌드 완료 후 `node --test --test-concurrency=1`로 아래 파일을 실행했습니다.

- `scripts/github-runner-bootstrap.test.mjs`
- `scripts/local-runner/health.test.mjs`
- `scripts/local-runner/supervisor.test.mjs`
- `scripts/local-runner/usage-collector.test.mjs`
- `scripts/local-runner/usage-service.test.mjs`
- `scripts/test-runner.test.mjs`

skip 5건은 Windows 전용 private-store/junction 검사, 별도 실제 Expo 앱·Docker pnpm 이미지로 실행하는 선택적 검사 2건, Android build tools를 필요로 하는 실제 APK 서명 검사 2건입니다. 이 항목들의 실행 성공을 주장하지 않습니다.

## 발견한 문제와 수정

1. 기존 Git 추적 파일만 복사한 환경에서는 frozen install 자체는 성공했지만, 누락된 workspace 소스로 빌드가 `TS2307` 오류를 냈습니다. SDK·Runner와 필요한 전이 소스를 검증 브랜치에 포함했습니다. `verify:clean`에는 추적 manifest에 없는 `workspace:` 의존성을 `WORKSPACE_SOURCE_INCOMPLETE`로 거부하는 사전 검사와 회귀 테스트를 추가했습니다.
2. 최초 전체 검사에서는 큰 D1 바인딩 직렬화 이후 로컬 Miniflare의 idle 연결에서 응답 확인이 `ECONNRESET`으로 실패했습니다. DB 쓰기는 이미 끝났을 수 있으므로 재시도하지 않습니다. 로컬 테스트 harness의 `/cdn-cgi/local/platform-proxy` RPC에만 이벤트 루프 양보를 추가하고, 단 한 번 쓰기·고유키 중복 거부 회귀 검사를 추가했습니다. 일반 HTTP 요청의 body/admission 타이밍과 운영 코드는 변경하지 않았습니다.
3. 보완 과정의 일반 HTTP 타이밍 실패, Miniflare URL 타입 오류, 빌드 전 추가 검사 실패도 로그에 남겼습니다. 수정된 최종 소스에서 설치·빌드·타입 검사·전체 테스트와 빌드 후 추가 검사를 다시 통과한 결과만 위 표에 집계했습니다.

## 보존과 범위

원본 HEAD·실제 Git index/staging을 비교했고, 이번 작업에 해당하는 파일 외의 기존 추적 파일은 hash가 같습니다. 운영 DB·키·배포 자산·복구 저널·Runner 서비스 설정을 이전하거나 삭제하지 않았습니다. `.gitignore`는 생성물과 개인키·서명 자료의 신규 추가를 방지합니다. 공개 인증서 fixture는 테스트 소스로 유지합니다.

이 작업은 EAS·GitHub Actions·운영 OTA 배포를 실행하지 않았습니다. 실제 기기나 네이티브 binary 빌드·서명 검증도 이번 결과에 포함하지 않습니다. SDK registry 게시와 `main` 병합은 별도입니다. 검증 브랜치 공개 시 마지막 문서 commit에 `[skip ci]`를 사용하며 기존 workflow 설정은 변경하지 않습니다. 위 소스 commit 이후 검증 기록 문서만 추가합니다.

재현 절차는 [새 clone 검증 가이드](clean-clone-source.ko.md)를 따릅니다. 이전 실제 앱 OTA 증거는 [6개 앱·플랫폼 네트워크 복구 기록](github-release-ota-network-2026-10-17.ko.md)과 구분합니다.
