# Flora: 웹 AI 코드 수정 아키텍처 추가안

작성: 2026-10-06 UTC · 독립 검토 반영·공식 자료 재확인: 2026-10-07 UTC

**상태: 검토용 초안. 설계·구현 계획 승인 전이며 구현된 기능 목록이 아니다.** 실제 API 호출, credential 생성, 서비스 등록, 배포, 제품 코드 변경은 수행하지 않았다.

## 1. 명시적인 범위 변경

새 우선순위는 “목표대로 다 하고 제일 좋은건 웹으로 ai로 코드 수정하는거야”다. 기존 [통합 기획 §13](https://github.com/uulab-official/flora/blob/f13f8d96fa9e6aa5bd63b7f5b3a38f8466f97f67/docs/product/integrated-plan.ko.md)은 AI를 MVP에서 제외했다. 이를 **사용자가 명시적으로 승인한 범위·우선순위 변경**으로 기록한다. 이전 계획에 AI가 이미 포함되었거나 구현되었다고 고쳐 쓰지 않는다. 사용자 검토가 남은 것은 이 새 방향 자체가 아니라 아래에 제안한 상세 아키텍처와 이후 구현 계획이다.

변경 후 제품 방향은 **웹에서 변경 요청 → 격리된 소스 작업공간 → AI 패치 → diff·테스트 검토 → GitHub branch·draft PR → 기존 App Operations로 인계**다. GitHub, Flavor/Environment/Config, Vault, native build, Store, OTA, Web, Release history라는 원래 목표는 유지한다. 코딩 기능이 별도 배포 시스템을 만들지 않고 같은 소스·타깃·이력에 연결된다.

현재 기준은 [Foundation 커밋 f13f8d9](https://github.com/uulab-official/flora/commit/f13f8d96fa9e6aa5bd63b7f5b3a38f8466f97f67)이다. 확인한 실제 구현은 로컬 core/config/SQLite Job·lease·fence/CLI simulation이다. 로그인, RBAC, 웹 UI, 실 Runner daemon, AI/provider 연동은 없다. 기존 Linux/macOS/Windows Foundation CI 성공은 이 새 흐름이나 격리 검증의 증거가 아니다.

원문 102개 요구사항은 보존하고 A010 “웹 AI 코드 수정과 검토·운영 인계”를 추가하는 것이 좋다. R083의 원래 AI 제외 기록 옆에 이번 변경을 연결한다.

## 2. 가능한 세 가지 접근

| 접근 | 장점 | 비용·제약 | 판단 |
| --- | --- | --- | --- |
| **A. Cloudflare 관리 화면 + 이식 가능한 조직 Coding Runner** | 개인/공용/클라우드 Runner, 자체 모델, BYOK를 같은 계약으로 연결. 원래 운영 플랫폼과 일치 | 실제 인증·격리·취소·Runner 운영을 우리가 구현·검증해야 함 | **권장. 다음 단계는 한 저장소의 작은 패치 경로** |
| B. Cloudflare Sandboxes를 첫 실행 환경으로 고정 | 관리 화면과 가까운 Linux 격리 실행, 직접 VM fleet 운영 감소 | Workers Paid·사용량 비용, Linux 범위, 현재 Durable Object scheduling policy는 public beta. macOS/Xcode 대체가 아님 | 후속 실행 adapter로 추가 |
| C. 외부 hosted coding agent로 요청을 전달하고 결과 PR을 가져오기 | 외부 서비스가 지원하는 흐름에서는 빠르게 가치 검증 | 서비스별 API/권한/과금/감사 범위, 자체 Runner·로컬 모델 보장 불가 | 선택 integration. 공개·허용된 호출 경로를 실제 검증한 경우만 지원 |

Cloudflare는 현재 Containers 기반 Linux sandbox를 개별 kernel/network가 있는 microVM으로 설명한다. 단순 Worker isolate를 Linux build machine처럼 쓰는 설계는 아니다. [공식 Sandbox 개요](https://developers.cloudflare.com/sandbox/)

GitHub의 coding agent도 Actions minutes와 AI credits를 소비한다고 명시한다. 특정 구독을 Flora의 범용 무제한 AI API로 취급하지 않는다. [공식 agent 비용](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)

## 3. 권장 책임 경계

- **웹/Control Plane:** 사용자·조직·권한, source SHA 고정, 실행 정책, Job/승인/감사, diff와 결과 조회. Cloudflare Workers를 우선하고 D1 metadata·R2 private artifacts를 연결한다. Git checkout·package install·테스트 프로세스를 API 안에서 실행하지 않는다
- **Runner supervisor:** 조직이 허용한 머신에서 outbound HTTPS polling으로 작업을 받는다. 인바운드 포트·개인 개발자 세션은 필요 없다. machine identity와 lease를 검증하고 격리 환경 생성·자원 제한·중단·폐기를 책임진다
- **Source/AI broker:** GitHub installation credential과 미래 BYOK key는 Control Plane 측 전용 service에 두고 sandbox에 전달하지 않는다. source 전달과 모델 호출을 repo/model·payload·예산으로 제한한다. 로컬 모델은 Runner 측 trusted broker가 사전 등록된 endpoint로 호출하되 repository 코드를 실행하는 process와 분리한다
- **Coding sandbox:** 작업당 새 VM 또는 검증된 OS/container 격리 환경. 선택된 source와 비밀 없는 테스트 입력만 받는다. source·dependency·AI 결과는 모두 비신뢰 데이터다
- **Publisher/Release 경계:** 웹에서 승인한 exact diff를 별도 publisher broker가 지정 repo의 전용 branch와 draft PR로 반영한다. repo write credential은 sandbox에 주지 않는다. main merge·protected branch 반영·signing·Store/OTA/production 배포는 별도의 권한·승인·실행 경로다

Core·UI·Runner·공식 adapter·RBAC·감사는 기존 Apache-2.0 방향을 유지한다. 모델 weight, 외부 API, 클라우드 서비스와 OS의 라이선스·이용 조건은 별도다. “완전 오픈소스”는 외부 비용 0이나 모든 모델의 오픈소스를 뜻하지 않는다.

## 4. 웹 노출 전에 필요한 인증과 권한

GitHub 사용자 인증을 우선하되 **GitHub 로그인과 Flora 조직 권한, GitHub App 설치는 별개**다. 서버가 검증한 subject에 조직 Membership과 app/repo scope를 연결하고 매 API/로그 stream/artifact download에서 권한을 검사한다. email 문자열이나 client가 보낸 organization ID만 믿지 않는다. GitHub App은 선택한 저장소의 필요한 읽기 권한부터 사용한다. [사용자 승인과 App 설치의 차이](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps), [installation 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

초기 capability는 read / coding.run / coding.cancel / patch.approve / coding.publish_draft / runner.manage / integration.manage로 분리한다. Viewer는 실행 불가, Developer는 허용 repo에서 제안 가능, Reviewer는 특정 결과 승인 가능, Admin은 등록·revoke를 관리한다. draft PR 게시 권한은 별도로 부여한다. 단독 사용자에게 여러 역할을 줄 수 있으나 숨은 자동 승인은 만들지 않는다. coding 권한은 secret reveal·production publish 권한을 포함하지 않는다.

세션은 서버 검증, CSRF/Origin 검사, 안전한 cookie, 만료·logout/revoke, request/동시성 제한을 갖춘다. 시험용 인증은 명시적인 loopback test 모드에만 있고 배포 모드에서 시작 자체를 거부한다. 기존 로컬 함수가 받는 `now`, `actorId`, `authorization`은 HTTP body에서 신뢰해 전달하지 않고 서버 clock·principal·RBAC로 생성한다.

## 5. 실제 격리와 비밀 차단

Git worktree는 여러 checkout을 관리하는 도구이지 OS 보안 경계가 아니다. 첫 adapter는 **production credential이 없는 전용 Linux coding host의 hardened rootless container**를 최소 지원 수준으로 삼고, hostile multi-tenant/public PR에는 job당 VM/microVM을 요구한다. host에는 제한된 Runner identity가 필요하며 kernel 공유와 host administrator 신뢰는 남는다. macOS/Windows 호스트의 지원 여부는 검증된 Linux VM 경로 또는 별도 검증된 adapter로 표시하며 native iOS build 지원과 혼동하지 않는다. [Git worktree](https://git-scm.com/docs/git-worktree), [Docker 보안 모델](https://docs.docker.com/engine/security/)

필수 정책:

- host home/SSH agent/cloud config/Keychain/Docker socket·privileged device/다른 Job 디렉터리 mount 금지. root filesystem read-only, 작업별 writable volume, capability drop, no-new-privileges, seccomp, CPU/memory/PID/disk/time 제한
- **Vault/signing/Store/production secret은 코딩 sandbox에 0개.** 미래 일반 Vault가 생겨도 coding job에는 secret resolution 자체를 허용하지 않음
- repository 코드는 network-off. source와 pinned dependency 준비는 별도 helper가 처리하고, 테스트는 offline cache로 실행. 초기에는 private package 설치·임의 network·MCP·사용자 shell을 지원하지 않음
- 모델은 등록된 provider만 broker가 호출. remote endpoint의 DNS/private IP/metadata/redirect 우회 차단; 등록된 local model endpoint만 좁은 예외. 사용자 prompt가 endpoint나 network allowlist를 바꾸지 못함
- symlink·경로 이탈·`.git`·submodule·git hook/config·binary·과대 파일을 검증. host의 shared writable Git metadata를 sandbox에 노출하지 않음
- 설치 script와 테스트도 비신뢰 코드다. 명령 이름 allowlist만으로 안전해지지 않으므로 같은 격리·시간 제한을 적용

Cloudflare 역시 같은 sandbox의 모든 코드가 그 안의 값에 접근할 수 있고 credential을 외부에 두라고 경고한다. network allowlist·masking은 악성 코드가 접근 가능한 데이터를 악용하는 위험을 없애지 못한다. [공식 Sandbox 보안](https://developers.cloudflare.com/sandbox/concepts/security/)

Live preview는 이번 범위에서 제외한다. 후속 구현에서도 비신뢰 앱을 Control Plane과 분리된 origin에서 제공하고 Control Plane cookie·token·주변 API 권한을 공유하지 않으며, 미리보기 접근제어와 browser isolation을 별도로 검증한다.

## 6. AI, 코드 유출, 비용의 정직한 계약

`AiProvider`는 provider/model·endpoint profile·지원 기능·사용량·중단·오류 계약으로 분리한다. **이미 구성된 local inference 또는 사용자가 허용한 BYOK API provider를 선택**할 수 있게 한다. 로컬 모델을 제품의 품질 기준이나 필수 경로로 강요하지 않는다. 첫 acceptance에는 실제로 구성된 provider 하나 이상의 end-to-end 증거가 필요하며, 검증하지 않은 adapter와 deterministic fixture는 각각 미검증·시험용으로 표시한다. 모든 OpenAI-compatible endpoint가 같은 기능을 제공한다고 가정하지 않는다.

외부 모델 전송 전 목적지, 전송할 source 범위, prompt·로그 포함 여부, retention/data policy와 예산을 보여준다. 로컬 모델은 모델 process 자체의 egress를 막고 cloud fallback·telemetry로 source가 전송되지 않는 것을 검증한 경로에서만 “로컬 처리”라 표시한다. Ollama는 공식 local API를 제공하지만 cloud 경로도 있으므로 local URL만으로 완전 offline을 추정하지 않는다. [Ollama API](https://docs.ollama.com/api/introduction)

repo의 AGENTS/README/주석, PR 본문, package script, AI tool output은 권한을 부여하는 지시가 아니다. 모델에 전달할 문맥을 비신뢰 자료로 구분하고, 승인·egress·secret·publisher 권한은 모델 밖의 코드가 강제한다. prompt 문장이나 injection detector만을 보안 경계로 삼지 않는다. [OpenAI의 agent 위험 설명](https://developers.openai.com/api/docs/guides/agent-builder-safety)

비용 화면에는 provider token/tool 사용량, Runner 시간·하드웨어, 저장·로그·network를 구분한다. 로컬 모델에도 장비·전력·운영비가 있다. 실행당 token/시간/동시성 한도를 선차감·예약하며 잔액이 불명확하면 새 요청을 중단한다. timeout 후 유료 생성 재시도는 중복 비용 가능성을 표시한다. 취소가 이미 발생한 청구를 취소하지 않는다. **ChatGPT 구독과 일반 API 과금은 분리**되어 있다. [OpenAI 공식 billing](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform), [Cloudflare Containers 가격](https://developers.cloudflare.com/containers/platform/pricing/)

## 7. 스냅샷, 검토, 이력, 취소

CodingSession은 tenant/repo/app/root/base SHA, 요청·허용 파일·test profile·model profile·egress/resource policy의 digest를 고정한다. Prompt/source는 민감한 private artifact로 tenant ACL·retention을 적용하며 audit에는 필요한 digest·식별자만 남긴다. 비밀 탐지 실패 가능성은 남으므로 원래부터 비밀 없는 입력이 기본이다.

각 attempt의 Runner identity·격리 profile/image digest·toolchain·lease/fence, 사용량, patch digest·candidate tree digest, 테스트의 실제 exit status·명령·결과 digest를 보존한다. 모델의 “테스트 통과” 설명은 증거가 아니다. AI 실행 실패·빈 diff·정책 차단·테스트 실패를 별도 표시한다.

검토 승인은 base SHA + patch/tree + 비밀 없는 config snapshot + toolchain/test profile/results + 대상 repo/ref + 게시할 draft PR 내용·승인 주체에 바인딩한다. 새로운 prompt·파일 수정·검증 입력 변경은 이전 승인을 무효화한다. branch가 앞으로 이동하면 자동 덮어쓰기/자동 재승인 없이 stale로 표시하고 새 base에서 재생성·재검증한다. 원격 commit의 tree가 승인된 candidate tree와 같은지 확인하고 publication receipt에 candidate → remote SHA 매핑을 기록한다. tree 일치는 이전 evidence 연결의 필요조건이며 모든 테스트·artifact의 동등성을 뜻하지 않는다. **실제 게시된 SHA에서 CI를 다시 실행·확인**하고, commit metadata가 bundle/provenance에 들어가는 artifact는 그 revision으로 다시 만든다. 수동 반영·merge로 tree가 달라지면 다시 검증·승인한다. Release에는 최종 확인된 commit SHA로 **새 ConfigSnapshot**을 만들고 CodingSession/patch/test provenance를 연결한다. 기존 base source에 묶인 snapshot을 새 commit의 snapshot인 것처럼 재사용하지 않는다.

CI 통과는 이름이나 aggregate green만으로 판단하지 않는다. 승인된 expected GitHub App ID/CI actor, workflow ID·path·profile version, 실제 published SHA와 필요한 test-merge SHA, run ID·attempt를 함께 고정한다. 기본값은 해당 실행의 `completed` + `success`만 허용하며 누락·출처 불명·모호한 중복·stale rerun·skipped/neutral을 통과로 보지 않는다. 명시적 정책 예외는 범위·사유·승인자·만료를 남기고 “테스트 성공”과 구분한다. GitHub branch protection 자체는 skipped/neutral을 허용할 수 있고 같은 이름의 status를 다른 writer가 만들 수 있으므로 Flora의 실행 증거 기준은 더 엄격해야 한다. [공식 required checks·expected source](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)

취소/revoke는 먼저 lease와 broker 권한을 무효화하고 새 AI/tool 요청과 finalize를 거부한다. supervisor가 process tree를 중단하고 격리 workspace를 폐기한다. 네트워크 단절 시 로컬 lease deadline에 강제 중단한다. “취소 요청됨”과 “프로세스 종료·정리 확인됨”을 구분하고, 폐기 실패는 Runner quarantine과 운영 경고로 남긴다. sandbox가 사라져도 제한된 감사·결과 이력은 남는다.

## 8. 다음 단계와 승인

권장 다음 단위는 별도 [웹 AI 변경 명세](next-slice-spec.ko.md)의 **한 저장소·한 app·비밀 없는 Linux 검증·전용 branch와 draft PR**이다. 현재 Foundation에 없는 구성요소가 많으므로 작은 코드 변경이 아닌 좁은 end-to-end milestone이며, 로컬 실행 증거 → 인증된 웹·Runner → 실제 GitHub 게시의 세 완료 단위로 나눈다. patch export는 중간 검증/권한 미설정 시의 fallback이지 영구적인 제품 종착점이 아니다. native build·일반 Vault·Store·OTA/Web deploy를 끝냈다고 표시하지 않는다.

Export-only는 GitHub read-only 권한으로 검증할 수 있지만 사용자가 직접 적용해야 한다. 권장 milestone 완료는 별도 권한을 가진 broker로 실제 branch·draft PR을 생성하고 원격 SHA/tree·URL을 재조회하여 웹 요청의 결과를 팀이 바로 검토할 수 있게 하는 것이다. 선택 repo의 Contents write·Pull requests write와 사용하는 CI API의 Checks read·Commit statuses read가 필요하며 새 권한 부여는 실제 setup 때 승인받는다. Workflows write·Actions write는 기본 요구하지 않는다. Contents write가 upstream에서 merge까지 허용할 수 있으므로 broker의 merge/주요 branch 차단과 GitHub branch protection을 별도로 검증하고 App을 bypass actor로 두지 않는다. [Git reference 생성](https://docs.github.com/en/rest/git/refs#create-a-reference), [draft PR 생성](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [GitHub Actions 보안](https://docs.github.com/en/actions/reference/security/secure-use)

이 기본 scope만으로 모든 사전 검사가 가능한 것은 아니다. webhook 조회에는 Webhooks read, branch protection 조회에는 Administration read, Actions workflow/run identity 조회에는 해당 Actions read가 필요할 수 있다. 필요한 읽기 권한은 별도로 승인받거나, 검증된 repository owner가 허용 ref·알려진 CI/deploy 효과·보호 설정을 명시한 좁은 publication policy와 증빙/attestation을 제공한다. 정책은 repo ID·설정 version/digest·소유자·확인/만료 시각에 묶고 게시 때 재검증한다. API로 읽지 못한 항목은 “없음”으로 처리하지 않는다. webhook 목록만으로 installed-app·외부 polling automation이 없음을 증명할 수 없으며, owner가 정한 inventory/change-control 범위와 잔여 신뢰를 밝힌다. 필요한 사실이 여전히 불명확하면 게시를 막고, 알려진 허용 CI·알림·비용만 정책 안에서 실행한다. [Webhooks 조회 권한](https://docs.github.com/en/rest/repos/webhooks#list-repository-webhooks), [Branch protection 조회 권한](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)

이 문서와 다음 명세를 사용자가 검토·승인한 뒤 상세 구현 계획을 작성한다. 그 계획도 검토받고 실행 방식을 정한 다음 코드에 착수한다. 광범위한 목표 동의나 기존 Foundation 승인을 새 문서의 승인으로 대신하지 않는다. GitHub App 등록·권한 부여, machine credential, 모델 다운로드·라이선스, 실제 Cloudflare 리소스·배포는 별도의 필요한 승인을 거친다.
