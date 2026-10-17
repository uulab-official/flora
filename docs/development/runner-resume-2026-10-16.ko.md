# PC Runner 안전 중지 복구 검증

검증일: 2026-10-16. 운영 화면: https://flora.uulab.co.kr/projects

## 조사와 수정

기존 로그는 네트워크 전송 실패와 Docker 격리 환경 확인 실패를 반복한 뒤 `presence-fatal-stop`으로 끝났다. 최종 presence 호출에는 `RUNNER_TRANSPORT_UNAVAILABLE` 진단과 오류 코드가 있었다. 실제 자식 프로세스로 같은 진단을 출력한 직후 supervisor 제한 시간에 의해 SIGTERM을 받는 상황을 재현하면 종료 코드는 `null`이 된다. 기존 분류 함수는 재시도 가능한 오류라도 종료 코드가 정확히 1이어야 한다고 판단했으므로 전체 서비스가 안전 중지됐다. 운영 로그 자체에는 종료 신호가 없어 당시 신호를 단정하지 않으며, 동일한 오류 기록으로 잘못 중지되는 경로를 재현·수정한 것이다.

수정은 presence 분류 함수와 호출부 두 부분이다. 해당 presence 요청의 자체 제한 시간이 지난 경우에 한해, 정확한 일시적 통신 오류를 남기고 종료 코드 0 또는 null로 회수된 자식도 기존 제한 재시도 경로로 보낸다. 확인되지 않은 성공 heartbeat를 만들지 않는다. 재시도는 기존 최대 3회와 5초 간격을 유지한다. 인증·권한·설정·복구·게시 오류, 출력 초과, 작업 단계가 섞인 응답, 자체 제한 시간 없이 종료한 비정상 결과는 계속 중지한다. Claim·lease·게시 확정·복구 판단은 바꾸지 않았다.

첫 실행 점검에서 전용 Lima VM은 `Stopped`, Docker 소켓은 없었다. 기존 `flora-ota-pc` VM을 그대로 시작한 뒤 격리 사전 검사가 통과했다. VM·앱 데이터·캐시를 삭제하거나 새로 만들지 않았다. 세 앱의 기존 Runner 자격 증명으로 presence가 각각 성공한 뒤 수정본을 설치하고 기존 LaunchAgent의 `start` 절차로 재개했다.

## 보존과 자동 시작

재개 전에 fatal 표식·서비스와 앱별 설정·로그·설치된 supervisor와 health 스크립트를 0700 비공개 백업에 보존했다. 복구 디렉터리 세 개도 그대로 백업했다. 시작 전 대기 중인 복구 journal은 모두 0건이었으며, 이를 삭제하거나 임의로 확정하지 않았다. 원래 안전 중지 표식은 백업에 남아 있다.

처음 재개한 supervisor 수정본 SHA-256은 `073b25c123a33c10cf2403a5b5b33624467596bb1ab7dcc7ce224678125ca18a`다. 이 수정본과 원래 설치본의 차이는 위 두 부분뿐이다. 후속 컴파일 진단을 보존하는 보강본 SHA-256은 `44d439b71785a4c32313485832ce980af9045fdab545503f71b057a265e49ef8`다. 고정된 compiler 단계·원인을 `compilerCode`에 기록하며 권한·게시 판단용 `code`와 분리한다. 기존에 중지시키던 제어 코드는 계속 우선 처리한다.

기존 앱별 토큰·서비스 설정·controller·LaunchAgent는 유지한다. 아래 성능 비교 과정에서 Isso·Promise의 로컬 `dockerImage` 참조만 변경했다. LaunchAgent는 사용자 로그인 때 시작하는 `RunAtLoad`와 비정상 종료 시 재시작하는 기존 설정을 유지한다. 실제 PC 재부팅 검증과는 구분한다.

## 테스트와 조회 제한

Presence 수정 전에 회귀 테스트 세 개의 실패를 확인했고, 후속 진단 보강도 새 테스트 두 개의 실패를 먼저 확인했다. 실제 SIGTERM 자식, 제한 재시도, 권한·복구 오류와 외부 종료를 포함한 독립 집중 검토 9개도 통과했다. 최종 Supervisor·Health·사용량 수집 검사 73개와 OTA Runner의 복구·daemon·전송·실행·예산·heartbeat 검사 54개, 신규 workspace 용량 검사 3개·앱 용량 검사 3개와 기존 용량 회귀 5개, 총 138개가 통과했다. 문법·타입·diff 검사도 통과했다. 기존 graceful child 검사는 고정 200ms 대신 실제 준비 파일을 제한 시간 안에 확인하도록 보강해 CPU 부하에 따른 불안정성을 제거했다.

