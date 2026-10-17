# GitHub Release OTA 네이티브 적용 검증 — 2026-10-17

Isso·Promise·Reward의 설치된 Release 앱을 iOS Simulator·Android Emulator에서 실행하여, 새 비공개 저장소 `uulab-official/flora-ota-assets`에 저장된 여섯 OTA의 다운로드·적용·재시작과 Flora 상세 화면 반영을 모두 확인했다. 물리 기기 검증은 아니다.

앞선 [저장소 연결·PC Runner 자동 배포 기록](./github-release-ota-storage-2026-10-17.ko.md)의 실제 커밋 및 여섯 배포를 그대로 사용했다. 이번 검증에서 새 커밋·export·배포·네이티브 빌드·앱 재설치·DB migration은 하지 않았다. EAS·GitHub Actions·R2 구독은 사용하지 않았다.

## 여섯 앱·플랫폼 결과

채널은 모두 `flora-verification`이다. 표의 파일 수는 launch bundle을 포함한다. 지연은 네이티브 적용 확인부터 서버 반영을 관측하기까지이며 전송 시간의 정밀 측정값은 아니다.

| 앱 | 플랫폼 | 배포 ID | 서명·파일 SHA256 | 다운로드/적용/재시작 설치 수 | SDK 반영 관측 지연 | 완전 종료 후 재실행 |
| --- | --- | --- | --- | --- | ---: | --- |
| Isso | iOS | `dc4769b5-1f1c-4adc-88cb-fba4e2bd1e20` | 36개 통과 | 1 / 1 / 1 | 1,025ms | 통과 |
| Isso | Android | `1bf8a1dc-de91-44f5-b29c-ff7fb3a35d45` | 40개 통과 | 1 / 1 / 1 | 1,711ms | 통과 |
| Promise | iOS | `20d3962c-ab13-4326-b631-90ed6e4f9b06` | 47개 통과 | 1 / 1 / 1 | 1,219ms | 통과 |
| Promise | Android | `797da5a7-6d9b-43aa-b7c7-ea93a0ef8617` | 51개 통과 | 1 / 1 / 1 | 1,430ms | 통과 |
| Reward | iOS | `4622e32e-0244-48eb-ac29-f7da79f49222` | 53개 통과 | 1 / 1 / 1 | 1,137ms | 통과 |
| Reward | Android | `94c45f9a-a627-49cf-8dd2-267398b78e10` | 57개 통과 | 1 / 1 / 1 | 1,327ms | 통과 |

각 배포의 관측 설치 한 개에서 적용률 100%, 실패 설치 0개였다. 이 결과를 전체 사용자 적용률이나 실패·복구 장애 주입 검증으로 확대 해석하지 않는다. 이번 범위는 새 자산 저장소에서 정상 OTA를 끝까지 적용하는 경로다.

실제 설치 앱의 정상 OTA 흐름으로 파일을 받았다. 기기 캐시에 파일을 주입하거나 테스트 코드로 SDK 이벤트를 대신 전송하지 않았다. 서명된 manifest의 앱·플랫폼·runtime·채널과 실제 파일 284개의 SHA256을 검증했고, 실행 bundle 해시는 앞선 GitHub Release 원본 및 공개 다운로드 검증값과 일치했다. 네이티브 active/launched 또는 committed가 대상 배포이며 pending/launching 상태가 끝난 것을 확인했다.

Reward는 최초 다운로드 중 시작 시한이 지나 기존 화면을 유지했다. 다운로드 완료·캐시 무결성을 확인한 뒤 정상적인 다음 cold start에서 준비된 OTA를 활성화했다. 활성화 확인 뒤에는 보고만을 위한 추가 실행 없이 적용·재시작 이벤트가 도착했다. 이후 내구성 검증을 위해 별도로 완전히 종료하고 재실행했다. 늦게 강제 reload하거나 시작 정책을 변경하지 않았다.

완전 재실행 시 PID는 Isso iOS `38663→40617`, Android `3408→4851`, Promise iOS `40845→41533`, Android `5192→5713`, Reward iOS `43049→60187`, Android `6741→7061`로 바뀌었다. 여섯 경우 모두 대상 OTA와 기존 데이터가 유지됐다.

## Flora 상세 화면과 보고 출처

로그인한 운영 Flora에서 여섯 배포 상세 페이지를 각각 열고 적용률·다운로드·적용·재시작 수 및 익명 설치 상세 이벤트를 직접 펼쳐 확인했다. 다운로드 완료, 적용 요청, 적용 실행 확인, 재시작 확인의 기기 보고 시각과 서버 수신 시각이 표시됐다. Isso·Promise는 플랫폼별 6개, Reward는 플랫폼별 8개 이벤트가 있었고 보관 생략 없이 한 페이지에 모두 표시됐다. Reward의 반복 다운로드 확인 등 원본 이벤트는 삭제하지 않았다.

