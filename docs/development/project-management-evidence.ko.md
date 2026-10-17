# 프로젝트 관리 기능 개선 검증

2026-10-13 UTC. 대상은 운영 Flora의 있소(`uulab-official/isso`), 우리만나(`uulab-official/promise`), Reward(`uulab-official/reward`)입니다. 앱별 기존 공개 설정, GitHub 연결, 배포 정책과 게시·작업 이력을 보존했습니다. GitHub Actions·EAS 실행이나 새로운 유료 자원 생성 없이 기존 Worker·D1·Durable Object와 PC Runner를 사용했습니다.

## 이번 변경

- 앱 개요에서 현재 연결의 검증된 GitHub 소스, PC Runner presence, 자동 배포 대상, 현재 소스의 iOS·Android 게시 ID를 확인합니다. 아직 조회하지 않은 상태를 미연결로 단정하지 않으며, 앱을 전환하거나 응답 순서가 달라져도 다른 앱의 결과를 덮어쓰지 않습니다.
- 자동 배포 로그에 플랫폼과 결과 필터를 추가했습니다. 시도·상태 변경·실패 도움말과 정책 설정은 선택한 앱 범위를 유지합니다. 기본 안내는 PC Runner이며 Actions는 별도 고급 선택 항목입니다.
- 연결 저장 전에 후보 저장소·ref·앱 루트·Expo/RN 선언을 확인합니다. 소스 조회나 인식 실패 시 기존 연결과 설정을 덮어쓰지 않습니다. 이 보장은 후보 검증 실패에 대한 것이며, 검증 이후 별도 저장 단계의 모든 데이터베이스 오류에 대한 트랜잭션 롤백을 추가한 것은 아닙니다.
- GitHub 접근 거절, 저장소 조회 불가, 확인된 ref 부재, 지원하지 않는 앱을 구분합니다. 불명확한 인증·네트워크 오류와 rate limit을 잘못된 저장소로 단정하지 않습니다. 토큰이나 원본 provider 응답을 공개 오류에 포함하지 않습니다.
- PC 서비스의 실제 프로세스·등록 후 대기·중단·치명적 중단을 구분합니다. 작업 인수 전에 호스트 여유 공간 2 GiB와 제한 시간 내 Docker 서버 응답을 확인합니다. 실패 시 presence를 유지하고 작업 인수를 멈추며, 복구 journal과 캐시는 보존합니다.
- GitHub App 생성 form 제출에 필요한 CSP 허용은 인증된 관리 HTML에만 적용했습니다. 로그인·API·다른 정적 파일의 form-action은 기존 self 제한을 유지합니다.

## 운영 반영과 보존 확인

최종 Worker 버전은 `89f29b1f-3e94-4795-bb54-f01f14302a49`입니다. D1 `717d19c0-9e46-4deb-9539-560161e7397c`, FloraAuth namespace `ce3a2721b2c7493dac470b7d1c2a4252`, 기존 migration `v1`, compatibility date와 9개 binding을 유지했습니다. 데이터 migration·자원 교체·자동 배포 정책 변경은 하지 않았습니다.

| 앱 | 보존한 OTA 게시 | 보존한 자동 작업 | 정책 |
| --- | ---: | ---: | --- |
| 있소 | 7 | 16 | v4, iOS + Android |
| 우리만나 | 7 | 12 | v4, iOS + Android |
| Reward | 0 | 0 | 미설정 |

세 앱의 운영 API 전후 자료를 비교해 GitHub 연결·앱 인식·에셋·게시 이력, 작업·현재 정책, Runner grant와 비활성 CI binding이 동일함을 확인했습니다. presence 시각은 실행 중인 Runner가 정상 갱신합니다. D1의 기존 공개 설정 5행과 자동 배포 정책 8행도 JSON 원문과 버전까지 그대로 보존됐습니다. 최종 배포 후에도 세 앱의 작업과 정책을 다시 비교했습니다.

운영 HTTPS에서 관리 HTML, JS, CSS, 로그인 HTML 네 파일을 확인했습니다. JS·CSS는 빌드 파일 해시가 일치하며, HTML은 기존 Cloudflare edge가 삽입한 beacon script 한 개를 구분한 뒤 원본 해시가 일치합니다. 이를 위해 CSP나 기존 계정의 Analytics 설정을 변경하지 않았습니다. 관리 HTML의 GitHub form-action과 다른 응답의 self 제한도 확인했습니다. 인증 값은 검증 결과 파일에 저장하지 않았습니다.

PC의 private 서비스 모듈 세 개만 교체하고 기존 모듈을 별도 보관했습니다. 앱별 토큰·설정·작업/복구 디렉터리와 LaunchAgent를 유지했습니다. 재시작 후 `running`, PID `60629`와 두 앱의 지속 presence·빈 큐 순차 조회를 확인했습니다. PID와 presence는 관측 시점의 값입니다. 로그인 후 시작은 기존 LaunchAgent 구성으로 유지되며 실제 PC 전원 재부팅은 이번에 수행하지 않았습니다.

Reward 소스 동기화는 운영 API에서 HTTP 404 `GITHUB_REPOSITORY_UNAVAILABLE`를 반환했습니다. 기존 연결 v1과 설정을 보존했으며, 성공한 앱 인식이나 자동 게시로 표시하지 않습니다. GitHub App이 실제로 Reward 읽기를 허용하지 않는 문제는 남아 있습니다. 계정 전체 OAuth 조회를 이번에 새로 구현하거나 권한 범위를 확장하지 않았습니다.

## 검증 수준

전체 테스트 773개 중 770개 통과, 실패 0, 선택 실행 3개 제외입니다. 전체 build와 typecheck도 통과했습니다. PC service/health 테스트 38개, hosted UI 테스트 125개가 포함된 별도 검증도 통과했습니다. 후보 연결 검증 실패 시 D1의 관련 9개 테이블과 두 앱의 기존 상태를 보존하는 회귀 검사를 포함합니다.

운영 도메인은 브라우저 도구가 접근을 차단해 실제 운영 화면의 클릭 검증은 하지 못했습니다. UI는 동일한 최종 소스와 운영 조회 자료를 사용하는 GET 전용 로컬 미리보기에서 확인했습니다. 있소·우리만나 전환 시 각각의 소스와 게시 ID, 우리만나 Android/게시 완료 필터, Reward의 미검증 상태와 빈 이력을 확인했습니다. 로컬 preview의 session은 합성 값이며 운영 인증 증거가 아닙니다. 운영 인증·API·배포 파일은 별도 HTTPS 조회로 확인했습니다.

새 커밋 게시나 최신 V6-PC의 기기 다운로드·적용·재시작은 이번 관리 화면 변경에서 재실행하지 않았습니다. 앞선 실제 자동 게시 결과는 [두 플랫폼 PC 자동 게시 기록](dual-platform-github-ota-evidence.ko.md), Reward의 격리 export 준비는 [Reward 연결 기록](reward-flora-connection.ko.md)에 구분합니다. VM 내부 쓰기 상태 감시·물리 기기·스토어 출시와 계정 청구 플랜의 무료 한도 확인은 이번 증거에 포함하지 않습니다.

증거 파일은 `dist/real-apps-2026-10-13/evidence/management-*`와 `dist/project-management-2026-10-13/`에 있습니다. 핵심 파일은 `management-final-full-tests.log`, `management-preservation.json`, `management-raw-row-preservation.json`, `management-live-assets.json`, `deployed-version.json`, `management-overview.png`, `management-logs.png`, `management-reward.png`입니다. 원본 저장소의 미커밋 작업과 기존 데이터는 삭제하지 않았습니다.
