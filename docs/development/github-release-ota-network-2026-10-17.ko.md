# GitHub OTA 네트워크 장애·복구 검증 — 2026-10-17

상태: **Isso·Promise·Reward의 iOS·Android 실제 다운로드 장애→재시도→적용·재시작 검증 6/6 완료. Flora 상세 화면 직접 확인도 6/6 완료**. 각 검증 배포에서 보고 설치 1개, 누적 적용률 100%, 실패 1개, 동일 설치 복구 1개, 해결됨 1개, 미복구 0개다. 이는 검증 설치의 결과이며 전체 사용자 적용률을 뜻하지 않는다. 환경은 전용 Android Emulator와 iOS Simulator이며 물리 기기 검증은 아니다.

[이전 정상 적용 검증](./github-release-ota-native-2026-10-17.ko.md)의 캐시된 배포를 재사용한 것으로 장애 검증을 대신하지 않았다. 기존 QA 브랜치에 식별용 JS 값만 추가한 실제 커밋 세 개와 Promise 재검증 커밋 한 개를 만들었다. 기존 GitHub webhook→PC Runner→export→비공개 GitHub Release→Flora 게시로 최초 여섯 OTA와 후속 두 OTA를 모두 첫 시도에 게시했다. 앱/runtime/native 버전과 기존 정책은 변경하지 않았다. EAS·Actions·R2 구독·앱 재설치는 사용하지 않았다.

## 실제 새 배포

| 앱 | 플랫폼 | 배포 ID | 현재 검증 결과 |
| --- | --- | --- | --- |
| isso | android | `3f8301ad-4c83-4a3f-9b55-8ac9707e9eb6` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |
| isso | ios | `027d12be-767e-40a1-a069-f7a6203dbef3` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |
| promise | android | `7ca92a14-4da4-4b9b-b44f-d4d06e3e7140` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |
| promise | ios | `3a9cc3f3-54da-4b45-862b-9b55144f1a8d` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |
| reward | android | `e86e9fab-8bed-484b-a6ec-75170153e78d` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |
| reward | ios | `e218a24d-0509-4af8-8ff1-b76f4b7ccba1` | 실패 1 · 복구 1 · 미복구 0 · 적용/재시작 1 |

소스 커밋은 Isso `a9252587f88164c609fa6ba69de7cb5b463559be`, Promise `d2d4d0f7c5080fe117552ab74c2d05cab52c82ae`, Reward `b59e6af78e95c74e9d76d59ab9833de96e4a1133`다. Isso·Promise는 기존 `codex/flora-ota-integration`, Reward는 `codex/flora-reward-integration`에만 non-force로 반영했다. 실제 새 번들 6개의 합계는 25,621,302바이트다. 모두 같은 앱·플랫폼·채널·runtime의 서명과 공개 다운로드 SHA256을 확인했고 외부 proof는 GitHub Release 경로다. 이 커밋들의 Actions 실행은 각각 0건이며 자산 저장소 Actions도 비활성 상태다.

## Android 실제 장애·복구

전용 AVD `Flora_RealApps_Android_OTA_QA_API36`, `emulator-5560`, ADB 서버 5038에서 수행했다. 기존 정상 앱의 실제 OTA 동작으로 부분 파일이 생긴 뒤, 해당 앱 UID의 IPv4/IPv6 TCP 443만 잠시 reset했다. Isso 524,216바이트, Promise 393,144바이트, Reward 360,412바이트 수신 시점의 부분 staging 파일을 확인했다. 실제 SDK의 failed/download 이벤트와 이전 native committed·차단 이력 유지까지 확인한 뒤 차단을 해제했다. 원시 이벤트를 직접 POST하거나 SDK 실패·복구를 합성하지 않았다.

세 앱은 모두 `NATIVE_OPERATION_FAILED`를 보고했다. 실제 주입 원인은 네트워크 차단이지만, 설치된 Android 네이티브 엔진이 스트리밍 IO 예외를 일반 실패로 전달하므로 허용된 실제 코드를 유지한다. Flora의 원인 표시는 ‘다운로드 · 네이티브 작업 실패’이며 ‘네트워크 연결 실패’로 임의 변경하지 않는다.

Isso·Promise는 정상 OTA 적용 버튼으로 재시도했다. Reward는 기존 시작 게이트 정책에 따라 정상 cold start로 다시 다운로드했다. 다운로드 완료 시에는 기존 게이트가 닫혀 있어 정상 다음 시작에서 캐시를 활성화했으며, 늦게 강제 reload하지 않았다. 세 앱 모두 새 OTA 실행·서명·다운로드 파일 전체 SHA256·실행 확인과 재시작 보고를 확인했다. 다운로드 파일 수는 Isso 40개, Promise 51개, Reward 57개다.

