# 다음 milestone: 웹 AI 변경을 GitHub 검토까지 연결하기

작성일: 2026-10-06 UTC · 독립 검토 반영: 2026-10-07 UTC

**상태: 사용자 검토 전 상세 설계 초안. 웹 AI 코드 수정이라는 방향과 범위 변경은 사용자가 명시적으로 승인했다. 이 문서는 상세 구현 계획이 아니며 그 계획과 실행 방식 검토를 대신하지 않는다.**

## 1. 목적과 성공 장면

사용자가 다른 PC의 브라우저에서 허용된 앱을 고르고 코드 변경을 요청한다. Flora는 고정된 GitHub revision을 비밀 없는 별도 작업공간에 준비한다. 조직의 Coding Runner가 구성된 AI provider를 통해 작은 text patch를 만들고 실제 테스트를 실행한다. 사용자는 diff와 증거를 본 뒤 정확한 결과를 승인하고 **실제 GitHub 전용 branch·draft PR과 재현 가능한 검증 이력**을 받는다. 나중에 이 commit이 기존 Build/Release로 이어진다.

목적은 이 한 흐름을 실제로 검증하는 것이다. 임의 프로젝트 전체를 자율 수정하는 IDE, 자동 main push, 앱 출시까지를 같은 완료 기준에 넣지 않는다. 기존 Foundation에는 auth/web/실행기가 없으므로 “작은 코드 수정”이 아닌 좁은 end-to-end milestone이며 §7의 세 완료 단위로 나눈다.

## 2. 명확한 범위

### 포함

- GitHub 사용자 인증 및 Flora 조직 Membership 기반 private 웹 UI/API; Viewer/Developer/Reviewer/Admin capability 검사
- 등록된 한 GitHub repo·한 app root·preview/web target, immutable base SHA와 제한된 file allowlist
- Cloudflare-compatible API/D1 adapter와 로컬 개발 경로; source/patch/results의 private artifact 저장 계약
- outbound polling 방식의 실제 Coding Runner supervisor, 제한된 registration/revoke·capability·lease/attempt/fence·취소
- 전용 Linux coding host의 검증된 격리 container 한 adapter. kernel 공유 위험을 명시하고 public fork/불특정 tenant 입력은 거부
- provider-neutral `AiProvider`와 구성된 local inference 또는 승인된 BYOK API 선택 경로 + deterministic test adapter; 구조화된 patch-only 응답. AI에게 임의 shell/network/MCP 도구를 주지 않음. provider별 미지원 기능은 fail closed
- BYOK를 선택한 경우 필요한 최소 credential broker: 관리자가 안전하게 구성한 secret reference만 사용하며 provider key는 browser·Job payload·Runner sandbox·로그에 전달하지 않음. 일반 앱 Vault와 분리
- source-only 작은 변경과 새 test 파일, 고정된 baseline tests를 실행하는 offline 검증. 첫 버전은 dependency/lockfile/workflow/보안정책 변경을 차단
- diff·테스트 결과·비용/사용량·취소 상태·실행 이력, 결과별 명시적 승인
- secret 없는 patch·provenance JSON export와 base SHA 적용 안내. 전체 Git history/ref를 담는 bundle은 첫 버전에서 제외
- 별도 publisher broker의 exact candidate 승인 → 앱 전용 branch 생성 → draft PR 생성 → remote SHA/tree·PR URL 재조회. merge·배포와 분리

### 제외

- SaaS public signup, arbitrary repo URL/fork PR 자동 실행, marketplace plugin, 조직 간 shared execution
- 완전한 코드 editor/terminal, live preview URL, 여러 model 자동 fallback, 백그라운드 무한 수정
- 일반 앱 Vault, 임의 provider를 자동 연결하는 기능, 확인되지 않은 구독 credit 변환·자동 model fallback
- AI key/GitHub token/signing key/production config의 sandbox 주입
- main push/merge·protected branch 변경, signed commit, native build, TestFlight/Play, OTA, 웹 배포
- 실제 cloud provisioning·credential 생성/등록, 새 모델 다운로드, 서비스 약관 수락을 개발 과정에서 자동 수행하는 것