유휴 claim의 앱별 최대 5분 backoff와 presence 60초 주기, 정확한 D1 일일 한도 오류 때 다음 UTC 자정까지 함께 대기하는 정책은 유지한다. 상태 확인은 로컬 로그를 우선 사용하고 게시 완료 시 운영 API로 결과를 대조한다. 새 서버 polling·유료 리소스·GitHub Actions·EAS는 추가하지 않았다. 후속 저장 용량 문제에는 아래의 한정된 DB 마이그레이션을 적용했다.

## 실제 GitHub 자동 배포 검증

기존 검증 브랜치에 원래 소스 tree가 같은 빈 커밋을 추가했다. 앱 코드·키·runtime·자동 배포 정책은 바꾸지 않았다. Isso 브랜치의 Actions 파일은 수동 `workflow_dispatch`만 있고 Promise·Reward 브랜치에는 Actions 파일이 없다. 커밋에도 `[skip ci]`를 넣었다. 이 표식은 [GitHub 공식 문서](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)에 따라 push/PR 워크플로 실행을 건너뛰는 용도이며, Flora GitHub App webhook은 정상 수신됐다.

| 앱 | 브랜치 | 검증 커밋 |
| --- | --- | --- |
| Isso | `codex/flora-ota-integration` | `761c5a34891162aff2e34b3714e3692298d31e4d` |
| Promise | `codex/flora-ota-integration` | `72a7dcb3c2e0441cf0ea635f18445035fa79892f` |
| Reward | `codex/flora-reward-integration` | `cc4f4779d9f6b485cb3901a076297c770780bb94` |

세 webhook에서 iOS·Android 작업을 각각 두 개씩, 총 여섯 개 생성했다. 기존 정책 버전 Isso 4 / Promise 4 / Reward 1과 채널 `flora-verification`을 유지했다. 자동 롤백·네이티브 QA 채널과 기존 이력은 별도로 보존한다.

첫 Isso iOS 작업은 `EXPORT_FAILED`로 남았고 서비스는 다음 앱 처리를 계속했다. 조사 당시 Docker VM은 ARM64이지만 Isso·Promise의 고정 이미지는 AMD64였다. 기존 Reward용 ARM64 이미지 `sha256:dd627dc85a04653231698b1631aa6b0d2f1de3760fcfc063099bc7f6c66e4ee0`를 소스·자격 증명 마운트와 네트워크 없이 실행해 Node 24.19.0·npm 10.9.8·ARM64를 확인했다. 이 이미지에는 pnpm 11.10.0도 있으나 Isso·Promise는 기존 `npm-registry`와 잠금 파일을 계속 사용한다. 두 앱의 토큰·나머지 설정이 동일함을 대조하고 컴파일 이미지 참조 하나만 교체했다. 이미 시작된 Promise AMD64 작업은 전체 18분 제한에 도달해 중지됐다. 게시가 없고 복구 저널과 실행 중 컨테이너가 없는 것을 확인한 뒤 해당 검증 작업만 취소 이력으로 남겼다. Export 5분·전체 작업 18분 제한은 늘리지 않았다.

중복 실행을 줄이기 위해 이번 검증에서 추가한 Isso·Promise의 아직 대기 중인 Android 작업 두 개만 취소 이력으로 남겼다. 기존 작업이나 이력을 삭제하지 않았다. 같은 소스 tree의 후속 검증 커밋은 Isso `90dcd26ad49c1dfb1e8a86fa566b09caa221775f`, Promise `58521f9b2e4aea6806c1a4ad231c70d7aa3fbeca`다. 이 두 앱의 최종 여섯 조합 중 네 작업은 후속 커밋을 대상으로 한다.

### 추가 업로드 중지와 용량 보존

ARM64 전환 후 Isso·Promise iOS 게시가 성공했다. Reward iOS는 export·자산 검증까지 끝났지만 업로드 HTTP 409로 안전 중지했다. 당시 workspace의 canonical payload는 332,731,713 / 335,544,320 bytes였고 물리 DB 크기는 342,970,368 bytes였다. 세 앱의 자산 수·원본 용량은 모두 기존 앱별 128개·96MiB 안에 있었다. 이전 로그에는 409 세부 제어 코드가 보존되지 않아 당시 응답의 정확한 코드를 단정하지 않는다.

