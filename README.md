# Flora

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

**현재 상태: 로컬 Foundation과 앱 검증 화면.** 타깃·설정·SQLite Job/lease/fence, 정적 앱 snapshot과 개발 baseline import, 이력과 보호된 loopback Dashboard/CLI를 제공합니다. 기본 실행 provider는 blocked입니다. 조직 로그인, 실제 Runner/native build, Vault, OTA, 스토어 업로드, Cloudflare 배포와 AI 코드 수정은 후속 단계입니다.

별도 Cloudflare 경로에는 단일 소유자 비밀번호 로그인과 비공개 source/baseline 반입·이력 조회를 구현하고 로컬 Worker/DO/D1 합성 테스트를 추가했습니다. 실제 Free 계정 용량·성능, 운영 배포·도메인/TLS, 소유자 등록과 비공개 파일 업로드는 아직 미검증입니다. [비밀번호 보호 웹 반입 개발 가이드](docs/development/password-hosting.ko.md)와 [출시 증거·남은 조건](docs/release/password-hosting-evidence.md)을 확인하세요. 호스팅 경로에서는 Runner를 실행하지 않습니다.

[처음 실행하기: 준비 → 설치 → 결과 확인 → 문제 해결](docs/getting-started.ko.md)부터 따라 해보세요. [가상의 앱으로 웹 화면 열기](docs/development/dogfood.ko.md)는 계정이나 실제 저장소 없이 체험할 수 있습니다. 현재 컴퓨터의 loopback URL이며 공개 서비스 주소가 아닙니다.

## 지금 직접 실행하기

먼저 [Node.js 24.19.0](https://nodejs.org/en/download/archive/v24.19.0)과 [Git](https://git-scm.com/install/)을 준비합니다. Node에 포함된 npm을 사용하므로 pnpm 전역 설치는 필요 없습니다. macOS/Linux 터미널, Windows PowerShell 또는 명령 프롬프트에서 한 줄씩 실행합니다.

```sh
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
npm exec --yes --package=pnpm@11.19.0 -- pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
```

확인할 결과는 `check`의 **0 fail**, simulation의 `mode: "local-simulation"`, Job의 `status: "success"`, `attemptCount: 2`, `fence: 2`, `rejectedOperations`의 `LEASE_STALE`입니다. 오래된 실행권을 거부한 정상 결과이며 실제 앱 빌드 성공이 아닙니다. 임시 SQLite DB는 실행이 끝나면 제거됩니다.

Windows에서 `npm.ps1` 실행 정책 오류가 나면 위 명령의 `npm`만 `npm.cmd`로 바꾸세요. 보안 정책을 낮출 필요가 없습니다. [전체 시작 가이드](docs/getting-started.ko.md)에 정확한 예상 출력과 복구 방법이 있습니다. API key·로그인·클라우드 계정은 필요하지 않습니다. 최초 설치는 공개 패키지를 내려받으므로 인터넷 연결이 필요합니다.

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

1. [왜 만드는가: 개발 의도와 제품 원칙](docs/product/intent.ko.md)
2. [통합 기획서: 전체 제품 범위](docs/product/integrated-plan.ko.md)
3. [원문 102개 항목 추적표](docs/product/requirements.ko.md)
4. [Cloudflare·플러그인·PC 독립 실행 설계](docs/architecture/control-plane-and-runners.ko.md)
5. [단계별 구현과 완료 기준](docs/roadmap/milestones.ko.md)
6. [첫 Foundation 설계안](docs/superpowers/specs/2026-10-06-foundation-design.md)
7. [공식 문서로 확인한 제약과 비용](docs/reference/provider-facts.ko.md)
8. [Foundation 상세 구현 계획](docs/superpowers/plans/2026-10-06-foundation-implementation.md)
9. [웹 AI 코드 수정: 검토 대기 중인 상세 설계 제안](docs/proposals/web-ai/next-slice-spec.ko.md) · [아키텍처 추가안](docs/proposals/web-ai/architecture-addendum.ko.md)

## 완전 오픈소스 원칙

Core, Dashboard, CLI, Runner, 공식 Adapter, RBAC, Audit, Vault 인터페이스, Self-host 배포 코드는 모두 공개하는 방향입니다. 핵심 보안·팀 운영 기능을 유료 에디션에만 두지 않습니다. 유료 서비스를 제공하더라도 호스팅·관리·지원 같은 편의성을 판매합니다.

라이선스는 **[Apache-2.0](LICENSE)**입니다. 소스 사용·수정·재배포·상업적 이용을 허용하는 공개 라이선스를 적용합니다. Third-party 구성요소에는 해당 라이선스와 NOTICE를 유지합니다.

## 비용과 실행 환경

Expo 유료 플랜 의존 제거는 목표입니다. Apple/Google 개발자 계정, 필요한 Mac 하드웨어, 클라우드 사용량, 도메인 등 제3자 비용까지 없어지는 것은 아닙니다. iOS 빌드는 macOS/Xcode Runner가 필요합니다. Windows 개발자도 웹에서 조직의 Mac Runner에 작업을 요청할 수 있게 합니다.

서비스 운영 인프라는 Cloudflare를 우선합니다. 다른 개발자의 PC를 사용하기 위해 최초 개발자의 개인 로그인 세션이나 로컬 파일에 의존해서는 안 됩니다. 상세 제약은 [공식 문서 확인 기록](docs/reference/provider-facts.ko.md)을 따릅니다.
