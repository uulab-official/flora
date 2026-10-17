# 실제 UULab 앱의 GitHub / Flora OTA 검증

검증일: 2026-10-12~13 (KST). 이 기록은 기존 `FloraQAA` / `FloraQAB` 테스트 앱 기록과 별개다.

## 실제 소스와 연결

| 항목 | 있소 (Isso) | 우리만나 (Promise) |
| --- | --- | --- |
| 저장소 | `uulab-official/isso` | `uulab-official/promise` |
| 검증 브랜치 | `codex/flora-ota-integration` | `codex/flora-ota-integration` |
| SDK 연결 V1 commit | `e6ebcde52210d3ea6fa93988fa7e8e3d2c796660` | `2dbfaab99c93b96461e79336e780a8f35505d181` |
| Flora app ID | `application_7bd7f110-eb19-4e78-88f8-64ab27e8cb2a` | `application_b91186b6-7cd0-4f92-bbec-69cfc20cf581` |
| 실제 GitHub 인식 | Expo `~57.0.23`, RN `0.86.3` | Expo `~57.0.27`, RN `0.86.3` |
| 연결 버전 | 2 | 2 |

Flora UULab GitHub App (App ID 5283312, installation 170528052)은 사용자 승인 후 이 두 저장소만 읽도록 설치했다. 권한은 Contents / Metadata 읽기이며, 실제 설치 API와 서버 저장소 목록에서 두 저장소로 제한되는 것을 확인했다. 서버가 저장소의 `flora.config.json`을 읽고 위 V1 commit의 앱별 HTTPS OTA 주소, 명시적 런타임, export recipe를 인식했다. 이전 main 연결 / 인식 기록도 유지한다.

운영 주소는 `https://flora.uulab.co.kr`이다. 신규 전용 D1 `flora-uulab` 및 SQLite `FloraAuth` DO를 사용하며 기존 `nth-db`와 로컬 반입 / QA DB는 변경하지 않았다. 초기 소유자 등록 뒤 setup 창을 다시 잠갔다. 실제 HTTPS TLS 검증을 유지한다.

## SDK / 공개 신뢰 정보

두 앱은 자체 SDK `@flora/ota` 0.3.1을 사용한다. vendored tarball SHA-256:
`139839930cc487bb6f3927872b6157a66d35eed34d23fa42bb8d7501cf91ecb4`.

GitHub App 개인키와 앱별 OTA RSA 개인키는 서버 DO에 보관한다. 저장소의 `flora.connection.json`에는 공개 인증서, key ID, 앱 ID, HTTPS 주소, `flora-verification` 채널과 `flora-rn0863-v1` 런타임만 포함한다. 앱별 공개 설정은 버전 1로 서로 다른 `PUBLIC_FLORA_APP` 값을 유지한다.

Flora plugin은 Expo native host와 연결하며 Expo Updates의 번들 로딩을 끈다. 앱의 동기식 entry에서 native launch constants로 RN / Expo Asset resolver를 설치한 뒤 기존 Expo Router entry를 호출한다. 실제 제품 route가 mount / layout된 뒤 현재 native launch ID를 확인한다. Metro 개발 실행은 OTA launch를 확인하지 않는다. EAS CLI / 계정 / 서비스는 사용하지 않는다.

## 검증 상태

- GitHub V1 commit push / 서버 실제 앱 인식: 확인.
- 게시 전 실제 공개 업데이트 주소: 두 앱 모두 204 (업데이트 없음).
- 원래 Isso / Promise checkout: 변경 없음, 별도 git worktree에서 작업.
- V1 iOS arm64 unsigned Release: 두 앱 모두 빌드 성공. 실제 제품 화면의 폰트 / 이미지 / 아이콘 및 `Flora V1 / embedded null` 확인. QA 시뮬레이터에는 설치 전 두 실제 앱의 데이터 컨테이너가 없었다.
- V2 marker-only GitHub commit: 있소 `91a6fec5118a16d7f91affc59c36d016b3f2c52a`, 우리만나 `9688b6ee5c0f39a4323f3be976167ff3ad698042`.
- V2 실제 Expo export와 공개 native 연결 검사: 두 앱 모두 통과. 기존 동일 lockfile로 설치된 의존성을 별도 V2 worktree에서 재사용했다. 있소 35 에셋 / 총 18,668,040 bytes, 우리만나 46 에셋 / 총 13,370,017 bytes. 각 실행 번들까지 포함해 36 / 47 파일의 서버 해시·크기 readback을 확인했다. 우리만나 업로드의 일시적 503은 저장된 파일을 확인하고 남은 업로드만 재개했다.
- 있소에만 V2 게시: `a0a942f8-d69b-4d83-a7fb-0fb2a17108d9`. 공개 manifest의 RSA-SHA256 서명이 있소의 공개 인증서로 검증된다. 우리만나는 204이며, 우리만나 주소의 있소 번들 다운로드 및 우리만나 요청의 있소 번들 게시가 404로 거절된다. 다른 런타임 / production 채널도 204다.
- 실제 OTA 다운로드 / 적용 / 완전 재시작: 두 앱 모두 통과. 실제 Device Hub에서 앱 버튼을 눌러 다운로드 / native reload한 뒤 V2와 앱별 배포 ID를 확인했다. 전체 프로세스 종료 / 새 PID 실행 후에도 V2, 같은 native 배포 ID, `activeId=launchedId`, `launchPending=false`를 유지했다. 폰트 / 상품 이미지 / 아이콘이 정상 표시된다.

