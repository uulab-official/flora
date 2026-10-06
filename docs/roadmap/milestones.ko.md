# 단계별 구현과 완료 기준

2026-10-06 · 모든 항목은 아직 계획 상태

## 단계 0A: 검증 가능한 Foundation

첫 구현 후보이며 현재 설계 검토 전이다. 범위: brand-neutral domain/target identity, configuration resolution + immutable snapshot, job request idempotency/lease fencing/state, migration 제약 및 provenance 계약, local-only 검사·시뮬레이션. 외부 로그인·secret 전송·실제 build/store/OTA/deploy는 포함하지 않는다.

완료 증거: strict typecheck, unit/contract/integration tests, SQL tenant/FK/invariant 테스트, stale fence/concurrent claim 테스트, secret-free fixtures, 새 checkout 재실행 문서, 독립 코드 리뷰. 로컬 테스트만으로 Cloudflare 분산 운영·native 빌드 검증이 끝났다고 보고하지 않는다.

## 단계 0B: 실제 Control Plane과 팀 기반

- User/Organization/Membership와 deny-by-default RBAC
- Project/Application/Flavor/Environment/PlatformTarget CRUD
- GitHub App 설치·webhook 검증·monorepo detector
- Cloudflare Worker API/D1 migrations/R2/Queue outbox 및 로컬 개발
- immutable config/secret version refs, 실제 Vault key custody·rotation·backup 설계와 검증
- Runner 등록·회전·revoke·outbound polling·doctor·capability matching
- API/v1 validation, audit, approval, lease/fence/idempotency adapter

완료 기준: 인증된 두 조직의 격리, 조직 공용 Runner 교체, 실패·취소·revoke·유실 응답 복구, secret 비노출 테스트. 실제 인프라·권한·credential 설정은 별도 승인과 안전한 입력 절차를 거친다.

## 단계 1: 내부 앱을 운영하는 MVP

- Expo 탐지 및 native local build(iOS/Android), Expo Web build
- signing, artifact storage, source/toolchain/config provenance
- Release와 timeline, platform별 버전
- TestFlight 및 Play upload와 실제 처리 상태
- Expo protocol OTA publish/history/rollback
- Cloudflare web deploy/history/rollback
- Dashboard, 로그, 이력, 실패 원인·재시도·승인 UX

첫 성공 경로: 로그인 → 조직 → GitHub → Expo 앱 → Runner → credential/config → iOS/TestFlight → Android/Play → OTA → Web → 하나의 Release.

출시 gate:

1. 새 PC/다른 개발자가 기존 PC의 `.env`/Keychain/개인 로그인 없이 같은 흐름 수행
2. Windows 브라우저에서 조직 Mac Runner로 iOS build 요청
3. 첫 Mac offline 시 다른 Mac이 있으면 안전한 새 attempt, 없으면 명확한 대기
4. lease 만료·queue 중복·provider timeout·revoke·취소 후 중복 공개 없음
5. production/staging 및 tenant 격리, 승인 digest binding, 원문 secret 비노출
6. 실제 Expo test app의 native/OTA/Web E2E와 필요한 실기기 테스트
7. 내부 앱 5개 이상에서 운영 시간 절감 확인

## 단계 2: 운영 고도화

Store version/TestFlight/Play track/staged rollout, Web PR preview, scheduled build/release, OTA rollout/monitoring, remote config/feature flags. 자동 rollback은 telemetry 품질·표본·false positive 정책 검증 후.

## 단계 3: Engagement

FCM/APNs/Expo push, schedule/timezone/segment/test device, In-App SDK, short link/QR/Universal/App Link/campaign/click analytics. consent·retention·token lifecycle·링크 검증이 출시 gate.

## 단계 4: Business

AdMob/AdSense/revenue, 기본 attribution/conversion, crash/analytics/monitoring adapters. 통화·시간대·정산 지연·API access 제한·privacy 및 data export/deletion 검증.

## 단계 5: Platform

Plugin marketplace, Flutter advanced/RN CLI/native, GitLab/Vercel/Netlify/AWS, Docker self-host, enterprise SSO/advanced approval. 모든 core 및 공식 adapter는 같은 오픈소스 원칙을 따른다. SSO/approval을 계획했다는 이유로 일반 조직 RBAC와 보안을 유료 잠금하지 않는다.

## 진행 표시 규칙

- Planned: 요구사항만 있음
- Designed: 계약/실패 시나리오/검증 계획을 검토함
- Implemented locally: 코드와 로컬 테스트만 통과함
- Integration verified: 실제 또는 문서화된 provider sandbox 검증을 마침
- Production ready: 보안·운영·복구·native·실기기·외부 provider gate를 통과함
- Deployed: 확인 가능한 환경과 revision을 실제 배포함

문서 커밋, 테스트용 simulation, mock provider는 실제 서비스 연결·배포 완료로 표시하지 않는다.