SDK 보고가 복구로 집계된 뒤 별도로 완전히 종료하고 다시 실행했다. PID는 Isso 3269→8639, Promise 4229→6338, Reward 7040→7312로 바뀌었고 새 OTA와 기존 데이터 증거가 유지됐다. 최종 상세 이벤트는 각각 8/8/10개이며 생략 없이 한 페이지에 보관됐다. 실제 SDK 집계는 각 배포에서 다운로드·적용·재시작 설치 1개, 실패 1개, 복구 1개, 해결됨 1개, 미복구 0개다. 실제 검증 영수증 세 개도 별도로 기록했으며 SDK 집계나 SDK 환경 분류를 덮어쓰지 않는다.

## iOS 실제 장애·복구

첫 Mac 잠금 해제 후 실제 Device Hub 버튼 조작과 Flora 운영 화면 검증을 재개했다. 전용 iOS Simulator `7BECFF0F-DFDE-4300-9B06-A21D0C8FFDFD`의 Isso·Reward에서 실제 TLS 다운로드를 1,048,576바이트 통과시킨 뒤 TCP reset한 증거와 실제 SDK `NETWORK_UNAVAILABLE` 실패 보고를 확인했다. 실패 후 기존 실행 배포·차단 이력 유지와 staging 정리도 확인했다.

Isso는 정상 ‘Flora OTA 적용’ 버튼으로 재시도했다. Reward는 정상 cold start에서 다운로드하고 다음 정상 시작에서 준비된 OTA를 활성화했다. 두 앱 모두 다운로드·적용·재시작 설치 1개, 실패 1개, 복구 1개, 해결됨 1개, 미복구 0개를 실제 SDK 보고로 확인했다. 이 집계는 추가 실행 전에도 수집됐으며, 이후 별도의 완전 종료·재실행에서도 새 OTA가 유지됐다. Isso PID 35385→38793, Reward 43306→43883. 검증된 다운로드 파일은 각각 36개·53개이며 서명·전체 파일 SHA256·기존 바이너리·데이터 sentinel·차단 이력이 유지됐다.

일회성 NSURLSession 설정 콜백과 localhost CONNECT 터널은 대상 앱·PID·실행 파일·앱 Bundle ID·데이터 컨테이너·기존 native 상태·차단 목록·빈 다운로드 stage로 제한한다. TLS를 그대로 통과시키며 PC 전체 프록시·TLS 신뢰·앱 저장 데이터를 바꾸지 않는다. 일회성 breakpoint와 터널에는 만료·해제 처리를 적용했다. 실제 SDK 이벤트를 합성하지 않았다.

Promise의 초기 수동 디버거 준비 중 발생한 TIMEOUT은 보존하되 네트워크 차단 성공으로 세지 않는다. 첫 콜백 실행에서는 LLDB의 Objective-C setter 반환형 정보가 없어 프록시 설정이 실패했다. `0f483517-adf2-4483-8cdf-c793040d940b`는 정상 경로로 다운로드·적용됐으므로 실제 TCP reset 성공으로 세지 않는다. throwaway 설정에서 `(void)` 캐스트로 원인을 재현·수정한 뒤, 검증용 JS 표식만 v2로 바꾼 non-force 커밋 `f4b4145246d208a5ccba37c6084218e14f4cef1a`를 추가했다. PC Runner는 iOS `3a9cc3f3-54da-4b45-862b-9b55144f1a8d`와 Android `dae313ab-71cf-45f9-a8ec-ac386974930b`를 모두 첫 시도에 자동 게시했다. 후속 iOS 자산의 서명·다운로드 SHA256도 확인했다.

마지막 Promise 실제 버튼 조작 직전에 Mac이 다시 자동 잠금된 시도는 콜백이 실행되지 않았으므로 성공으로 세지 않았다. 터널 종료·breakpoint 해제·디버거 분리 후 기존 실행 배포와 데이터를 유지했다. 잠금 해제 후 같은 신규 iOS 배포를 대상으로 실제 ‘Flora OTA 적용’ 버튼을 실행했다. 최신 앱·데이터 컨테이너·터널 상태·만료 검사를 통과한 일회성 콜백이 적용됐고, 터널은 실제 TLS 1,048,576바이트 전달 뒤 TCP reset했다. SDK는 `failed / download / NETWORK_UNAVAILABLE`를 보고했다. 기존 OTA `0f483517-adf2-4483-8cdf-c793040d940b`와 차단 목록은 유지됐으며 staging도 정리됐다.

검증 터널과 디버거를 종료한 후 같은 정상 OTA 버튼으로 재시도했다. Promise 신규 OTA `3a9cc3f3-54da-4b45-862b-9b55144f1a8d`가 다운로드·적용·재시작됐고, 추가 실행 전에 실제 SDK 보고로 적용률 100%·복구 1·해결됨 1·미복구 0을 확인했다. 다운로드 47개 파일의 서명·SHA256·기존 바이너리·데이터 sentinel을 검증했다. 이후 완전 종료·재실행에서도 PID 44794→3914로 바뀌고 같은 신규 OTA가 유지됐다. 최종 보관 이벤트는 8개이며 생략 0건이다. 실제 검증 영수증도 별도로 기록했다. iOS 세 앱의 실제 네트워크 장애·재시도·복구가 모두 확인됐다.

