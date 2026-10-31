# Flora 전체 완성 목표 — 통합 게이트

이 문서는 기능 완료 주장 대신 실제 인수 기준을 추적합니다. 현재 브랜치의 스크립트는 단독 검증 모듈이며 프로덕션 Runner, Worker, UI에 아직 연동되지 않았습니다.

| 축 | 목표 동작 | 릴리스 게이트 |
| --- | --- | --- |
| 사용자/앱 | Owner 단위 권한, 앱별 격리 | 서로 다른 앱/계정의 빌드·OTA·로그·아티팩트 조회 차단, 서버측 권한 테스트 |
| GitHub 소스 | 비공개 저장소 본인 권한으로 읽기 | 설치 권한 축소/철회, 특정 ref/SHA 고정, fork 및 PR 비밀키 차단 |
| 빌드 | 자기 PC Runner 또는 개인 GitHub Actions/Provider | 승인 전 유료 실행 불가, 실행 결과 및 작업 ID 대조, 취소·재시도·unknown 상태 복구 |
| 네이티브 아티팩트 | 로컬 기본 저장, R2/S3 BYOC 선택 | 검증된 job ID, 원자적 저장, 읽기시 재검증, 용량/보관 정책 및 다운로드 권한 |
| 서명 | Android/iOS 플랫폼별 검증 | 단순 해시 검사와 코드 서명·기기 설치 결과 분리 |
| OTA | 앱/플랫폼/runtime/채널별 게시 | 두 플랫폼 실기기에서 적용·재시작·오프라인·rollback |
| 운영 | 설치·복구·로그·관측 | 환경별 D1 migration/백업, 인증키 회전, 장애 복구, 실제 브라우저 및 CI 통과 |

## 이번 검증 브랜치의 구체적 코드
- `scripts/artifacts/native-artifact-integrity.mjs`: 앱/작업/파일 크기/해시 검증
- `scripts/artifacts/native-artifact-file.mjs`: 파일 디스크립터 기반 검증
- `scripts/artifacts/local-artifact-store.mjs`: 로컬 파일 게시/읽기 전 재검증
- `scripts/artifacts/build-lifecycle.mjs`: 순수 함수 기반 상태 전이 가드. 인증·DB 트랜잭션이나 provider API는 **미구현**입니다.

상태 전이는 `unconfigured → authorized → queued → running → succeeded|failed|cancelled|unknown`을 기본으로 합니다. `unknown`은 실제 Provider의 상태 조회를 통해서만 재동기화해야 합니다. `succeeded`는 Provider API 2xx와 동의어가 아니고 별도 실행 증거와 아티팩트 무결성 증거를 요구합니다. 저장소의 lifecycle 모듈은 이 입력을 검사할 뿐, 증거의 발급자나 진위를 검증하지 않습니다.

## 다음 실제 구현 작업
1. 원장 DB에서 인증된 작업을 조회하고 compare-and-swap 버전/작업 중복 방지 구현
2. Runner 실행 결과를 검증된 manifest/로컬 저장 모듈에 연결하고 실패·중단 회복
3. 사용자 권한 확인 후 파일 다운로드를 **열려 있는 불변 FD에서** 스트리밍; 토큰 만료·중복 사용 방지
4. 앱별 웹 UI에 작업 이력·원인·산출물·OTA 링크를 안전하게 표시
5. EAS/Codemagic/Bitrise는 사용자 소유 계정으로 별도 opt-in, 비용 고지와 취소 구현
6. 실제 Android APK/AAB, macOS IPA 서명 및 모바일 OTA 적용·롤백 E2E
7. 최신 SHA 기준 Hosted Chrome 및 OS CI 모두 통과 후 main 병합 검토

운영 Cloudflare Worker/D1/기존 OTA/인증서는 검증 완료 전 변경하지 않습니다.