신규 `0011_workspace_capacity_384mib.sql`은 workspace 상한만 320→384MiB로 높인다. [Cloudflare 공식 무료 D1 한도](https://developers.cloudflare.com/d1/platform/limits/)는 DB당 500MB다. 현재 오버헤드 기준 여유를 확인했으며, 상한을 높였다고 무제한 보존을 보장하지 않는다. 앱별 제한·단일 자산 제한·불변 이력·lease와 롤백 보호 규칙은 그대로다. Worker 코드와 배포 버전은 변경하지 않았다.

운영 DB 식별자와 Time Travel bookmark를 확인한 뒤 파일 전체를 단일 관리자 트랜잭션으로 적용했다. 103개 SQL이 모두 성공했다. 적용 전후 counter 332,731,713 bytes와 원장 18행, 배포 116건은 정확히 동일했다. 스키마 209개를 대조하면 상한 숫자가 바뀐 20개 정의만 다르고 FK 오류는 0건이었다. 적용 직후 물리 크기는 342,974,464 bytes다. 전체 요청의 일회성 읽기 14,198행·쓰기 391행은 반복 Runner 조회량과 구분한다.

최종 Supervisor SHA-256은 `a2333aa63e30cf67d21f08a1b9a379c13df48e434efd0522a7ad5572f2dd3e84`다. `CONFLICT`·`INVALID_TRANSITION`도 고정 제어 코드로 남기며 계속 안전 중지한다. HTTP 409를 임의 재시도 가능한 오류로 바꾸지 않았다. Reward의 중지 표식·로그를 추가 백업했고 게시 없음·임대 만료·대기 저널 0건을 확인한 뒤 기존 서비스 절차로 재개했다. 서버가 기존 만료 작업을 새 lease와 시도로 처리하며 이전 시도는 보존한다.

### 후속 커밋을 위한 앱별 저장 제한

여섯 배포 검증 중 Isso 원본 자산은 97,447,100 bytes로 기존 96MiB까지 여유가 3,216,196 bytes뿐이었다. 이번 Android 번들 4,712,365 bytes보다 작아 다음 같은 규모의 배포가 막힐 상태였다. Promise도 남은 7,621,493 bytes에 다음 두 플랫폼 번들 약 9.33MB를 모두 넣을 수 없었다.

신규 `0012_hosted_app_asset_capacity_128mib.sql` 전체를 한 트랜잭션으로 적용해 앱별 원본 자산 상한만 96→128MiB로 조정했다. 자산 128개·파일 16MiB·공유 workspace 384MiB와 기존 안전 규칙은 유지한다. 앱 설정·키·자동 배포 정책을 바꾸지 않는다. 적용 전후 counter 355,280,893 bytes, 원장 18행, 배포 120건은 동일했다. 스키마 209개 중 `ota_app_capacity` 한 정의의 상한만 달랐고 FK 오류는 0건이다. 물리 DB 크기는 366,141,440 bytes로 동일했다. 일회성 관리자 적용은 읽기 1,520행·쓰기 4행이었다. 로컬 workerd의 경계 경쟁·앱 분리·자산 수·파일 크기·선행 조건 검사는 3/3 통과했고 독립 검토도 통과했다.

전체 공유 여유는 현재 47,372,291 bytes(약 45.2MiB)다. 앱별 여유의 합계를 전체 저장 여유로 보장하지 않는다. 기존 이력을 계속 보존하면 무료 저장 공간도 유한하며 추가 확장이 필요하다. 별도 R2 조회는 아직 비활성 상태(`10042`)임을 확인했고, 요금제·결제·R2 활성화는 변경하지 않았다.

### 최종 게시 결과

모두 GitHub push webhook에서 생성된 작업을 PC Runner가 처리했다. 로컬 수동 export·수동 업로드·GitHub Actions·EAS를 사용하지 않았다. 작업별 서버 완료 상태와 앱·플랫폼·커밋·runtime·채널·게시 ID를 대조하고, 공개 OTA manifest 및 launch bundle을 실제 다운로드해 SHA-256 일치를 확인했다. 서명 헤더와 모든 자산 URL의 앱 범위도 확인했다. 이 단계는 새 네이티브 기기 설치·적용·재시작 검증과 구분한다.

| 앱 | 플랫폼 | 게시 시각(KST, 2026-10-16) | 배포 | 번들 bytes |
| --- | --- | --- | --- | ---: |
| isso | iOS | 22:44:05 | [984159f7-75a1-4b87-9667-dcc28c1cfadf](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/984159f7-75a1-4b87-9667-dcc28c1cfadf) | 4,518,119 |
| isso | Android | 23:20:01 | [2c627d75-fa1f-4d40-9cf8-a9bdf52d2fd3](https://flora.uulab.co.kr/apps/application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a/ota/2c627d75-fa1f-4d40-9cf8-a9bdf52d2fd3) | 4,712,365 |
| promise | iOS | 22:54:34 | [52293cd4-9d55-4374-a057-5c5ccafa8f9a](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/52293cd4-9d55-4374-a057-5c5ccafa8f9a) | 4,570,054 |
| promise | Android | 23:22:50 | [cebf41a1-ed99-4798-a278-96c21726e728](https://flora.uulab.co.kr/apps/application_b91186b6-7cd0-4f92-bbec-69cfc20cf581/ota/cebf41a1-ed99-4798-a278-96c21726e728) | 4,757,686 |
| reward | iOS | 23:26:27 | [d8a33d60-0245-4791-a233-b7b6d1d63d26](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/d8a33d60-0245-4791-a233-b7b6d1d63d26) | 3,382,927 |
| reward | Android | 23:31:10 | [fece886d-7655-45a9-9186-76e5e3a98c7c](https://flora.uulab.co.kr/apps/application_1225979e-f858-4cd0-9213-55b201e7e6a5/ota/fece886d-7655-45a9-9186-76e5e3a98c7c) | 3,676,547 |

Reward iOS의 첫 시도는 `expired / LEASE_EXPIRED`, 두 번째 시도는 `succeeded`로 함께 남았다. Flora Runner 화면에서 만료·재획득·게시 완료를 직접 열어 확인했다. 다섯 검증 커밋의 Actions 실행 건수는 각각 0건이다.

Flora 프로젝트 목록에서 세 PC Runner가 온라인이고, 여섯 최신 플랫폼 배포가 위 ID와 같음을 확인했다. 새 배포에는 아직 SDK 기기 보고가 없으므로 적용률 성공으로 표시하거나 가짜 보고를 추가하지 않았다. 원래 OTA·롤백·실패·복구 이력은 이전 배포에서 조회할 수 있다.


### 최종 보존·운영 상태

기준 배포 원문 114건·자산 메타데이터 210건·작업 70건·전환 이력 698건의 소유자·앱·논리 ID·JSON이 모두 동일했다. 추가된 것은 배포 6건·자산 6건·후속 검증 작업 4건·정상 처리 전환 155건이다. 과거 실패·취소·만료 기록을 삭제하지 않았다. 세 앱의 설정·저장소 연결·소스 스냅샷·기준선 이력·키 메타데이터와 접근 이력·자동화 정책·자동 롤백 정책·Runner 권한은 전후 동일했다.

최종 PC 서비스는 `running`, Docker health `ok`, 중지 표식 없음, 세 복구 디렉터리의 대기 journal은 각각 0건이다. 원래 표식과 로그·설정·저널 디렉터리 백업은 유지한다. LaunchAgent의 로그인 자동 시작과 VM 자동 시작 설정은 유지했다. 검증 중 실제 PC 재부팅은 수행하지 않았다.

Cloudflare 계정 전체의 2026-10-16 UTC 집계는 확인 시각 기준 읽기 2,300,250 / 5,000,000, 쓰기 31,700 / 100,000이었다. 이는 Flora 외 같은 계정의 D1 활동과 이전 검증도 포함하며 이번 작업만의 비용으로 해석하지 않는다. 프로젝트 화면은 이 10분 간격의 수집값을 캐시해 표시한다. 유휴 claim backoff와 presence 간격을 유지하고 새 자동 조회를 추가하지 않았다.

화면 증거: `output/playwright/runner-resume-2026-10-16/projects-recovered.png`, 앱별 `*-runners.png`·`*-automatic-ota.png`, `reward-recovered-attempts.png`. 원문 대조 증거: `immutable-preservation-final.json`, `app-preservation-final.json`, `source-history-preservation.json`, `runtime-final.json`, `publication-readbacks.json`.

비공개 원본 증거: `dist/runner-resume-2026-10-16/evidence/`. 비밀번호·세션 쿠키·개인키·Runner 토큰은 문서나 이 증거 폴더에 저장하지 않는다. 자격 증명 설정의 원문 백업은 사용자 홈의 0700 비공개 백업에만 둔다.