로컬 테스트용 GitHub fixture·인증 fixture는 real integration과 구분한다. 실 GitHub 인증/checkout, 실제 구성된 AI provider, 다른 실제 Runner 교체를 검증하지 못한 부분은 “로컬 구현”까지만 표시한다. 첫 acceptance는 실제 provider 하나 이상을 요구하고 나머지는 검증 여부를 개별 표시한다. 단지 interface나 fake adapter가 통과했다고 제품 흐름의 실제 검증 완료로 부르지 않는다. 이 설계 작성 중에는 실제 모델 호출·credential 생성/권한 부여를 수행하지 않는다.

### Export-first와 draft-PR 완료 비교

| 경로 | 필요한 setup·권한 | 완료가 주는 가치 | 적용 |
| --- | --- | --- | --- |
| Export-only | private 로그인/Membership, GitHub read-only source access, Runner identity, local 또는 BYOK 설정 | 웹에서 만든 diff·테스트를 확인하고 수동 적용 가능. 실제 GitHub commit/PR은 없음 | 중간 검증·게시 권한이 없는 경우의 fallback |
| **Branch + draft PR** | 위 항목 + 선택 repo Contents write/Pull requests write 및 CI용 Checks read/Commit statuses read, 안전한 publisher credential custody, owner의 publication policy·증빙 또는 별도 승인한 조회 권한을 통한 CI/automation/branch protection 검증 | 사용자가 다운로드·로컬 적용하지 않고 팀이 실제 commit과 PR을 바로 검토. 이후 Release와 연결할 SHA 확보 | **권장 milestone 완료** |

GitHub 로그인과 App 설치·쓰기 권한은 별도이며 App key·등록·권한 확대와 Runner identity 설정을 자동 승인하지 않는다. BYOK는 provider key·데이터 전송 목적지·예산을 허용받아 별도 broker에 구성한다. local model은 라이선스·가용 CPU/GPU·disk·offline 검증이 필요하다. Cloudflare 배포 검증은 별도 계정·사용량·권한 설정이 필요하다. 권한이 없으면 setup blocker와 export 결과를 정직하게 보여주며, export만으로 이 milestone의 GitHub 완료를 선언하지 않는다.

## 3. 데이터와 기존 Foundation 연결

기존 `jobs`는 release/target/snapshot에 강하게 연결되고 `kind`가 build/store_submit/store_release로 제한되어 있다. coding을 fake build나 fake Release로 집어넣지 않는다.

이번에는 독립된 `coding_sessions`, `coding_attempts`, `patch_candidates`, `coding_approvals`, `coding_publications`, `coding_events`를 만들고 기존 lease/fence/state primitive와 contract test를 재사용하는 방향을 권장한다. 기존 Job schema의 무리한 범용화는 하지 않는다. 사용자·Membership·Runner·Integration 및 공용 audit 권한 경계는 이번에 필요한 만큼만 추가한다. Publication에는 승인 digest, operation ID, repo/base/head ref, 예상 SHA/tree, provider request/commit/PR receipt와 reconciliation 상태를 기록한다. 함께 보존할 정책 증거는 publication policy version/digest·owner·유효기간, 설정/automation 검토 증빙, CI issuer/workflow/profile·SHA·run/attempt·결론이다.

고정할 입력:

- organization/project/application/target IDs, provider의 immutable repository ID, root, base commit SHA, source tree digest
- 사용자 request revision, context manifest와 digest, 허용 파일·금지 파일 정책 version
- immutable `CodingExecutionSnapshot`: 비밀 없는 test config, test command/profile digest, lockfile/image/toolchain digest, model/provider profile, resource/egress policy
- 요청자, idempotency key, budget reservation, correlation ID

이 snapshot은 기존 production ConfigSnapshot의 secret references를 읽거나 resolve하는 통로가 아니다. Release 인계 시에는 최종 commit SHA와 선택 target으로 별도의 운영 ConfigSnapshot과 승인 요청을 만든다.

각 시도에는 attempt/runner/fence/lease, 격리 profile, 종료 원인, 실제 command exit/status, 모델 사용량·provider receipt(있으면), 결과 artifact digest를 기록한다. DB uniqueness·tenant FK·idempotency를 검증한다. Foundation의 client-supplied `now`·`authorization` 인자는 API에서 받지 않는다.

