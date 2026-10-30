# Flora Native Runner: 앱 바이너리 로컬 검증

상태: \`flora builds verify-native\` CLI + 순수 공개 메타데이터 영수증 생성 기능. 공개 GitHub Actions에서 다운로드한 산출물은 기존 \`flora builds verify\` 명령을 사용한다.

**목적:** 오픈소스 사용자가 자신의 PC/Mac에서 생성한 APK/AAB/IPA를 서버 업로드나 유료 스토리지 없이 확인한다. 서명 인증서·Keystore·P12·Bearer Token·GitHub 인증정보는 JSON 영수증에 포함하지 않는다.

## 사용 방법

1. 자신의 Flora 인스턴스에 로그인하여 앱을 선택한다. 네이티브 PC Runner가 \`succeeded\`로 보고하고 \`artifactVerification=runner_reported\`인 작업의 **공개 메타데이터 영수증**만 사용한다.
2. 해당 작업의 \`flora-native-build-receipt.json\`을 다운로드한다. 자신의 PC Runner에 저장된 **같은 작업의** \`*.apk\`, \`*.aab\`, \`*.ipa\` 파일을 로컬 폴더 하나에 넣는다. 영수증과 바이너리 **정확히 두 파일**만 포함한다.
3. Flora 저장소에서 \`pnpm install --frozen-lockfile\`과 \`pnpm build\`를 실행한 뒤, 아래 예시처럼 **로컬에서만** 검증한다.

\`\`\`sh
node /PATH/TO/FLORA/packages/cli/dist/main.js builds verify-native \
  --dir /ABSOLUTE/PATH/TO/NATIVE-ARTIFACT \
  --app-id YOUR_FLORA_APP_ID \
  --commit YOUR_EXACT_40_HEX_COMMIT
\`\`\`

출력 \`status: "bytes_match_runner_report"\`는 파일 크기와 SHA-256이 보고된 영수증과 일치한다는 뜻이다. \`runnerReported: true\`, \`provenanceAttested: false\`, \`signatureVerified: false\`가 반드시 함께 나온다. **이 결과만으로 Apple/Android 배포 서명이나 GitHub 코드 출처가 독립 검증된 것은 아니다.**

서명 검증은 Android \`apksigner verify --print-certs\`(APK), \`jarsigner\`/Play App Signing 계정 검토(AAB), iOS \`codesign\`/프로비저닝 프로파일 확인 등 별도 플랫폼 도구와 신뢰 설정으로 확인해야 한다. Flora의 해시 출력이 App Store/Google Play 제출, 설치 성공 또는 OTA 기기 적용 증거를 대신하지 않는다.

## 영수증 v1 구조

\`\`\`json
{
  "schemaVersion": 1,
  "source": "flora-native-runner-report",
  "appId": "my_app",
  "jobId": "native_job_one",
  "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "state": "succeeded",
  "artifactVerification": "runner_reported",
  "artifact": {
    "fileName": "my-app.apk",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "byteLength": 123456,
    "appIdentifier": "co.example.myapp",
    "platform": "android",
    "signerFingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }
}
\`\`\`

위 값은 예시이며 실제 파일이나 서명 검증이 아니다. 인증된 브라우저가 이미 로드한 **현재 앱의 종료된 성공 Job**의 허용 필드만 영수증으로 직렬화한다. \`native-artifact-receipt.js\`는 외부 URL이나 요청을 사용하지 않는다.

## 안전 경계

- 유효한 앱 ID, Job ID, 40자리 고정 SHA, 플랫폼 확장자, 64자리 해시, 파일 크기, Bundle/Package ID, SHA-256 서명자 메타데이터만 허용한다.
- 클린 폴더·정확한 파일명·링크 개수·비심볼릭 링크·비하드링크·파일 핸들 inode/size를 검사한다.
- 64 KiB 영수증, 최대 4 GiB 바이너리, 스트리밍 SHA-256 검증으로 메모리 사용을 제한한다.
- API 토큰이나 인증서를 CLI 인자로 받지 않는다. 원격 업로드·네트워크 통신·금액이 발생하는 동작도 없다.
- 잘못되거나 다른 앱의 영수증을 제공하면 실패하며, 성공을 재시도하거나 서명·업로드·OTA 배포했다고 표시하지 않는다.

오픈소스 사용자 설치 방법과 외부 서비스 선택: [웹 빌드 Provider](web-build-provider-center.ko.md).
