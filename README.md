# Flora

**Open Source App Operations Platform**

> Your apps. Your runners. Your cloud. Your control.

Flora는 iOS, Android, Web 앱의 빌드·서명·환경설정·스토어·OTA·웹 배포와 운영 이력을 한곳에서 연결하는 앱 운영 플랫폼입니다. **Flora는 임시명**이며 내부 데이터 모델과 패키지는 브랜드 변경에 독립적으로 설계합니다.

## 지금 가장 중요한 목표

- Expo 유료 서비스가 필수가 아닌 빌드·업데이트·배포 경로
- Cloudflare에 배포하는 공통 관리 화면과 API
- GitHub, Apple, Google, Cloudflare 등을 선택해서 연결하는 오픈소스 플러그인
- 특정 개발자 PC가 꺼져 있거나 바뀌어도, 권한이 있는 다른 개발자가 작업을 이어갈 수 있는 조직 공용 Runner
- 설정과 인증서 파일을 사람마다 복사하지 않아도 되는 팀 운영

**현재 상태: 로컬 Foundation 구현.** 타깃 검증, 설정 스냅샷, SQLite Job/lease/fence, synthetic artifact·Release 이력과 CLI가 구현되었습니다. 로그인, 실제 Runner daemon/native build, Vault, OTA, 스토어 업로드, Cloudflare 배포와 Dashboard는 아직 구현되지 않았습니다.

[로컬 설치·실행 가이드](docs/development/local-foundation.ko.md)의 명령은 실행할 수 있습니다. 제품 기획서의 나머지 명령·화면은 향후 목표입니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
```

Node 24.19.0 / pnpm 11.19.0 기준입니다. 기존 pnpm 없이 시작하는 방법도 실행 가이드에 있습니다. 실제 클라우드 리소스나 credential을 만들지 않습니다.

## 문서

1. [왜 만드는가: 개발 의도와 제품 원칙](docs/product/intent.ko.md)
2. [통합 기획서: 전체 제품 범위](docs/product/integrated-plan.ko.md)
3. [원문 102개 항목 추적표](docs/product/requirements.ko.md)
4. [Cloudflare·플러그인·PC 독립 실행 설계](docs/architecture/control-plane-and-runners.ko.md)
5. [단계별 구현과 완료 기준](docs/roadmap/milestones.ko.md)
6. [첫 Foundation 설계안](docs/superpowers/specs/2026-10-06-foundation-design.md)
7. [공식 문서로 확인한 제약과 비용](docs/reference/provider-facts.ko.md)
8. [Foundation 상세 구현 계획](docs/superpowers/plans/2026-10-06-foundation-implementation.md)

## 완전 오픈소스 원칙

Core, Dashboard, CLI, Runner, 공식 Adapter, RBAC, Audit, Vault 인터페이스, Self-host 배포 코드는 모두 공개하는 방향입니다. 핵심 보안·팀 운영 기능을 유료 에디션에만 두지 않습니다. 유료 서비스를 제공하더라도 호스팅·관리·지원 같은 편의성을 판매합니다.

라이선스는 **[Apache-2.0](LICENSE)**입니다. 소스 사용·수정·재배포·상업적 이용을 허용하는 공개 라이선스를 적용합니다. Third-party 구성요소에는 해당 라이선스와 NOTICE를 유지합니다.

## 비용과 실행 환경

Expo 유료 플랜 의존 제거는 목표입니다. Apple/Google 개발자 계정, 필요한 Mac 하드웨어, 클라우드 사용량, 도메인 등 제3자 비용까지 없어지는 것은 아닙니다. iOS 빌드는 macOS/Xcode Runner가 필요합니다. Windows 개발자도 웹에서 조직의 Mac Runner에 작업을 요청할 수 있게 합니다.

서비스 운영 인프라는 Cloudflare를 우선합니다. 다른 개발자의 PC를 사용하기 위해 최초 개발자의 개인 로그인 세션이나 로컬 파일에 의존해서는 안 됩니다. 상세 제약은 [공식 문서 확인 기록](docs/reference/provider-facts.ko.md)을 따릅니다.
