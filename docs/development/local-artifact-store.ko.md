# Flora 로컬 네이티브 산출물 저장소 (검증 브랜치)

## 범위
`scripts/artifacts/local-artifact-store.mjs`은 검증된 로컬 파일을 앱/작업별 격리 디렉터리에 저장하는 **내부 구현 모듈**입니다. 아직 Flora 웹 API, DB, Runner, 외부 Provider, 사용자별 인증 시스템에 연결하지 않았습니다. HTTP 다운로드/공유 URL, 서명 검증, 기기 설치도 수행하지 않습니다.

### API
- `publishLocalArtifact({root,sourcePath,manifest,authorizedJob})`: 기존 SHA-256 및 작업 scope 검증 후 지정 private root에 스트리밍 복사, 해시 재검증, 디스크 동기화와 임시 파일 rename; 반환 receipt는 `storage:"local-only"`, `artifactId`, `filePath` 포함
- `resolveLocalArtifact({root,receipt,authorizedJob})`: 별도로 인가받은 작업 범위와 저장된 파일 해시가 맞는지 확인. **파일을 클라이언트에 스트리밍하지 않습니다.**

`authorizedJob`은 반드시 인증된 요청자와 DB의 불변 작업 기록으로부터 얻어야 합니다. 업로드 manifest, receipt 또는 요청 본문의 임의 ID를 그대로 작업 인가 근거로 사용하지 마세요.

### 보호 환경
- `root`는 Runner 운영자만 쓸 수 있는 **전용 로컬 디렉터리**여야 합니다. 같은 호스트의 공격자가 디렉터리나 부모 경로를 수정할 수 있다면 안전한 파일 접근을 보장하지 않습니다.
- sourcePath 역시 전용 Runner 작업 폴더에서 관리해야 하며, 미신뢰 사용자가 수정할 수 없어야 합니다.
- 파일은 임시 이름으로 기록되고 digest가 맞을 때만 rename됩니다. 외부로 공개하는 시점에는 DB 트랜잭션·영속 receipt 등록·권한 검사·재검증을 추가해야 합니다.
- 반환값에 로컬 절대경로가 있으므로 API 응답이나 로그에 그대로 직렬화하지 마세요.
- 서명·설치·OTA 적용은 항상 `false` 또는 미검증으로 유지합니다.

### 반드시 추가할 부분
- [ ] Runner에서 안전한 출처의 `authorizedJob` 조회 및 연결
- [ ] 로컬 저장소 전용 소유자/권한 검증, root·상위 디렉터리 symlink 방어, 경합 차단
- [ ] 저장 원장 및 복구·GC 정책 (실패한 임시 파일 처리 포함)
- [ ] 사용자별 인가 및 1회성 다운로드 토큰/API 스트림
- [ ] 플랫폼별 서명 확인, 실제 앱 설치, OTA 롤백 시험
- [ ] 외부 Provider 및 BYOC R2/S3는 별도 동의·자격 증명 저장을 갖춘 뒤 구현

현재 운영 Cloudflare Worker/D1/OTA에는 변경을 배포하지 않았습니다.