## 4. 사용자 흐름과 완료의 의미

1. **로그인·대상:** Membership과 repository access를 서버에서 확인. repo/app/base SHA, 선택 provider/model, 데이터 전송 목적지·비용/자원·라이선스 조건, 실행 제한, AI에 읽힐 파일 목록을 표시
2. **요청:** 사용자 prompt와 file selection을 검증. secret 의심 입력은 보관·모델 전달 전에 차단하고 수정 요청. 같은 idempotency key/입력은 같은 session, 다른 입력이면 conflict
3. **대기:** compatible Runner가 없으면 필요한 isolation/model/toolchain과 마지막 heartbeat를 보여줌. polling이 없어도 무한 “실행 중”으로 표시하지 않음
4. **준비:** trusted helper가 허용 repo의 정확한 SHA를 fetch. credential·원래 `.git/config`·hooks를 제외한 source를 검증하여 새 sandbox에 반입. source hash를 다시 확인
5. **제안:** trusted broker가 bounded source/prompt만 선택 provider에 전달. remote BYOK에는 해당 데이터 전송·사용량 예산에 대한 사용자 권한이 필요함. 출력은 schema-validated patch로 받고 size/path/type/정책을 검사. 허용되지 않은 수정은 적용하지 않음
6. **검증:** 새 isolated validator workspace에서 base + patch를 재구성. 고정 baseline tests와 허용된 새 tests를 실행. model workspace의 “통과” 파일을 신뢰하지 않음. 각 command와 tree digest를 결과에 결합
7. **검토:** diff·최종 tree digest·정책 거부·pass/fail/skipped·실행 환경·비용을 표시. 결과를 수정하려면 새 request/candidate version을 만들고 다시 검증
8. **승인·게시:** Reviewer가 exact candidate와 draft PR 대상/내용을 승인. `coding.publish_draft` 권한을 가진 사용자 요청으로 trusted broker가 tree를 재구성·검증하고 GitHub의 새 전용 branch와 draft PR을 생성. GitHub installation credential은 Control Plane broker에만 있음. 승인된 파일 이외 수정·기존 사용자 branch 덮어쓰기·main/merge/deploy 불가
9. **원격 검증·운영 인계:** commit SHA·tree·draft 상태·base/head repo/ref·PR URL을 GitHub에서 재조회하고 candidate → remote SHA 매핑을 publication receipt에 기록. remote tree 일치는 필요한 검증이지만 테스트·artifact 전부의 동등성을 뜻하지 않음. **실제 게시된 commit SHA에서 승인된 issuer/workflow/profile의 CI를 다시 실행하고 해당 run/attempt의 completed success를 확인**한다. PR test-merge SHA를 검사했다면 head SHA와 구분하여 둘 다 기록. merge/수동 반영으로 tree가 달라졌다면 재검증·재승인. 이후 Build/Release는 확정 source SHA로 새 ConfigSnapshot과 별도 승인 요청을 사용하며 metadata를 포함하는 bundle/build artifact는 그 revision으로 재생성. draft PR을 main 반영·배포 완료로 표시하지 않음

게시 권한이 없는 중간 단계에서는 patch + provenance만 export한다. Git history/refs를 export하지 않으며 export가 실제 commit/PR을 대신한 것처럼 표시하지 않는다.

**테스트 통과는 해당 고정 test profile의 통과**이며 보안·전체 앱·native·production 준비 완료를 의미하지 않는다. 실패한 candidate는 검토할 수 있지만 이 단계의 승인/publish-ready 상태로 승격하지 않는다.

## 5. 상태, 재시도, stale 처리

Session projection: queued → preparing → proposing → validating → review_ready → approved → publishing → published_checks_pending → draft_pr_ready. 원격 CI 실패는 `published_checks_failed`로 표시하고 원격 결과를 숨기지 않는다. Export는 독립된 artifact 이력이다. failed/cancelled는 terminal이며 queued 상태에는 waiting reason을 갖는다. 검토·승인 중 base가 바뀌면 `stale`이 되어 approval/publication을 차단하고 새 session revision을 요구한다. 취소 요청은 실행권을 즉시 무효화하고 별도 `cleanup_pending/confirmed/failed` 상태로 실제 종료를 추적한다. 이전 attempt와 result는 덮어쓰지 않는다.

