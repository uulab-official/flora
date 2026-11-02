const $ = id => document.getElementById(id);
const names = { unconfigured: '미승인', authorized: '승인됨', queued: '대기', running: '실행 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', unknown: '결과 불명' };
const state = { csrf: null, app: null, jobs: [], selected: null, epoch: 0, detailEpoch: 0, cursors: [''], next: null, historyNext: null, busy: false, overview: null, presets: [], executionEnabled: false, intent: null, detailSignature: null, diagnosticEpoch: 0, diagnostic: null };
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').dataset.error = String(error); $('notice').hidden = !text; }
function reset() {
  clearPreflight();
  clearDiagnostic();
  state.epoch++; state.detailEpoch++; state.csrf = null; state.app = null; state.jobs = []; state.selected = null; state.overview = null; state.presets = []; state.intent = null; state.executionEnabled = false; state.detailSignature = null;
  $('console-panel').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('job-rows').replaceChildren(); $('artifact-list').replaceChildren(); $('history-list').replaceChildren(); $('job-facts').replaceChildren();
  $('detail-content').hidden = true; $('detail-empty').hidden = false; $('approval-code').value = '';
  for (const id of ['create-dialog', 'run-dialog', 'retry-dialog']) if ($(id).open) $(id).close();
  for (const id of ['count-all', 'count-active', 'count-success', 'count-attention']) $(id).textContent = '0';
  $('build-activity').replaceChildren(); $('build-activity').hidden = true;
  $('execution-status').textContent = ''; $('runner-mode').textContent = '실행 설정 확인 중';
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.csrf ? { 'x-flora-csrf': state.csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !(path === '/api/session' && method === 'POST')) reset();
    const error = new Error(result.error ?? 'BUILD_REQUEST_FAILED'); error.status = response.status; throw error;
  }
  return result;
}
function explain(error) {
  const labels = { ARTIFACT_SIGNATURE_SIGNER_MISMATCH: '서명 인증서가 운영자가 등록한 업로드 인증서와 다릅니다. 산출물 등록을 차단했습니다.',
    ARTIFACT_SIGNATURE_UNSIGNED: '서명되지 않은 파일이 포함되어 산출물 등록을 차단했습니다.',
    ARTIFACT_SIGNATURE_CERTIFICATE_INVALID: '서명 인증서의 유효 기간 또는 키 용도를 확인하세요.',
    ARTIFACT_SIGNATURE_INVALID: 'AAB 서명 무결성이 일치하지 않습니다.',
    ARTIFACT_SIGNATURE_LAYOUT_INVALID: 'AAB ZIP 구조가 예상과 다르거나 서명된 파일이 누락되었습니다.',
    ARTIFACT_SIGNATURE_TIMEOUT: '서명 검사 시간 한도에 도달했습니다. 등록하지 않았습니다.',
    ARTIFACT_SIGNATURE_TOOL_UNAVAILABLE: '설정한 JDK 서명 검사 도구를 사용할 수 없습니다.',
    BUILD_VERSION_CONFLICT: '다른 작업으로 상태가 변경되었습니다. 새로고침 후 다시 확인하세요.',
    BUILD_APPROVAL_INVALID: '승인 코드가 잘못되었거나 만료·사용되었습니다. 콘솔을 재시작해 새 코드를 받으세요.',
    BUILD_SESSION_EXPIRED: '세션이 만료되었습니다. 콘솔을 재시작해 다시 연결하세요.',
    BUILD_SESSION_REQUIRED: '로컬 콘솔 연결이 필요합니다.', BUILD_RUNNING_CANCEL_REQUIRES_RUNNER: '실행 중인 작업은 Runner에서 중지해야 합니다.',
    BUILD_DIAGNOSTIC_LIMIT: '진단이 실행 중이거나 방금 완료되었습니다. 잠시 뒤 다시 검사하세요.',
    BUILD_EXECUTABLE_UNAVAILABLE: '등록된 실행 파일이 없거나 실행 권한이 없습니다. PC에서 도구 설치와 권한을 확인하세요.',
    BUILD_PREFLIGHT_LIMIT: '점검 중이거나 방금 점검했습니다. 잠시 뒤 다시 요청하세요.',
    BUILD_PREFLIGHT_STATE_CHANGED: '점검 중 작업이 바뀌었습니다. 작업을 다시 열어 확인하세요.',
    BUILD_RUNNER_LOCKED: '같은 체크아웃의 실행 잠금이 남아 있습니다. 기존 Runner를 확인하고 임의로 삭제하지 마세요.',
    BUILD_EXECUTION_DISABLED: '이 콘솔은 실행이 비활성화되어 있습니다. PC에서 사전 등록한 설정을 허용해 시작하세요.',
    BUILD_EXECUTION_LIMIT: '동시 실행 한도에 도달했습니다. 현재 작업이 끝난 뒤 다시 요청하세요.',
    BUILD_EXECUTION_ACTIVE: '이미 시작 요청을 처리 중입니다. 상태를 확인하세요.',
    BUILD_PRESET_NOT_FOUND: '등록된 빌드 설정을 찾지 못했습니다.',
    BUILD_SOURCE_DIRTY: '작업 폴더에 커밋되지 않은 변경이 있습니다. 변경을 보존·정리한 뒤 다시 확인하세요.',
    BUILD_SOURCE_SHA_MISMATCH: 'PC의 체크아웃 커밋이 작업에 등록한 SHA와 다릅니다.',
    BUILD_OUTPUT_PATH_UNSAFE: '출력 폴더가 링크이거나 안전하게 확인되지 않습니다. PC에서 출력 경로를 확인하세요.',
    BUILD_OUTPUT_EXISTS: '이전 출력 파일이 남아 있습니다. 필요한 파일을 보존한 뒤 PC에서 별도로 정리하세요.',
    BUILD_RUNNER_NOT_MANAGED: '이 콘솔이 실행한 작업이 아닙니다. 해당 Runner에서 중지하세요.',
    BUILD_RETRY_DENIED: '실패 또는 취소가 확인된 작업만 새 작업으로 만들 수 있습니다.',
    BUILD_RESULT_RECONCILIATION_REQUIRED: '실행 결과 확인이 필요합니다. 자동으로 다시 실행하지 말고 원장과 Runner 출력을 확인하세요.',
    BUILD_JOB_ALREADY_EXISTS: '같은 앱에 이 작업 ID가 이미 있습니다.', ARTIFACT_HASH_MISMATCH: '파일 무결성이 맞지 않아 다운로드를 차단했습니다.' };
  return labels[error.message] ?? '요청을 완료하지 못했습니다. ' + error.message;
}
async function attempt(fn) { try { await fn(); } catch (error) { notice(explain(error), true); } }
function badge(status) { const b = node('span', names[status] ?? status, 'badge'); b.dataset.state = status; return b; }
function renderJobs() {
  const counts = state.overview?.states ?? {};
  $('count-all').textContent = state.overview?.total ?? 0;
  $('count-active').textContent = (counts.queued ?? 0) + (counts.running ?? 0);
  $('count-success').textContent = counts.succeeded ?? 0;
  $('count-attention').textContent = (counts.failed ?? 0) + (counts.unknown ?? 0);
  const jobs = state.jobs;
  $('job-rows').replaceChildren();
  for (const job of jobs) {
    const row = node('tr'), title = node('td'); title.append(node('strong', job.jobId), node('small', job.sourceSha.slice(0, 12)));
    const statusCell = node('td'); statusCell.append(badge(job.status));
    const actionCell = node('td'), open = node('button', '보기', 'quiet'); open.setAttribute('aria-label', job.jobId + ' 상세 보기');
    open.addEventListener('click', () => attempt(() => detail(job.jobId))); actionCell.append(open);
    row.append(title, node('td', job.platform === 'ios' ? 'iOS' : 'Android'), statusCell, actionCell); $('job-rows').append(row);
  }
  $('empty').hidden = jobs.length > 0; $('previous').disabled = state.cursors.length === 1; $('next').disabled = !state.next;
  $('page-label').textContent = `${state.cursors.length} 페이지`;
}
async function load() {
  if (!state.csrf || !state.app) return;
  const epoch = ++state.epoch, app = state.app, cursor = state.cursors.at(-1);
  $('refresh').disabled = true;
  try {
    const [result, overview] = await Promise.all([api(`/api/jobs?app=${encodeURIComponent(app)}&limit=25&after=${encodeURIComponent(cursor)}&search=${encodeURIComponent($('job-search').value)}&status=${encodeURIComponent($('status-filter').value === 'all' ? '' : $('status-filter').value)}`), api(`/api/overview?app=${encodeURIComponent(app)}`)]);
    if (epoch !== state.epoch || app !== state.app) return;
    const changed = JSON.stringify([state.jobs, state.overview, state.next]) !== JSON.stringify([result.jobs, overview, result.nextCursor]);
    state.jobs = result.jobs; state.overview = overview; state.next = result.nextCursor; if (changed) renderJobs();
    $('sync-status').textContent = '최근 확인 ' + new Date().toLocaleTimeString('ko-KR');
  } finally { if (epoch === state.epoch) $('refresh').disabled = false; }
}
async function loadPresets() {
  const app = state.app, csrf = state.csrf;
  const catalog = await api(`/api/presets?app=${encodeURIComponent(app)}`);
  if (app !== state.app || csrf !== state.csrf) return;
  state.presets = catalog.presets; state.executionEnabled = catalog.enabled;
  $('runner-mode').textContent = catalog.enabled ? `로컬 실행 허용 · 등록 설정 ${catalog.presets.length}개 · 동시 ${catalog.maxConcurrent}개` : '조회·작업 준비 모드 · 프로세스 실행 꺼짐';
}
async function connected(session) {
  state.csrf = session.csrf; $('approval-code').value = ''; $('login-panel').hidden = true; $('console-panel').hidden = false; $('logout').hidden = false;
  $('app-select').replaceChildren(); for (const app of session.apps) { const option = node('option', app); option.value = app; $('app-select').append(option); }
  state.app = session.apps[0]; state.cursors = ['']; notice('소유자 전용 연결 · 이 세션은 30분 후 만료됩니다.'); await loadPresets(); await load();
}
async function history(jobId, append = false) {
  const epoch = state.detailEpoch, app = state.app, cursor = append ? state.historyNext : 0;
  const result = await api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}/history?limit=25&after=${cursor ?? 0}`);
  if (epoch !== state.detailEpoch || app !== state.app || state.selected?.jobId !== jobId) return;
  if (!append) $('history-list').replaceChildren();
  for (const event of result.events) {
    const stageNames = { 'runner-process-starting': '빌드 프로세스 시작 준비', 'runner-process-exited': '프로세스 정상 종료 확인', 'runner-artifact-verifying': '산출물 검증 시작', 'runner-artifact-publishing': '산출물 등록 시작' };
    const li = node('li', stageNames[event.eventType] ?? names[event.status] ?? event.status); li.append(node('small', ` · v${event.version}`));
    const time = node('time', new Date(event.createdAt).toLocaleString('ko-KR')); time.dateTime = event.createdAt; li.append(time); $('history-list').append(li);
  }
  state.historyNext = result.nextCursor; $('history-more').hidden = !result.nextCursor;
}
async function transition(job, status, button) {
  if (state.busy) return; state.busy = true; button.disabled = true;
  // Keep one key for this attempted action. Never silently retry with a new key.
  const key = crypto.randomUUID().replaceAll('-', ''), app = state.app;
  try {
    await api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(job.jobId)}/transition`, 'POST', { expectedVersion: job.version, status, idempotencyKey: key });
    if (app !== state.app) return;
    notice(status === 'queued' ? '대기열에 등록했습니다. 로컬 Runner를 실행하면 처리됩니다.' : '상태가 저장되었습니다.'); await load(); await detail(job.jobId);
  } finally { state.busy = false; button.disabled = false; }
}
async function download(job, artifact, button) {
  button.disabled = true; const epoch = state.detailEpoch, app = state.app;
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(job.jobId)}/downloads`, 'POST', { artifactId: artifact.artifactId });
    if (epoch !== state.detailEpoch || !state.csrf) return;
    const form = $('download-form'); form.elements.ticket.value = result.ticket; form.elements.csrf.value = state.csrf;
    form.submit(); form.reset(); notice('다운로드 요청을 보냈습니다. 오류가 발생하면 열린 탭에서 원인을 확인하세요. 파일 SHA-256은 아래 값과 비교하세요.');
  } finally { button.disabled = false; }
}
const controlPaths = Object.freeze({ execute: '/execute', stop: '/stop', retry: '/retry' });
function pathFor(job, action) { return `/api/jobs/${encodeURIComponent(job.appId)}/${encodeURIComponent(job.jobId)}` + controlPaths[action]; }
async function downloadEvidence(job, artifact, button) {
  const epoch = state.epoch, app = state.app, csrf = state.csrf; button.disabled = true;
  try {
    const report = await api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(job.jobId)}/evidence?artifact=${encodeURIComponent(artifact.artifactId)}`);
    if (epoch !== state.epoch || app !== state.app || csrf !== state.csrf) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = node('a'); link.href = url; link.download = 'flora-artifact-evidence.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally { button.disabled = false; }
}
function startConfirmation(job, preset) {
  state.intent = { action: 'execute', job: { ...job }, presetId: preset.id, csrf: state.csrf, idempotencyKey: crypto.randomUUID().replaceAll('-', '') };
  $('run-context').textContent = `${preset.label} · ${job.jobId}\n${job.repository}\n${job.sourceSha}\nRunner: ${job.runnerId}`;
  $('run-confirm').disabled = true; $('run-preflight').disabled = false;
  $('run-preflight-status').textContent = '빌드 명령 없이 조건을 확인합니다. 점검 후 실행할 수 있습니다.';
  $('run-preflight-checks').replaceChildren();
  if (preset.signaturePolicy) $('run-context').textContent += `\n필수 AAB 업로드 서명 · 인증서 SHA-256: ${preset.signaturePolicy.expectedSignerSha256}`;
  $('run-dialog').showModal();
}
function retryConfirmation(job) {
  state.intent = { action: 'retry', job: { ...job }, csrf: state.csrf, idempotencyKey: crypto.randomUUID().replaceAll('-', '') };
  $('retry-job-id').value = job.jobId.slice(0, 100) + '-retry-' + crypto.randomUUID().slice(0, 8);
  $('retry-dialog').showModal();
}
async function controlAction(intent, body, button) {
  if (state.busy || !intent || intent.job.appId !== state.app || intent.csrf !== state.csrf) return;
  state.busy = true; button.disabled = true;
  try {
    const result = await api(pathFor(intent.job, intent.action), 'POST', body);
    if (intent.job.appId !== state.app || intent.csrf !== state.csrf) return;
    for (const id of ['run-dialog', 'retry-dialog']) if ($(id).open) $(id).close();
    state.intent = null;
    notice(intent.action === 'execute' ? '실행 요청을 접수했습니다. 사전 검증과 실제 프로세스 결과를 확인합니다.' : intent.action === 'stop' ? '중지를 요청했습니다. 프로세스 종료 전에는 취소 완료로 표시하지 않습니다.' : '원본 이력을 보존한 새 작업을 만들었습니다. 다시 승인해야 실행할 수 있습니다.');
    await load(); await detail(intent.action === 'retry' ? result.jobId : intent.job.jobId);
  } catch (error) {
    if (intent.action === 'execute' && ['BUILD_VERSION_CONFLICT', 'BUILD_NOT_QUEUED', 'BUILD_RECIPE_SCOPE_MISMATCH'].includes(error.message)) {
      intent.preflightReady = false; $('run-preflight-status').textContent = '작업이 변경됐습니다. 창을 닫고 다시 선택해 점검하세요.';
    }
    throw error;
  } finally { state.busy = false; button.disabled = intent.action === 'execute' && intent.preflightReady !== true; }
}
async function detail(jobId, preserve = false) {
  const epoch = ++state.detailEpoch, app = state.app;
  const [result, control] = await Promise.all([api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}`), api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}/execution`)]);
  if (epoch !== state.detailEpoch || app !== state.app) return;
  const job = result.job;
  // Numeric heartbeat updates must not replace focused action buttons or history controls.
  renderActivity(control.execution?.activity);
  const executionIdentity = control.execution ? { id: control.execution.id, phase: control.execution.phase, canStop: control.execution.canStop, reason: control.execution.reason, stage: control.execution.activity?.stage } : null;
  const signature = JSON.stringify([job.jobId, job.version, executionIdentity]);
  if (preserve && signature === state.detailSignature) return; state.detailSignature = signature;
  state.selected = job; $('detail-empty').hidden = true; $('detail-content').hidden = false;
  $('detail-title').textContent = job.jobId; $('detail-status').textContent = names[job.status]; $('detail-status').dataset.state = job.status;
  $('job-facts').replaceChildren(); for (const [label, value] of [['저장소', job.repository], ['커밋 SHA', job.sourceSha], ['Runner', job.runnerId], ...(job.parentJobId ? [['원본 작업', job.parentJobId]] : []), ...(job.failureCode ? [['진단 코드', job.failureCode]] : []), ['플랫폼 / 원장 버전', `${job.platform} / v${job.version}`]]) $('job-facts').append(node('dt', label), node('dd', value));
  $('job-actions').replaceChildren(); const actions = { unconfigured: [['authorized', '작업 승인']], authorized: [['queued', '대기열 등록']], queued: [['cancelled', '대기 취소']] };
  for (const [status, label] of actions[job.status] ?? []) { const button = node('button', label, status === 'cancelled' ? 'quiet' : 'primary'); button.addEventListener('click', () => attempt(() => transition(job, status, button))); $('job-actions').append(button); }
  const execution = control.execution;
  $('execution-status').textContent = execution?.reason ? explain({ message: execution.reason }) : execution?.phase === 'stopping' ? '중지 요청 처리 중 · 실제 종료를 확인하고 있습니다.' : execution?.phase === 'starting' ? '소스와 실행 조건을 확인 중입니다.' : '';
  if (job.status === 'queued' && state.executionEnabled && !execution?.canStop && execution?.phase !== 'stopping') {
    const presets = state.presets.filter(p => ['appId', 'repository', 'runnerId', 'platform'].every(k => p[k] === job[k]));
    if (presets.length) {
      const label = node('label', '실행 설정'); label.htmlFor = 'build-preset'; const select = node('select'); select.id = 'build-preset';
      for (const preset of presets) { const option = node('option', preset.label); option.value = preset.id; select.append(option); }
      const button = node('button', '빌드 실행', 'primary'); button.addEventListener('click', () => startConfirmation(job, presets.find(p => p.id === select.value)));
      $('job-actions').append(label, select, button);
    } else $('job-actions').append(node('p', '이 앱·저장소·Runner·플랫폼과 일치하는 등록 설정이 없습니다.', 'muted'));
  }
  if (execution?.canStop && ['queued', 'running'].includes(job.status)) {
    const button = node('button', '실행 중지 요청', 'quiet'); button.addEventListener('click', () => attempt(() => controlAction({ action: 'stop', job, csrf: state.csrf }, { expectedVersion: job.version }, button))); $('job-actions').append(button);
  } else if (job.status === 'running' && execution?.phase !== 'stopping') $('job-actions').append(node('p', '실행 중입니다. 이 콘솔 밖에서 시작한 프로세스는 해당 Runner에서 중지하세요.', 'muted'));
  if (['failed', 'cancelled'].includes(job.status)) { const button = node('button', '새 작업으로 다시 준비', 'quiet'); button.addEventListener('click', () => retryConfirmation(job)); $('job-actions').append(button); }

  if (job.status === 'unknown') $('job-actions').append(node('p', '실행 결과를 확인하지 못했습니다. 자동 재실행하지 말고 Runner 기록을 먼저 확인하세요.', 'muted'));
  $('artifact-list').replaceChildren();
  for (const artifact of result.artifacts) {
    const card = node('div', undefined, 'artifact'); card.append(node('strong', `${artifact.format.toUpperCase()} · ${(artifact.byteCount / 1024 / 1024).toFixed(2)} MB`), node('code', artifact.sha256));
    if (artifact.signatureVerified === true && artifact.signatureEvidence?.scheme === 'aab-jar-v1') {
      const proof = artifact.signatureEvidence;
      card.append(node('p', 'AAB 업로드 서명 · 등록 인증서와 일치 (검증 당시)', 'signature-status'), node('code', proof.signerSha256),
        node('small', `검증 ${new Date(proof.verifiedAt).toLocaleString('ko-KR')} · 서명 파일 ${proof.signedEntries}개 · 인증서 만료 ${new Date(proof.certificateNotAfter).toLocaleDateString('ko-KR')}`));
    } else card.append(node('p', '무결성 확인 · 코드 서명은 미검증', 'muted'));
    // bundleValidated and installVerified must never be inferred from a signature.
    card.append(node('p', '앱 번들 유효성 · Play 승인 · 실제 설치는 미검증', 'muted'));
    const evidenceButton = node('button', '서명 검증 기록 JSON', 'quiet');
    evidenceButton.addEventListener('click', () => attempt(() => downloadEvidence(job, artifact, evidenceButton))); card.append(evidenceButton);
    const button = node('button', '검증 후 다운로드', 'quiet'); button.addEventListener('click', () => attempt(() => download(job, artifact, button))); card.append(button); $('artifact-list').append(card);
  }
  if (!result.artifacts.length) $('artifact-list').append(node('p', '아직 등록된 산출물이 없습니다.', 'muted'));
  await history(jobId);
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); const code = $('approval-code').value.trim(); $('approval-code').value = ''; attempt(async () => connected(await api('/api/session', 'POST', { code }))); });
$('logout').addEventListener('click', () => attempt(async () => { await api('/api/session', 'DELETE'); reset(); notice('연결을 종료했습니다. 다시 연결하려면 콘솔을 재시작하세요.'); }));
$('app-select').addEventListener('change', () => { clearPreflight(); clearDiagnostic(); state.epoch++; state.detailEpoch++; state.app = $('app-select').value; state.selected = null; state.overview = null; state.jobs = []; state.presets = []; state.detailSignature = null; state.intent = null; state.cursors = [''];
  for (const id of ['run-dialog', 'retry-dialog']) if ($(id).open) $(id).close();
  for (const id of ['artifact-list', 'history-list', 'job-facts', 'job-actions', 'build-activity']) $(id).replaceChildren();
  $('build-activity').hidden = true; $('execution-status').textContent = '';
  $('detail-content').hidden = true; $('detail-empty').hidden = false; $('job-search').value = ''; renderJobs(); attempt(async () => { await loadPresets(); await load(); }); });
