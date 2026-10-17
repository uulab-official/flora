# 멀티앱 Foundation

한 개인 작업실의 로컬 SQLite 또는 hosted D1에서 여러 앱을 등록하고 선택할 수 있습니다. 앱 identity는 저장소 ID와 루트 디렉터리의 조합입니다. 같은 저장소의 다른 루트도 다른 앱으로 등록합니다. Flavor는 해당 앱의 하위 선언이며 독립 앱 registry와 구분합니다.

화면의 **등록한 앱**에서 선택하면 해당 앱의 revision, HEAD 관측, baseline, 실행 요청과 공개 CONFIG만 표시합니다. 소스 JSON 반입은 일치하는 registry를 자동 생성합니다. 별도 **앱 등록**으로 소스가 없는 앱도 먼저 등록할 수 있습니다. 저장소 ID는 반입 JSON의 `repository.id`와 같아야 합니다. 저장소 URL의 자동 연결·범용 Expo 탐지는 후속 단계이며 [현재 source/profile 형식](dogfood.ko.md#3-자신의-자료-가져오기)은 유지합니다.

## 기존 데이터 보존

로컬은 기존 checksum을 가진 `0001_foundation.sql`과 `0002_dogfood.sql`을 변경하지 않고 `0003_multi_app.sql`을 추가합니다. CLI를 실행하면 기존 migration 검사 후 새 migration을 transaction 안에서 적용합니다. 기존 snapshot JSON/ID/digest, baseline evidence/receipt, HEAD, 실행 attempt와 터미널 상태는 그대로 유지하고 registry·기본 공개 설정 version 0을 연결합니다. 기존 실행 요청 키는 원문을 유지하는 앱별 mapping으로 연결합니다.

Hosted에는 `0002_multi_app.sql`을 추가합니다. 기존 원격 DB에 새 migration을 적용하는 작업과 변경 Worker 배포는 별도 운영 단계입니다. 이 구현 작업에서는 원격 DB나 운영 배포를 변경하지 않습니다. 기존 row·receipt·용량 counter는 유지하고, migration이 파생한 registry/default settings는 payload charge 0입니다. 새 registry·설정 버전은 원래의 128 MiB payload 예산에 실제 canonical bytes를 추가합니다. 앱은 최대 100개이며 source 100개/baseline 500개 한도는 전체 작업실의 합계입니다. 기존 데이터가 한도에 도달해도 이전 자료 읽기와 동일 receipt 재조회는 유지됩니다.

소스 자동 등록·초기 설정·snapshot 저장은 같은 transaction/batch입니다. 저장이 실패하면 자동 registry도 남지 않습니다. 기존 DB를 지우거나 새 DB로 바꾸는 절차가 아닙니다. 운영 DB는 별도 백업·적용 검토 후 migration을 진행합니다.

후속 구현인 [GitHub 연결·Expo/RN 인식·OTA](github-ota.ko.md)는 이 registry에 앱별 연결과 배포 이력을 추가합니다. 아래 고정 JSON 반입 형식과 별도 경로이며 기존 반입 증거의 출처는 유지합니다.

## 공개 CONFIG와 CLI

공개 설정은 앱별로 저장하고 변경마다 append-only 버전을 남깁니다. 편집 화면이 읽은 `expectedVersion`과 현재 버전이 다르면 conflict로 거절합니다. 다른 앱의 설정은 바뀌지 않습니다. 현재 공개 CONFIG는 저장·조회용이며 build/OTA/runtime에 자동 적용되지 않습니다. 비밀번호·토큰·인증서 원문은 이 편집기에 넣지 않습니다.

입력 제한: 최대 64개 대문자 키(`A–Z`, 숫자, `_`, 첫 글자는 영문), 값은 문자열 최대 2,048자, 전체 canonical JSON은 8 KiB입니다. Credential/Vault 참조와 조직 RBAC는 후속 범위입니다.

등록 파일:

```json
{"name":"My app","repositoryId":"repository-id","rootDirectory":"."}
```

설정 파일:

```json
{"expectedVersion":0,"values":{"APP_LABEL":"My app","ENVIRONMENT":"staging"}}
```

```sh
pnpm flora dogfood register-app --file registration.json
pnpm flora dogfood settings --app APP_ID --file settings.json
pnpm flora dogfood status --app APP_ID --json
pnpm flora dogfood import-source --app APP_ID --file source.json
pnpm flora dogfood import-baseline --app APP_ID --snapshot INVENTORY_ID --file baseline.json
```

`APP_ID`와 `INVENTORY_ID`는 실제 응답 ID로 바꿉니다. 기존 `--db` 선택은 그대로 지원합니다. `--app` 없는 source import도 앱을 자동 등록하며 응답에 `appId`를 반환합니다.

## API와 분리 검증

- `GET/POST /api/apps`: `{id,name,createdAt}` 선택용 registry 조회와 `{name,repositoryId,rootDirectory}` 등록. 전체 저장소 ID·루트는 선택한 앱의 `selectedApplication`에 보존해 반환하며, 긴 identity를 가진 앱 100개도 목록 응답을 초과시키지 않는다.
- `POST /api/apps/APP_ID/settings`: `{expectedVersion,values}` 설정 변경.
- `GET /api/state?appId=APP_ID`: 해당 앱의 상태·설정·revision·이력.
- Source/baseline/HEAD, 로컬 run/cancel, hosted log 조회에 `appId`를 함께 지정하면 참조한 snapshot/record가 해당 앱에 속하는지 검사합니다. 일치하지 않으면 404입니다.
- `snapshotId`는 앱에 속하는 정확한 revision을 선택합니다. Hosted cursor도 앱과 snapshot에 묶이며 다른 앱에서 재사용할 수 없습니다. 앱을 바꾸면 브라우저가 cursor를 초기화하고 이전 응답을 폐기합니다.

모든 API는 기존 세션·Origin·CSRF와 mutation fence를 유지합니다. 단일 소유자가 모든 등록 앱에 접근하는 현재 모델이며, 앱별 조직 사용자 권한을 구현했다는 뜻은 아닙니다.

회귀 테스트는 서로 다른 저장소 두 개의 등록·설정·이력·로그 분리, 같은 저장소의 다른 루트, 앱마다 동일 request key, 잘못된 교차 참조·stale 설정 거절, 기존 v1/v2 SQLite와 v1 D1의 원본 행 보존, 실패한 자동 등록의 atomic rollback을 확인합니다. 전체 검사는 `pnpm check`입니다. 실제 provider 연결/native build·스토어·OTA 배포는 별도 검증 대상입니다.
