# 운영 웹 배포 및 접근 확인

2026-10-14 UTC. 사용 주소는 **https://flora.uulab.co.kr/** 입니다. `admin@admin.com`과 기존에 지정한 비밀번호로 로그인합니다. 비밀번호·세션·GitHub 키는 이 문서와 증거 파일에 저장하지 않습니다.

## 운영 반영

기존 UULab Cloudflare 계정의 `flora-uulab` Worker에 현재 소스를 반영했습니다. 운영 버전은 `b54cc34b-d35e-428f-83bf-d55621df7de1`, 배포는 `fedb20eb-7915-4f30-81bd-9a91894ad1ec`이며 트래픽 100% 적용을 API로 확인했습니다. 기존 Custom Domain과 TLS 인증서, D1 `717d19c0-9e46-4deb-9539-560161e7397c`, FloraAuth namespace `ce3a2721b2c7493dac470b7d1c2a4252`, 9개 binding, compatibility date와 설정을 유지했습니다. 데이터 migration·자원 교체·유료 자원 추가·GitHub Actions·EAS 실행은 하지 않았습니다.

실제 Safari에서 로그아웃 상태의 첫 주소가 로그인 화면 대신 `UNAUTHENTICATED` JSON을 표시하는 문제를 재현했습니다. 허용된 `/` 문서 요청의 인증 결과가 401일 때만 보안 헤더가 포함된 `302 → /login`을 반환하도록 수정했습니다. 비인증 API와 앱 JS·CSS는 계속 401이며, 임의 origin·쿼리·`/index.html` 별칭·의존성 장애 검증을 유지합니다.

## 실제 사용 확인

Safari에서 운영 주소 접속, 소유자 로그인, 세 프로젝트 목록, Reward·우리만나·있소 전환을 확인했습니다. 각 앱의 저장소·runtime·배포 ID가 분리되어 표시됐습니다. Reward의 PC Runner 온라인 상태, iOS·Android 자동 배포 정책과 작업 로그, 있소의 공개 설정 조회도 확인했습니다. 운영 반영 후 로그아웃한 상태에서 첫 주소가 `/login`으로 이동하고 재로그인하면 세 프로젝트 목록이 다시 보이는 것을 확인했습니다. 설정 저장·배포 요청·권한 변경 버튼은 검증 중 실행하지 않았습니다.

Codex 내장 브라우저는 `ERR_BLOCKED_BY_CLIENT`로 접속을 차단했지만 Safari와 TLS 검증을 켠 HTTPS 요청은 정상 동작했습니다. 이는 운영 사이트 화면 검증을 못했다는 이전 기록과 구분되는 이번 실제 브라우저 증거입니다.

| 앱 | 자동 작업 보존 | OTA 게시 보존 | 자동 배포 정책 | PC Runner |
| --- | ---: | ---: | --- | --- |
| 있소 | 16 | 7 | v4, iOS + Android | online |
| 우리만나 | 12 | 7 | v4, iOS + Android | online |
| Reward | 4 | 4 | v1, iOS + Android | online |

세 앱의 `/api/state?appId=…` 전체 응답과 운영 API의 연결·인식·자산·게시 이력, 자동 작업·정책·Runner 등록 정보를 전후 비교했습니다. 모두 동일하며 실행 중인 Runner의 presence 시각만 정상 갱신됐습니다. 모든 정책의 기존 `flora-verification` 채널을 유지했습니다. 이 웹 배포에서 기기의 OTA 다운로드·적용·재시작을 다시 수행하지 않았습니다. 기존 Reward 기기 검증은 [별도 OTA 증거](reward-github-pc-ota-evidence.ko.md)에 있습니다.

## 검증

- 신규 Worker 회귀 테스트는 수정 전 401과 기대한 302의 차이로 실패했고, 수정 후 Worker 테스트 16개가 통과했습니다.
- 실제 HTTP hosted 통합 테스트 26개 통과. 익명 및 로그아웃 후 로그인 안내와 기존 API·데이터 보호를 확인했습니다.
- 최종 `pnpm check`: build·typecheck 성공, 전체 793개 중 **790개 통과, 실패 0, 선택 실행 3개 제외**.
- Wrangler dry run과 운영 배포 성공. 운영 API에서 새 버전 100% 적용, 기존 binding 및 도메인 유지 확인.
- 운영 HTTPS 8개 응답과 8개 웹 파일 검증. JS·CSS·이미지는 빌드 해시가 일치하며 HTML은 기존 Cloudflare가 삽입한 beacon script와 바로 뒤 줄바꿈 한 개만 제거한 원본 해시가 일치합니다. 계정 Analytics나 CSP는 변경하지 않았습니다.

증거는 `dist/web-deploy-2026-10-14/`의 `final-check.log`, `deploy.log`, `deployment-receipt.json`, `live-web.json`, `preservation.json` 및 `dist/real-apps-2026-10-13/evidence/web-deploy-before-*`, `web-deploy-after-*`에 있습니다. 기존 미커밋 작업과 앱 데이터를 보존했습니다.

웹 콘솔은 Cloudflare에서 제공됩니다. 커밋 자동 export와 OTA 게시를 실행하는 기존 PC Runner는 PC와 Docker가 실행 중이어야 합니다. OneLink·GA4·Google 오류 보고·스토어·팀 기능은 [기능 범위 문서](unified-project-management-status.ko.md)의 미구현 구분을 그대로 유지합니다.