- Runner loss: 만료 fence의 AI 호출·artifact finalize·완료를 거부. watchdog이 로컬 deadline에 subprocess/container를 정지. 새 Runner는 폐기된 프로세스를 이어받지 않고 마지막 확정된 불변 source/patch에서 새 attempt를 시작
- AI 응답 유실: 생성 요청이 이미 처리/청구되었을 수 있음. provider receipt가 있으면 조회하고, 없으면 `generation_outcome_unknown`으로 표시. 새 유료/비싼 생성은 예산·사용자의 retry 의도를 재확인
- 테스트/업로드 중 재시도: 같은 source/patch/policy에 한해 새 attempt. 부분 output은 finalized artifact로 보이지 않음
- source branch 이동: review_ready/publication 직전 서버가 선택 base branch head를 다시 읽음. base와 다르면 stale. 자동 rebase나 강제 반영을 하지 않고 새 base로 실행·검토. 게시 직후 base가 바뀌면 PR을 stale로 표시하고 CI/재검토 필요 상태를 유지
- patch/test/model policy 변경: 기존 approval 무효화. 새 result digest에 새 승인을 받음
- cancellation/approval/finalize race: transaction/CAS로 단 하나의 허용 전이만 성공. 성공한 과거 이력과 뒤늦은 요청을 구분하여 audit

Publisher는 session별 새 branch namespace만 사용하고 기존 branch 충돌 시 실패한다. update를 지원할 때에도 expected SHA 확인과 non-force만 허용한다. GitHub timeout은 성공/실패를 추측하지 않고 `publication_reconciliation_required`로 두어 operation ID·branch·tree·PR receipt를 조회한다. branch만 생겼으면 새 commit 중복 생성 대신 검증 후 같은 branch의 draft PR 생성만 이어간다. 이미 외부에 보낸 요청은 fence/취소로 회수되지 않는다. 취소가 게시와 경합하면 새 요청을 멈추고 실제 외부 결과를 조회·보고하며 branch/PR을 무단 삭제하지 않는다.

Store/OTA/production 승인은 source/config/action과 실제 artifact digest에 별도로 묶는다.

## 6. 보안·운영 최소 계약

API는 매번 tenant·Membership·scope·session expiry/revoke를 검사한다. GitHub App 설치만으로 Flora 조직원이 되지 않는다. Runner 등록은 Admin이 특정 조직과 `coding` trust class에 부여하며 production capability는 없다. machine secret을 생성·저장하는 실제 절차는 별도 승인·안전한 입력 경로를 필요로 한다.

첫 실행 정책 기본값 제안은 1 session당 active attempt 1개, 생성 1회, 작업 전체 15분, test command당 5분, 2 CPU/4 GiB/256 PID/2 GiB writable disk다. patch는 최대 20 files/1 MiB이며 관리자가 정책 version으로 조정한다. 모델 context/output limit은 모델 capability 안에서 별도로 설정하고 무제한 기본값은 없다. 이 숫자는 제품 안전 기본값 제안이며 현재 provider 한도가 아니다.

repo 내용·prompt·AI output으로 container flag, host path, model URL, egress allowlist, command profile, approval policy를 수정할 수 없다. source symlink·case/Unicode path alias·archive traversal·submodule·`.git`·remote helper·hook을 차단한다. git 실행은 trusted fixed arguments와 격리된 config를 사용한다. 테스트에는 인터넷·provider credential·production secret이 없다.

Control Plane과 model broker는 repository의 명령을 실행하지 않는다. source fetch/credential·AI broker·publisher는 untrusted sandbox와 분리하고 API가 임의 URL fetch·임의 Git ref 쓰기 proxy가 되지 않게 한다. local model endpoint는 supervisor가 사전 등록한 주소만 사용하고 browser가 주소를 지정하지 못한다. remote endpoint의 SSRF 차단과 등록된 local endpoint 예외를 구분한다. “로컬 처리”를 주장하려면 model process 자체의 외부 통신·cloud fallback 차단도 검증한다.

### CI evidence policy

