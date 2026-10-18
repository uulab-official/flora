# 첫 설치·GitHub·PC Runner 안내 검증 (2026-10-18)

한국어·영어 README를 처음 설치하는 운영자 기준으로 정리했습니다. 이 기록은 문서 명령·소스 계약·격리된 통합 검증이며 새 Cloudflare/GitHub 계정의 실제 승인이나 물리 기기 OTA 적용 증거가 아닙니다.

## 소스와 격리 조건

- 설치·전체 회귀 검사 candidate: `6b4ab25bed95e2c107e9fa06f8e01320b6fb8233`.
- 이후 수정은 README·연결 가이드·이 검증 기록뿐입니다. 제품 코드·의존성·schema·workflow 변경은 없습니다.
- 실제 `git clone --no-local --single-branch`으로 별도 사본을 만들고 빈 HOME·npm cache·pnpm store·XDG 경로, 서로 다른 빈 npm user/global 설정을 사용했습니다. 기존 node_modules·서비스 키·인증 세션은 복사하지 않았습니다.
- 실행 환경: macOS-27.0.1-arm64-arm-64bit, Node `v24.19.0`, npm `10.9.8`, Flora pnpm `11.19.0`. Windows 실행 증거가 아닙니다.
- full suite 종료 시각(UTC): 2026-10-18T01:30:39.448528+00:00.

## 실행 결과

| 검사 | 실제 결과 |
| --- | --- |
| README의 pinned pnpm frozen install (`--ignore-scripts`, 새 store) | exit 0 |
| 전체 build·TypeScript typecheck | 모두 exit 0 |
| 전체 `.test.ts` 회귀 검사 | 1373 pass / 0 fail / 5 skip, 총 1378건 |
| Runner supervisor·health·usage·bootstrap·테스트 실행기 `.mjs` | 89 pass / 0 fail |
| strict doctor JSON | exit 0, `readiness.ready=true`, `nativeBuildVerified=false` |
| standalone SDK pack | `flora-ota-0.3.2.tgz` 생성·해시 확인; 두 독립 앱의 offline 설치는 SDK package 회귀 검사에서 확인 |
| README 예제 | 한국어/영어 설정·명령 code block 18개 일치(구조도 제외), shell 구문·JSON·SDK TypeScript snippet 검사 통과 |
| 실제 parser | 공개 connection/native binding·automation·Runner·supervisor JSON 모두 해당 소스 validator 통과 |
| 최초 서버 설정 recipe | 새 private 폴더 0700·설정/발급 기록 0600, 기존 경로 거절, checkout 내부 경로 거절, 재발급/덮어쓰기 거절 및 기존 파일 보존 확인 |
| 최초 등록 recipe | 임의 32바이트의 decoded SHA-256, typed setup object, 정확한 10분 TTL·generation 1·enroll 검증; setup 항목만 제거한 설정도 검증 |
| Cloudflare 설정 build + `wrangler deploy --dry-run` | synthetic 전용 설정으로 exit 0; 실제 deploy·원격 DB 명령은 실행하지 않음 |
| 별도 demo HOME | 예제 import(`operator-import`, `isolatedExecution:not_run`)·loopback GET 200·정상 종료; 실제 OTA 실행은 아님 |
| export Docker 이미지 | 공개 base pull + checked-in Dockerfile build + read-only/network-none 도구 probe 통과 |
| 선택적 실제 PNPM Docker 검사 | 별도 실행 1 pass / 0 fail; 준비 cache의 offline 사용, metadata 누락 실패, lifecycle 미실행·cache 불변 확인 |

전체 suite의 skip 5건은 Windows 전용 경로 1건, 선택적 실제 Expo 앱 1건, 선택적 PNPM Docker 1건, Android APK signing 도구 검사 2건입니다. 그중 Docker 검사는 별도로 활성화해 위와 같이 통과했습니다. 나머지 네 조건을 이 macOS source 검증에서 통과했다고 표시하지 않습니다.

Docker base: `node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`. 실제 검사한 QA 이미지: `sha256:46ffd30a933b489749c9be863f98e0967b5e4300c705bbeea7572022ca84a7c2`. 이미지의 Node `24.19.0`·npm `10.9.8`·pnpm `11.10.0`을 확인했습니다. 이 PNPM 버전은 Flora 개발용 `11.19.0`과 별개입니다. 기존 운영 이미지 tag·service 설정은 교체하지 않았습니다.

## 안내가 보장하는 범위

README에는 설치 → 본인 HTTPS 서버/첫 소유자 → GitHub App 생성·선택 저장소 설치 → 앱별 공개 SDK 설정/최초 바이너리 → Docker PC Runner 등록·presence → push로 iOS/Android 게시 → 기기 상세 이력 확인 순서를 넣었습니다. 기본 자산 저장 경로는 제한이 있는 D1입니다. 현재 UULab 고정 GitHub Release 저장소와 UULab LaunchAgent를 범용 설치 기능으로 안내하지 않습니다.

GitHub UI·manifest 권한·공개 signing 응답은 소스와 대조했습니다. GitHub/Cloudflare 본인 인증·설치 승인·공개 hostname/DNS/TLS·새 서버 remote migration·실제 첫 native binary 설치는 운영자 단계로 남겨 두었습니다. 로컬 API fixture와 실제 Docker package 준비 성공을 원격 승인·실제 GitHub 커밋 배포·물리 기기 성공으로 바꾸어 주장하지 않습니다. 기존 앱 6개 조합의 과거 기기 검증은 [별도 기록](github-release-ota-network-2026-10-17.ko.md)을 확인합니다.

최초 예제 demo는 canonical HOME을 사용해야 합니다. macOS의 `/var` alias를 그대로 임시 HOME으로 사용한 probe는 `PRIVATE_STORE_UNSAFE`로 거절됐습니다. 경로를 realpath로 정규화한 뒤 통과했으며 안전 검사를 완화하거나 기존 DB 권한을 바꾸지 않았습니다. 가상 baseline의 `passed`는 import 상태이며 실제 실행 성공을 뜻하지 않습니다.

## 보존

원본 작업 폴더 559개 파일 hash·HEAD·Git index/staging·porcelain 상태가 시작 전과 같음을 확인했습니다. 작업은 별도 clone에서 진행했습니다. 운영 DB·키·배포 자산·복구 journal·배포 이력에 변경 명령을 실행하지 않았으며 기존 PC Runner/VM을 중지·재시작하지 않았습니다. Docker 검사는 고유 QA tag·컨테이너·scratch 하위 경로를 사용했습니다.

EAS·GitHub Actions로 검사를 실행하지 않았습니다. 공개 문서 커밋에는 `[skip ci]`를 사용하고 기존 workflow 설정은 보존합니다. 설치 절차는 [README](../../README.md), 격리 clone 재현은 [새 환경 가이드](clean-clone-source.ko.md)를 따릅니다.
