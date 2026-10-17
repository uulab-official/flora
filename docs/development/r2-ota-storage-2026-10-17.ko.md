# R2 OTA 저장소 분리 — 2026-10-17 검증 기록

> 이후 결정: 사용자가 R2 구독 활성화를 보류하고 무료 대안 연결을 요청했다. R2는 활성화하지 않았으며 [GitHub Release 저장소](github-release-ota-storage.ko.md)를 구현 중이다. 아래 테스트·파일 SHA는 당시 R2 구현의 역사적 기록이다. 미배포 migration은 이후 공통 `0013_external_ota_assets.sql`로 일반화했다.

## 운영 적용 상태

**R2 상태: 사용자가 구독 활성화를 보류했으므로 원격 R2 연결은 하지 않았다. 현재 운영 대안과 검증 결과는 [GitHub Release 저장소 기록](github-release-ota-storage-2026-10-17.ko.md)을 확인한다. 아래는 보류 결정 이전의 준비 기록이다.**

UULab Cloudflare 계정(`1302e647c709ce0cc8b4d64938772cb9`)의 R2 API가 **2026-10-17 08:51 KST**에 `10042`(R2 비활성)를 반환했다. 이후 사용자 로그인 완료 답변을 받고 **09:05 KST에 해당 계정의 R2 구독 화면을 확인했다.** 현재 결제액 $0.00, 월 $0.00 + 추가 사용량이며, 활성화 버튼은 약관 동의·자동 갱신·무료 한도 초과 시 과금을 포함한다. 이후 사용자가 구독 활성화를 보류했으며 이 결정을 유지한다. 대안 구현을 위해 R2 활성화나 로그인을 다시 요청하지 않는다.

확인 화면: `dist/r2-ota-2026-10-17/evidence/r2-subscription-approval.jpg`. 사용자의 비밀번호나 인증 코드는 수집하지 않았다.

신규 버킷, 원격 0013 migration, R2 지원 Worker 배포, 앱 검증 커밋은 아직 실행하지 않았다. R2를 활성화하기 전에 DB만 변경해 현재 Runner의 업로드를 막지 않는다. 기존 서비스와 복구 저널은 유지한다.

## 보존 기준과 현재 운영 확인

- Worker: `flora-uulab`, 활성 버전 `d3dbfac4-402e-42db-a1ce-547001b33a9c`.
- D1: `717d19c0-9e46-4deb-9539-560161e7397c`, AuthDO namespace: `ce3a2721b2c7493dac470b7d1c2a4252`.
- 기존 Worker binding 12개와 secret의 이름·종류를 기록했다. secret 값은 출력하거나 새 설정에 복사하지 않았다.
- 기존 배포 120행, 자산 216행, 자동 작업 74행, 작업 전이 853행, D1 바이너리 청크 658행을 보존 비교 기준으로 확보했다. 앱 설정·GitHub 연결·자동화 정책·롤백 정책·키 메타데이터와 이력도 별도로 기록했다.
- D1 파일 크기 366,141,440 bytes, 기존 canonical payload 355,280,893 bytes. 두 값은 같은 지표가 아니다.
- PC Runner는 `running`/`loaded: true`, PID 69021이며 세 앱의 presence 기록이 계속 갱신된다. 서비스나 VM을 재설치하지 않았다.

### 기존 배포의 실제 다운로드

새 R2 배포의 증거가 아니다. 현재 운영 중인 여섯 manifest의 RSA-SHA256 서명을 기존 앱 공개 인증서로 검증하고, 실제 받은 launch asset의 SHA-256이 manifest와 같은지 확인했다.

| 앱 | 플랫폼 | 기존 배포 | 다운로드 bytes |
| --- | --- | --- | ---: |
| Isso | iOS | `984159f7-75a1-4b87-9667-dcc28c1cfadf` | 4,518,119 |
| Isso | Android | `2c627d75-fa1f-4d40-9cf8-a9bdf52d2fd3` | 4,712,365 |
| Promise | iOS | `52293cd4-9d55-4374-a057-5c5ccafa8f9a` | 4,570,054 |
| Promise | Android | `cebf41a1-ed99-4798-a278-96c21726e728` | 4,757,686 |
| Reward | iOS | `d8a33d60-0245-4791-a233-b7b6d1d63d26` | 3,382,927 |
| Reward | Android | `fece886d-7655-45a9-9186-76e5e3a98c7c` | 3,676,547 |