## 네이티브 실행 결과

| 항목 | 있소 | 우리만나 |
| --- | --- | --- |
| 배포 ID / 재시작 후 native update ID | `a0a942f8-d69b-4d83-a7fb-0fb2a17108d9` | `6a019346-12dc-4ddd-ad5e-bc5f6a6a9302` |
| 프로세스 PID (V1 → 완전 재시작) | `12494 → 20761` | `38876 → 42002` |
| 검증 에셋 | 35 | 46 |
| 실행 marker / source | `V2 / update` | `V2 / update` |
| 문서 디렉터리의 보존 확인 파일 SHA-256 (전후 동일) | `0474670c12e1338b10667663b0745380ff697814846988b2c5263ee2be4c9d02` | `92b5487ab0c3f006c95f14551d288ce9313b1b65f69afcff303b63139c114f38` |

앱의 uninstall / 데이터 reset은 하지 않았다. 보존 파일은 각 앱 `Documents` 아래이며 Flora 캐시 밖에 둔다. 이는 QA 앱 컨테이너의 로컬 파일 보존 증거이며, 기존 사용자의 물리 기기 계정 / 데이터 검증으로 확대하지 않는다. 원래 앱 checkout은 그대로 깨끗하고, 작업은 별도 V1 / V2 worktree에서 진행했다. 원래 로컬 반입 및 QA DB를 운영 저장소로 재사용하거나 초기화하지 않았다.

있소만 게시한 상태에서 우리만나의 실제 네이티브 V1 / embedded 실행을 확인한 후 우리만나를 게시했다. 최종 실제 서버 조회에서 앱별 연결 버전 2, 인식 이력 3건 (기존 main / SDK V1 / marker V2), 게시 1건씩이며 서로의 배포를 포함하지 않는다. 앱별 공개 설정은 계속 버전 1 / 기존 값이다. 두 공개 manifest는 서로 다른 앱의 공개 인증서로 서명이 검증된다. 동일 채널 / 동일 런타임에서도 앱 ID로 분리되는 것을 확인했다.

증거 위치: `dist/real-apps-2026-10-12/evidence/`. 핵심 파일은 `both-apps-native-isolation-final.json`, `isso-ota-v2-apply-restart.json`, `promise-ota-v2-apply-restart.json`, `a-only-server-separation.json`, `final-server-separation.json`, `app-settings-after-a-ota.json`, `*-v1-binary-and-sentinel.json`, `*-v2-export.json`, `*-v2-full-restart.jpg`다. 바이너리 기록에는 실제 source commit / executable SHA / embedded bundle SHA를 포함한다. 실제 운영 콘솔에서도 각 앱의 별도 commit / 배포 ID / 게시 1건을 확인해 `isso-live-ota-history.jpg`, `promise-live-ota-history.jpg`로 남겼다. 우리만나 게시 뒤 있소의 같은 V2 ID와 제품 화면을 `isso-after-promise-publish-native-snapshot.json`, `isso-after-promise-publish.jpg`로 재확인했다.

SDK 자체 테스트, 합성 서버 테스트, 이전 bare RN 테스트 앱 결과를 실제 앱의 네이티브 적용 증거로 대신하지 않는다. 위 실제 결과는 GitHub commit / native binary / Expo export digest / 서버 deployment / native launch ID를 연결한 것이다. SDK의 JS/패키징 40개, Swift 123개 assertion, Android 22개 검사와 Runner 41개 검사도 별도로 통과했다. 실제 앱 작업자의 최종 검사는 양쪽 typecheck/lint, 공통 focused 21개, Isso 기존 30개 / Promise 전체 525개가 통과했다.

첫 Flora 엔진 도입은 새 native binary가 한 번 필요하다. 이 기록의 unsigned iOS Simulator Release 검증에는 Apple 배포 인증서가 필요하지 않다. 스토어 / 물리 기기용 바이너리 서명과 실제 자동 Docker Runner 실행은 별도 검증 범위다. 로컬 operator가 GitHub 고정 commit을 export / 게시하는 결과를 자동 Runner 성공으로 기록하지 않는다.
