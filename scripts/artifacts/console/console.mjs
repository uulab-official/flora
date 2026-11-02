const $ = id => document.getElementById(id);
const names = { unconfigured: '미승인', authorized: '승인됨', queued: '대기', running: '실행 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', unknown: '결과 불명' };
const state = { csrf: null, app: null, jobs: [], selected: null, epoch: 0, detailEpoch: 0, cursors: [''], next: null, historyNext: null, busy: false };
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').dataset.error = String(error); $('notice').hidden = !text; }
function reset() {
  state.epoch++; state.detailEpoch++; state.csrf = null; state.jobs = []; state.selected = null;
  $('console-panel').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('job-rows').replaceChildren(); $('artifact-list').replaceChildren(); $('history-list').replaceChildren(); $('job-facts').replaceChildren();
  $('detail-content').hidden = true; $('detail-empty').hidden = false; $('approval-code').value = '';
  if ($('create-dialog').open) $('create-dialog').close();
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
    BUILD_JOB_ALREADY_EXISTS: '같은 앱에 이 작업 ID가 이미 있습니다.', ARTIFACT_HASH_MISMATCH: '파일 무결성이 맞지 않아 다운로드를 차단했습니다.' };
  return labels[error.message] ?? '요청을 완료하지 못했습니다. ' + error.message;
}
async function attempt(fn) { try { await fn(); } catch (error) { notice(explain(error), true); } }
function badge(status) { const b = node('span', names[status] ?? status, 'badge'); b.dataset.state = status; return b; }
function renderJobs() {
  $('count-all').textContent = state.jobs.length;
  $('count-active').textContent = state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  $('count-success').textContent = state.jobs.filter(j => j.status === 'succeeded').length;
  $('count-attention').textContent = state.jobs.filter(j => ['failed', 'unknown'].includes(j.status)).length;
  const search = $('job-search').value.toLowerCase(), status = $('status-filter').value;
  const jobs = state.jobs.filter(j => j.jobId.toLowerCase().includes(search) && (status === 'all' || j.status === status));
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
    const result = await api(`/api/jobs?app=${encodeURIComponent(app)}&limit=25&after=${encodeURIComponent(cursor)}`);
    if (epoch !== state.epoch || app !== state.app) return;
    state.jobs = result.jobs; state.next = result.nextCursor; renderJobs();
  } finally { if (epoch === state.epoch) $('refresh').disabled = false; }
}
async function connected(session) {
  state.csrf = session.csrf; $('approval-code').value = ''; $('login-panel').hidden = true; $('console-panel').hidden = false; $('logout').hidden = false;
  $('app-select').replaceChildren(); for (const app of session.apps) { const option = node('option', app); option.value = app; $('app-select').append(option); }
  state.app = session.apps[0]; state.cursors = ['']; notice('소유자 전용 연결 · 이 세션은 30분 후 만료됩니다.'); await load();
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
async function detail(jobId, preserve = false) {
  const epoch = ++state.detailEpoch, app = state.app;
  const result = await api(`/api/jobs/${encodeURIComponent(app)}/${encodeURIComponent(jobId)}`);
  if (epoch !== state.detailEpoch || app !== state.app) return;
  const job = result.job;
  if (preserve && state.selected?.jobId === job.jobId && state.selected?.version === job.version) return;
  state.selected = job; $('detail-empty').hidden = true; $('detail-content').hidden = false;
  $('detail-title').textContent = job.jobId; $('detail-status').textContent = names[job.status]; $('detail-status').dataset.state = job.status;
  $('job-facts').replaceChildren(); for (const [label, value] of [['저장소', job.repository], ['커밋 SHA', job.sourceSha], ['Runner', job.runnerId], ...(job.failureCode ? [['진단 코드', job.failureCode]] : []), ['플랫폼 / 원장 버전', `${job.platform} / v${job.version}`]]) $('job-facts').append(node('dt', label), node('dd', value));
  $('job-actions').replaceChildren(); const actions = { unconfigured: [['authorized', '작업 승인']], authorized: [['queued', '대기열 등록']], queued: [['cancelled', '대기 취소']] };
  for (const [status, label] of actions[job.status] ?? []) { const button = node('button', label, status === 'cancelled' ? 'quiet' : 'primary'); button.addEventListener('click', () => attempt(() => transition(job, status, button))); $('job-actions').append(button); }
  if (job.status === 'running') $('job-actions').append(node('p', '실행 중입니다. 중지는 Runner에서 수행하세요.', 'muted'));
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
$('app-select').addEventListener('change', () => { state.detailEpoch++; state.app = $('app-select').value; state.selected = null; state.cursors = ['']; $('detail-content').hidden = true; $('detail-empty').hidden = false; $('job-search').value = ''; attempt(load); });
$('refresh').addEventListener('click', () => attempt(async () => { await load(); if (state.selected) await detail(state.selected.jobId); }));
$('next').addEventListener('click', () => { if (state.next) { state.cursors.push(state.next); attempt(load); } });
$('previous').addEventListener('click', () => { if (state.cursors.length > 1) { state.cursors.pop(); attempt(load); } });
$('job-search').addEventListener('input', renderJobs); $('status-filter').addEventListener('change', renderJobs);
$('history-more').addEventListener('click', () => attempt(() => history(state.selected.jobId, true)));
$('create-open').addEventListener('click', () => $('create-dialog').showModal()); $('create-close').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', event => { event.preventDefault(); const button = event.submitter; button.disabled = true; const app = state.app;
  attempt(async () => { try {
    const input = Object.fromEntries(new FormData(event.target)); input.appId = app;
    await api('/api/jobs', 'POST', input); $('create-dialog').close(); event.target.reset(); notice('작업을 등록했습니다. 내용을 확인한 뒤 승인하고 대기열에 넣으세요.');
    if (app === state.app) { state.cursors = ['']; await load(); await detail(input.jobId); }
  } finally { button.disabled = false; } });
});
// Poll only an active, visible page, and never overlap a previous poll.
let polling = false;
setInterval(async () => { if (!state.csrf || document.hidden || polling || state.busy || $('create-dialog').open) return; polling = true;
  try { await load(); if (state.selected) await detail(state.selected.jobId, true); } catch (error) { notice(explain(error), true); } finally { polling = false; }
}, 15_000);
try { await connected(await api('/api/session')); } catch { reset(); }
