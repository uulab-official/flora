# 비공개 GitHub Actions APK/IPA 무결성 확인

Flora의 재사용 GitHub Actions Workflow로 빌드한 뒤, 사용자가 **비공개 호출 저장소에서 직접 다운로드한 산출물**을 PC에서 검증하는 절차입니다. Flora 운영 서버에 업로드하지 않으며 외부 GitHub/API 자격증명도 필요하지 않습니다.

## 절차

1. 비공개 Expo 앱에 examples/github-actions/private-expo-build.yml을 복사하고, 호출할 Flora Workflow를 검토한 **40자리 고정 Git SHA**로 지정합니다.
2. 비공개 앱 GitHub Actions에서 Flora native build를 실행합니다. 해당 Run의 Artifacts ZIP을 직접 다운로드하여 압축을 풉니다.
3. APK, AAB 또는 IPA와 flora-build-receipt.json이 **동일한 폴더** 안에 있도록 합니다.
4. Flora를 잠금 파일로 설치·빌드한 후 아래 명령을 본인 환경에 맞춰 실행합니다.

    node /ABSOLUTE/PATH/TO/FLORA/packages/cli/dist/main.js builds verify --dir /ABSOLUTE/PATH/TO/EXTRACTED-ARTIFACT --repository OWNER/MY-PRIVATE-APP --commit 0123456789abcdef0123456789abcdef01234567 --run-id 123456789

--run-id는 선택 사항이지만 지정하는 것을 권장합니다. --dir, --repository, --commit은 필수입니다.

## 검증 범위

- Manifest 및 실제 APK/AAB/IPA 파일의 SHA-256 비교와 바이트 길이 확인
- 사용자 지정 GitHub 저장소, 커밋 SHA, 선택한 Run ID와 manifest 값 일치
- 등록된 네이티브 파일만 허용하며, 추가·누락 파일, 중복 이름, 심볼릭 링크·하드 링크, 경로 탈출, 큰 JSON manifest 거절
- 출력은 제한된 코드와 안전한 해시/Run 메타데이터만 포함; 원본 파일 경로·토큰 비출력
- status: integrity_verified는 **파일 무결성만** 확인합니다. provenanceAttested:false, signatureVerified:false이므로 GitHub 서명 증명·앱 인증서·스토어 제출·기기 적용을 보장하지 않습니다. 호출 Workflow와 실제 Run을 GitHub에서 별도로 확인해야 합니다.

GitHub 다운로드와 비용/권한은 비공개 저장소 소유자가 관리합니다. Flora 웹에서는 해당 비공개 저장소 Actions 화면으로 이동만 지원합니다. 바이너리를 Flora에 자동 복사·재배포하거나 서명 성공으로 판단하지 않습니다.

## 다음 단계

GitHub Artifact Attestation 독립 검증, 사용자 BYOC 바이너리 저장, 만료 다운로드 링크, Android/iOS 인증서 검증, 스토어 제출, 기기 OTA 적용·롤백은 별도로 검증한 뒤 추가해야 합니다. 기존 Flora PC Runner는 별도 보안·서명 권한 체계를 유지합니다.
