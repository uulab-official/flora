# 통합 프로젝트 관리 상태

2026-10-14 KST. 목표는 GitHub·SDK·OTA·관측·링크·스토어를 앱별로 관리하는 오픈소스 운영 플랫폼입니다. 최신 운영 API와 코드, Safari의 실제 로그인·앱 전환·자격증명 등록 화면을 확인했습니다. Codex 내장 브라우저는 접근을 차단했으며 Safari 검증과 구분합니다. 최신 [자격증명 구현·배포 증거](app-credentials.ko.md)를 함께 봅니다.

## 지금 동작하는 범위

| 앱 | PC Runner | 자동 정책 | 최근 iOS / Android 작업 | 작업 이력 수 |
| --- | --- | --- | --- | --- |
| Isso / 있소 | online | v4 · 두 플랫폼 활성 | succeeded / succeeded | 16 |
| Promise / 우리만나 | online | v4 · 두 플랫폼 활성 | succeeded / succeeded | 12 |
| Reward | online | v1 · 두 플랫폼 활성 | succeeded / succeeded | 4 |

각 앱에는 별도 GitHub 저장소·루트·설정 버전·OTA 배포 이력·Runner 권한이 있습니다. 최근 두 플랫폼 작업은 실제 서버 저장 결과이며, 클라이언트 적용 여부와는 구분합니다. Reward 최신 게시의 실제 클라이언트 적용·재시작은 [별도 증거](reward-github-pc-ota-evidence.ko.md)에서 확인했습니다. Isso·Promise 최신 PC 게시의 클라이언트 적용 범위는 기존 증거 문서와 구분합니다.

| 기능 | 상태와 경계 |
| --- | --- |
| 프로젝트 등록·선택·검색 | 저장소 + 저장소 내 루트로 앱을 구분합니다. 모노레포의 앱 루트도 별도 등록할 수 있습니다. |
| 앱 설정·설정 이력 | 버전이 있는 공개 문자열 설정을 저장합니다. 비밀 키 저장소가 아니며 저장만으로 설치된 앱이나 export 환경에 자동 적용되지 않습니다. |
| 인증서·서비스 키 | 앱별 9종 파일/키의 암호화 등록·교체·사용 중지·이력과 공개 metadata 조회. 실제 공급자 권한·네이티브 서명·스토어 제출·푸시 전송은 별도 단계입니다. |
| GitHub | GitHub App 설치 권한 범위의 저장소 탐색·연결·소스 인식·push 자동 작업이 있습니다. 사용자 계정 OAuth 전체 권한과 구분합니다. |
| OTA | 앱별 runtime/channel/platform, 서명·해시, 수동/자동 게시 및 배포 이력을 관리합니다. SDK 네이티브 연결 정보 변경에는 새 바이너리가 필요합니다. |
| PC Runner | 앱별 등록·권한 폐기·presence·job/attempt/event 조회가 있습니다. 실제 export에는 PC와 Docker가 사용 가능해야 합니다. |
| SDK 실행 | 자체 iOS/Android 엔진이 다운로드·적용·확정·미확정 실행 복구를 담당합니다. 중앙 화면의 게시 성공만으로 클라이언트 실행 성공을 표시하지 않습니다. |

주요 코드 근거: `packages/dogfood/src/applications.ts`, `packages/cloudflare/src/hosted-api.ts`, `packages/dashboard/src/operations-http.ts`, `packages/dashboard/src/automation-http.ts`, `packages/dogfood/src/automation.ts`, `packages/cloudflare/public/index.html`, `packages/cloudflare/public/app.js`.

## 아직 없는 범위

| 영역 | 미구현 내용 |
| --- | --- |
| OneLink·딥링크 | 캠페인 링크·리다이렉트·Universal/App Link·클릭/전환 API와 관리 화면 |
| GA4 | Google Analytics 데이터 연결·조회·앱별 분석 화면 |
| Google 오류 보고 | Google 오류 서비스 연결·동기화·이슈 상세·앱별 오류 화면 |
| 스토어 | App Store Connect/Google Play 상태 동기화·업로드·심사 제출·출시 실행 |
| 팀·권한·비밀 설정 | 팀원/역할/초대, 환경별 일반 비밀 설정 상속, native 작업 자격증명 전달, KEK 재포장/복구 UI |
| OTA 운영 관측 | 앱별 설치/실행/실패 telemetry, 배포 건강 지표 및 그 지표를 이용한 자동 rollback |

기존 foundation 스키마의 generic store job과 CLI simulation은 실제 스토어 연동으로 세지 않습니다. SDK의 미확정 launch 복구와 중앙 오류 지표 기반 rollback도 다른 기능입니다.

## 통합 관리 화면의 다음 작업 기준

1. **프로젝트 개요:** 저장소·앱 루트·플랫폼·SDK runtime/channel·최근 게시·Runner 상태를 앱별 한 화면에서 보여줍니다.
2. **설정:** 일반 공개 설정, 설치된 SDK의 네이티브 연결 정보, 서버 자동 배포 정책을 구분하고 변경이 앱에 적용되는 조건을 설명합니다. JSON 저장을 실제 앱 설정 적용으로 표시하지 않습니다.
3. **연동:** GitHub·GA4·Google 오류 보고·링크·스토어의 설정/접근/동기화 상태와 마지막 검증 시간을 따로 표시합니다. 실제 provider 조회가 없는 연동은 미연동으로 표시합니다.
4. **배포와 로그:** source commit → export → 게시 → 클라이언트 실행을 별도 단계로 표시하고, 앱/플랫폼/runtime/channel별 조회와 실패 원인을 제공합니다.
5. **분석과 링크:** 실제 provider 권한 및 프로젝트 바인딩 검증을 거친 뒤 GA4·오류·OneLink 기능을 순차 연결합니다. 다른 앱이나 개발 도구의 자격정보를 자동 복사하지 않습니다.

위 목록은 후속 구현 기준이며 구현 완료 상태가 아닙니다. 프로젝트 관리·OTA의 실제 성공 결과와 넓은 통합 운영 플랫폼의 남은 범위를 분리합니다.

이번 실제 API snapshot: `dist/real-apps-2026-10-13/evidence/management-current-{isso,promise,reward}-automation.json`. 이번 점검에서는 앱 설정·정책·배포·권한을 변경하지 않았습니다.
