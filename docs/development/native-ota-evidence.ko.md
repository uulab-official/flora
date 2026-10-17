# 자체 네이티브 OTA 검증 — 2026-10-12

서로 다른 bare RN 저장소 두 개에 `@flora/ota`와 Flora 자체 엔진을 연결했습니다.
RN 0.86.3 / React 19.2.3 / Metro 0.84.6이며, Expo 프레임워크와 EAS를 사용하지 않았습니다.
iOS 26.5 전용 시뮬레이터와 Android API 36 전용 에뮬레이터에서 **Release 바이너리**를
실행했습니다. JavaScript mock이나 캐시 포인터 변경만으로 성공을 판정하지 않았습니다.

## 실제 실행 결과

| 앱 | 플랫폼 | 확인한 경로 | V2 배포 ID |
| --- | --- | --- | --- |
| FloraQAA / `com.uulab.flora.qaa` | Android | V1 → 서명 검증·다운로드 → V2 → force-stop → V2 | `bfd32d2d-eb87-4530-9414-ddb831561ad4` |
| FloraQAA / `com.uulab.flora.qaa` | iOS | V1 → 서명 검증·다운로드 → V2 → terminate → V2 | `b9416fa9-cd21-4cde-9dae-ab27214bc772` |
| FloraQAB / `com.uulab.flora.qab` | Android | V1 → 서명 검증·다운로드 → V2 → force-stop → V2 | `5ebf7a02-66a4-4059-ad1b-713110ef7494` |
| FloraQAB / `com.uulab.flora.qab` | iOS | V1 → 서명 검증·다운로드 → V2 → terminate → V2 | `299c5849-8024-4ab7-ab86-01e90695a01c` |

실제 화면과 실행 중인 JS의 telemetry에서 버전·native update ID를 확인했습니다.
OS 프로세스 ID가 바뀌었고, 재실행 뒤 같은 V2 ID와 앱 전용 자산 URI가 유지됐습니다.
Android A는 PID 5923→6088, B는 V2 적용 뒤 6134→6233,
iOS A는 72594→73135, B는 69942→73914를 기록했습니다.

앱 A만 Android V2를 발행한 상태에서 앱 B는 V1과 `No update`를 유지했습니다.
이후 B를 따로 발행했습니다. 저장소 `a`/`b`, 앱 ID, 배포·인식 이력이 분리됐고
각 native 파일 경로도 Android의 package sandbox / iOS의 앱 ID namespace에 속했습니다.
동일 runtime `native-v1`과 채널 `production`을 사용해 앱 ID 경계를 검사했습니다.

정상 실행 확인을 의도적으로 보내지 않는 `BAD` 후보도 A의 두 플랫폼에 적용했습니다.
다음 프로세스 시작에서 정확한 이전 V2로 복구됐습니다. native launch info에는
`UNCONFIRMED_LAUNCH`와 거부한 후보 ID가 남았습니다. B의 V2는 유지됐습니다.
최종 서버 이력은 A 4개 배포(V2/BAD × 2개 플랫폼), B 2개 배포입니다.
배포 이력을 삭제하거나 이전 결과를 덮어쓰지 않았습니다.

## 소스와 설치 파일

V1 바이너리 기준 Git SHA: A `1e8cc870a7b942cbd31aebf478d4c91c22e392f9`,
B `7efb31b8c5e539b56e2898e39401e102c49377a1`.
V2 소스 SHA: A `d7c6900e07b3af1a815013bafddb618f139734c8`,
B `ab664aa8eeb432b547ccc7df37ff1ef9a3c2142f`.
A의 BAD SHA는 `a775eecb725c5fd4825baea9c4d64ef7dd7a75bd`입니다.

SDK 0.2.0 최종 tarball SHA-256:
`79f4f8fa8e587940e765d5553b6ce70dcc69de48c2d5c2347326f0cc3f3d4476`.
Android는 이 후보로 최종 APK를 재빌드했습니다. iOS는 이전 후보의 동일한 최종
iOS/JS 소스로 빌드했으며 이후 변경은 Android HTTP deadline 구현뿐이었습니다.

현재 작업 공간의 `dist/native-qa-2026-10-12/`에 다음 증거를 보관했습니다.

- `verified.json`: 네 앱/플랫폼 조합의 다운로드·적용·프로세스 재시작과 앱 경계 검증
- `report.json`, `events.jsonl`, `actions.jsonl`: 서버 이력, 실제 JS 시작 정보와 OS 조작
- `acceptance.db`: 일관된 SQLite backup, 원본 설정 보존 및 foreign-key 검사 결과
- `artifacts/{a,b}/`: APK, simulator `.app`, V2·재시작·롤백 화면
- `artifacts.json`: SDK·APK·iOS executable SHA-256
- `repositories/{a,b}.bundle`: 두 독립 Git 저장소의 소스와 커밋 이력

서명 private key와 TLS private key는 SDK나 증거 묶음에 포함하지 않았습니다.
테스트는 별도 DB/저장소/디바이스를 사용했습니다. 기존 운영 DB와 사용자 앱을
초기화하지 않았고, QA 원본 앱·설정도 동일하게 보존됐습니다.

## 검사 결과와 적용 범위

`pnpm check`: **566 통과, 0 실패, Windows 전용 1 skip**.
최종 패키징·서버 OTA 경로 추가 확인: 4/4 통과.
iOS native: 63개 서명·저장·복구 assertion 통과.
Android native: 19/19 통과, 실제 TLS 헤더/본문 지연의 전체 시간 제한 포함.
네 개 Release 빌드와 실제 OTA 검증은 위 기록과 별개로 실행했습니다.

검증 중 Android의 기본 Release reload가 파일 경로를 무시하는 문제를 찾아
`FloraReactHost`의 동적 bundle loader로 고쳤습니다. 서명된 플랫폼 바인딩,
잘못된 signature header 거부, 다운로드 후 종료 복구와 디렉터리 fsync도 검증했습니다.
ADB 기본 서버가 반복 재시작되어 전용 포트 5038을 사용했습니다. 한 네트워크 확인
실패는 명시적으로 재시도했고 최종 적용·재시작 결과를 다시 확인했습니다.

물리 기기, 운영 GitHub 설치/webhook, Cloudflare 운영 도메인, 스토어 배포와
전원 손실 실험은 이 로컬 검증에 포함되지 않습니다. RN의 표준 `require()` 이미지
자산 URI 자동 재매핑은 아직 제공하지 않으며 native asset map을 명시적으로 사용합니다.
설정과 재현 절차는 [네이티브 SDK 가이드](native-ota.ko.md)를 따릅니다.
