const $ = id => document.getElementById(id);
const names = { unconfigured: '미승인', authorized: '승인됨', queued: '대기', running: '실행 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', unknown: '결과 불명' };
const state = { csrf: null, app: null, jobs: [], selected: null, epoch: 0, detailEpoch: 0, cursors: [''], next: null, historyNext: null, busy: false, overview: null, presets: [], executionEnabled: false, intent: null, detailSignature: null };
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').dataset.error = String(error); $('notice').hidden = !text; }
function reset() {
  state.epoch++; state.detailEpoch++; state.csrf = null; state.app = null; state.jobs = []; state.selected = null; state.overview = null; state.presets = []; state.intent = null; state.executionEnabled = false; state.detailSignature = null;
  $('console-panel').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('job-rows').replaceChildren(); $('artifact-list').replaceChildren(); $('history-list').replaceChildren(); $('job-facts').replaceChildren();
  $('detail-content').hidden = true; $('detail-empty').hidden = false; $('approval-code').value = '';
  for (const id of ['create-dialog', 'run-dialog', 'retry-dialog']) if ($(id).open) $(id).close();
  for (const id of ['count-all', 'count-active', 'count-success', 'count-attention']) $(id).textContent = '0';
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
  const labels = { BUILD_VERSION_CONFLICT: '다른 작업으로 상태가 변경되었습니다. 새로고침 후 다시 확인하세요.',
    BUILD_APPROVAL_INVALID: '승인 코드가 잘못되었거나 만료·사용되었습니다. 콘솔을 재시작해 새 코드를 받으세요.',
    BUILD_SESSION_EXPIRED: '세션이 만료되었습니다. 콘솔을 재시작해 다시 연결하세요.',
    BUILD_SESSION_REQUIRED: '로컬 콘솔 연결이 필요합니다.', BUILD_RUNNING_CANCEL_REQUIRES_RUNNER: '실행 중인 작업은 Runner에서 중지해야 합니다.',
    BUILD_EXECUTION_DISABLED: '이 콘솔은 실행이 비활성화되어 있습니다. PC에서 사전 등록한 설정을 허용해 시작하세요.',
    BUILD_EXECUTION_LIMIT: '동시 실행 한도에 도달했습니다. 현재 작업이 끝난 뒤 다시 요청하세요.',
    BUILD_EXECUTION_ACTIVE: '이미 시작 요청을 처리 중입니다. 상태를 확인하세요.',
    BUILD_PRESET_NOT_FOUND: '등록된 빌드 설정을 찾지 못했습니다.',
    BUILD_SOURCE_DIRTY: '작업 폴더에 커밋되지 않은 변경이 있습니다. 변경을 보존·정리한 뒤 다시 확인하세요.',
    BUILD_SOURCE_SHA_MISMATCH: 'PC의 체크아웃 커밋이 작업에 등록한 SHA와 다릅니다.',
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
    const li = node('li', names[event.status] ?? event.status); li.append(node('small', ` · v${event.version}`));
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
function startConfirmation(job, preset) {
  state.intent = { action: 'execute', job: { ...job }, presetId: preset.id, csrf: state.csrf, idempotencyKey: crypto.randomUUID().replaceAll('-', '') };
  $('run-context').textContent = `${preset.label} · ${job.jobId}\n${job.repository}\n${job.sourceSha}\nRunner: ${job.runnerId}`;
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
  } finally { state.busy = false; button.disabled = false; }
}
async function detail(jobId, preserve = false) {
  const epoch = ++state.detailEpoch, app = state.app;
  const [result, control] = await Promise.all([api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}`), api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}/execution`)]);
  if (epoch !== state.detailEpoch || app !== state.app) return;
  const job = result.job;
  const signature = JSON.stringify([job.jobId, job.version, control.execution]);
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
    const card = node('div', undefined, 'artifact'); card.append(node('strong', `${artifact.format.toUpperCase()} · ${(artifact.byteCount / 1024 / 1024).toFixed(2)} MB`), node('code', artifact.sha256), node('p', '무결성 확인 · 코드 서명 / 실제 설치는 미검증', 'muted'));
    const button = node('button', '검증 후 다운로드', 'quiet'); button.addEventListener('click', () => attempt(() => download(job, artifact, button))); card.append(button); $('artifact-list').append(card);
  }
  if (!result.artifacts.length) $('artifact-list').append(node('p', '아직 등록된 산출물이 없습니다.', 'muted'));
  await history(jobId);
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); const code = $('approval-code').value.trim(); $('approval-code').value = ''; attempt(async () => connected(await api('/api/session', 'POST', { code }))); });
$('logout').addEventListener('click', () => attempt(async () => { await api('/api/session', 'DELETE'); reset(); notice('연결을 종료했습니다. 다시 연결하려면 콘솔을 재시작하세요.'); }));
$('app-select').addEventListener('change', () => { state.epoch++; state.detailEpoch++; state.app = $('app-select').value; state.selected = null; state.overview = null; state.jobs = []; state.presets = []; state.detailSignature = null; state.intent = null; state.cursors = [''];
  for (const id of ['run-dialog', 'retry-dialog']) if ($(id).open) $(id).close();
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
  $(kind + '-close').addEventListener('click', () => { $(kind + '-dialog').close(); state.intent = null; });
  $(kind + '-dialog').addEventListener('cancel', () => { state.intent = null; });
}
$('run-form').addEventListener('submit', event => { event.preventDefault(); const intent = state.intent; if (!intent || intent.action !== 'execute') return;
  attempt(() => controlAction(intent, { presetId: intent.presetId, expectedVersion: intent.job.version, idempotencyKey: intent.idempotencyKey }, event.submitter)); });
$('retry-form').addEventListener('submit', event => { event.preventDefault(); const intent = state.intent; if (!intent || intent.action !== 'retry') return;
  attempt(() => controlAction(intent, { newJobId: $('retry-job-id').value.trim(), expectedVersion: intent.job.version, idempotencyKey: intent.idempotencyKey }, event.submitter)); });
// Poll only an active, visible page, and never overlap a previous poll.
let polling = false, nextPoll = 0;
setInterval(async () => { if (!state.csrf || document.hidden || polling || state.busy || ['create-dialog', 'run-dialog', 'retry-dialog'].some(id => $(id).open) || Date.now() < nextPoll) return; polling = true;
  try { await load(); if (state.selected) await detail(state.selected.jobId, true); } catch (error) { notice(explain(error), true); } finally { polling = false; nextPoll = Date.now() + (['queued', 'running'].includes(state.selected?.status) ? 3000 : 15000); }
}, 3000);
try { await connected(await api('/api/session')); } catch { reset(); }
