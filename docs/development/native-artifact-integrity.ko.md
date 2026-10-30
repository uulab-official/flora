# 네이티브 산출물 무결성 검증 (검증 브랜치)

현재 상태: **재사용 가능한 로컬 파일 검증 모듈과 단위 테스트**. Flora 서버/빌드 Provider/API/다운로드 UI에 아직 연결하지 않았으며, 산출물 업로드·배포·실기기 성공을 의미하지 않습니다.

- `scripts/artifacts/native-artifact-integrity.mjs`: 메모리 내 Buffer 검증
- `scripts/artifacts/native-artifact-file.mjs`: 최대 2GiB 정규 파일 스트리밍 SHA-256 검증. 심볼릭 링크, 하드 링크, 부모 심볼릭 링크를 거부하고 검사 전후 파일 상태를 비교
- `scripts/artifacts/*.test.mjs`: 동일 앱/작업 범위, 다른 앱 접근, 손상·크기·링크 거부 및 서명·설치 검증 상태 분리
- `.github/workflows/native-artifact-integrity.yml`: 변경 시 Node 24 단위 테스트 실행

## 연결 계약

사용 시 빌드 작업의 **서버가 확인한** `expected`를 입력하세요. 산출물 manifest에 들어 있는 앱/작업 ID를 그대로 `expected`로 재사용하면 교차 앱 차단이 성립하지 않습니다. 필요한 값은 `appId`, `jobId`, `repository` (owner/repo), `sourceSha` (40자리), `platform` (ios/android) 입니다.

```js
import { verifyNativeArtifactFile } from "../../scripts/artifacts/native-artifact-file.mjs";
const receipt = await verifyNativeArtifactFile({ filePath, manifest, expected: authorizedJob });
if (!receipt.integrityVerified) throw new Error("integrity required");
// receipt.signatureVerified === false, receipt.installVerified === false
```

`manifest`에 `byteCount` (실제 바이트) 및 `sha256` (소문자 64자리)을 포함하세요. 파일명은 신뢰할 수 없으므로 실행/설치 가능성을 파일 확장자로 판정하지 마세요.

**보안 경계:** 작업 결과의 출처·코드 서명·설치 가능성은 별도로 검증해야 합니다. 파일 검사와 업로드 사이에 파일이 교체되지 않도록 실제 Provider 연결 구현에서는 검증된 파일 디스크립터/격리 디렉터리 소유권/원자적 이동 정책이 필요합니다. 큰 파일은 메모리에 적재하지 않으며, 반환 receipt는 서명이나 실기기 설치를 보증하지 않습니다.

## 미완료 게이트

- [ ] 빌드 작업 ID/접근 권한 확인 후 receipt 영속화
- [ ] 다운로드/업로드 경로에서 동일 digest 재검증 및 원자적 publish
- [ ] APK/AAB/IPA 각각 플랫폼 도구로 서명 검증
- [ ] 실제 PC·GitHub Actions Provider 실빌드
- [ ] 실제 디바이스 설치·OTA 적용·롤백
- [ ] Linux/macOS/Windows CI 및 Hosted Chrome QA 최신 HEAD 통과

운영 Worker/D1, OTA 데이터 및 인증서는 변경하지 않습니다.
