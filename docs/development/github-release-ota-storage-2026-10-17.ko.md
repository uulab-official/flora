# GitHub Release OTA 저장소 운영 검증 — 2026-10-17

## 범위

R2 구독 활성화 보류 결정을 유지하고, 별도 유료 저장소 구독 없이 PC Runner가 빌드한 OTA 자산을 비공개 GitHub Release에 보관하도록 연결했다. EAS·Actions를 실행하거나 기존 앱의 네이티브 구성·인증키를 바꾸지 않는다. 실제 검증 대상은 기존 `flora-verification` 채널의 Isso·Promise·Reward 및 각 iOS·Android이다.

설계·제한: [운영 가이드](./github-release-ota-storage.ko.md).

## 실제 적용한 구성

- 자산 저장소: `uulab-official/flora-ota-assets`, private, ID `1422798122`, Actions 비활성.
- 기존 GitHub App 설치 `170528052`의 전체 저장소 Contents 읽기로 접근 확인. 새 PAT·권한 확장 없음.
- Worker: `flora-uulab`, 버전 `628fc128-6a3c-4ba3-a9c5-27f6f628b432`, 배포 `98b6ae65-57db-48f9-aa15-087c64f14567`.
- 기존 D1 `717d19c0-9e46-4deb-9539-560161e7397c`, AuthDO namespace `ce3a2721b2c7493dac470b7d1c2a4252`, origin·vault secret·기존 변수 보존. 외부 자산용 변수 네 개만 추가하고 R2 binding은 추가하지 않음.
- PC controller: `controller-github-assets-20261017/ci/flora-runner`, 소스 포함 57개 파일 체크섬 확인. 기존 Docker 이미지·자원 격리·토큰 유지, 앱별 `assetStorage`만 추가.
- 기존 LaunchAgent의 RunAtLoad·KeepAlive·VM 시작 구성을 보존한 상태에서 서비스를 안전하게 중지·교체·재개. 실제 PC 재부팅은 하지 않음.

## 보존 및 코드 검증

`0013_external_ota_assets.sql` 전체를 하나의 원격 SQL batch로 적용했다. 14개 명령 성공, SHA256 `cf9ea0bb4c21d0d97e754cdf566dcdf2c357193e5c647e3b8556e4ee546c2c49`.

적용 직후 기존 23개 테이블의 24,314개 행에서 메타데이터·설정·이력이 일치했다. 청크 테이블의 대용량 base64는 반복 조회하지 않고 식별자·크기를 비교했다. 과거 바이너리 청크 658개와 용량 카운터 355,280,893바이트가 유지됐고 foreign key 오류는 0개였다. 마이그레이션은 기존 청크를 쓰지 않으며, 기존 파일 내용은 별도의 실제 다운로드·해시 검사로 확인했다. 운영 DB의 Time Travel bookmark와 PC 서비스·설정·복구 저널 상태를 별도 private 백업에 보존했다.

전체 workspace 빌드와 테스트 TypeScript 검사를 통과했다. 관련 회귀 검사 최종 140개 통과. 최초 병렬 실행에서 정상 경로 테스트의 1초 임대가 실제 비동기 검증 시간보다 짧아 만료되었으며, 해당 테스트 임대만 60초로 고쳤다. 만료·권한 취소·경합 차단 검사는 유지했다.

독립 코드 검토 후 GitHub 403·429 대기를 영속화하고, 업로드 단계의 정확한 제공자 일시 오류만 작업 실패로 분류했다. 인증·무결성·알 수 없는 오류·중첩 제어 오류·최종 게시와 복구 저널 보호는 유지했다. 실제 supervisor를 포함한 집중 11개 검사도 통과했다.

Worker 변경 후 기존 여섯 OTA의 서명과 실제 다운로드 SHA256을 다시 확인했다. 새 저장 방식 전환 전의 기존 배포·파일은 정상이다.

## 실제 커밋 자동 배포

앱 동작을 바꾸지 않는 번들 검증 표식을 기존 진입 파일에 추가했다. 검증 브랜치에 force 없이 커밋했고, 각 커밋의 Actions 실행은 0건이다.

| 앱 | 브랜치 | 실제 커밋 |
| --- | --- | --- |
| Isso | `codex/flora-ota-integration` | `f8107c775b48dc220b218c2d95cfe406fc3b9af6` |
| Promise | `codex/flora-ota-integration` | `a062df52a55c20d908987967afd0ec30a0eee385` |
| Reward | `codex/flora-reward-integration` | `b52447f99567058aa63f1b5ded53ee07af4b9075` |

세 커밋으로 앱별 두 플랫폼 자동 작업이 실제 생성됐고, 2026-10-17 10:02 KST 최종 확인에서 **6개 모두 첫 시도에 성공**했다. 각 배포의 커밋·서명·실제 번들·포함 자산을 검증했다.

## 여섯 자동 배포와 실제 다운로드 결과

