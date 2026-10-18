# 설치 마법사 검증 기록 — 2026-10-18

승인된 설계와 구현 계획에 따라 독립 브랜치에서 구현 중입니다. 기존 UULab 운영 앱·키·DB·서비스를 새 설치로 교체하지 않습니다. 이 기록은 현재 단계의 증거이며 원격 설치 완료를 뜻하지 않습니다.

## 확인한 범위

- 로컬 private journal: 소유권·0700/0600·symlink/hardlink·동시 실행·원자 교체 검증.
- CLI 시작/취소/허용 argv/실제 PTY 숨김 입력과 복원 검증.
- Cloudflare adapter: 고정 Wrangler 인자·리소스 충돌·계정/도메인·설정 drift·응답 유실 시 중복 생성 방지. 합성 HOME의 고정 Wrangler `auth token --json` 실행에서 디스크 로그 비활성 확인. 실제 사용자 인증값으로 원격 배포한 증거와 구분.
- 최초 등록: HTTPS 확인 전 승인 코드 발급 금지, 32-byte 난수·10분·generation 1, 원장 pending 우선 기록, 불명확한 요청 재전송 금지, 등록 확인 후 FLORA_SETUP만 제거.
- Runner: 두 앱의 새 private 경로·token prefix·SDK origin/app 일치, 로컬 Unix 소켓·이미지 버전·2GiB 확인, fingerprint 재검증, 기존 키·복구 journal·fatal-stop 보존. supervisor/health 보조 테스트 68건 통과.
- 웹: private `/onboarding`, 세션·앱 전환 시 응답 fence, GitHub 응답 유실 시 조회 확인, 공개 SDK·Runner 파일, 모든 선택 플랫폼 게시 확인, 별도 중복 poller 없음.
- 실제 local workerd/D1/auth/signing/HTTP/controller: 서로 다른 두 fixture 저장소/root 앱, 다른 서명 키·단일 앱 Runner, iOS/Android 4개 배포 조회·서명/전체 자산 다운로드. 소스·export·작업 완료는 명시적인 fixture이며 실제 GitHub/Docker 완료로 표시하지 않음.
- 오래된 배포의 point 조회는 24개 최신 배포가 더 생겨도 4 queries / 7 rows read / 0 writes로 동일. SDK 집계나 과거 이력을 쓰지 않음.
- 별도 공개 다운로드 QA 도구는 raw manifest RSA-SHA256/expected key ID와 모든 자산 SHA-256을 검증. unsigned·다른 앱/키·손상·과대 응답을 거절하며 코드를 실행하거나 기기 적용 완료로 표시하지 않음.

## 새 clone와 원격 검증

후보 commit의 실제 새 clone·빈 HOME/cache/store 설치·전체 검사·SDK pack·CLI smoke·원본 보존 확인은 아직 진행 중입니다. 최종 결과로 갱신합니다.

현재 `gh auth status`는 기존 bonjin-app 인증이 유효하지 않다고 보고했습니다. 새 QA GitHub 저장소 생성·설치는 실제 본인 인증과 권한 확인이 필요합니다. 기존 Flora GitHub App 키를 새 QA 서버로 복사하거나 기존 앱으로 대신 완료 처리하지 않습니다. 새 Worker/D1/hostname 무료 여유·DNS/TLS, 새 소유자 HTTPS 등록, 실제 signed webhook → PC Docker export → 4개 원격 게시·다운로드·화면 확인은 아직 미완료입니다.

새 바이너리를 설치·실행하지 않은 경우 다운로드 검증을 OTA 적용·재시작이나 실제 사용자 채택률로 해석하지 않습니다. EAS·GitHub Actions workflow는 이 구현에서 추가하거나 실행하지 않습니다. QA 리소스를 자동 삭제하거나 기존 데이터를 초기화하지 않습니다.

## 재현 명령

고정 Node 24.19.0으로 build 후 실행합니다.

```sh
npm exec --yes --package=pnpm@11.19.0 -- pnpm check
node --test scripts/local-runner/health.test.mjs scripts/local-runner/supervisor.test.mjs
node scripts/onboarding-download-qa.mjs --connection /ABSOLUTE/PUBLIC/flora.connection.json --target /ABSOLUTE/PUBLIC/target.json --out /ABSOLUTE/NEW/download-receipts
node scripts/onboarding-qa.mjs --record /ABSOLUTE/PUBLIC/receipts.json --out /ABSOLUTE/NEW/public-evidence
```

다운로드 target은 `{appId,commitSha,channel,runtimeVersion,platforms,deployments:{ios:deploymentId,android:deploymentId}}`이며 선택한 플랫폼만 포함합니다. 공개 설정의 expected certificate/keyId를 사용하며 쿠키·토큰·개인키·비밀번호 입력 인자를 지원하지 않습니다. manifest 1MiB, 자산 각각 16MiB, 최대 65개, 플랫폼당 총 64MiB, 요청 20초, 동일 origin·redirect 거절로 제한합니다. 한도 초과는 미완료이며 자산을 생략해 통과 처리하지 않습니다. 대상을 읽기 전용으로 재확인하며 실패 후 자동 재게시하지 않습니다.
