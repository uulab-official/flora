# Flora

2026-10-17 검증 기록: Isso·Promise·Reward의 iOS Simulator·Android Emulator 6개 조합에서 GitHub 커밋 → PC Runner 자동 export·OTA 게시 → 다운로드 중 네트워크 실패 → 재시도·적용·재시작 → Flora 상세 화면의 복구 집계까지 확인했습니다. 검증 설치는 각 배포 1개이며 물리 기기·전체 사용자 적용률이나 현재 서비스 상태를 보장하지 않습니다. [장애·복구 검증과 한계](docs/development/github-release-ota-network-2026-10-17.ko.md)를 확인하세요. 이 경로는 EAS·GitHub Actions·R2 구독을 사용하지 않습니다.

[한국어](README.md) · [English](README.en.md)

**Open Source App Operations Platform**

> Your apps. Your runners. Your cloud. Your control.

Flora는 iOS, Android, Web 앱의 빌드·서명·환경설정·스토어·OTA·웹 배포와 운영 이력을 한곳에서 연결하는 앱 운영 플랫폼입니다. **Flora는 임시명**이며 내부 데이터 모델과 패키지는 브랜드 변경에 독립적으로 설계합니다.

## 지금 가장 중요한 목표

- Expo 유료 서비스가 필수가 아닌 빌드·업데이트·배포 경로
- Cloudflare에 배포하는 공통 관리 화면과 API
- GitHub, Apple, Google, Cloudflare 등을 선택해서 연결하는 오픈소스 플러그인
- 특정 개발자 PC가 꺼져 있거나 바뀌어도, 권한이 있는 다른 개발자가 작업을 이어갈 수 있는 조직 공용 Runner
- 설정과 인증서 파일을 사람마다 복사하지 않아도 되는 팀 운영

**현재 상태: 멀티앱 기반, GitHub 앱 인식, 자체 네이티브 OTA SDK와 자동 export Runner 코드.** 고정 GitHub 커밋을 Flora SDK 설정으로 인식하고 앱별 정책·Job·Runner 권한·시도·배포 이력을 분리합니다. 기본은 Metro와 자체 OTA이며 Expo CLI export는 선택 가능한 오픈소스 어댑터입니다. EAS 계정·API는 사용하지 않습니다. [자동 배포·무료 운영 구성](docs/development/automation-runner.ko.md), [네이티브 SDK 연결](docs/development/native-ota.ko.md), [SDK](packages/ota-sdk/README.md), [Runner](packages/ota-runner/README.md)를 확인하세요.

기존 SQLite/D1 source·baseline·설정·OTA 자료는 additive migration으로 보존합니다. 로컬 Foundation의 모의 Job과 실제 OTA 운영 경로는 별개입니다. UULab 배포에서는 세 앱의 GitHub 연결·앱별 정책과 이력·PC Runner·서명된 OTA와 실패·복구 상세 화면을 검증했습니다. [처음 네이티브 엔진 검증](docs/development/native-ota-evidence.ko.md)과 [최신 실제 앱 검증](docs/development/github-release-ota-network-2026-10-17.ko.md)은 날짜·대상·환경별 증거입니다. 다른 설치의 연결과 무료 한도는 별도로 확인해야 합니다.

실제 운영에는 [호스팅 준비](docs/development/password-hosting.ko.md), [PC Runner 설치·운영](docs/development/local-pc-runner.ko.md), [구독 없는 GitHub Release 자산 저장소](docs/development/github-release-ota-storage.ko.md)를 순서대로 확인하세요. PC가 꺼지거나 잠들면 새 export는 대기합니다. GitHub에 게시가 확정된 자산의 다운로드는 PC와 분리됩니다. 조직 로그인·스토어 제출 등 전체 제품 계획을 이번 OTA 검증이 인증하는 것은 아닙니다.

[처음 실행하기: 준비 → 설치 → 결과 확인 → 문제 해결](docs/getting-started.ko.md)부터 따라 해보세요. [가상의 앱으로 웹 화면 열기](docs/development/dogfood.ko.md)는 계정이나 실제 저장소 없이 체험할 수 있습니다. 현재 컴퓨터의 loopback URL이며 공개 서비스 주소가 아닙니다.

## 지금 직접 실행하기

