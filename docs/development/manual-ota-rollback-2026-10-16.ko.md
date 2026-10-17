# 관리자 OTA 롤백 구현 및 실제 앱 검증 — 2026-10-16

Flora 운영 서비스에 앱·플랫폼별 수동 롤백을 배포했다. EAS와 GitHub Actions를 사용하지 않았고 기존 앱 데이터, 키, 운영 이력을 보존했다. 검증 대상은 기존에 설치된 Isso·Promise·Reward Release 앱이며, 아래 기기 증거는 전용 iOS 시뮬레이터와 Android 에뮬레이터 기준이다. 물리 기기 증거로 해석하지 않는다.

## 사용 방법

프로젝트 → OTA 배포 → 해당 iOS 또는 Android 배포의 **기기별 적용 현황** → **이전 배포로 롤백**에서 호환되는 이전 배포와 사유를 선택한다. 게시 내용을 확인한 후 실행하면 새 롤백 배포의 적용 현황 링크가 표시된다. 채널·Runtime이 같은 배포 중 최근 조회 범위의 후보만 표시하며, 이전 이력이 없는 경우 이를 명시한다. 기기는 기존 앱의 업데이트 확인 정책에 따라 다운로드하고 적용한다. 이후 GitHub 커밋은 기존 자동 배포 정책을 따른다.

## 저장 및 보호 규칙

- `POST /api/apps/:appId/ota/rollbacks`: `{requestKey,fromDeploymentId,targetDeploymentId,reason}`. 소유자 세션·Origin·CSRF를 요구한다.
- 원본 배포를 수정하지 않고 새 UUID·증가하는 게시 시각으로 이전의 탐지 기록·커밋·번들·자산 전체를 재사용한다. `.rollback`에 롤백 전 배포, 복원 원본, 사유, 요청 시각을 기록한다. 개인키를 조회하거나 자산 바이트를 다시 저장하지 않는다.
- 앱·플랫폼·채널·Runtime이 같고 더 오래된 대상만 허용한다. 최신 배포 비교를 같은 D1 배치의 조건부 INSERT 및 트리거에서 재검사한다. Runner가 먼저 게시하면 충돌을 반환하며 롤백 배포·자산 참조·용량 기록이 생기지 않는다.
- 동일 요청 키·내용은 최신 배포나 GitHub 연결 변경 이후에도 원래 영수증을 반환한다. 다른 내용 재사용과 일반 게시 경로의 롤백 메타데이터 주입을 차단한다. UI는 `rollback_` 접두사 UUID를 사용하며 중복 클릭을 막는다.
- 관리자 롤백은 SDK 네이티브 자동 복구 이벤트 `rolled_back`과 구분한다. 새 롤백 배포에 대한 실제 SDK 다운로드·적용·재시작 이벤트를 상세 화면에 표시한다.

## 운영 반영

Worker `flora-uulab`, 버전 `4a0e8cb5-4157-47b6-b85f-7dc6cf3cc4a7`에 100% 반영했다. 기존 12개 바인딩, D1·DO 식별자, Vault secret, 호환성 날짜, 사용 플랜을 유지했다. `0010_manual_ota_rollback.sql`만 별도 적용했다. 이 마이그레이션은 두 보호 트리거만 변경·추가하며 테이블·기존 행·자산·키를 재작성하지 않는다. 적용 직전과 직후 용량 카운터 및 18개 원장이 정확히 같음을 비교했다. 과거 미기록 마이그레이션 전체를 다시 실행하지 않았다.

## 앱별 실제 적용 및 화면 증거

| 앱 | 검증 환경 | 이전 배포 롤백 | 최종 상태 | 다운로드 / 적용 / 재시작 설치 수 | 검증 설치 적용률 |
|---|---|---|---|---|---|
| Isso | iOS Simulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/70a4f275-98cd-4007-b69a-39da60ab2aa1) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/a2590fb5-b7db-4cab-bf69-0c7afaa43397) | 1 / 1 / 1 | 100% |
| Isso | Android Emulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/e7803e84-07b4-409c-8f98-47a74f868145) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/758fba3d-baa6-4adb-9750-32f7f7cb1f79) | 1 / 1 / 1 | 100% |
| Promise | iOS Simulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/04202bfa-135c-465c-8a7c-d66edfd37d4e) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/04202bfa-135c-465c-8a7c-d66edfd37d4e) | 1 / 1 / 1 | 100% |
| Promise | Android Emulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/1a4de2d2-bfee-470f-a846-feed2c2cf54d) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/1b756250-75be-426f-a1c6-29e66b640846) | 1 / 1 / 1 | 100% |
| Reward | iOS Simulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/0c3b1b94-5757-4b75-8f58-31c4c7ba7fd2) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/04392b97-2005-4fbd-abfa-3861d8799827) | 1 / 1 / 1 | 100% |
| Reward | Android Emulator | [롤백 상세](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/578d46d8-4af0-4971-9cb3-3f7daf4f9b9f) | [최종 정상 SDK](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/291782f5-994d-4ff7-97fb-9c3092bfa013) | 1 / 1 / 1 | 100% |

