# 로컬 AAB 서명 검증과 검증 기록

## 범위
기존 로컬 빌드 레시피에 선택적으로 `signaturePolicy`를 넣으면, 프로세스가 종료된 뒤 Android AAB의 **JAR 서명 및 운영자가 고정한 업로드 인증서 지문**을 검사합니다. 검증 실패 시 Runner는 실패 원인을 남기고 완료 산출물을 등록하지 않습니다. 기존 설정은 여전히 기본 무서명 검증 경로이며, APK/IPA에 이 정책을 붙이면 거부합니다.

검증기는 JDK 표준 `JarFile` 검증을 사용합니다. AAB 안의 코드를 실행하거나 파일을 추출하지 않습니다. 실제 파일을 비공개 임시 폴더에 해시 검증 복사하고, 서명 검사 뒤 같은 복사본의 해시를 다시 확인합니다. 등록 시 원본 파일도 재검증하므로 검사 후 바뀐 바이트가 같은 증거로 등록될 수 없습니다.

**이 기능은 APK 검증, bundletool의 AAB 형식/리소스 검증, Google Play 승인, 앱 설치, OTA 또는 코드의 안전성 보장이 아닙니다.** AAB 업로드 인증서와 Play가 배포 APK에 사용하는 서명 인증서는 다를 수 있습니다. 개인 키나 keystore를 읽거나 서버로 보내지 않습니다.

## 설정
Node는 저장소 고정 버전 24.19.0, 서명 검증에만 JDK 17 이상이 필요합니다. JRE만 있는 환경이나 실행 파일의 존재만 확인한 preflight는 Java source launcher의 사용 가능성까지 보장하지 않습니다. 실제 검증 실행에서 확인합니다.

기존 `android` / `aab` 레시피에 다음 속성을 추가합니다. 자리표시자는 실제 값으로 바꾸기 전까지 유효하지 않습니다.

```json
{
  "signaturePolicy": {
    "scheme": "aab-jar-v1",
    "javaExecutable": "/absolute/path/to/jdk/bin/java",
    "expectedSignerSha256": "REPLACE_WITH_64_LOWERCASE_HEX_CERTIFICATE_SHA256",
    "timeoutMs": 30000
  }
}
```

지문은 검증할 AAB 자체에서 자동 채택하지 마세요. 별도로 신뢰하는 업로드 인증서에서 확인하고, 콜론 없는 소문자 64자리 SHA-256으로 설정합니다. 인증서 파일 확인 예: `keytool -printcert -file upload-certificate.pem`. 설정 파일은 로컬 운영자가 소유한 비공개 파일에 보관합니다. 웹은 정책/명령/경로를 받지 않고 기존 등록 설정 ID만 받습니다.

한 개의 기대 서명자만 지원합니다. 인증서 지문 일치, 검증 시각의 유효 기간, 서명 용도 및 키 강도를 검사합니다. 인증서 체인 신뢰/폐기 조회, TSA 서명 시각, 자동 키 회전은 구현하지 않습니다. 한도가 있는 검증 프로세스이고, 운영자가 선택한 JDK와 Flora 코드 자체는 신뢰 경계입니다.

## 실제 검사와 한도
모든 payload 파일(일반 META-INF 파일 포함)을 끝까지 읽어 JAR 서명을 검증합니다. 서명되지 않은 추가 파일, 삭제된 manifest 참조 파일, 중복/위험 경로, 불필요한 서명 블록, 잘못된 인증서, 만료 인증서, 변조를 거부합니다. BundleConfig.pb와 base manifest 존재만 확인하며 protobuf/DEX가 유효한지는 확인하지 않습니다.