먼저 [Node.js 24.19.0](https://nodejs.org/en/download/archive/v24.19.0)과 [Git](https://git-scm.com/install/)을 준비합니다. Node에 포함된 npm을 사용하므로 pnpm 전역 설치는 필요 없습니다. macOS/Linux 터미널, Windows PowerShell 또는 명령 프롬프트에서 한 줄씩 실행합니다.

```sh
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform doctor --strict --json
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
```

`doctor --strict --json`은 Node 24.19.0·pnpm 11.19.0·Git 준비 여부를 검사합니다. `readiness.ready: true`이면 종료 코드 0, 필수 도구 누락·지원하지 않는 버전·검사 시간 초과로 준비되지 않으면 종료 코드 1입니다. `readiness.issues`의 `code`·`remediation`을 따라 같은 명령을 다시 실행하세요. 기존 `doctor` / `doctor --json`은 진단 보고용이며 준비 실패만으로 종료 코드 1을 반환하지 않습니다. 두 옵션의 순서는 바꿔도 됩니다. 도구 설치·설정 변경은 하지 않으며, Xcode·Java는 로컬 체험에 선택 항목입니다. `nativeBuildVerified: false`는 정상이고 실제 네이티브 빌드 준비를 증명하지 않습니다.

확인할 결과는 `check`의 **0 fail**, simulation의 `mode: "local-simulation"`, Job의 `status: "success"`, `attemptCount: 2`, `fence: 2`, `rejectedOperations`의 `LEASE_STALE`입니다. 오래된 실행권을 거부한 정상 결과이며 실제 앱 빌드 성공이 아닙니다. 임시 SQLite DB는 실행이 끝나면 제거됩니다.

Windows에서 `npm.ps1` 실행 정책 오류가 나면 위 명령의 `npm`만 `npm.cmd`로 바꾸세요. 보안 정책을 낮출 필요가 없습니다. [전체 시작 가이드](docs/getting-started.ko.md)에 정확한 예상 출력과 복구 방법이 있습니다. API key·로그인·클라우드 계정은 필요하지 않습니다. 최초 설치는 공개 패키지를 내려받으므로 인터넷 연결이 필요합니다.

새 clone의 독립 설치를 확인할 때는 [소스 완전성·격리 설치 절차](docs/development/clean-clone-source.ko.md)를 따르세요. `verify:clean`은 Git 추적 파일의 workspace 의존성이 빠지면 `WORKSPACE_SOURCE_INCOMPLETE`로 중단합니다. 이 검사는 추적 파일의 임시 사본을 사용하며 실제 Git clone 검증과는 구분합니다.

## 가상의 앱으로 로컬 화면 열기

설치·check를 완료한 뒤 다음을 실행합니다. 예제는 홈 profile의 `.flora/dogfood/demo.db`를 사용하며 실제 앱의 기본 `state.db`와 분리됩니다.

```sh
node scripts/dogfood-demo.mjs
node scripts/dogfood-demo.mjs --status
node scripts/dogfood-demo.mjs --serve
```

터미널에 한 번 출력된 URL을 같은 컴퓨터의 브라우저에서 엽니다. demo는 명백한 synthetic source·2개 파일/4개 테스트 증거를 반입합니다. 새 테스트 실행이나 isolated Runner 성공이 아닙니다. 실행 요청의 기본 결과는 `blocked`입니다. 비밀값이 든 bootstrap URL을 공유하지 마세요. 예제 store에 다른 앱이 있다면 자동 삭제하지 않고 `CONFLICT`로 멈춥니다. [별도 private store 사용법](docs/development/dogfood.ko.md)으로 새 경로를 선택할 수 있습니다.

## 문서

처음 방문했다면 [한국어 시작 가이드](docs/getting-started.ko.md) / [English quick start](README.en.md#try-the-local-foundation) → [CLI·데이터 계약 상세](docs/development/local-foundation.ko.md) 순서로 읽습니다.

자신의 PC에서 개발을 이어가려면 [PC 개발 인수인계·우선순위 체크리스트](docs/development/pc-handoff.ko.md)를 사용하세요. 설치 명령, Windows/Mac 차이, 확인된 검사와 미실행 검사, 다음 첫 작업과 완료 조건을 모았습니다. [실제 연동 현황](docs/development/integration-status.ko.md)은 구현·반입 데이터·운영 연결을 구분합니다. 계정 인증만으로 아직 없는 Runner·스토어·OTA 어댑터가 활성화되지는 않습니다.

1. [왜 만드는가: 개발 의도와 제품 원칙](docs/product/intent.ko.md)
2. [통합 기획서: 전체 제품 범위](docs/product/integrated-plan.ko.md)
3. [원문 102개 항목 추적표](docs/product/requirements.ko.md)
4. [Cloudflare·플러그인·PC 독립 실행 설계](docs/architecture/control-plane-and-runners.ko.md)
5. [단계별 구현과 완료 기준](docs/roadmap/milestones.ko.md)
6. [첫 Foundation 설계안](docs/superpowers/specs/2026-10-06-foundation-design.md)
7. [공식 문서로 확인한 제약과 비용](docs/reference/provider-facts.ko.md)
8. [Foundation 상세 구현 계획](docs/superpowers/plans/2026-10-06-foundation-implementation.md)
9. [웹 AI 코드 수정: 검토 대기 중인 상세 설계 제안](docs/proposals/web-ai/next-slice-spec.ko.md) · [아키텍처 추가안](docs/proposals/web-ai/architecture-addendum.ko.md)
10. [OTA 자산의 private R2 분리·무료 범위 보호·기존 D1 보존 절차](docs/development/r2-ota-assets.ko.md)
11. [구독 없는 GitHub Release OTA 저장소·PC Runner 연결](docs/development/github-release-ota-storage.ko.md)

## 완전 오픈소스 원칙

Core, Dashboard, CLI, Runner, 공식 Adapter, RBAC, Audit, Vault 인터페이스, Self-host 배포 코드는 모두 공개하는 방향입니다. 핵심 보안·팀 운영 기능을 유료 에디션에만 두지 않습니다. 유료 서비스를 제공하더라도 호스팅·관리·지원 같은 편의성을 판매합니다.

라이선스는 **[Apache-2.0](LICENSE)**입니다. 소스 사용·수정·재배포·상업적 이용을 허용하는 공개 라이선스를 적용합니다. Third-party 구성요소에는 해당 라이선스와 NOTICE를 유지합니다.

## 비용과 실행 환경

Expo 유료 플랜 의존 제거는 목표입니다. Apple/Google 개발자 계정, 필요한 Mac 하드웨어, 클라우드 사용량, 도메인 등 제3자 비용까지 없어지는 것은 아닙니다. iOS 빌드는 macOS/Xcode Runner가 필요합니다. Windows 개발자도 웹에서 조직의 Mac Runner에 작업을 요청할 수 있게 합니다.

서비스 운영 인프라는 Cloudflare를 우선합니다. 다른 개발자의 PC를 사용하기 위해 최초 개발자의 개인 로그인 세션이나 로컬 파일에 의존해서는 안 됩니다. 상세 제약은 [공식 문서 확인 기록](docs/reference/provider-facts.ko.md)을 따릅니다.