집계 출처는 `sdk-self-report`다. 실제 네이티브 검증이 끝난 뒤 증거 digest를 가진 `operator-verification` 영수증 여섯 개도 별도로 등록했다. 이 영수증이 SDK 집계나 환경 분류를 덮어쓰지 않는다. Promise·Reward SDK가 보고한 환경 `unknown`은 유지하며, 별도 운영자 검증에는 실제 Simulator/Emulator 환경을 기록했다. 물리 기기 검증 배지는 부여하지 않았다.

관측기는 앱을 조작하지 않고 네이티브 상태·outbox를 로컬에서 확인했다. 보고 관측은 사례당 소유자 API 세 번(기준·반영·상세 이벤트)을 사용했고, 별도의 최종 보존 비교를 수행했다. 화면의 자동 조회는 꺼진 상태로 유지했다. 확인 직후 여섯 outbox의 대기 이벤트는 모두 0개였다. 프로젝트의 무료 한도 표시는 계정 전체의 캐시된 지표이므로 이번 작업의 호출량으로 해석하지 않는다.

## 데이터·이력·실행 환경 보존

- 기존 D1 23개 테이블, 26,210행을 앞선 자동 배포 완료 snapshot과 비교하여 보존을 확인했다. 배포 126개, 작업 80개, 기존 청크 658개를 유지했다. 큰 바이너리 청크의 base64는 반복 snapshot에서 제외하고 ID·크기 및 실제 다운로드 해시로 확인했다. 외부 자산 proof 여섯 행도 동일했다.
- 앱별 설정·자동 배포 정책·자동 롤백 정책·키 목록·키 접근/교체 이력과 기존 롤백 결정·설치 이력 36행은 유지했다. 새 SDK 보고와 실제 검증 영수증만 추가했다. 앱 데이터 sentinel 및 설치된 실행 바이너리/APK 해시는 여섯 경우 모두 동일했다. 앱의 모든 개별 업무 데이터 행을 별도 열람한 검증은 아니다.
- 각 앱·플랫폼의 기존 차단 배포 네 개씩, 총 24개를 그대로 유지했다. 차단 목록이나 복구 저널을 지우지 않았다. 기존 정책을 우회하거나 롤백을 실행하지 않았다.
- PC Runner는 running이고 복구 대기 저널은 세 앱 모두 0개였다. 서비스·앱 설정은 동일했다. 기존 LaunchAgent 자동 실행 설정을 유지했으며 이번 작업에서 PC를 실제 재부팅하지 않았다.
- 소스 branch head 세 개는 앞선 실제 자동 배포 커밋과 동일했다. 해당 커밋의 Actions 실행 수는 모두 0건이었다. 기존 QA Simulator와 `emulator-5560`만 조작했고, 다른 앱/기기는 건드리지 않았다.

## 증거

원시 증거는 private `dist/github-native-2026-10-17/evidence/`에 보존한다. 계정 인증·키 내용·원시 설정을 공개 문서로 옮기지 않는다.

- `verification-summary.json`: 여섯 네이티브·여섯 화면 검증과 보존 최종 요약.
- `ios/*-immediate-report.json`, `android/*-immediate-report.json`: SDK 실제 보고와 추가 보고용 실행 없음.
- 플랫폼별 inspect/restart 영수증, `native-proof-bundle.json`: 서명·파일 해시·네이티브 확정 상태·PID·기존 데이터 보존.
- `sdk-final-six-platforms.json`, `operator-proofs.json`: 실제 SDK 집계·전체 이벤트 및 별도 검증 영수증.
- `admin-ui-verification.json`, `*-admin-timeline.txt`, `*-admin-summary.png`: 여섯 운영 상세 화면 검증.
- `reward-android-admin-visible-timeline.png`: 펼쳐진 상세 타임라인 화면.
- `d1-unchanged.json`, `external-storage-preserved.json`, `app-preservation.json`, `native-preservation-final.json`, `runner-final.json`, `no-actions-and-source-preservation.json`: 보존·실행·출처 검증.

이번 작업은 검증과 문서 추가이므로 제품 코드 수정이나 재배포가 없었다. 앞선 저장소 변경의 단위 테스트 결과는 앞선 기록에 남기고, 이번 결과는 실제 설치된 앱의 통합 검증으로 구분한다.