운영 Chrome에서 세 앱·두 플랫폼의 실제 상세 화면 6개를 직접 확인했다. 각 화면에 누적 적용률 100%, 실패 후 ‘해결됨’, 미복구 0건, 다운로드 실패 원인과 다운로드 완료·적용·재시작 이벤트가 표시됐다. Promise iOS에서는 수동 조회 전 미복구 1·적용률 0% 화면과, 최신 결과를 수동 조회한 후 해결됨 1·적용률 100% 화면도 대조했다. 각 이벤트 페이지는 생략 0건·수동 조회이며 자동 polling을 추가하지 않았다. 화면 DOM·PNG는 `evidence/ui/`에 보존했다. SDK의 ‘환경 미확인’은 운영자 영수증으로 덮어쓰지 않았다.

## 기존 데이터·이력·무료 한도 보호

기존 D1 원본 26,191행을 그대로 보존했다. 기존 18개 누적 ledger와 전역 용량 카운터는 실제 facts·행 수로 다시 계산해 일치를 확인했다. 기존 배포 126개·작업 80개는 유지하고 각 6개만 추가되어 현재 배포 132개·작업 86개다. 기존 GitHub 외부 자산 proof 6개를 유지하고 6개만 추가했다. 기존 바이너리 청크 658개 유지, 신규 D1 바이너리 청크는 0개다. payload 용량 증가는 866,961바이트의 메타데이터이며 witness 집계와는 별도다.

후속 커밋 이후 다시 읽기 전용으로 대조해 직전 원본 28,123행과 외부 proof 12개가 모두 유지됐음을 확인했다. 현재 배포 134개·작업 88개·외부 proof 14개이며 기존 바이너리 청크는 계속 658개다. 전역 payload는 357,212,444바이트로 최초 대비 1,140,298바이트의 메타데이터만 증가했다. ledger·원본 행 수·facts·전역 카운터가 일치한다.

앱별 키 목록·키 접근/교체 이력·자동 배포 정책·자동 롤백 정책·기존 롤백 결정 및 설치 이력 36행을 다시 대조해 보존했다. 여섯 앱·플랫폼의 실행 바이너리/APK와 데이터 sentinel 해시, 차단 배포 각 4개씩 총 24개도 유지했다. 이는 앱의 모든 개별 업무 DB 행을 별도로 열람한 검증은 아니다.

PC Runner는 running, 복구 대기 저널은 세 앱 모두 0개다. 서비스·앱 설정은 동일하며 이번에는 재부팅하지 않았다. 테스트용 IPv4/IPv6 방화벽 규칙은 모두 제거됐고 독립 watchdog도 복원을 확인했다. 주기적 UI 조회를 추가하지 않았고 Runner의 기존 대기·호출 예산을 유지했다. 새 서버/구독/과금 설정은 만들지 않았다.

## 검사·증거

SDK 오류 분류/보고 40개와 관리자 실패·복구 UI 102개, 합계 142개 회귀 검사가 통과했다. Android 장애 도구는 소유 에뮬레이터·공유 UID 재확인을 포함해 15개, iOS 콜백은 만료·잘못된 앱 경로 거부를 포함해 48개 자체 검사가 통과했다. TLS 터널은 연결 claim·전송·조기 종료 상태를 파일에 즉시 기록하도록 보강했으며 56개 자체 검사와 JavaScript 구문 검사가 통과했다. 별도 읽기 전용 리뷰에서도 남은 검증 도구 지적은 없었다. 제품 코드 재배포는 없었으며 검증 도구 세 파일을 추가/보강했다.

증거는 private `dist/github-network-2026-10-17/evidence/`에 보존한다. `verification-summary.json`, `published-targets.json`, `verified-downloads.json`, `source-and-actions-resume.json`, 앱별 Android 장애 디렉터리의 `fault-result.json`·`watchdog-restoration.json`, `network-faults-ios-complete.json`, `sdk-final-complete.json`, 플랫폼별 inspect/restart 영수증과 PNG, `operator-proofs.json`, `d1-preservation-resume.json`, `d1-final-counts.json`, `key-and-policy-preservation-complete.json`, `native-preservation-complete.json`, `cleanup-complete.json`, `ui/proofs.json`이 주요 증거다. 첫 잠금 시점의 진행 요약과 Promise 완료 전 요약도 각각 `verification-summary-before-unlock-resume.json`, `verification-summary-before-promise-complete.json`으로 보관했고 이전 정상 검증 원본이나 실패 기록은 삭제하지 않았다.