$('refresh').addEventListener('click', () => attempt(async () => { await load(); if (state.selected) await detail(state.selected.jobId); }));
$('next').addEventListener('click', () => { if (state.next) { state.cursors.push(state.next); attempt(load); } });
$('previous').addEventListener('click', () => { if (state.cursors.length > 1) { state.cursors.pop(); attempt(load); } });
let searchTimer;
function filterJobs(delay = 0) { state.epoch++; state.cursors = ['']; clearTimeout(searchTimer); searchTimer = setTimeout(() => attempt(load), delay); }
$('job-search').addEventListener('input', () => filterJobs(200)); $('status-filter').addEventListener('change', () => filterJobs());
$('history-more').addEventListener('click', () => attempt(() => history(state.selected.jobId, true)));
$('create-open').addEventListener('click', () => $('create-dialog').showModal()); $('create-close').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', event => { event.preventDefault(); const button = event.submitter; button.disabled = true; const app = state.app;
  attempt(async () => { try {
    const input = Object.fromEntries(new FormData(event.target)); input.appId = app;
    await api('/api/jobs', 'POST', input); $('create-dialog').close(); event.target.reset(); notice('작업을 등록했습니다. 내용을 확인한 뒤 승인하고 대기열에 넣으세요.');
    if (app === state.app) { state.cursors = ['']; await load(); await detail(input.jobId); }
  } finally { button.disabled = false; } });
});
for (const kind of ['run', 'retry']) {
  $(kind + '-close').addEventListener('click', () => { $(kind + '-dialog').close(); state.intent = null; if (kind === 'run') clearPreflight(); });
  $(kind + '-dialog').addEventListener('cancel', () => { state.intent = null; if (kind === 'run') clearPreflight(); });
}
$('run-form').addEventListener('submit', event => { event.preventDefault(); const intent = state.intent; if (!intent || intent.action !== 'execute' || intent.preflightReady !== true) return;
  attempt(() => controlAction(intent, { presetId: intent.presetId, expectedVersion: intent.job.version, idempotencyKey: intent.idempotencyKey }, event.submitter)); });
