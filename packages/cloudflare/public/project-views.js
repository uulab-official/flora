import { adminPath } from "./admin-routes.js";
import { validateAutomaticRollbackDecision } from "./auto-rollback.js";
import { projectBranding } from "./project-branding.js";
/* Read-only operational presentation. No provider actions or key material. */
function clean(value, limit = 2048) {
  return String(value ?? "—").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, limit);
}
function node(document, tag, text, className = "") { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = clean(text); return value; }
function stamp(value) { if (!Number.isSafeInteger(value) || value < 0) return "시각 미확인"; return new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " KST"; }
function platform(value) { return value === "ios" ? "iOS" : value === "android" ? "Android" : "플랫폼 미확인"; }
function pair(document, label, value) { const row = node(document, "div", undefined, "fact-row"); row.append(node(document, "span", label, "fact-label"), node(document, "span", value, "fact-value")); return row; }
export function technicalDetails(document, entries, label = "기술 정보 · 식별자") {
  const detail = node(document, "details", undefined, "technical-details"); detail.append(node(document, "summary", label));
  for (const [key, value] of entries) detail.append(pair(document, key, value));
  return detail;
}
function summariesArray(summaries) { return Array.isArray(summaries) ? summaries : Array.isArray(summaries?.projects) ? summaries.projects : []; }
function repository(summary, app) { return summary?.github ? `${summary.github.owner}/${summary.github.repository}` : summary?.repositoryId || app?.repositoryId || "GitHub 연결 미확인"; }
function runnerLabel(runner) { return ({ online: "온라인", offline: "오프라인", unregistered: "미등록", unseen: "연결 기록 없음", revoked: "권한 폐기됨" })[runner?.status] ?? "상태 미확인"; }
function currentPresence(options) { return options.status !== "error" && (!Number.isSafeInteger(options.now) || !Number.isSafeInteger(options.observedAt) || options.now >= options.observedAt && options.now - options.observedAt <= 120_000); }
function publication(document, value, os, metadataKnown = true, appId) {
  if (value && (value.appId !== undefined && value.appId !== appId || value.platform !== undefined && value.platform !== os)) { value = null; metadataKnown = false; }
  const row = node(document, "div", undefined, "project-ota-platform");
  const label = node(document, "span", undefined, "project-platform-label");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.setAttribute("class", "icon"); icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "/icons.svg#icon-platform-" + os); icon.append(use);
  label.append(icon, node(document, "span", platform(os))); row.append(label);
  const info = node(document, "span", undefined, "project-publication-info");
  info.append(node(document, "strong", value ? `${value.channel} · 게시됨` : metadataKnown ? "게시 이력 없음" : "게시 상태 미확인"));
  if (value) info.append(node(document, "small", stamp(value.createdAt)));
  const report = value?.telemetry;
  const scoped = report && (report.appId === undefined || report.appId === appId) && (report.deploymentId === undefined || report.deploymentId === value?.id) && (report.platform === undefined || report.platform === os);
  info.append(node(document, "small", scoped && isValidSdkTelemetry(report, os) && report.applicationRate !== null ? `SDK 적용 ${report.applicationRate.toFixed(1)}% · 보고 ${report.observedInstallations}개 설치` : "기기 보고 대기", "project-adoption-preview"));
  row.append(info); return row;
}
export function isValidSdkIssueResolution(report) {
  const value = report?.issueResolution;
  const count = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || !["unresolvedInstallations", "resolvedInstallations", "unknownInstallations"].every(key => count(value[key])) || !["observedInstallations", "failedInstallations", "rolledBackInstallations", "appliedInstallations", "restartedInstallations"].every(key => count(report[key]))) return false;
  const issues = value.unresolvedInstallations + value.resolvedInstallations;
  const rollbackResolved = value.rollbackResolvedInstallations === undefined ? 0 : value.rollbackResolvedInstallations;
  return count(rollbackResolved) && rollbackResolved <= value.resolvedInstallations && value.unknownInstallations <= value.unresolvedInstallations && value.resolvedInstallations - rollbackResolved <= Math.min(report.appliedInstallations, report.restartedInstallations) && issues >= Math.max(report.failedInstallations, report.rolledBackInstallations) && issues <= Math.min(report.observedInstallations, report.failedInstallations + report.rolledBackInstallations);
}
function issueResolution(report) { return isValidSdkIssueResolution(report) ? report.issueResolution : null; }
function projectAttention(app, summary, status, options) {
  const fresh = Boolean(summary) && status === "ready" && currentPresence(options);
  const appScoped = Boolean(adminPath("overview", app.id));
  const problems = [], resolved = []; let unknown = !fresh || !appScoped;
  for (const os of ["ios", "android"]) {
    const current = summary?.ota?.[os];
    if (!current) continue;
    const candidates = [{ value: current, rollbackId: null }];
    if (current.rollbackIssue !== undefined) {
      const origin = current.rollbackIssue, rollback = current.rollback;
      const depth = origin?.depth ?? 1;
      const validLineage = rollback && origin && Number.isSafeInteger(depth) && depth >= 1 && depth <= 32 && (depth === 1 ? origin.deploymentId === rollback.fromDeploymentId && rollback.targetDeploymentId !== origin.deploymentId : origin.deploymentId !== rollback.fromDeploymentId) && origin.deploymentId !== current.id && rollback.targetDeploymentId !== current.id && rollback.fromDeploymentId !== current.id && Boolean(adminPath("ota-detail", app.id, rollback.fromDeploymentId)) && Boolean(adminPath("ota-detail", app.id, origin.deploymentId)) && Boolean(adminPath("ota-detail", app.id, rollback.targetDeploymentId)) && Number.isSafeInteger(rollback.requestedAt) && rollback.requestedAt >= 0;
      if (validLineage) candidates.push({ value: { ...current, id: origin.deploymentId, telemetry: origin.telemetry }, rollbackId: current.id });
      else unknown = true;
    }
    for (const { value, rollbackId } of candidates) {
      const scoped = Boolean(adminPath("ota-detail", app.id, value.id)) && (value.appId === undefined || value.appId === app.id) && (value.platform === undefined || value.platform === os);
      const report = value.telemetry;
      const verified = scoped && isValidSdkTelemetry(report, os) && (report.appId === undefined || report.appId === app.id) && (report.deploymentId === undefined || report.deploymentId === value.id) && (report.platform === undefined || report.platform === os);
      if (!verified) { unknown = true; continue; }
      const resolution = issueResolution(report);
      if (!resolution) { unknown = true; continue; }
      if (resolution.unknownInstallations > 0) unknown = true;
      if (resolution.unresolvedInstallations > 0) problems.push({ os, value, resolution, rollbackId });
      if (resolution.resolvedInstallations > 0) resolved.push({ os, value, resolution, rollbackId });
    }
  }
  const knownRunner = ["online", "offline", "unseen", "unregistered", "revoked"].includes(summary?.runner?.status);
  if (!knownRunner) unknown = true;
  const runner = appScoped && fresh && summary?.automation?.enabled === true && ["offline", "unseen", "unregistered", "revoked"].includes(summary?.runner?.status);
  return { problems, resolved, runner, unknown, fresh, attention: problems.length > 0 || runner };
}
function projectLink(document, label, path, issue = true) {
  const link = node(document, "a", label, "project-attention-link"); link.setAttribute("href", path); link.setAttribute("data-project-path", path); if (issue) link.setAttribute("data-project-issue", ""); return link;
}
export function renderProjectRows(document, state, summaries, options = {}) {
  const target = document.getElementById("project-list"); if (!target) return;
  const apps = Array.isArray(state?.applications) ? state.applications : [];
  const list = summariesArray(summaries); const byId = new Map(list.map(value => [value.id, value]));
  const status = options.status ?? (summaries ? "ready" : "loading");
  const presenceOptions = { ...options, status, observedAt: options.observedAt ?? summaries?.observedAt };
  const query = clean(document.getElementById("project-search")?.value ?? "").trim().toLocaleLowerCase();
  const requested = document.getElementById("project-status-filter")?.value;
  const filter = ["attention", "ota", "resolved", "runner", "unknown"].includes(requested) ? requested : "all";
  const visible = apps.map(app => { const summary = byId.get(app.id); return { app, summary, attention: projectAttention(app, summary, status, presenceOptions) }; }).filter(({ app, summary, attention }) => {
    const search = [app.name, repository(summary, app), summary?.rootDirectory, summary?.github?.ref, summary?.ota?.ios?.channel, summary?.ota?.android?.channel].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
    return search && (filter === "all" || filter === "attention" && attention.attention || filter === "ota" && attention.problems.length > 0 || filter === "resolved" && attention.resolved.length > 0 || filter === "runner" && attention.runner || filter === "unknown" && attention.unknown);
  });
  const total = document.getElementById("project-total"); if (total) total.textContent = `${apps.length}개 프로젝트`;
  const result = document.getElementById("project-filter-status"); if (result) result.textContent = `검색·상태 조건 일치 ${visible.length}개 / 전체 ${apps.length}개 프로젝트`;
  const rows = visible.map(({ app, summary, attention }) => {
    const selected = state?.selectedApplication?.id === app.id;
    const row = node(document, "article", undefined, "project-card project-operation-row" + (selected ? " selected" : "")); row.id = "project-card-" + app.id; row.setAttribute("data-select-application", app.id); row.setAttribute("data-selected", String(selected));
    const identity = node(document, "button", undefined, "project-row-identity project-open"); identity.type = "button"; identity.setAttribute("data-select-application", app.id); identity.setAttribute("aria-pressed", String(selected)); identity.setAttribute("aria-label", `${clean(app.name)} 앱 개요`);
    const avatar = node(document, "span", clean(app.name).trim().slice(0, 1).toUpperCase() || "F", "project-avatar");
    const branding = options.branding ?? projectBranding;
    const repositoryKey = summary?.github ? `${summary.github.owner}/${summary.github.repository}`.toLowerCase() : "";
    const iconSrc = Object.hasOwn(branding, repositoryKey) ? branding[repositoryKey] : null;
    if (typeof iconSrc === "string" && /^\/project-icons\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,95}\.(?:png|webp|jpg)$/.test(iconSrc) && !iconSrc.includes("..")) {
      const icon = node(document, "img", undefined, "project-app-icon"); icon.setAttribute("src", iconSrc); icon.setAttribute("alt", ""); icon.setAttribute("width", "64"); icon.setAttribute("height", "64"); icon.setAttribute("decoding", "async");
      icon.addEventListener("error", () => avatar.replaceChildren(node(document, "span", clean(app.name).trim().slice(0, 1).toUpperCase() || "F")), { once: true });
      avatar.replaceChildren(icon);
    }
    identity.append(avatar);
    const names = node(document, "span", undefined, "project-row-names"); names.append(node(document, "strong", app.name), node(document, "span", repository(summary, app), "project-row-repository"));
    if (summary?.github?.ref || summary?.rootDirectory && summary.rootDirectory !== ".") names.append(node(document, "small", [summary.github?.ref, summary.rootDirectory && summary.rootDirectory !== "." ? summary.rootDirectory : null].filter(Boolean).join(" · ")));
    identity.append(names); row.append(identity);
    const ota = node(document, "span", undefined, "project-row-ota"); ota.append(publication(document, summary?.ota?.ios, "ios", Boolean(summary), app.id), publication(document, summary?.ota?.android, "android", Boolean(summary), app.id)); row.append(ota);
    const runner = node(document, "span", undefined, "project-row-runner"); runner.append(node(document, "strong", attention.fresh ? `Runner ${runnerLabel(summary?.runner)}` : "현재 연결 미확인", "project-runner-status " + (attention.fresh && summary?.runner?.status === "online" ? "runner-online" : attention.fresh && summary?.runner?.status === "offline" ? "runner-offline" : "")));
    const runnerSeen = Number.isSafeInteger(summary?.runner?.lastSeenAt) && summary.runner.lastSeenAt >= 0 ? `마지막 연결 ${stamp(summary.runner.lastSeenAt)}` : summary ? "PC Runner 연결 기준" : status === "error" ? "불러오지 못함" : "상태 확인 중";
    runner.setAttribute("title", runnerSeen); row.append(runner);
    const evidence = node(document, "details", undefined, "project-card-evidence"); evidence.append(node(document, "summary", "기기 적용·재시작 보고"));
    for (const os of ["ios", "android"]) {
      const value = summary?.ota?.[os];
      const scoped = value && (value.appId === undefined || value.appId === app.id) && (value.platform === undefined || value.platform === os);
      const section = node(document, "section", undefined, "project-evidence-platform"); section.append(node(document, "strong", platform(os)), applicationEvidence(document, scoped ? value : null, os, app.id)); evidence.append(section);
    }
    const issues = node(document, "details", undefined, "project-row-attention");
    if (attention.problems.length) {
      issues.append(node(document, "span", "OTA 미복구 문제", "badge project-attention-badge"), node(document, "small", "최근 배포 또는 연결된 롤백 전 배포에서 같은 설치의 정상 복구가 확인되지 않은 문제입니다."));
      for (const { os, value, resolution, rollbackId } of attention.problems) {
        const context = rollbackId ? "원래 문제의 " : value.rollback ? "롤백 배포의 " : "";
        issues.append(node(document, "small", `${platform(os)} · 미복구 ${resolution.unresolvedInstallations}개 설치${resolution.unknownInstallations ? ` · 이 중 복구 시점 미확인 ${resolution.unknownInstallations}개` : ""}`));
        const paths = node(document, "span", undefined, "project-attention-actions"); paths.append(projectLink(document, `${platform(os)} ${rollbackId ? "원래 문제 배포" : value.rollback ? "문제가 발생한 롤백 배포" : "문제 배포"}`, adminPath("ota-detail", app.id, value.id)), projectLink(document, `${platform(os)} ${context}미복구 기기 이력`, adminPath("ota-unresolved", app.id, value.id))); if (rollbackId) paths.append(projectLink(document, `${platform(os)} 롤백 적용·재시작`, adminPath("ota-detail", app.id, rollbackId))); issues.append(paths);
      }
    }
    if (attention.resolved.length) {
      issues.append(node(document, "span", "OTA 해결됨", "badge project-resolved-badge"), node(document, "small", "같은 설치에서 마지막 문제 이후 원래 배포 또는 롤백 배포의 정상 적용·재시작을 확인했습니다. 실패 이력은 보존됩니다."));
      for (const { os, value, resolution, rollbackId } of attention.resolved) {
        const context = rollbackId ? "원래 문제의 " : value.rollback ? "롤백 배포의 " : "";
        const paths = node(document, "span", undefined, "project-attention-actions"); paths.append(node(document, "small", `${platform(os)} · 해결됨 ${resolution.resolvedInstallations}개 설치${resolution.rollbackResolvedInstallations ? ` · 롤백으로 해결됨 ${resolution.rollbackResolvedInstallations}개` : ""}`), projectLink(document, `${platform(os)} ${context}해결된 기기 이력`, adminPath("ota-resolved", app.id, value.id)));
        if (rollbackId) paths.append(projectLink(document, `${platform(os)} 롤백 적용·재시작`, adminPath("ota-detail", app.id, rollbackId)));
        issues.append(paths);
      }
    }
    if (attention.runner) { issues.append(node(document, "span", "Runner 확인 필요", "badge project-attention-badge"), node(document, "small", `자동 배포 정책 켜짐 · Runner ${runnerLabel(summary.runner)}`), projectLink(document, "Runner 상태·로그", adminPath("runners", app.id))); }
    if (attention.unknown) issues.append(node(document, "span", "운영 상태 미확인", "badge project-unknown-badge"), node(document, "small", attention.fresh ? "기기 보고 또는 배포·Runner 정보의 확인이 필요합니다." : "현재 운영 정보가 미확인이거나 이전 확인 정보입니다."));
    if (issues.children.length) { const heading = node(document, "summary", attention.problems.length ? `OTA 미복구 ${attention.problems.length}개 플랫폼 · 상세 보기` : attention.runner ? "Runner 확인 필요 · 상태와 이력" : attention.resolved.length ? "해결된 OTA 이력 보기" : "기기 보고·운영 상태 안내"); const content = node(document, "div", undefined, "project-attention-content"); content.append(node(document, "p", runnerSeen, "subtle"), ...Array.from(issues.children)); issues.replaceChildren(heading, content); evidence.append(issues); }
    if (attention.problems.length) evidence.firstElementChild.textContent = `OTA 미복구 ${attention.problems.length}개 플랫폼 · 기기 보고`;
    row.append(evidence);
    if (status === "error" || status === "loading") row.append(node(document, "span", summary ? status === "error" ? "이전 확인 정보 · 현재 상태를 불러오지 못했습니다" : "이전 확인 정보 · 새로 확인 중" : status === "error" ? "운영 정보를 불러오지 못했습니다 · 상태 미확인" : "운영 정보 확인 중", "project-row-snapshot-note"));
    const footer = node(document, "footer", undefined, "project-card-footer");
    for (const [label, page] of [["앱 개요", "overview"], ["배포·이력 보기", "ota"]]) { const path = adminPath(page, app.id); if (path) footer.append(projectLink(document, label, path, false)); }
    row.append(footer);
    return row;
  });
  if (!rows.length) rows.push(node(document, "p", apps.length ? "검색·상태 조건에 맞는 프로젝트가 없습니다. 이름·저장소·배포 채널 또는 상태 조건을 바꿔보세요." : "프로젝트를 등록해 GitHub 소스와 OTA 배포를 연결하세요.", "project-empty"));
  target.replaceChildren(...rows);
}
function detectionFor(operations) {
  const c = operations?.connection; if (!c) return null;
  return operations.detections?.find(value => value.appId === c.appId && value.connection && ["appId", "version", "installationId", "owner", "repository", "ref"].every(key => value.connection[key] === c[key]) && Number.isSafeInteger(value.detectedAt) && value.detectedAt >= c.connectedAt && (operations.expectedRootDirectory === undefined || value.rootDirectory === operations.expectedRootDirectory)) ?? null;
}
function overviewCard(document, label, value, note) { const card = node(document, "article", undefined, "overview-operation-card"); card.append(node(document, "span", label, "overview-operation-label"), node(document, "strong", value)); if (note) card.append(node(document, "p", note, "subtle")); return card; }
export function renderOperationalOverview(document, app, inputs = {}) {
  const target = document.getElementById("project-readiness"); if (!target) return;
  if (!app) { target.replaceChildren(node(document, "p", "프로젝트를 선택하세요.", "subtle")); return; }
  const summary = inputs.summary?.id === app.id ? inputs.summary : null;
  const candidateOperations = inputs.operations;
  const operations = candidateOperations && (!candidateOperations.connection || candidateOperations.connection.appId === app.id) && [candidateOperations.detections, candidateOperations.deployments].every(values => !Array.isArray(values) || values.every(value => value.appId === app.id)) ? candidateOperations : null; const connection = operations?.connection?.appId === app.id ? operations.connection : summary?.github;
  const candidateDetection = Object.prototype.hasOwnProperty.call(inputs, "detection") ? inputs.detection : detectionFor(operations); const detection = candidateDetection?.appId === app.id ? candidateDetection : null;
  const automation = inputs.automation && Array.isArray(inputs.automation.jobs) && Array.isArray(inputs.automation.runners) && inputs.automation.jobs.every(job => job.appId === app.id) && (!inputs.automation.policy || inputs.automation.policy.appId === app.id) ? inputs.automation : null;
  const policy = automation ? automation.policy : summary?.automation;
  const grid = node(document, "div", undefined, "operational-overview-grid");
  grid.append(overviewCard(document, "GitHub 저장소", connection ? `${connection.owner}/${connection.repository}` : repository(summary, app), connection ? `브랜치 / ref · ${connection.ref}` : "현재 연결 확인 필요"));
  grid.append(overviewCard(document, "앱 Runtime", detection?.runtimeVersion || "현재 소스 미확인", detection ? `${detection.framework} · 소스 읽기 확인` : "소스 읽기 미검증 · 현재 연결의 소스를 동기화하세요"));
  grid.append(overviewCard(document, "자동 배포 정책", policy ? policy.enabled ? `${policy.channel} · 켜짐` : "꺼짐" : "정책 미확인", policy?.enabled ? (policy.platforms ?? [policy.platform]).map(platform).join(" + ") : "GitHub push 정책 기준"));
  let runner = summary?.runner;
  if (Array.isArray(automation?.runners)) {
    const active = automation.runners.filter(value => value.revokedAt === null && value.appIds?.includes(app.id));
    runner = { status: !active.length ? "unregistered" : active.some(value => value.presence?.status === "online") ? "online" : active.some(value => value.presence?.status === "offline") ? "offline" : "unseen" };
  }
  grid.append(overviewCard(document, "PC Runner", currentPresence(inputs) ? runnerLabel(runner) : "현재 연결 미확인", "온라인은 연결 상태이며 빌드·게시 성공과 별도입니다"));
  for (const os of ["ios", "android"]) {
    const value = summary?.ota?.[os] ?? operations?.deployments?.find(item => item.appId === app.id && item.platform === os);
    const sourcePublication = value && (operations?.deployments?.find(item => item.appId === app.id && item.id === value.id) ?? value);
    const current = Boolean(sourcePublication && detection && sourcePublication.detectionId === detection.id && sourcePublication.commitSha === detection.commitSha && sourcePublication.runtimeVersion === detection.runtimeVersion && (!policy || sourcePublication.channel === policy.channel));
    const otaCard = overviewCard(document, `${platform(os)} 최근 OTA 게시`, value ? `${value.channel} · ${stamp(value.createdAt)}` : summary || Array.isArray(operations?.deployments) ? "게시 이력 없음" : "게시 상태 미확인", value ? current ? "현재 소스 게시 확인 · 기기 적용은 별도" : "최근 게시 이력 · 현재 소스 게시는 " + (inputs.automation ? "확인된 게시 없음" : "상태 확인 필요") : "다운로드·적용 이력은 별도 검증");
    otaCard.append(applicationEvidence(document, value, os, app.id, true)); grid.append(otaCard);
  }
  const technical = [["프로젝트 ID", app.id], ["앱 폴더", summary?.rootDirectory ?? app.rootDirectory], ["고정 소스 Commit", detection?.commitSha ?? "미확인"], ["GitHub 연결 버전", connection?.version ?? "미확인"]];
  for (const os of ["ios", "android"]) {
    const currentJob = detection && automation?.policy && automation.jobs.find(job => job.appId === app.id && job.platform === os && job.state === "succeeded" && job.deploymentId && job.detectionId === detection.id && job.commitSha === detection.commitSha && job.runtimeVersion === detection.runtimeVersion && job.channel === automation.policy.channel);
    if (currentJob) technical.push([`${platform(os)} 현재 소스 게시 ID`, currentJob.deploymentId]);
  }
  const details = technicalDetails(document, technical);
  const children = [grid, node(document, "p", "OTA 게시됨은 기기의 다운로드·설치·재시작 완료를 의미하지 않습니다.", "subtle publication-scope-note"), details];
  if (inputs.status === "error") children.unshift(node(document, "p", "현재 운영 정보를 불러오지 못했습니다. 표시된 이력은 마지막 확인 정보입니다.", "project-row-snapshot-note"));
  target.replaceChildren(...children);
}
function launchURL(appId, asset) { const digest = asset?.digest ?? (/^asset_[a-f0-9]{64}$/.test(asset?.id ?? "") ? asset.id.slice(6) : null); return /^[a-f0-9]{64}$/.test(digest ?? "") ? `/updates/${encodeURIComponent(appId)}/assets/${digest}` : null; }
export function renderCompactOtaHistory(document, appId, deployments, options = {}) {
  const target = document.getElementById(options.targetId ?? "ota-history"); if (!target) return;
  const entries = Array.isArray(deployments) ? deployments.filter(value => value.appId === appId) : [];
  const rows = entries.map(value => {
    const row = node(document, "article", undefined, "record compact-operation-record"); const head = node(document, "div", undefined, "record-heading"); head.append(node(document, "h3", `${platform(value.platform)} · ${value.channel}`), node(document, "span", "게시됨", "badge success")); row.append(head, node(document, "p", `${stamp(value.createdAt)} · Runtime ${value.runtimeVersion}`, "record-note"), node(document, "p", "기기 다운로드·적용은 별도 확인", "subtle"));
    if (value.rollback && typeof value.rollback.reason === "string" && [value.rollback.fromDeploymentId, value.rollback.targetDeploymentId].every(id => adminPath("ota-detail", appId, id))) {
      const automatic = validateAutomaticRollbackDecision(value.automaticRollback, appId) && value.automaticRollback.rollbackDeploymentId === value.id && value.automaticRollback.platform === value.platform && value.automaticRollback.channel === value.channel && value.automaticRollback.runtimeVersion === value.runtimeVersion;
      row.append(node(document, "p", `${automatic ? "실패율 기준 자동 롤백" : "관리자 롤백"} · ${stamp(value.rollback.requestedAt)} · ${value.rollback.reason}`, "record-note"));
      for (const [label, id] of [["롤백 전 배포", value.rollback.fromDeploymentId], ["복원 원본 배포", value.rollback.targetDeploymentId]]) { const link = node(document, "a", label, "button secondary small"); const path = adminPath("ota-detail", appId, id); link.setAttribute("href", path); link.setAttribute("data-deployment-path", path); row.append(link); }
    }
    row.append(applicationEvidence(document, value, value.platform, appId, true));
    const decision=value.automaticRollback;
    if (validateAutomaticRollbackDecision(decision,appId) && [decision.sourceDeploymentId,decision.rollbackDeploymentId].includes(value.id) && decision.platform === value.platform && decision.channel === value.channel && decision.runtimeVersion === value.runtimeVersion) {
      const cancelled = decision.status === "skipped" && decision.lastErrorCode === "AUTO_ROLLBACK_RECOVERED";
      const status = decision.status === "succeeded" ? "복구 배포 게시됨" : cancelled ? "실패 기준 미충족으로 취소" : decision.status === "skipped" ? "실행 건너뜀" : decision.status === "failed" ? "게시 실패" : "처리 중";
      row.append(node(document,"p",`자동 롤백 감지 · ${status}`,"record-note"), node(document,"p",`최초 감지 · 실패 ${decision.failedInstallations} / ${decision.attemptedInstallations}개 설치 · ${decision.failureRatePercent.toFixed(1)}%`,"record-note"), node(document,"small","자동 롤백 판단에 허용한 설치 기준 · SDK 전체 보고 설치 수와 구분","application-report-scope"));
      if (decision.cancellation) {
        const checked = decision.cancellation;
        row.append(node(document,"p",`취소 시 재확인 · 실패 ${checked.failedInstallations} / ${checked.attemptedInstallations}개 설치 · ${checked.failureRatePercent === null ? "실패율 미확인" : checked.failureRatePercent.toFixed(1) + "%"}`,"record-note"), node(document,"p",`동일 배포 정상 실행 확인 ${checked.confirmedHealthyInstallations}개 · 최초 실패 설치의 회복을 뜻하지 않습니다.`,"subtle"));
      } else if (cancelled) row.append(node(document,"p","취소는 정상 적용·재시작 확인과 별도입니다. 취소 시 재확인 수치는 기록되지 않았습니다.","subtle"));
    }
    const detailPath = adminPath("ota-detail", appId, value.id); if (detailPath) { const link = node(document, "a", "기기별 적용 현황", "button secondary small"); link.setAttribute("href", detailPath); link.setAttribute("data-deployment-path", detailPath); row.append(link); }
    const download = launchURL(appId, value.launchAsset); if (download) { const link = node(document, "a", "Launch bundle 다운로드", "button secondary small"); link.href = download; link.download = ""; row.append(link); }
    row.append(technicalDetails(document, [["Deployment ID", value.id], ["프로젝트 ID", appId], ["Commit SHA", value.commitSha], ["업데이트 URL", `/updates/${encodeURIComponent(appId)}?channel=${encodeURIComponent(value.channel)}`], ["Launch 다운로드", download ?? "미확인"]])); return row;
  });
  if (options.status === "error") rows.unshift(node(document, "p", "게시 이력을 불러오지 못했습니다. 현재 게시 여부는 미확인입니다.", "notice notice-error"));
  else if (!rows.length) rows.push(node(document, "p", options.status === "loading" ? "게시 이력 확인 중" : "게시한 OTA 없음 · 기기 적용 여부는 별도입니다.", "subtle"));
  target.replaceChildren(...rows);
}
export function renderCompactAutomationJobs(document, appId, state, options = {}) {
  const target = document.getElementById(options.targetId ?? "automation-history"); if (!target) return;
  const oldDetails = new Map(Array.from(target.querySelectorAll?.("details[data-job]") ?? []).map(value => [value.getAttribute("data-job"), value]));
  const os = document.getElementById("automation-history-platform")?.value || "all";
  const result = document.getElementById("automation-history-result")?.value || "all";
  const all = Array.isArray(state?.jobs) ? state.jobs.filter(job => job.appId === appId) : [];
  const filtered = all.filter(job => (os === "all" || job.platform === os) && (result === "all" || result === "active" && ["queued", "leased", "cancel_requested"].includes(job.state) || result === job.state));
  const labels = { queued: "Runner 대기", leased: "Runner 작업 중", cancel_requested: "취소 처리 중", succeeded: "OTA 게시 완료", failed: "작업 실패", cancelled: "취소됨" };
  const rows = filtered.map(job => {
    const row = node(document, "article", undefined, "record compact-operation-record"); const head = node(document, "div", undefined, "record-heading"); head.append(node(document, "h3", `${platform(job.platform)} · ${job.channel}`), node(document, "span", labels[job.state] ?? "상태 미확인", "badge " + (job.state === "succeeded" ? "success" : "neutral"))); row.append(head, node(document, "p", `${stamp(job.updatedAt)} · 시도 ${job.attemptCount}회 · Runtime ${job.runtimeVersion}`, "record-note"));
    if (job.code) row.append(node(document, "p", `결과 코드 · ${job.code}`, "record-code"));
    if (job.state === "succeeded") row.append(node(document, "p", "게시 완료 · 기기 다운로드·적용은 별도 확인", "subtle"));
    if (["queued", "leased"].includes(job.state)) { const cancel = node(document, "button", "자동 작업 취소", "button secondary small"); cancel.type = "button"; cancel.setAttribute("data-cancel-automation", job.id); row.append(cancel); }
    row.append(technicalDetails(document, [["작업 ID", job.id], ["프로젝트 ID", appId], ["Commit SHA", job.commitSha], ["게시 ID", job.deploymentId ?? "없음"], ["작업 등록", stamp(job.createdAt)], ["Runner 시도 ID", job.lease?.attemptId ?? "없음"], ["Runner ID", job.lease?.runnerId ?? "없음"], ["Lease 만료", job.lease ? stamp(job.lease.expiresAt) : "없음"]]));
    const detail = oldDetails.get(job.id) ?? node(document, "details", undefined, "automation-log-details"); detail.setAttribute("data-job", job.id);
    if (!oldDetails.has(job.id)) { const summary = node(document, "summary", "시도 · 상태 변경 · 실패 도움말"); summary.setAttribute("data-automation-job", job.id); const body = node(document, "div", "열어서 작업별 이력을 확인하세요.", "automation-job-detail"); body.id = "automation-job-" + job.id; detail.append(summary, body); }
    row.append(detail); return row;
  });
  if (options.status === "error") rows.unshift(node(document, "p", "자동 작업 이력을 불러오지 못했습니다. 현재 상태는 미확인입니다.", "notice notice-error"));
  else if (!rows.length) rows.push(node(document, "p", options.status === "loading" || !state ? "자동 작업 이력 확인 중" : all.length ? "필터에 맞는 작업 없음 · 전체 플랫폼과 결과로 변경해 확인하세요." : "자동 작업 없음 · 수동 파일 게시와 별도로 기록됩니다.", "subtle"));
  target.replaceChildren(...rows);
}
function validVerification(value, os, appId, deploymentId) {
  if (!value || value.source !== "operator-verification" || !["android-emulator", "ios-simulator", "physical-device"].includes(value.environment) || value.environment === "android-emulator" && os !== "android" || value.environment === "ios-simulator" && os !== "ios" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || !/^[a-f0-9]{64}$/.test(value.receiptDigest ?? "") || ["applied", "restarted", "signatureVerified", "assetsVerified"].some(key => typeof value[key] !== "boolean") || value.appId !== undefined && value.appId !== appId || value.deploymentId !== undefined && value.deploymentId !== deploymentId) return null;
  return value;
}
const sdkFailureLabels = Object.freeze({ NETWORK_UNAVAILABLE: "네트워크 연결 실패", TIMEOUT: "응답 시간 초과", SIGNATURE_INVALID: "서명 검증 실패", ASSET_HASH_MISMATCH: "파일 무결성 불일치", UPDATE_INCOMPATIBLE: "앱 Runtime 호환 불가", UNCONFIRMED_LAUNCH: "실행 확인 실패", STORED_UPDATE_INVALID: "저장된 업데이트 검증 실패", NATIVE_OPERATION_FAILED: "네이티브 엔진 작업 실패", CHECK_FAILED: "업데이트 확인 실패", DOWNLOAD_FAILED: "다운로드 실패", ACTIVATION_FAILED: "적용 실패", LAUNCH_CONFIRMATION_FAILED: "재시작 실행 확인 실패", UNKNOWN: "원인 미확인" });
export function isValidSdkTelemetry(value, os) {
  if (!value || value.source !== "sdk-self-report") return false;
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const total = value.observedInstallations;
  if (![total, value.lastReportedAt].every(count) || !["downloadedInstallations", "appliedInstallations", "restartedInstallations", "failedInstallations", "rolledBackInstallations"].every(key => count(value[key]) && value[key] <= total)) return false;
  if (value.recoveredInstallations !== undefined && (!count(value.recoveredInstallations) || value.recoveredInstallations > Math.min(total, value.appliedInstallations, value.restartedInstallations, value.failedInstallations + value.rolledBackInstallations))) return false;
  if (value.applicationRate !== (total ? value.appliedInstallations / total * 100 : null)) return false;
  const env = value.environments;
  if (!env || !["physicalDevice", "androidEmulator", "iosSimulator", "unknown"].every(key => count(env[key])) || env.physicalDevice + env.androidEmulator + env.iosSimulator + env.unknown !== total || os === "ios" && env.androidEmulator !== 0 || os === "android" && env.iosSimulator !== 0) return false;
  return Array.isArray(value.failures) && value.failures.length <= 52 && value.failures.every(item => item && ["check", "download", "activation", "launch"].includes(item.stage) && Object.hasOwn(sdkFailureLabels, item.code) && count(item.installations) && item.installations <= total && count(item.lastReportedAt) && item.lastReportedAt <= value.lastReportedAt);
}
function sdkTelemetry(document, value, os, detailed) {
  const result = node(document, "span", undefined, "sdk-telemetry-summary");
  if (!isValidSdkTelemetry(value, os)) { result.append(node(document, "small", "사용자 적용 보고 미수집", "application-report-scope")); return result; }
  result.append(node(document, "strong", value.applicationRate === null ? "SDK 보고 설치 기준 누적 적용률 미확인" : `SDK 보고 설치 기준 누적 적용률 ${value.applicationRate.toFixed(1)}%`));
  result.append(node(document, "small", `보고 ${value.observedInstallations} · 다운로드 ${value.downloadedInstallations} · 적용 ${value.appliedInstallations} · 재시작 ${value.restartedInstallations} · 일반 실패 보고 ${value.failedInstallations} · 네이티브 자동 복구 ${value.rolledBackInstallations}`));
  if (value.recoveredInstallations !== undefined) result.append(node(document, "small", `동일 설치 실패 후 적용·재시작 확인 ${value.recoveredInstallations}개 설치`, "sdk-telemetry-recovery"));
  else result.append(node(document, "small", "동일 설치 복구 미확인 · 이전 SDK 보고에는 복구 집계가 없을 수 있습니다.", "sdk-telemetry-recovery"));
  result.append(node(document, "small", "각 항목은 누적 설치 수이며 서로 겹칠 수 있어 합산하지 않습니다.", "application-report-scope"));
  if (detailed) result.append(node(document, "small", "과거 미보고 복구는 소급 집계하지 않습니다. 실패 원인에는 일반 실패와 네이티브 자동 복구의 보고가 함께 포함됩니다.", "application-report-scope"));
  const env = value.environments;
  result.append(node(document, "small", `SDK 자체 보고 환경 · 실기기 ${env.physicalDevice} · Android 에뮬레이터 ${env.androidEmulator} · iOS 시뮬레이터 ${env.iosSimulator} · 미확인 ${env.unknown}`));
  result.append(node(document, "small", `최근 보고 ${stamp(value.lastReportedAt)} · 이 배포를 보고한 설치 기준, 전체 설치 기기 수와 다름`, "application-report-scope"));
  const failures = detailed ? value.failures : value.failures.slice(0, 1);
  for (const item of failures) result.append(node(document, "small", `${{check:"확인",download:"다운로드",activation:"적용",launch:"실행"}[item.stage]} · ${sdkFailureLabels[item.code]} · ${item.installations}개 설치${detailed ? " · " + stamp(item.lastReportedAt) : ""}`, "sdk-telemetry-failure"));
  if (!detailed && value.failures.length > 1) result.append(node(document, "small", `추가 실패 원인 ${value.failures.length - 1}개 · 앱 상세에서 확인`));
  return result;
}
function applicationEvidence(document, value, os, appId, detailed = false) {
  const evidence = validVerification(value?.verification, os, appId, value?.id);
  const result = node(document, "span", undefined, "project-application-evidence");
  if (evidence) {
    const environment = { "android-emulator": "Android 에뮬레이터", "ios-simulator": "iOS 시뮬레이터", "physical-device": "실기기" }[evidence.environment];
    const complete = evidence.applied && evidence.restarted && evidence.signatureVerified && evidence.assetsVerified;
    result.append(node(document, "span", `${environment} · ${complete ? "적용·재시작 검증" : "적용 검증 미완료"}`, "application-verification-badge " + (complete ? "verified" : "")), node(document, "small", `운영자 검증 ${stamp(evidence.observedAt)}`));
  } else result.append(node(document, "span", "적용 검증 미확인", "application-verification-badge"));
  const report = value?.telemetry;
  const scopedReport = report && (report.appId === undefined || report.appId === appId) && (report.deploymentId === undefined || report.deploymentId === value?.id) && (report.platform === undefined || report.platform === os) ? report : null;
  result.append(sdkTelemetry(document, scopedReport, os, detailed));
  return result;
}
function usageMeter(document, label, count, limit, current = true) {
  const card = node(document, "article", undefined, "workspace-quota-meter");
  card.append(node(document, "span", label, "overview-operation-label"));
  const known = Number.isSafeInteger(count) && count >= 0;
  card.append(node(document, "strong", known ? `${count.toLocaleString("ko-KR")} / ${limit.toLocaleString("ko-KR")}` : "사용량 미확인"));
  const progress = node(document, "progress", undefined, "quota-progress"); progress.max = limit;
  if (known) { progress.value = Math.min(count, limit); progress.setAttribute("value", String(Math.min(count, limit))); progress.setAttribute("aria-label", `${label} ${((count / limit) * 100).toFixed(1)}%`); }
  else { progress.hidden = true; progress.setAttribute("aria-label", `${label} 미확인`); }
  progress.setAttribute("max", String(limit)); card.append(progress);
  card.append(node(document, "small", known ? current ? `${((count / limit) * 100).toFixed(1)}% 사용 · ${Math.max(0, limit - count).toLocaleString("ko-KR")} 남음` : `${((count / limit) * 100).toFixed(1)}% · 이전 측정 기준, 현재 남은 한도 미확인` : "측정값을 받아야 남은 한도를 알 수 있습니다", "subtle"));
  return card;
}
export function renderWorkspaceStatus(document, result, options = {}) {
  const target = document.getElementById("workspace-status"); if (!target) return;
  const projects = Array.isArray(result?.projects) ? result.projects : null;
  const counts = node(document, "div", undefined, "workspace-operation-summary");
  for (const [label, value] of [["등록 프로젝트", projects?.length], ["최근 OTA 게시", projects ? projects.reduce((total, app) => total + Number(Boolean(app.ota?.ios)) + Number(Boolean(app.ota?.android)), 0) : null], ["PC Runner 온라인 앱", projects && currentPresence(options) ? projects.filter(app => app.runner?.status === "online").length : null]]) counts.append(overviewCard(document, label, value === null || value === undefined ? "미확인" : `${value}개`, label === "최근 OTA 게시" ? "앱별 iOS·Android 최근 게시 슬롯 · 적용 수 아님" : label === "PC Runner 온라인 앱" ? "Runner 연결 상태 · 배포 성공과 별도" : "현재 계정의 등록 앱"));
  const infrastructure = document.getElementById("workspace-infrastructure");
  const quota = node(document, "details", undefined, "workspace-quota"); quota.open = infrastructure?.firstElementChild?.open === true;
  const candidate = result?.usage;
  const usage = candidate?.scope === "account" && candidate.source === "cloudflare-graphql" && ["ready", "stale", "unconfigured", "error", "pending"].includes(candidate.status) ? candidate : null;
  const timeExpired = Number.isSafeInteger(options.now) && usage && (usage.day !== new Date(options.now).toISOString().slice(0, 10) || Number.isSafeInteger(usage.freshUntil) && options.now > usage.freshUntil);
  const status = (options.status === "error" || timeExpired) && usage?.status === "ready" ? "stale" : usage?.status ?? (options.status === "loading" ? "pending" : "unconfigured");
  const title = node(document, "summary"); title.append(node(document, "strong", "Cloudflare 인프라 사용량"), node(document, "small", status === "ready" ? "최근 측정값" : status === "stale" ? "이전 측정값" : "사용량 확인 대기")); quota.append(title);
  quota.append(node(document, "p", "아래 한도는 프로젝트 등록 수가 아니라, 연결한 Cloudflare 계정 전체의 D1 무료 일일 사용량 기준입니다.", "subtle"));
  const measured = usage && ["ready", "stale"].includes(status);
  const meters = node(document, "div", undefined, "workspace-quota-grid"); meters.append(usageMeter(document, "행 읽기 / 일", measured ? usage.rowsRead : null, 5_000_000, status === "ready"), usageMeter(document, "행 쓰기 / 일", measured ? usage.rowsWritten : null, 100_000, status === "ready")); quota.append(meters);
  const note = { ready: "Cloudflare GraphQL 측정값 · Flora 외 같은 계정의 D1 사용량도 포함", stale: "이전 측정값 · 현재 사용량 갱신 대기, 실제 남은 한도와 다를 수 있습니다", unconfigured: "사용량 조회 연결 미설정 · 무료 한도를 0으로 간주하지 않습니다", error: "사용량 조회 실패 · 현재 남은 한도 미확인", pending: "사용량 조회 대기 · 현재 남은 한도 미확인" }[status];
  quota.append(node(document, "p", note, "subtle quota-status-note"));
  if (usage?.collectedBy === "pc-runner") quota.append(node(document, "p", "PC Runner가 조회한 Cloudflare 계정 지표 · 10분 간격", "subtle"));
  quota.append(node(document, "p", `집계일 ${usage?.day && /^\d{4}-\d{2}-\d{2}$/.test(usage.day) ? usage.day + " UTC" : "미확인"} · 일일 초기화 ${Number.isSafeInteger(usage?.resetAt) && usage.resetAt >= 0 ? stamp(usage.resetAt) : "미확인"}`, "subtle"), node(document, "p", `측정 시각 ${Number.isSafeInteger(usage?.observedAt) && usage.observedAt >= 0 ? stamp(usage.observedAt) : "미확인"} · 자동 새로 조회 대신 캐시된 측정값을 표시합니다`, "subtle"));
  const children = [counts];
  if (options.status === "error") children.unshift(node(document, "p", "현재 운영 요약을 불러오지 못했습니다. 마지막 확인 정보가 있으면 보존해 표시합니다.", "project-row-snapshot-note"));
  target.replaceChildren(...children);
  if (infrastructure) infrastructure.replaceChildren(quota);
}
