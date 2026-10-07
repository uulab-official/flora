# 원문 요구사항 추적표

2026-10-06 · 원문 102개 항목을 통합 기획서 섹션에 연결한다. 아래 모든 기능 상태는 **Planned(미구현)** 이다. 문서 작성 완료를 기능 구현 완료와 혼동하지 않는다.

이 표는 원문 내용을 압축한 인덱스다. 구체적 동작·실패 처리·보안·제품 의도는 [통합 기획서](integrated-plan.ko.md), [Runner 설계](../architecture/control-plane-and-runners.ko.md), [단계별 완료 기준](../roadmap/milestones.ko.md)을 함께 읽는다.

| 원문 ID | 요구사항 | 통합 기획서 섹션 | 단계 | 보존한 핵심 요구/검증 |
| --- | --- | --- | --- | --- |
| R001 | 해결하려는 문제 | §1 | 전 단계 | 분산 운영 도구와 인증서·설정 공유 업무 감소 |
| R002 | Flora의 위치 | §1 | 전 단계 | 외부 서비스 연결·관찰·실행 Control Plane |
| R003 | 지원 대상 | §1 | 1/5 | Expo 우선, RN CLI/Flutter/Web 및 native 확장 |
| R004 | Control/Execution 분리 | §2 | 0 | Cloudflare 관리, Runner 실행 경계 |
| R005 | Runner 역할 | §2 | 0/1 | checkout/toolchain/build/test/upload/log 계약 |
| R006 | Runner 등록 | §2 | 0 | OS/architecture/capability/조직·환경 scope |
| R007 | Runner Job 구조 | §2 | 0/1 | API→Job→Queue→claim→snapshot→artifact |
| R008 | Runner Job Lease | §2 | 0 | 원자 claim/fence/heartbeat/expiry/reconciliation |
| R009 | Project 계층 | §3 | 0 | tenant와 project/app/target ownership |
| R010 | Flavor와 Environment 분리 | §3 | 0 | app+flavor+environment+platform 타깃 |
| R011 | Framework별 Flavor Adapter | §3 | 1/5 | Expo/Android/iOS/Flutter 매핑 |
| R012 | GitHub Integration | §3 | 0/1 | App 설치·선택 repo·webhook·revision |
| R013 | Monorepo 지원 | §3 | 0/1 | 한 repo의 여러 app root 독립 등록 |
| R014 | Environment Variables | §4 | 0 | CONFIG/SECRET/FILE/CREDENTIAL 분리 |
| R015 | Environment Scope | §4 | 0 | 명시적 scope 상속·동순위 충돌 처리 |
| R016 | Environment Version | §4 | 0 | history/diff/rollback/author/reason/time |
| R017 | Config Snapshot | §4 | 0 | 빌드별 불변 config/secret version refs |
| R018 | Vault | §4 | 0/1 | envelope/key custody/회전/복구 |
| R019 | Runner Secret 사용 | §4 | 0/1 | job-scoped token·필요 버전만 수령 |
| R020 | iOS Credential | §4 | 1 | 임시 Keychain/profile 및 실패 후 정리 |
| R021 | Android Credential | §4 | 1 | Job 임시 keystore·제한 권한·정리 |
| R022 | Secret masking | §4 | 0/1 | stdout/stderr 전송 전 chunk-aware masking |
| R023 | Version Management | §5 | 1 | marketing/iOS/Android/runtime/OTA/web 구분 |
| R024 | Release | §5 | 0/1 | source+target별 snapshot+결과 연결 |
| R025 | Release Timeline | §5 | 1 | 요청·실행·provider 처리·공개 event |
| R026 | Apple Store | §5 | 1/2 | App Store Connect/Transporter/TestFlight |
| R027 | Google Play | §5 | 1/2 | track·status·staged rollout |
| R028 | Store Version Dashboard | §5 | 1/2 | platform별 live/processing/rollout 표시 |
| R029 | OTA Provider | §6 | 1/5 | Expo protocol 우선, 기타 adapter 확장 |
| R030 | OTA 데이터 모델 | §6 | 1 | Runtime/Channel/Update/Rollout/Deployment |
| R031 | OTA 기능 | §6 | 1/2 | publish/history/rollback/promote/monitoring |
| R032 | Web Deployment | §6 | 1/5 | Cloudflare 우선, static/SSR 지원 구분 |
| R033 | Web Deployment History | §6 | 1 | deploy/rollback/preview/domain/health |
| R034 | PR Preview | §6 | 2 | PR URL/QR/status/log·secret 격리 |
| R035 | Links Platform | §7 | 3 | short/QR/deep/universal/app/campaign |
| R036 | Universal Link | §7 | 3 | OS association 검증과 fallback |
| R037 | Short URL | §7 | 3 | target mapping 및 QR 생성 |
| R038 | Links Analytics | §7 | 3 | click/country/platform/campaign·privacy |
| R039 | Attribution | §7 | 4/5 | UTM/referrer→SDK→privacy attribution |
| R040 | Push | §8 | 3 | FCM/APNs/Expo/Custom provider |
| R041 | Push Campaign | §8 | 3 | app/audience/message/schedule/test |
| R042 | Push 기능 | §8 | 3 | timezone/segment/delivery/open/deep link |
| R043 | In-App Messaging | §8 | 3 | SDK와 조건별 banner/modal/sheet/tooltip |
| R044 | Remote Config | §8 | 2 | environment/version/platform/flavor/rollout |
| R045 | Feature Flags | §8 | 2 | stable bucketing·실험 기반 |
| R046 | AdMob | §9 | 4 | reporting 우선, 관리 API access 확인 |
| R047 | AdSense | §9 | 4 | Web mapping·수익 지표 |
| R048 | Revenue Dashboard | §9 | 4 | 조직/앱별 수익·통화·집계 기준 |
| R049 | Observability | §9 | 0/1/4 | 로그/상태 우선, crash/performance adapter |
| R050 | Organization | §10 | 0 | 초대·멤버·역할 |
| R051 | RBAC | §10 | 0 | action+org/project/app/environment scope |
| R052 | Production Protection | §10 | 0/1/5 | 별도 권한·input-bound approval |
| R053 | Audit Log | §10 | 0 | append-only API·actor/target/result |
| R054 | Cloudflare Control Plane | §11 | 0/1 | Workers/D1/R2/Queues/KV/Cron |
| R055 | Cloudflare 역할 | §11 | 0/1 | metadata/asset/command 분리 |
| R056 | 비용 전략 | §11 | 0/1 | Hosted/BYOC/Self-host |
| R057 | Hosted | §11 | 1 | 운영자 관리 인프라와 비용 고지 |
| R058 | BYOC | §11 | 1/2 | Cloudflare OAuth·scope·provisioning 검증 |
| R059 | BYOC 장점 | §11 | 1/2 | 데이터/키 위치와 export를 명시 |
| R060 | Cloudflare Free Tier | §11 | 전 단계 | 날짜 있는 quota와 usage·제한 표시 |
| R061 | Self Hosted | §11 | 1/5 | Cloudflare 설치·업그레이드·복구 공개 |
| R062 | Adapter Architecture | §12 | 0 | provider 독립 core 계약 |
| R063 | Provider Interface | §12 | 0 | capability/error/retry/reconcile 계약 |
| R064 | 핵심 Domain Model | §3 | 0~5 | 기초 entity부터 단계적 확장 |
| R065 | Release 모델 | §5 | 0/1 | immutable source와 target별 snapshot refs |
| R066 | Build 모델 | §5 | 0/1 | runner/job/attempt/artifact/provenance |
| R067 | Job State | §5 | 0 | 명시적 전이·waiting reason·attempt |
| R068 | Release State | §5 | 1 | platform별 집계·partial/rollback 의미 |
| R069 | Dashboard | §12 | 1 | 조직 현황·진행·심사·경고 |
| R070 | App Dashboard | §12 | 1~4 | app 운영 모듈 navigation |
| R071 | Integrations | §12 | 1~5 | 선택 연결·권한/health 상태 |
| R072 | Developer Experience | §12 | 0/1 | init 탐지·명시적 확인 |
| R073 | Doctor | §12 | 0/1 | 실제 도구·버전·해결 방법 |
| R074 | CLI | §12 | 0~2 | 중립 implementation과 브랜드 alias |
| R075 | Monorepo 구조 | §12 | 0 | pnpm/TS와 모듈별 경계 |
| R076 | Dashboard 기술 | §12 | 1 | React/TS UI와 API 분리 |
| R077 | API | §12 | 0 | Workers REST /api/v1/ |
| R078 | Runner Protocol | §2 | 0 | outbound HTTP polling·versioned schema |
| R079 | Authentication | §10 | 0 | 사용자 로그인과 Runner 인증 분리 |
| R080 | Security 금지 | §10 | 0 | plaintext/PAT 강제/무권한/inbound 금지 |
| R081 | Security 기본 | §10 | 0 | TLS/scoped token/rotation/revoke/audit |
| R082 | Runner Revocation | §2 | 0 | refresh/job/vault deny와 lease invalidation |
| R083 | MVP에서 하지 않을 것 | §13 | 0/1 | DB/auth/warehouse/build farm 등 제외 |
| R084 | Phase 0 Foundation | §13 | 0 | identity/GitHub/Runner/Job/config/vault |
| R085 | Phase 1 실제 제품 | §13 | 1 | native/store/OTA/Web/Release E2E |
| R086 | Phase 2 Operations | §13 | 2 | store/rollout/preview/schedule/config/flags |
| R087 | Phase 3 Engagement | §13 | 3 | push/in-app/links/campaign |
| R088 | Phase 4 Business | §13 | 4 | ads/revenue/attribution/observability |
| R089 | Phase 5 Platform | §13 | 5 | marketplace/framework/cloud/SSO 확장 |
| R090 | 첫 번째 목표 | §13 | 1 | 가입부터 한 Release 전체 상태까지 |
| R091 | 가장 중요한 UX | §2 | 1 | 개인 .env/인증서 복사 없이 Job 주입 |
| R092 | 새 PC 경험 | §2 | 0/1 | 등록·doctor 후 조직 작업 수행 |
| R093 | 제품 핵심 가치 | §1 | 전 단계 | 앱 개발 이후 운영 업무 제거 |
| R094 | 기술적 성공 기준 | §13 | 1 | Git/Runner/build/secrets/store/OTA/Web/RBAC/audit |
| R095 | 제품적 성공 기준 | §13 | 1 | 내부 5개 앱 운영과 반복 업무 감소 |
| R096 | Open Source 전략 | §11 | 전 단계 | Apache-2.0, 전체 core/adapter/self-host 공개 |
| R097 | SaaS 전략 | §11 | 후속 | 핵심 기능 잠금 없이 호스팅·관리 편의성 |
| R098 | 비용 철학 | §11 | 전 단계 | 자체 build farm 대신 사용자 Runner/인프라 |
| R099 | 브랜드 독립성 | §12 | 0 | 중립 DB/package/ID와 PRODUCT_NAME |
| R100 | 구현 원칙 | §12 | 전 단계 | strict/tests/migration/error/audit/docs/idempotency |
| R101 | 첫 개발 순서 | §12 | 0/1 | 기반→실행→배포→운영, audit는 처음부터 |
| R102 | 첫 End-to-End Test | §13 | 1 | Expo native/OTA/Web/Release + PC 교체 검증 |

