# 앱별 인증서·Google 키·푸시 키 관리

후속 작업에서 Isso·Promise의 기존 실제 키를 각각 6종 등록하고 PC 네이티브 Runner의 최소 권한 전달을 추가했습니다. 현재 운영 범위와 실제 빌드 검증은 [실제 앱 인증서와 PC 네이티브 빌드](native-build-signing.ko.md)를 확인하세요. 아래의 미등록·후속 상태와 828개 테스트 수는 최초 보관소 배포 당시의 기록입니다.

2026-10-14 KST. https://flora.uulab.co.kr/ 에서 **프로젝트 선택 → 이 앱의 인증서 · 서비스 키 관리** 또는 **설정 → 인증서 · Google 키 · 푸시 키**를 엽니다.

## 제공 기능

앱별 등록·암호화 보관·교체·Flora 사용 중지·이력을 구현했습니다. 같은 종류를 다시 등록하면 새 버전으로 교체하며 다른 앱의 키와 이력은 바뀌지 않습니다. 낡은 revision·동시 변경·잘못된 후보·한도 초과는 기존 활성 버전을 보존합니다.

| 종류 | 입력과 현재 검증 |
| --- | --- |
| iOS 배포 인증서 | P12/PFX와 비밀번호 보관. 별도 서명 도구 검증 필요 |
| iOS 프로비저닝 | mobileprovision 보관. 프로파일·인증서·앱 일치 검증은 후속 |
| Android Keystore | 파일·Alias·Keystore/Key 비밀번호 보관. 서명 도구 검증 필요 |
| App Store Connect | P8/PEM의 PKCS8 P-256 키 형식 검증 |
| Google Play | 서비스 계정 JSON, RSA 2048비트 이상 키 형식 검증 |
| APNs | P8/PEM의 PKCS8 P-256 키 형식 검증 |
| FCM | 서비스 계정 JSON, RSA 키 형식 검증 |
| Firebase Android | google-services.json의 package/project 식별 정보 일치 검증 |
| Firebase iOS | GoogleService-Info.plist 보관. plist·앱 일치 검증은 후속 |

등록·형식 검증·공급자 권한·실제 서명/푸시 성공은 별개입니다. 실제 iOS/Google/APNs/FCM 자격 증명은 아직 운영 앱에 등록하지 않았습니다. 키는 채팅 대신 해당 앱의 HTTPS 화면에 입력합니다. 자동 발급·기존 파일 자동 수집·native 빌드 전달·스토어 제출·푸시 전송은 이번 구현에 포함하지 않습니다. 공유 공급자 키도 사용할 앱에 각각 등록하며, Flora binding이 공급자의 계정 전체 권한을 줄인다고 표시하지 않습니다. Flora 사용 중지는 공급자의 키 폐기가 아닙니다.

## 보관과 권한

기존 소유자 SQLite DO에 별도 versions/bindings/history 테이블을 추가했습니다. 버전별 DEK와 별도 nonce를 사용한 AES-256-GCM envelope encryption을 적용하고 owner/DB/app/kind/version/KEK ID/공개 metadata를 AAD로 연결합니다. KEK는 일반 DB·공개 vars와 분리된 `FLORA_VAULT_KEYS` Worker Secret입니다. [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)와 [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)를 사용합니다.

목록과 이력에는 공개 식별자·fingerprint·검증 상태·revision·시각만 표시합니다. 원문 조회/export API는 없으며 일반 OTA Runner에도 Vault 접근 권한을 추가하지 않았습니다. 앱 전환·로그아웃·세션 종료 시 파일/비밀번호 입력을 비우고, 늦은 읽기/응답과 불명확한 변경 결과의 자동 재전송을 차단합니다.

한도: 요청 1,500,000바이트, 파일 1MiB, PEM/Google JSON 64KiB, 암호화 envelope 합계 앱당 4MiB/소유자당 16MiB, 앱·종류당 보관 버전 20개. 인증·CSRF를 본문 읽기 전에 검사하고 비동기 처리 후와 CAS 트랜잭션 안에서 권한을 재확인합니다. 한도 초과 시 기존 기록을 자동 삭제하지 않습니다.