| 앱 | 플랫폼 | 확정 배포 ID | 번들 바이트 | 포함 자산 참조 | 서명·해시 |
| --- | --- | --- | ---: | ---: | --- |
| isso | ios | `dc4769b5-1f1c-4adc-88cb-fba4e2bd1e20` | 4,518,268 | 35 | 통과 |
| isso | android | `1bf8a1dc-de91-44f5-b29c-ff7fb3a35d45` | 4,712,524 | 39 | 통과 |
| promise | ios | `20d3962c-ab13-4326-b631-90ed6e4f9b06` | 4,568,495 | 46 | 통과 |
| promise | android | `797da5a7-6d9b-43aa-b7c7-ea93a0ef8617` | 4,759,623 | 50 | 통과 |
| reward | ios | `4622e32e-0244-48eb-ac29-f7da79f49222` | 3,383,113 | 52 | 통과 |
| reward | android | `94c45f9a-a627-49cf-8dd2-267398b78e10` | 3,676,731 | 56 | 통과 |

새 번들 6개 총 **25,618,754바이트**가 비공개 GitHub Release에 게시됐다. Release·자산 ID와 본문·원본 작업·commit·실제 파일 SHA256을 서버 proof 및 PC 복구 캐시와 대조했다. 모든 배포의 278개 이미지·폰트 참조에 해당하는 고유 파일 166개도 실제 다운로드해 SHA256을 확인했다. 같은 불변 URL은 중복 다운로드 대신 검증 결과를 재사용했다. 다른 앱 ID로 새 번들 URL을 요청한 12건은 모두 404였다.

전체 자산 검증 중 동시 두 요청의 하나가 다운로드 보호 제한으로 429를 받았다. SDK의 순차 자산 다운로드 방식에 맞춰 해당 검증을 순차 요청으로 바꿨으며 모든 파일이 통과했다. 이 관찰을 실제 기기의 자동 재시도·적용 증거로 간주하지 않는다.

## 최종 보존·무료 한도 보호 결과

- 기존 데이터 테이블의 원본 행을 모두 유지했다. 기존 배포 120개·작업 74개·파일 메타데이터 216개를 보존하고 새 배포 6개·작업 6개·외부 자산 6개만 추가했다. 신규 commit 인식 기록 3개와 해당 작업 전이·참조·가드가 추가됐다.
- 기존 청크 658개 유지, **신규 D1 바이너리 청크 0개**. 외부 proof 6개의 메타데이터는 총 3,984바이트다. 기존 용량 계산에 포함되는 배포 이력·작업·참조 등 메타데이터 증가는 791,253바이트다.
- 용량 ledger 18행은 신규 누적분만 증가했다. 이를 불변 capacity facts 13,095개 및 실제 행 수·stored_bytes로 전부 재계산해 검증했으며, 전역 카운터 356,072,146바이트가 합계와 일치했다. ledger는 누적 집계이므로 배포 전 값과의 단순 불변 비교 대신 정확한 재계산을 사용했다.
- 앱별 자동 배포·롤백 정책과 기존 키·접근/교체 이력은 동일하다. Isso·Promise의 기존 키 각 6개와 각 6개 이력, Reward의 기존 빈 키 목록도 그대로다. 세 앱의 롤백 결정·설치 상세 이력 36행도 보존됐다.
- 최종 시점에도 새 source commit 3개의 Actions 실행은 0건이며 자산 저장소 Actions는 비활성이다. R2 구독·버킷·EAS·새 PAT를 사용하지 않았다.
- 세 앱의 현재 PC Runner가 모두 online이고, LaunchAgent와 supervisor 원본은 그대로이며 서비스는 running이다. 복구 대기 저널은 0개다. 기존 여섯 배포의 파일도 마지막에 다시 다운로드해 해시를 확인했다.
- 서버 상태 확인용 폴링을 추가하지 않았다. 빌드는 로컬 로그로 관찰했고, 검증된 다운로드의 edge cache와 제공자 호출 예산·영속 cooldown을 유지한다. GitHub API·Cloudflare 무료 한도는 계속 적용된다.

최종 요약은 private `verification-summary.json`, DB/집계 보존은 `d1-final-preservation.json`, 실제 GitHub 자산은 `actual-github-release-verification.json`, 전체 자산은 `full-manifest-asset-downloads.json`, 격리 검사는 `actual-cross-app-download-denials.json`, 기존 파일은 `legacy-downloads-final.json`, Runner는 `runner-final.json`에 보존했다.

## 증거 위치

민감 정보가 포함될 수 있는 원시 설정·DB snapshot·복구 백업은 공개 문서에 복사하지 않는다. 작업 증거는 private `dist/github-assets-2026-10-17/evidence/`에 보존한다. 주요 파일은 `focused-tests-final.log`, `typecheck-final.log`, `deploy.log`, `d1-after-migration-preservation.json`, `legacy-downloads-after-worker.json`, `source-commits.json`, `automatic-jobs-after-commits.json`, `no-actions-proof.json`이다.

이 검증의 실제 배포/다운로드 결과는 물리 기기의 네이티브 설치·적용·재시작 증거와 구분한다.

후속 [네이티브 적용 검증 기록](./github-release-ota-native-2026-10-17.ko.md)에서 같은 여섯 배포를 설치된 실제 앱의 iOS Simulator·Android Emulator에 적용하고 재시작·SDK 보고·운영 상세 화면까지 확인했다. 이 문서와 기존 원시 요약은 당시 검증 범위를 그대로 보존한다.