검사 전 입력은 기존 산출물 한도 2 GiB를 따릅니다. 고정 한도는 ZIP 50,000개 항목, 항목당 1 GiB, META-INF 항목당 8 MiB, 총 압축 해제 4 GiB, JVM heap 256 MiB, 도구 출력 16 KiB입니다. timeoutMs는 100~120,000ms, 기본 30초입니다. 환경변수의 Java 옵션 주입은 전달하지 않으며 고정 helper를 실행합니다. 한도/중지/도구 오류는 성공으로 취급하지 않습니다.

## 화면, CLI, HTTP
실행 확인창은 필수 서명 정책과 인증서 지문을 표시합니다. 실행 중에는 `AAB 업로드 서명 확인` 단계를 보여줍니다. 산출물 카드는 무결성, **검증 당시** 업로드 서명, 실제 설치를 분리합니다. 현재 인증서가 여전히 유효한지나 앱이 설치되는지 새로 검사한 결과가 아닙니다.

```sh
node scripts/artifacts/build-ops.mjs evidence \
  --state-dir /ABSOLUTE/PRIVATE/STATE --app my-app --job release-001 --artifact ARTIFACT_ID
```

인증된 `GET /api/jobs/:app/:job/evidence?artifact=ID`와 화면의 `서명 검증 기록 JSON`으로 같은 보고서를 읽습니다. 이 조회 자체는 파일을 재해시하지 않으므로 `integrityRechecked:false`입니다. 다운로드/내보내기는 기존 해시 재검증을 수행합니다. JSON에는 로컬 도구 경로·원문 로그·개인 키가 없습니다.

`artifact.signatureVerified:true`는 해당 바이트의 제한된 JAR 서명 관측입니다. `signatureEvidence`에는 해시/바이트 수, 기대 서명자와 일치한 인증서 SHA-256, 서명된 항목 수, 검사 시각, 인증서 유효 기간, Java feature 버전이 들어갑니다. `job.signatureVerified`는 일반 플랫폼 증명으로 승격하지 않아 false이며, `bundleValidated`와 `installVerified`도 false입니다.

## 영속성, 복구, 호환성
증거는 산출물 메타데이터와 완료 트랜잭션 안에 함께 저장합니다. 서명 정책을 바꾼 동일 완료 요청 키는 충돌합니다. 기존 무서명 완료 fingerprint는 변경하지 않았습니다. 재전송은 원본 파일/도구를 다시 실행하지 않지만 저장 파일과 증거 형태/지문을 검사합니다.

새 버전의 백업·복원은 증거를 보존하고 해시와 연결이 깨진 증거는 거부합니다. 복원 과정에서 JDK 서명 검증을 다시 실행한 것은 아닙니다. 백업 자체의 발급자 인증/암호화도 아닙니다. 서명 증거가 포함된 백업은 이 기능을 포함한 버전으로 복원하세요. 증거 조회와 다운로드는 서명 증거를 삭제하거나 승인 상태를 바꾸지 않습니다.

정상 오류·중지 시 임시 `.signature-*` 디렉터리를 정리합니다. OS 강제 종료/SIGKILL은 임시 복사본을 남길 수 있습니다. 자동 삭제나 잠금 해제를 하지 않으며, 프로세스를 확인한 로컬 운영자만 정리해야 합니다. 백업에는 이 실행 중 임시 데이터가 포함되지 않습니다.

## 검증과 아직 남은 항목
테스트는 매번 폐기할 키로 **실제로 서명한 합성 AAB 모양 ZIP**을 사용합니다. 암호학적 서명/변조/인증서 검증은 실제지만, 그 파일은 Gradle로 만든 설치 가능한 앱이 아닙니다. 실제 앱 AAB, APK apksigner, IPA codesign, 설치·OTA, 독립 보안 리뷰 및 기존 Hosted 연결은 별도 검증입니다.

참고: Android 공식 command-line build 문서의 App Bundle signing, Oracle JarFile/JarEntry API의 verify/getCodeSigners 계약. `JarFile`만으로 인증서 신뢰가 결정되지 않으므로 별도 인증서 pin 및 유효성 검사를 수행합니다.