$('retry-form').addEventListener('submit', event => { event.preventDefault(); const intent = state.intent; if (!intent || intent.action !== 'retry') return;
  attempt(() => controlAction(intent, { newJobId: $('retry-job-id').value.trim(), expectedVersion: intent.job.version, idempotencyKey: intent.idempotencyKey }, event.submitter)); });
// Diagnostics are explicit and scoped; polling never hashes files automatically.
function clearDiagnostic() {
  state.diagnosticEpoch++; state.diagnostic = null;
  $('diagnostic-status').textContent = '아직 검사하지 않았습니다. 버튼을 눌러 최대 64 MiB를 검증하세요.';
  $('diagnostic-summary').textContent = ''; $('diagnostic-issues').replaceChildren();
  $('diagnostic-export').hidden = true; $('diagnose').disabled = false;
}
const diagnosticMessages = Object.freeze({
  ARTIFACT_HASH_MISMATCH: '파일 내용이 등록된 해시와 다릅니다. 원본 빌드 결과를 확인하세요.',
  ARTIFACT_SIZE_MISMATCH: '파일 크기가 등록 정보와 다릅니다.', ARTIFACT_MISSING: '등록된 파일을 찾지 못했습니다.',
  ARTIFACT_UNREFERENCED: '원장에 등록되지 않은 파일이 있습니다. 확인 전 삭제하지 마세요.',
  ARTIFACT_PARTIAL_REMAINS: '미완성 파일이 남아 있습니다. 실행 이력을 먼저 확인하세요.',
  ARTIFACT_SCAN_INCOMPLETE: '검사 한도에 도달했습니다. 완료 판정이 아니며 CLI에서 한도를 지정해 다시 검사할 수 있습니다.',
  BUILD_DIAGNOSTIC_STATE_CHANGED: '검사 중 원장이 변경됐습니다. 작업이 안정된 뒤 다시 검사하세요.',
  BUILD_RUNNING_REQUIRES_CHECK: '원장에 실행 중 작업이 있습니다. 실제 Runner 상태와 일치하는지 확인하세요.',
  BUILD_RECONCILIATION_REQUIRED: '결과 불명 작업이 있습니다. 원본 실행 결과를 확인하기 전 재실행하지 마세요.',
  ARTIFACT_STORE_DIRECTORY_UNSAFE: '파일 저장 디렉터리의 권한 또는 연결 경로를 점검하세요.',
  ARTIFACT_UNEXPECTED_ENTRY: '저장소에 예상하지 않은 항목이 있습니다. 자동 삭제하지 않습니다.',
});
$('diagnose').addEventListener('click', async () => {
  if (!state.csrf || !state.app) return;
  const app = state.app, csrf = state.csrf, epoch = ++state.diagnosticEpoch;
  state.diagnostic = null; $('diagnostic-export').hidden = true; $('diagnose').disabled = true;
  $('diagnostic-issues').replaceChildren(); $('diagnostic-summary').textContent = '';
  $('diagnostic-status').textContent = '원장과 저장 파일을 검사하고 있습니다…';
  try {
    const report = await api('/api/diagnostics', 'POST', { appId: app });
    if (epoch !== state.diagnosticEpoch || app !== state.app || csrf !== state.csrf) return;
    state.diagnostic = report;
    $('diagnostic-status').textContent = report.ready ? '지정한 범위의 검사를 통과했습니다.' : '확인이 필요한 항목이 있습니다.';
    $('diagnostic-summary').textContent = `${new Date(report.checkedAt).toLocaleString('ko-KR')} · ${report.verifiedFiles}/${report.artifacts}개 파일 · ${(report.verifiedBytes / 1048576).toFixed(1)} MiB · ${report.complete ? '범위 검사 완료' : '불완전한 검사'} · 프로세스 생존·서명·설치 검증은 별도`;
    for (const issue of report.issues) {
      const li = node('li', diagnosticMessages[issue.code] ?? issue.code);
      if (issue.jobId) li.append(node('small', ' 작업: ' + issue.jobId)); $('diagnostic-issues').append(li);
    }
    $('diagnostic-export').hidden = false;
  } catch (error) { if (epoch === state.diagnosticEpoch && app === state.app && csrf === state.csrf) $('diagnostic-status').textContent = explain(error); }
  finally { if (epoch === state.diagnosticEpoch) $('diagnose').disabled = false; }
});
$('diagnostic-export').addEventListener('click', () => {
  if (!state.csrf || state.diagnostic?.appId !== state.app) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.diagnostic, null, 2)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = 'flora-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// Poll only an active, visible page, and never overlap a previous poll.
let polling = false, nextPoll = 0;
setInterval(async () => { if (!state.csrf || document.hidden || polling || state.busy || ['create-dialog', 'run-dialog', 'retry-dialog'].some(id => $(id).open) || Date.now() < nextPoll) return; polling = true;
  try { await load(); if (state.selected) await detail(state.selected.jobId, true); } catch (error) { notice(explain(error), true); } finally { polling = false; nextPoll = Date.now() + (['queued', 'running'].includes(state.selected?.status) ? 3000 : 15000); }
}, 3000);

function clearPreflight() {
  $('run-context').textContent = ''; $('run-preflight-checks').replaceChildren();
  $('run-preflight-status').textContent = ''; $('run-confirm').disabled = true; $('run-preflight').disabled = false;
}
function renderActivity(activity) {
  const panel = $('build-activity'); panel.replaceChildren(); panel.hidden = !activity;
  if (!activity) return;
  const labels = { preflight: '실행 조건 확인', 'source-check': '소스 커밋 확인', executing: '빌드 프로세스 실행', verifying: '산출물 무결성 검사', 'signature-verifying': 'AAB 업로드 서명 확인', publishing: '원장 · 파일 저장', finished: '이번 실행 처리 종료' };
  panel.append(node('strong', labels[activity.stage] ?? '실행 관측'));
  const elapsed = Math.floor(activity.elapsedMs / 1000);
  panel.append(node('p', `경과 ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초 · 출력 ${((activity.stdoutBytes + activity.stderrBytes) / 1024).toFixed(1)} KiB / ${(activity.outputLimitBytes / 1024).toFixed(0)} KiB`));
  panel.append(node('small', '관측 ' + new Date(activity.observedAt).toLocaleTimeString('ko-KR') + ' · 로그 원문은 수집하지 않습니다. 이 수치는 현재 콘솔 세션에만 유지됩니다.'));
  if (activity.lastOutputAt) panel.append(node('small', '마지막 출력 ' + new Date(activity.lastOutputAt).toLocaleTimeString('ko-KR') + ' · 출력이 없다는 이유만으로 멈춘 것으로 판단하지 않습니다.'));
}
$('run-preflight').addEventListener('click', async () => {
  const intent = state.intent;
  if (!intent || intent.action !== 'execute' || intent.job.appId !== state.app || intent.csrf !== state.csrf) return;
  intent.preflightReady = false; $('run-confirm').disabled = true; $('run-preflight').disabled = true;
  $('run-preflight-status').textContent = '소스·도구·출력 경로·잠금을 확인하고 있습니다…'; $('run-preflight-checks').replaceChildren();
  try {
    const report = await api(`/api/jobs/${encodeURIComponent(intent.job.appId)}/${encodeURIComponent(intent.job.jobId)}/preflight`, 'POST', { presetId: intent.presetId, expectedVersion: intent.job.version });
    if (intent !== state.intent || intent.job.appId !== state.app || intent.csrf !== state.csrf || !$('run-dialog').open) return;
    intent.preflightReady = report.ready === true && report.jobVersion === intent.job.version;
    $('run-preflight-status').textContent = intent.preflightReady ? '현재 조건을 통과했습니다. 실행 시 다시 검증하며, 빌드·서명 성공을 보장하지 않습니다.' : '실행 전에 확인할 항목이 있습니다. 원인을 해결한 후 다시 점검하세요.';
    const labels = { job: '작업 상태 · 버전', binding: '설정 연결', checkout: '작업 폴더', executable: '실행 파일', git: 'Git 도구', 'signature-tool': 'JDK 서명 검사 실행 파일', output: '이전 출력', lock: 'Runner 잠금', source: '소스 커밋 · 변경', freshness: '점검 중 상태 변경' };
    for (const check of report.checks) $('run-preflight-checks').append(node('li', `${labels[check.id] ?? check.id}: ${check.status === 'passed' ? '통과' : check.status === 'not_checked' ? '미검사' : explain({ message: check.code })}`));
    $('run-confirm').disabled = !intent.preflightReady;
  } catch (error) {
    if (intent === state.intent && intent.job.appId === state.app && intent.csrf === state.csrf) $('run-preflight-status').textContent = explain(error);
  } finally { if (intent === state.intent) $('run-preflight').disabled = false; }
});

try { await connected(await api('/api/session')); } catch { reset(); }