각 조합에서 새 롤백 배포 ID로 네이티브 포인터가 전환되고 launch confirmation이 완료됨을 확인했다. 저장된 manifest의 RSA 서명, 모든 다운로드 파일 해시, 실행된 번들 표식, APK 또는 iOS 실행 파일·embedded bundle·앱 데이터 sentinel을 확인했다. 배포·설치 상세 화면에서도 실제 SDK 이벤트 5종을 직접 확인했다. 전체 설치 수를 알 수 없으므로 이 수치는 검증 설치당 1건에 대한 결과이며 사용자 전체 적용률 증거가 아니다.

Promise iOS는 PC Runner가 GitHub 검증 커밋에서 만든 새 배포를 실제 적용한 뒤 이전 정상 SDK 번들로 롤백했다. 나머지 조합은 이미 보관된 이전 배포를 재사용해 롤백하고, 같은 기능으로 현재 정상 SDK 번들을 복원했다. 저장 상한을 바꾸지 않기 위해 추가 검증 export 다섯 건은 실행 전에 취소했으며 취소 이력도 유지했다. 정상 SDK 복원까지 포함한 롤백 게시 총 11건, PC Runner 신규 게시 1건으로 기존 48건과 합쳐 60건이다.

Reward의 기존 시작 제한은 8초로 유지했다. 일부 시작에서 검사 또는 다운로드가 제한을 넘었고, 다운로드가 끝난 캐시를 다음 정상 시작에서 적용했다. Android에서는 시작 검사 재시도도 필요했다. 최초 관찰 창이 기한을 넘은 기록도 삭제하지 않았다. 목표 번들이 실제 적용·확인된 뒤에는 보고 전송만을 위한 추가 실행이나 외부 flush를 하지 않았으며, 새로운 관찰 창에서 상세 이벤트 집계와 outbox 비움을 확인했다. 이를 처음 다운로드한 실행에서 즉시 적용됐다는 주장으로 해석하지 않는다.

## 데이터 보존 및 조회량

기존 OTA 48건의 저장 원본을 D1에서 직접 비교했고 모두 동일했다. 기존 자산 209개의 메타데이터, 모든 이전 탐지 기록, 각 앱 설정·소스 상태·키 메타데이터와 교체 이력, 기존 조회 창의 자동 배포 작업 52건, 자동 배포 정책, Runner 구성 네 파일의 해시도 보존했다. 검사에서 조회 창 밖으로 밀린 기존 작업은 개별 ID로 확인했다. APK·iOS 바이너리와 앱 데이터는 여섯 설치 모두 보존됐다.

상세 페이지는 여전히 수동 조회·페이지당 20개·60초 캐시를 사용한다. 설치 목록/이벤트 상세는 기존의 인덱스 D1 조회 2회와 제한된 DO SQL을 사용하며 D1에 쓰지 않는다. 후보 목록은 롤백 버튼을 열 때 기존 bounded operations API를 한 번 호출한다. 운영 상세 화면에서 73,353ms 동안 추가 API 요청 0건을 확인했다. 전체 스캔·새 자동 폴링·기기 식별자 노출을 추가하지 않았다.

운영에서 재전송 영수증 일치, 다른 앱 대상 404, 오래된 최신 배포 기준 409, CSRF 누락 403, 소유자 세션 누락 401도 확인했다.

## 테스트와 증거

- 최초 전체 실행: 1,107건 중 1,104 통과, 기존 선택적 테스트 3건 건너뜀.
- 최종 UI·HTTP·도메인 회귀: 58/58 통과. Typecheck 통과.
- 두 번째 전체 실행은 1,102 통과·2 실패·3 건너뜀: `upper_bound_domain_requests_fit_free_d1_query_budget`, `320 MiB migration preserves every source/history/accounting row and the exact incremental guard schema`에서 로컬 Miniflare/workerd TCP `ECONNRESET` 발생. Assertions 실패가 아니며 운영 DB 오류가 아니다.
- 최종 `FLORA_TEST_CONCURRENCY=1 node scripts/test.mjs`: **1,107건 중 1,104 통과·0 실패·3 건너뜀**, 926.2초. 앞서 연결 종료로 실패했던 두 테스트도 각각 9.4초·10.1초에 통과했다. 테스트 격리/호스트 부하 차이로 재현되지 않았으며, 연결 오류를 코드 수정으로 해결했다고 주장하지 않는다.
- 최종 hosted build 테스트 2/2, UI 표시 보강 회귀 40/40, `pnpm typecheck`, `git diff --check` 통과.
- 세 검증 커밋의 GitHub Actions runs API를 조회해 각각 0건임을 확인했다. PC Runner는 작업 전후 같은 서비스 프로세스로 실행 중이며 세 앱 모두 online이다.
- 선택적 건너뜀: Windows profile/junction, opt-in 실제 Expo CLI export, opt-in 실제 PNPM metadata transfer. 이 작업에서 EAS/Actions를 실행하지 않았다.

원본 증거는 ignored `dist/ota-rollback-2026-10-16/evidence/`에 보관한다. 사용자 화면 캡처는 `output/playwright/ota-rollback-2026-10-16/`에 있다. 인증 쿠키·CSRF·SDK 티켓·원시 설치 UUID·개인키는 보고서/화면 증거에 포함하지 않는다.