## 후속 대화에서 추가·명확화한 요구

| ID | 확정한 의도 | 설계 반영 |
| --- | --- | --- |
| A001 | 완전 오픈소스, 통합 관리 | Core/공식 adapter/RBAC/Audit/Vault/Self-host 공개, 핵심 유료 잠금 금지 |
| A002 | 우리 서비스 배포도 Cloudflare | Workers/D1/R2/Queues 중심, 실제 배포와 코드 준비 분리 |
| A003 | 외부 기능은 플러그인처럼 연결 | capability/version/schema/scope/health/retry/reconcile 계약 |
| A004 | 해당 PC에서만 되고 다른 PC에서 안 되면 실패 | 조직 소유 상태, 공용 Runner pool, portable toolchain, PC 교체 E2E |
| A005 | 다른 개발자가 배포 걱정 없이 운영 | 역할·승인에 따른 웹 요청, 자동 preflight, 명확한 대기/실패/복구 |
| A006 | Expo 유료 플랜을 필수로 쓰지 않음 | native build + 자체 Expo protocol OTA 경로, EAS는 선택 연동 |
| A007 | 기획을 GitHub에, 개발 목적을 Notion에 | 저장소 문서를 기술적 기준으로 두고 Notion에 제품 의도/진행 링크 |
| A008 | Supabase/Appwrite 라이선스를 보고 맞춤 | 공식 LICENSE 확인 후 Apache-2.0 선택, third-party notice 보존 |
| A009 | 공개 설치가 깨끗한 새 환경에서도 동작 | pinned toolchain/lockfile, sample config, doctor, OS 매트릭스와 실제 검증 표시 |
| A010 | 웹에서 AI로 코드를 수정하는 흐름을 우선 | private 웹 요청 → 격리 Runner → provider-neutral AI → diff/테스트 → 승인된 GitHub branch·draft PR → 기존 Release 인계. 상세 설계·구현 계획은 별도 검토 |

원문 문구보다 최신 명시적 결정이 우선한다. 원문의 provider 사실은 [2026-10-06 검증 기록](../reference/provider-facts.ko.md)으로 보완한다.

## 2026-10-07: 웹 AI 코드 수정 우선순위 변경

사용자는 웹에서 AI로 코드를 수정하는 방향을 명시적으로 추가했다. 이 결정은 초기 통합 기획 §13/R083의 AI 제외 범위·우선순위를 변경한다. 원래 GitHub·Flavor/Environment·Config/Vault·Build·Store·OTA·Web·Release 운영 목표는 유지한다.

[아키텍처 추가안](../proposals/web-ai/architecture-addendum.ko.md)과 [다음 milestone 상세 설계](../proposals/web-ai/next-slice-spec.ko.md)는 사용자 검토를 위한 제안이다. 방향에 대한 동의와 이 새 상세 설계·구현 계획 승인은 구분하며, 상세 설계와 이후 구현 계획의 검토·실행 방식 결정은 아직 남아 있다. 현재 Foundation에는 AI 코드 수정, 웹 UI, 실제 인증·Runner/provider 연동이 구현되지 않았다. 이번 문서 추가는 기능 출시나 배포를 뜻하지 않는다.