## 로컬 검증

- 기존 자동 배포·롤백·앱별 분리·D1 용량 보호·Worker·Cache API 등 영향 범위 13개 파일의 테스트 **120/120 통과**, 실패·생략 0개.
- 최종 소스에서 R2·설정·Worker·자동화 HTTP·Cache API·빌드 관련 8개 파일의 테스트 **55/55 통과**, 실패·생략 0개. 앞의 120개 회귀 검증과 일부 중복되므로 서로 다른 테스트 175개라고 계산하지 않는다.
- 신규 R2 helper 7개, D1/R2 운영 저장소 5개, 실제 AuthDO HTTP 통합 1개가 포함된다. 세 앱×두 플랫폼 자동 작업 receipt·배포·다운로드 격리, 128개 이후의 자산 선택, 기존 D1을 대상으로 한 롤백, 누락 binding, 동시 읽기, 예산 재시작·월 변경, 손상된 응답, 유실된 업로드 결과를 검증했다.
- 느린 R2 업로드 중 임대 만료를 실제로 재현한 실패 테스트 후 수정했다. 오래된 임대는 R2 호출 전 차단되고, 업로드 중 권한 취소·만료는 proof·자산 메타데이터·작업 자산 참조를 원자적으로 거절한다. 남을 수 있는 R2 객체의 예산 예약은 유지한다.
- `pnpm -r build`와 루트 `pnpm typecheck` 통과. 독립 검토에서 남은 코드 차단 사유 없음.
- 고정 Wrangler **4.148.0**의 `deploy --dry-run --keep-vars` 통과. 번들 **510.75 KiB / gzip 108.22 KiB**. 기존 설정의 모든 필드를 보존하고 `FLORA_OTA_ASSETS` binding만 추가한 것을 비교했다. dry-run은 원격 업로드가 아니다.
- `0013_r2_ota_assets.sql` SHA-256: `f172fc6e31d80e7048ceff3228eb1cd78a40e06d48cd0de0735b62367533ddac`.

로컬 검증은 실제 workerd/Miniflare의 SQLite D1·DO·R2·Cache API를 사용한다. 고정된 로컬 R2 버전이 Standard 객체의 `storageClass`를 빈 문자열로 반환하므로 fixture만 자신이 명시적으로 Standard로 쓴 정확한 객체 버전을 정규화한다. 운영 코드는 `Standard` 외의 값·누락을 계속 거절한다. 실제 Cloudflare의 Standard 객체 검증은 운영 단계에서 별도로 필요하다.

## 운영 적용을 위해 준비한 내용

[저장소 연결·비용 보호·보존 절차](r2-ota-assets.ko.md)에 따라 private Standard 버킷 `flora-uulab-ota-assets`와 `FLORA_OTA_ASSETS` binding을 사용한다. 기존 D1 바이너리를 옮기거나 지우지 않는다. Flora 호출에는 8 GiB·4,096개 객체 예약·UTC 월 Class A 100,000회/Class B 1,000,000회의 보수적인 상한을 적용한다. 콘솔이나 다른 서비스의 계정 전체 R2 사용량을 차단하는 기능은 아니다.

기존 검증 브랜치와 Actions 비실행 조건을 확인했다. Isso의 기존 workflow는 수동 실행용이며 Promise·Reward 검증 트리에는 workflow가 없다. 실제 실행 시에도 `[skip ci]`를 사용하고 새 커밋의 Actions 실행 수가 0인지 확인한다. EAS는 사용하지 않는다.

같은 소스의 커밋은 기존 D1 digest를 재사용할 수 있다. 새 R2 저장을 검증하기 위해 각 앱의 검증 브랜치 진입점에 기능 변경 없는 앱별 진단 표식을 추가할 후보를 준비했다. native 설정·의존성·인증서·키·일반 배포 브랜치는 바꾸지 않는다.

아직 확인하지 못한 항목: 실제 private R2 버킷 연결, 원격 migration·Worker 배포, 세 앱의 신규 GitHub 자동 작업 여섯 개, 새 R2 launch asset의 실제 다운로드, 적용 후 기존 원시 이력·청크·설정 비교. 이 항목들은 로컬 테스트나 위 기존 다운로드 결과로 대체하지 않는다.
