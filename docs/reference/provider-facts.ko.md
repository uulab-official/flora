# Provider 사실 확인과 구현 제약

확인일: **2026-10-06**. 아래는 그날의 공식 문서 확인 결과이며 영구 가격·지원 계약이 아니다. 출시 전 다시 확인하고 account별 실제 capability를 검사한다.

## Cloudflare

- Queues Free는 10,000 operations/day, 메시지 보관은 24시간이다. 보통 한 번 전달에 write/read/delete 3 operations가 들고 재시도·큰 메시지는 더 든다. “하루 1만 build 무료”라는 의미가 아니다. [공식 가격](https://developers.cloudflare.com/queues/platform/pricing/)
- 전달은 at-least-once이므로 중복 message를 예상해야 한다. lease만으로 외부 action의 exactly-once를 보장하지 않는다. [전달 보장](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- D1 Free는 하루 5M rows read/100K rows written, 총 5GB다. limit 초과 시 쿼리가 실패할 수 있고 scan/index 쓰기도 비용에 영향을 준다. heartbeat를 무조건 DB에 자주 쓰면 작은 Runner 수로도 예산을 소모한다. [D1 가격](https://developers.cloudflare.com/d1/platform/pricing/)
- R2 Standard 무료 구간은 월 10GB-month, 1M Class A, 10M Class B이고 인터넷 egress는 무료로 안내된다. 요청·저장·다른 상품 비용이 모두 무료라는 의미는 아니다. [R2 가격](https://developers.cloudflare.com/r2/pricing/)
- Cloudflare는 third-party OAuth Applications를 공식 제공한다. 계정 선택·scope consent·revoke가 있으며 account admin이 신규 접근을 제한할 수 있다. BYOC 설계에 사용할 수 있지만 Flora OAuth client 등록, redirect URI, 필요한 resource scope, provisioning API는 실제 구현·검증이 필요하다. [OAuth 개요](https://developers.cloudflare.com/fundamentals/oauth/), [권한 부여](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)

## Expo / EAS

- `eas build --local`은 로컬에서 실행되지만 Expo 로그인/token이 필요하고 EAS project 확인과 managed credential 조회가 남을 수 있다. Windows local build는 공식 지원되지 않는다. 따라서 완전 독립 경로의 유일한 구현으로 두지 않는다. Expo prebuild와 native Xcode/Gradle 도구를 통한 production build 경로를 우선 검증한다. [로컬 빌드 공식 문서](https://docs.expo.dev/build-reference/local-builds/)
- Expo Updates 공개 프로토콜과 `expo-updates` custom server 지원을 활용할 수 있다. 자체 manifest/asset/호환성/서명/rollback 구현은 별도 책임이며 EAS와 동일한 기능을 자동으로 얻는 것이 아니다. [Protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/), [Updates SDK](https://docs.expo.dev/versions/latest/sdk/updates/)
- native 코드·SDK 변화는 runtime compatibility에 반영해야 한다. 호환되지 않는 binary에 JS OTA를 보내는 것으로 native 기능을 추가할 수 없다. [Runtime versions](https://docs.expo.dev/eas-update/runtime-versions/)
- EAS Update hosted code signing은 문서상 Production/Enterprise plan 기능이다. `expo-updates` client의 서명 검증과 자체 provider의 독립 서명 경로를 구분해 구현·테스트한다. 유료 hosted 기능 설명을 자체 서버의 구독 요구로 혼동하지 않는다. [Code signing](https://docs.expo.dev/eas-update/code-signing/)

## Apple / Google Play

- Apple은 Xcode/Transporter 및 App Store Connect API build upload 경로를 문서화한다. API용 JWT, 역할 권한, 처리 지연과 version/build 식별을 고려한다. upload 완료는 TestFlight 처리·심사·공개 완료가 아니다. [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- Play track release에는 status와 userFraction이 있다. fraction은 0과 1 사이이며 inProgress/halted에서 사용한다. 100%는 completed 상태로 매핑하고, halt가 이미 설치된 앱을 이전 버전으로 되돌리지 않는다는 점을 UX에 반영한다. [Tracks API](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks)
- Store 정책, signing 요구, 개발자 계정 요금과 native SDK 요구는 실제 adapter 구현 및 release 때 최신 공식 문서로 다시 확인한다. 이 저장소 문서가 계정 개설·약관 수락·실제 앱 공개를 승인하지 않는다.

## Push / Ads

- FCM HTTP v1은 서버에서 적절한 권한으로 메시지를 전송하는 API다. access token 관리와 target validation이 필요하다. 전달 성공·열람 여부는 별도의 관측 단계다. [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
- AdMob mediation group create/list/update 기능은 공식 문서에 있으나 **limited access**라고 명시되어 있다. 모든 연결 계정에서 수정 가능하다고 가정하지 않는다. reporting 우선, 관리 기능은 capability-gated로 둔다. [Mediation groups](https://developers.google.com/admob/api/v1/mediation-groups)

## 비용 표시 정책

제3자 무료 한도를 코드의 영구 상수로 박지 않는다. 공식 문서 링크·확인일·정책 버전과 account usage를 함께 보여준다. 모든 provider가 quota API를 제공하지 않을 수 있으므로 자동 조회가 불가능한 값은 문서 기반으로 표시한다. 월간 추정에는 storage, requests, polling, heartbeat, logs, retention, retries와 필요한 Runner 비용을 포함한다.

“Expo 유료 플랜 없이 운영”은 제품 목표이며 “모든 앱 운영 비용 0”은 약속하지 않는다.

## 오픈소스 라이선스 비교

사용자의 “Supabase나 Appwrite를 보고 맞추자”는 요청에 따라 두 저장소의 LICENSE를 확인했다. Supabase의 해당 저장소는 Apache-2.0, Appwrite의 해당 저장소는 BSD-3-Clause다. Flora는 Apache-2.0을 선택한다. 각 회사의 모든 제품·서비스·의존성이 동일한 라이선스라는 뜻은 아니다.

- [Supabase LICENSE](https://github.com/supabase/supabase/blob/master/LICENSE)
- [Appwrite LICENSE](https://github.com/appwrite/appwrite/blob/main/LICENSE)
- [Apache License 2.0 원문](https://www.apache.org/licenses/LICENSE-2.0.txt)

라이선스는 무료 사용·수정·상업적 이용과 재배포의 조건을 정한다. hosted 서비스 이용 계약과 제3자 API 정책은 별개다. 배포 시 LICENSE와 필요한 NOTICE/third-party attribution을 보존한다.