KEK 복구 사본은 checkout 밖 `~/Library/Application Support/Flora/operator-vault/`에 디렉터리 0700·파일 0600으로 보관했습니다. 운영 비밀이므로 Git/공유 문서에 올리지 않습니다. 참조 중인 KEK를 제거하면 복호화가 불가능합니다. 키 링은 최대 3개를 지원하지만 전용 재포장/복구 UI는 후속입니다. 기존 GitHub·OTA 키는 기존 레코드와 사용 경로를 그대로 보존했고 일괄 이전하지 않았습니다.

## 테스트·운영 배포

최종 `pnpm check`: build·typecheck 성공, **828개 중 825개 통과, 실패 0, 선택 실행 3개 제외**. 신규 35개는 validator 12, 실제 workerd/SQLite/WebCrypto Vault 8, HTTP/API 5, UI 10개입니다. RED 이후 구현했으며 보안 리뷰의 Firebase Android 서버 용량 누락은 정확히 64KiB/64KiB+1 경계 테스트로 수정했습니다.

서로 다른 저장소의 합성 앱 두 개에서 키·교체·사용 중지 이력 분리, CAS, 실패 후보 보존, 세션 취소 중 업로드, raw export/Runner 거절, 암호문/AAD/앱/소유자/DB 변조, KEK 변경, 용량·SQL rollback을 확인했습니다. APNs/Google 테스트 키는 테스트에서 생성했습니다. 가짜 바이너리 파일은 보관 상태만 검증했고 운영 앱에 테스트 키를 넣지 않았습니다.

운영 버전 **1719f3a2-6fff-4810-8646-2599cfbbe392**, 트래픽 100% 적용. 기존 9개 binding·D1·FloraAuth namespace·도메인을 유지하고 Worker Secret 한 개를 추가했습니다. D1 migration, EAS/Actions 실행, 새 유료 제품/자원 생성, 요금제 변경은 없었습니다. 계정 청구 플랜 및 이후 전체 사용량의 무료 한도 보장은 별도 확인 대상입니다.

Safari에서 로그인, 있소 등록 화면, 우리만나 전환 시 빈 이름/파일/비밀번호와 별도 앱 이름/이력을 확인했습니다. 운영 세 앱은 `configured:true`, 실제 등록 키·신규 이력은 0개입니다. 비인증 목록은 401, 운영 HTTPS 8개 응답과 8개 웹 파일은 빌드와 일치합니다. 기존 edge beacon 삽입만 구분했으며 CSP/Analytics 설정은 바꾸지 않았습니다.

| 앱 | 작업 보존 | OTA 게시 보존 | 정책 | PC Runner |
| --- | ---: | ---: | --- | --- |
| 있소 | 16 | 7 | v4 · iOS + Android | online |
| 우리만나 | 12 | 7 | v4 · iOS + Android | online |
| Reward | 4 | 4 | v1 · iOS + Android | online |

세 앱의 전체 상태·공개 설정·연결·인식·자산·배포·작업·정책·Runner grant는 전후 동일합니다. presence 시각만 갱신됐습니다. 여섯 OTA 매니페스트의 hash·게시 ID·서명·key ID가 동일하며 기존 SDK 공개 인증서로 RSA 검증이 통과했습니다. 이번 작업에서 기기 적용·재시작·스토어/푸시 실행은 다시 수행하지 않았습니다.

증거: `dist/credentials-2026-10-14/`의 `full-check.log`, `deploy.log`, `deployment-receipt.json`, `preservation.json`, `ota-trust-{before,after}.json`, `live-web.json`, `production-credential-readiness.json` 및 `dist/real-apps-2026-10-13/evidence/credentials-{before,after}-*`. 실제 비밀값은 증거 파일에 기록하지 않았습니다.
