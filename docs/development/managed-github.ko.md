# 서버에서 관리하는 GitHub 연결과 OTA 키

Flora의 hosted 작업실에서 **GitHub 연결하기**를 선택하면 GitHub App manifest
등록을 시작한다. 조직을 지정하고 GitHub에서 인증·등록을 완료한 다음,
Flora의 콜백 화면에서 연결 완료를 누른다. GitHub가 요구하는 사용자 인증과
설치 권한 부여는 실제 계정에서 수행해야 한다.

GitHub App 개인키와 webhook secret은 소유자 인증 Durable Object의 비공개
저장소에만 보관한다. 브라우저, 앱 저장소, 공개 설정, D1의 앱 자료와 SDK에는
개인키를 전달하지 않는다. 등록 state는 세션과 인증 epoch에 연결되며 10분
후 만료되고 한 번만 사용할 수 있다. 콜백 GET은 키 교환이나 저장을 하지
않으며 동일 출처의 세션·CSRF POST에서만 연결을 완료한다.

설치할 때 **Only select repositories**로 관리할 저장소만 선택한다. Flora의
manifest는 Contents와 Metadata 읽기 및 push 이벤트만 요청한다. 설치 후
작업실의 저장소 목록에서 앱을 등록하면 설치 ID를 직접 입력하지 않아도 된다.
기존 환경 변수 방식의 GitHub App 설정도 계속 지원한다.

앱별 공개 OTA 인증서는 서버에서 자동 생성한다. RSA 개인키와 manifest 서명은
인증 DO 내부에 남고, 앱에는 공개 인증서와 key ID만 포함한다. 이 인증서는
업데이트 서명 검증용이며 HTTPS의 TLS 인증서가 아니다. 서버의 HTTPS 인증서는
호스팅 서비스가 관리하므로 PC에서 개인키·인증서를 준비할 필요가 없다.

공개 `flora.connection.json`에는 앱 ID, HTTPS 주소, 채널, 명시적 런타임,
공개 인증서와 key ID를 넣는다. `@flora/ota/plugin`으로 이를 바이너리에 고정한다.
처음 SDK를 연결하거나 이 네이티브 신뢰 설정을 변경하면 새 바이너리가 필요하다.
EAS를 호출하지 않고 CocoaPods/Xcode 또는 Gradle로 로컬 빌드할 수 있다.

기존 앱 데이터와 운영 배포는 유지한다. 검증은 앱별 별도 등록·설정·검증 채널과
기존 소스를 보존한 작업 브랜치에서 수행한다. 서버에 등록하거나 GitHub 소스를
인식한 것만으로 OTA가 다운로드·적용됐다고 보고하지 않는다. 실제 실행 정보와
업데이트 ID, 앱 화면, 재시작 결과를 확인해야 한다.

관련 구현: `managed-connections.ts`, `managed-signing.ts`, `auth-do.ts`.
GitHub 기준 문서: [App manifest 등록](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[설치 토큰 발급](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
