# 로컬 Foundation 실행

[처음 실행하기](../getting-started.ko.md) · [English quick start](../../README.en.md#try-the-local-foundation)

처음 받았다면 시작 가이드의 준비·예상 결과·문제 해결 순서를 따릅니다. 이 문서는 CLI와 데이터·보안 계약을 더 자세히 설명하는 reference입니다.

Foundation 0A는 실제 TypeScript·SQLite·CLI 구현이다. 아래 흐름에는 계정, secret 값, native compiler 또는 Cloudflare 계정이 필요하지 않다. 생성되는 artifact는 작은 synthetic JSON의 metadata이며 실제 앱 binary가 아니다.

## 준비와 설치

검증 기준 버전은 Node.js 24.19.0 / pnpm 11.19.0이다. Node는 [해당 버전의 공식 설치 경로](https://nodejs.org/en/download/archive/v24.19.0)를 사용하고 `.node-version` / `.nvmrc`와 맞춘다. Git과 Node에 포함된 npm이 필요하다. 기존 pnpm이 없으면 global 설치 없이 npm exec를 사용할 수 있다.

```sh
git clone https://github.com/uulab-official/flora.git
cd flora
npm exec --yes --package=pnpm@11.19.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
```

이후 예시의 `pnpm`이 PATH에 없다면 동일한 `npm exec --yes --package=pnpm@11.19.0 -- pnpm` 접두어를 쓴다. Windows에서 `npm.ps1`이 차단되면 `npm.cmd`를 사용한다. Corepack이나 이미 설치된 정확한 버전의 pnpm도 사용할 수 있다. lifecycle install script는 필요하지 않다. 실제 credential을 `.env`에 넣거나 로그인할 필요가 없다. CLI 전에 `check`로 source를 build한다. `verify:clean`은 Git의 추적 파일 목록을 사용하므로 ZIP이 아닌 Git clone에서 실행한다.

## 명령

```sh
pnpm platform doctor --json
pnpm platform config validate --file examples/local-workflow.json
pnpm platform job simulate --file examples/local-workflow.json --scenario happy-path
pnpm platform job simulate --file examples/local-workflow.json --scenario runner-replacement
pnpm platform job simulate --file examples/local-workflow.json --scenario unsafe-expiry
pnpm verify:clean
```

- doctor: OS/architecture/Node/pnpm 및 Xcode·Java·Git 진단. 종료 코드 0이어도 모든 도구가 준비되었다는 뜻은 아니다. 미설치 도구를 설치하거나 라이선스에 동의하지 않는다. Xcode/Java는 이 로컬 체험의 필수 조건이 아니며 `nativeBuildVerified`는 false다
- config validate: source/target/scope 검사, 결정적인 SHA-256 snapshot ID. 값 대신 key와 버전 참조만 출력한다
- happy-path: 실제 로컬 SQLite에 Job/lease/attempt/synthetic artifact/Release timeline을 연결한다
- runner-replacement: A의 lease 만료, B의 새 fence, A의 오래된 완료 거부를 검증한다. 거부 결과는 `rejectedOperations`에 표시한다. 실패한 transaction의 audit를 성공 event처럼 저장하지 않는다
- unsafe-expiry: Store action 상태를 모의 실행하다 만료시키고 `waiting/reconciliation_required`로 둔다. Store API는 호출하지 않는다
- verify:clean: Git에 추적된 파일만 별도 임시 디렉터리에 복사하고 빈 pnpm store에서 frozen install·전체 검사·CLI smoke를 수행한다. source와 lockfile 변동을 별도 hash로 확인한다

`flora`와 `platform`은 같은 CLI bin을 가리킨다. `pnpm flora`도 `pnpm platform`과 같은 동작이다. UI 표시 이름 변경은 저장소·ID·schema를 변경하지 않는다. 아직 UI는 없다.

## 입력과 보안 경계

`examples/local-workflow.json`은 catalog/target/source/configEntries/releaseVersion을 포함한다. Project와 Repository는 별개이며 flavor/environment/platform은 독립 축이다. 우선순위는 organization → project → application → flavor → environment → platform → exact target이다. exact target은 app/flavor/environment/platform을 모두 지정해야 한다. 같은 우선순위 중복 키와 kind 변경은 거부한다.

CONFIG는 공개 값이다. 서버 비밀값을 CONFIG로 분류하지 않는다. SECRET/FILE/CREDENTIAL에는 resourceId/versionId만 허용하며 raw value는 거부한다. 이것은 Vault 구현이나 credential 저장 기능이 아니다.

CLI는 최대 1MiB의 정상 UTF-8 JSON 파일만 읽는다. unknown field, prototype key, custom prototype, 불완전한 scope, 다른 조직 참조를 거부한다. 실패 시 원문 payload/SQL/credential을 출력하지 않는다.

각 simulation은 별도 임시 SQLite DB를 생성하고 종료 시 닫아 제거한다. 기존 DB를 덮어쓰는 옵션은 없다. 예시의 Runner는 시뮬레이션 주체이며 실제 PC에 등록된 Runner가 아니다. 사용자 PC에 포트를 열지 않는다.

## 실행권과 영속성

Job claim/cancel/complete는 SQLite transaction과 조건부 상태 변경으로 실행한다. Job/Release/Snapshot의 source 및 target과 artifact digest가 일치해야 한다. 만료된 실행권은 heartbeat로 되살릴 수 없고 새 attempt는 증가한 fence를 가진다. 위험 action은 자동 재실행하지 않는다.

SQL FK·trigger와 모든 adapter connection의 `recursive_triggers=ON`으로 일반 UPDATE/DELETE/REPLACE 경로에서 immutable provenance와 terminal attempts를 보호한다. DB administrator가 PRAGMA/trigger를 변경할 수 없다는 의미는 아니다. 이 라이브러리는 인터넷 인증·RBAC boundary가 아니다. operator authorization context는 신뢰된 호출자가 제공하는 내부 계약이다.

[Node 24.19.0 SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)는 release-candidate API다. 현재는 로컬 reference adapter이며 Cloudflare D1 운영 검증을 대체하지 않는다. polling/Queue/Vault/로그 전송/실제 Runner daemon은 후속 단계다.

## 검증 범위

- Linux 클라우드에서 strict build/typecheck, unit/integration/real Worker-thread race/CLI tests를 실행한다
- CI는 ubuntu/windows/macos 세 OS에서 같은 검사를 수행하도록 구성한다. workflow 존재만으로 해당 OS 성공을 주장하지 않으며 [실제 실행 결과](https://github.com/uulab-official/flora/actions)를 확인한다
- native iOS/Android compile, TestFlight/Play upload, Expo OTA, Cloudflare 배포는 이번 검사 대상이 아니다
- 자체 build farm, public dev API, OAuth grant, real credential은 만들지 않는다

## 의존성과 라이선스

프로젝트는 Apache-2.0이다. 외부 runtime dependency 없이 Node API와 workspace 모듈만 사용한다. development dependencies는 TypeScript(Apache-2.0), @types/node(MIT), 해당 타입의 undici-types(MIT)이며 lockfile로 고정한다. 각 패키지에 포함된 LICENSE를 보존한다. dependency audit 결과는 조회 시점의 알려진 취약점 검사이지 보안 인증이 아니다.
