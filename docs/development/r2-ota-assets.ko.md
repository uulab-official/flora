# OTA 바이너리 저장소를 private R2로 분리

> UULab은 R2 구독 활성화를 보류했다. 현재 진행하는 대안은 [구독 없는 GitHub Release 저장소](github-release-ota-storage.ko.md)다. 미배포 R2 전용 0013은 공통 `0013_external_ota_assets.sql`로 일반화했으며, 아래 R2 연결 방식은 선택 사항이다.

## 데이터 보존과 연결 방식

새 OTA 바이너리는 `FLORA_OTA_ASSETS` Worker binding을 통해 private R2에 저장한다. D1에는 앱·배포·이력과 바이너리의 완성 증명만 남긴다. 기존 D1 바이너리와 청크는 옮기거나 지우지 않으며, 기존 다운로드 URL과 SDK의 공개 인증서도 유지한다.

버킷은 전용 **Standard** 저장소로 만든다. `r2.dev`, 공개 사용자 도메인, S3 키는 필요하지 않다. 기존 Worker 배포 설정의 모든 binding·변수·secret을 보존하고 다음 항목만 추가한다.

```json
{
  "r2_buckets": [
    {
      "binding": "FLORA_OTA_ASSETS",
      "bucket_name": "flora-uulab-ota-assets"
    }
  ]
}
```

실제 배포 설정은 저장소에 비밀을 추가하지 않고 기존 설정에서 생성한다. 기존 D1 및 AuthDO의 ID와 배포 origin을 바꾸지 않는다. `0013_external_ota_assets.sql`은 기존 배포의 0001–0012 적용 여부를 확인한 뒤 전체 파일을 하나의 D1 batch로 적용한다. 기존 환경에서 전체 migration을 다시 실행하지 않는다.

R2를 사용한 새 배포가 생기면 R2를 모르는 예전 Worker로 되돌리지 않는다. 새 배포를 읽을 수 있는 R2 지원 버전으로 수정하거나 롤백해야 한다. 기존 앱의 OTA 배포 롤백 기능은 해당 바이너리를 삭제하지 않는다.

## 무료 범위 보호

[Cloudflare R2 Standard 무료 범위](https://developers.cloudflare.com/r2/pricing/)는 월 10 GB-month, Class A 100만 회, Class B 1,000만 회이며 인터넷 전송 비용은 없다. Infrequent Access에는 같은 무료 범위가 적용되지 않는다. 최초 R2 활성화가 필요한 계정은 대시보드의 구독 절차를 먼저 완료해야 한다.

Flora는 기존 소유자 AuthDO에서 호출 전에 예산을 예약한다.

| 항목 | Flora 상한 |
| --- | ---: |
| 저장·예약된 바이너리 | 8 GiB |
| 객체 예약 수 | 4,096 |
| Class A 호출 | UTC 월 100,000회 |
| Class B 호출 | UTC 월 1,000,000회 |

실패한 호출과 재시도도 예산을 사용한다. 업로드 응답이 유실되면 객체가 생겼을 가능성이 있으므로 저장 예약을 돌려주지 않는다. 재시작 시에도 예약은 유지하며, 상한에 도달하면 새 호출을 거절한다. 월별 호출 예산이 초기화되어도 저장 예약은 유지한다. 자동 삭제나 유료 상향은 수행하지 않는다.

이 보호는 **Flora가 해당 binding으로 실행하는 호출**에 적용된다. 콘솔·S3·다른 Worker나 다른 버킷의 사용량까지 계정 전체 과금을 차단하는 기능은 아니다. 별도 사용자가 객체를 쓰거나 지우면 Flora의 보수적 예약과 실제 사용량이 달라질 수 있다.

검증된 공개 immutable 다운로드만 Worker Cache API에 저장한다. 앱과 자산 digest를 포함한 키로 분리하며, manifest·오류·인증 또는 쿠키가 있는 요청은 캐시하지 않는다. 캐시 장애 시에도 저장소 검증과 예산 제한을 거친다. 조회를 위한 새 폴링은 추가하지 않는다.

## 배포 전후 검증

1. 기존 소유자·DB·DO·binding과 복구 저널을 기록하고, 배포·작업·전이·청크 및 앱 설정의 기준 데이터를 보관한다.
2. Runner에 실행 중인 작업이 없는 시점에 새 작업 수신을 잠깐 멈추고, D1 복구 bookmark를 확보한다.
3. 추가 migration과 R2 지원 Worker를 적용한다. 기존 iOS·Android manifest 서명과 D1 자산 다운로드를 먼저 확인한다.
4. Runner를 재개하고 기존 검증 브랜치에 실제 GitHub 커밋을 생성한다. Actions와 EAS를 실행하지 않는다.
5. Isso·Promise·Reward의 iOS·Android 작업 6개가 자동 완료되는지 확인한다. 각 manifest의 앱·플랫폼·커밋과 RSA 서명, 실제 다운로드한 바이너리의 SHA-256을 검증한다.
6. 새 바이너리의 R2 증명과 앱별 분리, D1 바이너리 청크 증가 0개를 확인한다. 기존 원시 이력·청크·앱 설정·키 메타데이터를 기준 데이터와 비교한다.

로컬 workerd/Miniflare 검증, 실제 Cloudflare 배포, GitHub 자동 작업, 다운로드 검증은 별도 증거다. 다운로드 성공만으로 실기기 적용·재시작 성공을 보고하지 않는다. 실제 실행 결과는 별도 날짜별 보고서에 기록한다.