Publisher는 선택 repo의 Contents write·Pull requests write, CI 관측에는 사용하는 endpoint에 맞는 Checks read·Commit statuses read를 요구한다. [Checks API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [Statuses API](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference). Workflows write·Actions write는 기본 요구하지 않는다. 실제 commit의 기존 승인된 CI trigger를 쓰고, CI가 없거나 수동 dispatch 권한이 필요하면 자동 권한 확대 대신 setup blocker를 표시한다.

각 필수 check의 정책에는 이름과 함께 expected GitHub App ID 또는 검증된 CI actor, workflow ID/path·승인된 profile version/digest, 허용 event, 검사할 정확한 published head SHA와 필요한 test-merge SHA를 고정한다. 검증 receipt에는 check/run ID·run attempt·시작/완료 시각·결론을 저장한다. GitHub Actions workflow/run 연결을 확인하는 데 Actions read가 필요하면 별도로 승인받는다. 외부 CI도 인증된 provider receipt로 같은 연결을 입증해야 한다. legacy status의 이름·creator·target URL만으로 run/profile을 입증할 수 없으면 기본 gate를 통과하지 못한다.

기본 통과 조건은 정책과 정확히 일치하는 현재 run/attempt가 실제로 `completed` + `success`인 것이다. aggregate green, check 0개, issuer 불명, 같은 이름의 다른 issuer, 모호한 중복 결과, 과거 SHA·profile·rerun attempt의 성공, skipped/neutral을 통과로 보지 않는다. 재실행이 시작되면 이전 성공을 재사용하지 않고 새 attempt의 결과를 기다린다. 허용된 정책 예외가 있다면 repo/check/issuer/profile·대상 revision·사유·승인자·만료를 versioned record로 남기고 “정책 예외”로 표시하며 테스트 실행/통과로 부르지 않는다. 실제 모델 fixture 테스트의 실행 증거는 이런 예외로 대체하지 않는다. [GitHub required checks와 expected-source App](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)

### Bounded publication preflight

Contents write는 GitHub 자체에서 merge까지 허용할 수 있으므로 broker가 주요 branch/merge API를 차단하고 App이 우회할 수 없는 branch protection을 검증한다. upstream GitHub 권한만으로 branch namespace가 제한된다고 가정하지 않는다. 기본 Contents/PR/Checks/Statuses scope로 repository webhook·branch protection·모든 CI identity를 읽을 수 있다고 가정하지 않는다. API 조사 경로는 필요한 경우 **Webhooks read / Administration read / Actions read를 각각 별도 승인**받는다. 이것은 지금 권한을 생성·확대하라는 지시가 아니다. [Webhooks read 요구](https://docs.github.com/en/rest/repos/webhooks#list-repository-webhooks), [Administration read 요구](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)

대안은 **검증된 repository owner가 작성·승인한 제한적인 PublicationPolicy**다. 이 정책은 immutable repo ID, 허용 base/head namespace와 event(push/PR 생성·갱신), CI/workflow profile, 알려진 webhook·installed app·외부 polling/deploy 연동, secret/data 전송 경계, 허용된 CI compute/알림/비용, main 보호·bypass 설정, 담당 owner를 명시한다. API로 얻은 증거나 owner의 설정 확인/attestation을 항목별로 연결하고, API 확인과 owner 확인을 UI에서 구분한다. 소유자의 app 권한·설정 변경 신고 및 정책 무효화 책임을 명시한다.

정책·증빙은 repo ID + 관찰한 config revision/digest + owner + 확인 시각/만료 시각에 바인딩한다. 제안 기본 유효기간은 최대 24시간이고 조직은 더 짧게 설정할 수 있다. 게시 직전에는 만료·revoke·확인 가능한 workflow/권한/보호 설정 변화·알려진 automation 변경을 재검사한다. 변경·만료가 있으면 새 증빙/attestation을 받고 이전 게시 승인을 재평가한다. 설정 snapshot으로 표현할 수 없는 외부 경로는 owner가 확인한 inventory 범위와 시각·change-control 신뢰를 함께 기록한다.

repository webhook 목록만으로 installed-app·외부 polling·downstream automation의 부재를 증명할 수 없다. 읽기 실패·권한 부족은 “0개”가 아니며, 필요한 사실이 API나 유효한 owner 증빙으로도 확인되지 않으면 publication을 차단한다. 확인된 허용 side effect는 policy 안에서 진행하여 매번 모든 외부 시스템의 불가능한 전수 증명을 요구하지 않는다. 반대로 알려진 `pull_request_target`/CI/외부 deploy가 승인되지 않은 secret 접근·source 전달·배포를 유발하면 게시를 막고 필요한 변경·승인을 요청한다. draft PR 자체를 안전한 sandbox로 오해하지 않는다. 저장소/플랜의 draft PR capability도 확인하고 미지원 시 일반 PR로 임의 대체하지 않는다.

Live preview는 제외하며 후속 구현은 Control Plane과 격리된 origin, 공유되지 않는 cookie/token/API 권한, 별도의 접근제어·browser isolation을 요구한다.

로그·diff·artifact는 권한별로 렌더링하며 HTML/terminal control sequences를 실행하지 않는다. 결과물에도 secret scan·size/MIME/path 검증을 적용한다. scanner가 모든 비밀을 찾는다고 보장하지 않는다. raw token·hidden model reasoning은 기록하지 않고 request/도구 결과/결정/승인과 필요한 오류 정보만 보관한다.

제안 기본 보관은 raw source/context/patch/log 7일, source가 없는 감사 metadata 90일이다. 조직 관리자는 시작 전 이를 확인하고 policy로 변경할 수 있다. 만료 후 export 불가는 사전에 표시한다. cleanup 실패 시 Runner를 새 작업에서 제외하고 경고한다. 일반 API의 audit 삭제를 금지하되 DB 관리자의 물리적 변경까지 막는다고 주장하지 않는다.

## 7. 검증·출시 gate

다음은 구현 뒤 실제 증거로 충족해야 하며, 이 문서를 작성했다고 충족된 것이 아니다.

완료 단위를 분리한다: **G1 로컬 실행 증거**는 비밀 없는 fixture/격리/모델·패치·테스트·export이며 인증 fixture는 loopback 시험 전용이다. **G2 private 웹 실행**은 실제 로그인/RBAC·outbound Runner·다른 PC 요청·tenant isolation이다. **G3 유용한 첫 제품 완료**는 같은 웹 요청의 승인된 결과가 실제 GitHub branch·draft PR이 되고 원격 provenance와 게시된 revision의 CI가 확인되는 것이다. 인터넷·네트워크 웹 노출 전에 G2의 인증·권한 gate를 통과해야 하며, G1만으로 웹 기능 완료를 선언하지 않는다.

1. **권한:** 인증 없는 API 거부, logout/revoke·CSRF·cross-tenant IDOR·다른 조직의 로그/artifact 접근 거부, Viewer 실행 불가, Developer의 publisher/production 요청 거부
2. **입력·isolation:** path traversal/symlink/Unicode alias·`.git`·host canary·SSH socket·Docker socket·metadata IP·외부 DNS/egress·fork bomb/disk 폭증이 각 경계에서 거부/중단됨
3. **비밀:** sandbox env/files/process args, 모델 payload, diff/log/export에 canary GitHub/AI/signing/production secret 0개. 의도적인 인코딩 유출 시도도 검사하되 결과를 절대적 보장으로 해석하지 않음
4. **Prompt injection:** 악성 README/AGENTS/PR 본문/모델 output이 권한 상승·network 확대·skip tests·self approval·publish를 유도해도 시스템이 거부
5. **실제 AI:** 구성된 local model 또는 허용된 BYOK provider 하나 이상이 작은 fixture 버그를 수정하여 diff가 생기고 frozen baseline test가 실패→통과. provider/model/version·실제 호출/사용량/시간·지원 범위를 기록. deterministic fixture 결과와 미검증 provider는 별도 표시
6. **신뢰된 검증:** 악성 patch의 “test succeeded” log, test script 삭제/교체, 뒤늦은 파일 수정은 실제 validator receipt를 대신하지 못함
7. **분산 상태:** 두 Runner 동시 claim, heartbeat 유실, 취소/완료 race, revoke, stale fence, 부분 artifact finalize, API restart·outbox 중복에서 단일 유효 결과 유지. D1 동작은 SQLite 성공으로 대신하지 않고 별도 환경에서 확인
8. **검토·source·게시:** 승인 뒤 edit/branch 이동/다른 target 연결은 stale/conflict. remote tree 불일치 시 기존 검증 재사용 금지. branch 충돌·API 성공 후 응답 유실·PR 중복·취소 중 게시를 receipt로 조정. 실제 draft PR URL·head SHA/tree를 재조회하고 actual published SHA의 trusted issuer/workflow/profile·run/attempt·completed success를 확인. 위조된 같은 이름의 status, 다른 issuer·중복/과거 rerun·skipped/neutral·check 0개·CI 미설정/조회 불가를 통과로 간주하지 않음
9. **Publication policy:** 읽기 권한 부족/불완전한 webhook 목록을 automation 부재로 판단하지 않음. owner 증빙·policy 만료/revoke·설정 변화·알 수 없는 필수 side effect는 게시 차단. 유효한 scoped attestation에서 허용된 CI/알림만 실행되는 경로도 성공해야 함. 정책의 관찰 범위 안에서 main/deploy 변경이 없음을 확인하고 그 밖의 가시성 한계를 표시
10. **휴대성:** 첫 Runner를 중지하고 새 호환 Runner에서 새 attempt가 성공. 개인 `.env`/Keychain/home 없이 export를 다른 개발자가 base SHA에 적용하고 같은 tree digest와 테스트 결과를 재현
11. **웹 UX:** 두 로그인 조직의 작업 분리, refresh/reconnect·double submit·Back/Forward·취소·실패·stale·waiting·cleanup failed·budget limit·사용량 unavailable 상태 검증
12. **회귀:** 기존 Foundation full checks와 migration 재실행·restore·기존 Job/Release contract가 유지됨. OS별 core tests와 실제 Linux sandbox tests의 범위를 별도 보고

첫 구현의 완료 표기는 “로컬 구현 및 해당 테스트 검증”이다. 실 GitHub/Cloudflare 환경과 인증·D1·R2·두 실제 Runner·선택 모델로 확인한 경우에만 “integration verified”로 승격한다. 공개 배포와 production-ready는 별도 보안·운영·복구 검토와 사용자 승인이 필요하다.

## 8. 유지할 다음 순서

이 slice의 결과를 바탕으로 후속 계획을 각각 검토한다:

1. 추가 local/BYOK provider adapter의 실제 검증, 데이터/예산·credential broker 운영 고도화
2. 여러 CI provider 연동과 실제 merge 이후 source 재검증·정책 고도화. merge/deploy 권한은 독립
3. 기존 0B의 Config/Vault·native Build·artifact 신뢰 경계를 완성하고 같은 commit을 Release로 인계
4. Apple/Play·OTA·Cloudflare Web 공개와 rollback/history. production은 coding 승인과 다른 승인

AI 코딩을 우선 보여주되 Store·OTA·Flavor/Environment·배포 이력이라는 원래 목표를 삭제하거나 완료된 것으로 표시하지 않는다.

## 9. 검토 요청과 근거

검토할 선택은 **portable Runner 우선, provider-neutral AI와 실제 구성된 provider 한 경로 이상, secret-free preview/web 검증, exact diff 승인과 실제 GitHub branch·draft PR까지**다. Export는 중간 검증/권한이 없을 때의 fallback이다. 이 서면 명세 승인 이후에 G1/G2/G3 각각의 파일·migration/API/테스트별 상세 구현 계획을 작성하고, 그 계획의 검토 및 실행 방식 선택을 받은 뒤 구현한다.

아키텍처와 공식 source는 [추가안](architecture-addendum.ko.md)에 연결되어 있다. 현재 구현 연결점은 [Job schema](https://github.com/uulab-official/flora/blob/f13f8d96fa9e6aa5bd63b7f5b3a38f8466f97f67/packages/runner-protocol/src/schema.ts), [SQLite migration](https://github.com/uulab-official/flora/blob/f13f8d96fa9e6aa5bd63b7f5b3a38f8466f97f67/packages/db/migrations/0001_foundation.sql), [기존 roadmap](https://github.com/uulab-official/flora/blob/f13f8d96fa9e6aa5bd63b7f5b3a38f8466f97f67/docs/roadmap/milestones.ko.md)다.
