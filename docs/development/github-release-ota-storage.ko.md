# 구독 없는 GitHub Release OTA 저장소

Flora의 PC Runner가 빌드하고, 비공개 GitHub Release에 새 바이너리를 보관한다. Flora는 기존 GitHub App의 Contents 읽기 권한으로 파일을 검증해 기존 OTA URL에서 제공한다. R2 구독, EAS, Actions 실행, PC 공개 포트와 Tunnel은 사용하지 않는다.

## 선택 이유와 제한

[GitHub 공식 문서](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)는 Release당 1,000개 자산, 파일당 2GiB 미만을 허용하며 Release 전체 크기와 대역폭에 별도 한도를 두지 않는다. Flora의 파일 제한은 계속 16MiB다. 별도 저장소 구독을 추가하지 않지만 [GitHub API의 기본·보조 요청 제한](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)은 적용된다. 요청 제한에 걸리면 새 작업을 무한 재시도하지 않고 보수적으로 대기하거나 실패시킨다.

PC 디스크를 공개 Tunnel로 제공하는 대안도 검토했다. [공개 Tunnel 문서](https://developers.cloudflare.com/tunnel/concepts/routing/)가 대용량 파일에 별도 유료 서비스를 요구하므로 기본 대안으로 채택하지 않았다. 현재 방식은 [Developer Platform](https://www.cloudflare.com/service-specific-terms-developer-platform/)의 Worker와 Cache API를 사용한다. Cloudflare의 기존 무료 요청·D1 한도도 유지된다.

빌드·신규 업로드에는 PC가 필요하다. GitHub에 확정된 파일의 다운로드는 PC가 꺼져도 가능하다. PC의 private 캐시는 업로드 복구용이며 외부에 공개하지 않는다. 새 캐시는 앱별로 분리하고 저장 공간·권한을 확인하며 기존 파일을 자동 삭제하지 않는다.

## 설정

전용 저장소 `uulab-official/flora-ota-assets`는 **비공개**, **Actions 비활성**, workflow 없음으로 운영한다. 앱 원본 저장소에는 자산용 tag·Release를 만들지 않는다. 설치 ID `170528052`의 기존 모든 저장소 읽기 범위에서 새 저장소 접근을 확인했다. App 쓰기 권한이나 새 PAT를 발급하지 않는다.

Worker 설정 예시:

```json
{
  "FLORA_OTA_ASSET_STORAGE": "github-releases",
  "FLORA_OTA_ASSET_REPOSITORY": "uulab-official/flora-ota-assets",
  "FLORA_OTA_ASSET_INSTALLATION_ID": "170528052",
  "FLORA_OTA_ASSET_REPOSITORY_ID": "1422798122"
}
```

기존 Worker·D1·AuthDO·origin·key·변수·secret을 보존한다. R2 binding을 추가하지 않는다. 호스트 Runner에는 선택적인 `assetStorage` 설정을 추가한다. `ghPath`는 호스트에 이미 인증된 공식 GitHub CLI, `cacheDirectory`는 별도의 0700 private 경로다. 인증 정보는 Runner 설정에 복사하거나 Docker에 전달하지 않는다.

## 저장과 검증

1. 기존 자산은 재사용한다. 새 digest에만 서버가 정확한 `428 ASSET_STORAGE_REFERENCE_REQUIRED`를 반환한다.
2. 호스트가 현재 작업·임대·바이트를 고정하고 결정적인 tag의 draft Release를 만든다. 파일 하나를 업로드한 뒤 prerelease로 게시한다. 업로드 결과가 불명확하면 같은 자원을 읽어 확인하며 덮어쓰기·삭제는 하지 않는다.
3. Runner는 기존 바이너리 요청과 제한된 Release/asset ID 참조를 다시 보낸다. 서버는 현재 권한·임대, 전용 저장소 ID, Release 본문·tag·자산 소속과 실제 다운로드 SHA256을 독립적으로 확인한다.
4. 검증된 proof·자산 메타데이터·작업 참조만 하나의 D1 transaction으로 기록한다. 임대 만료·취소·검증 실패 시 배포에 연결하지 않는다. 설정이 빠져도 D1 바이너리 저장으로 자동 복귀하지 않는다.
5. 다운로드는 당시 저장소·설치·Release·자산 위치를 사용한다. 앱 소스 저장소 연결을 바꿔도 과거 파일 위치는 바뀌지 않는다. SDK에는 GitHub 인증이나 임시 CDN 주소가 노출되지 않는다.

새 스키마는 `0013_external_ota_assets.sql`이다. 이전 R2 전용 0013은 운영에 적용하지 않았으며, 미배포 파일을 공통 proof 스키마로 일반화했다. 기존 0001–0012의 모든 데이터·청크·이력과 용량 계산은 보존한다. 기존 D1 URL은 그대로 읽을 수 있다. 바이너리만 외부로 분리하며 D1의 메타데이터·이력 용량 제한까지 없애는 것은 아니다.

## 용량과 호출 보호

GitHub 검증기는 읽기·설치 토큰 요청을 시간당 최대 3,000회로 제한하며, 32회 단위로 예산을 먼저 차감한다. 실패한 요청도 소비량에 포함하고 403·429 대기는 재시작 후에도 유지한다. 새로 추가한 상태 조회용 주기적 폴링은 없다. 기존 edge cache는 검증된 공개 OTA 응답만 재사용한다.

D1에는 최대 4,096개, 행당 최대 2,048바이트의 불변 외부 자산 proof를 추가한다. 기존 18개 테이블 용량 계산과 384MiB 제한은 유지한다. 이 한도는 GitHub 파일 전체 용량을 예약하는 장치가 아니다. 선택적 R2 어댑터의 8GiB 예약과 구분한다.

PC 업로드 복구 캐시는 앱별 20GiB와 디스크 여유 2GiB를 확인한다. 게시 실패 뒤 남은 원격 파일·로컬 저널은 보존하며 자동 삭제하지 않는다. 파일 하나당 Release 하나를 사용하고, 각 쓰기 사이에 최소 1,050ms를 둔다. 호스트 호출 제한도 디스크에 기록한다. 이 보호 장치가 GitHub 계정 전체의 API 제한을 보장하거나 모든 무료 서비스 장애를 없애지는 않는다.

실제 연결·배포·다운로드 결과는 [2026-10-17 운영 검증 기록](./github-release-ota-storage-2026-10-17.ko.md)을 확인한다. 로컬 fixture 통과와 실제 GitHub 커밋 자동 배포, 실제 다운로드는 각각 별도의 증거로 기록한다.

설치된 Isso·Promise·Reward의 iOS Simulator·Android Emulator에서 다운로드·적용·재시작과 Flora 상세 화면까지 확인한 후속 결과는 [네이티브 적용 검증 기록](./github-release-ota-native-2026-10-17.ko.md)에 있다.
