/** Explicit console pages. This public module contains no application data. */
export const ADMIN_PAGES = Object.freeze({
  onboarding: {title:"Flora 시작하기",description:"관리자 등록부터 GitHub · SDK · PC Runner · 첫 OTA까지 안내합니다.",section:"page-onboarding",legacy:"account"},
  projects: { title: "프로젝트", description: "등록한 앱을 찾고, 각 앱의 관리 화면을 여세요.", section: "application-panel", legacy: "apps" },
  register: { title: "프로젝트 등록", description: "GitHub 저장소와 앱 폴더를 선택해 새 프로젝트를 연결하세요.", section: "page-register", legacy: "account" },
  overview: { title: "앱 개요", description: "선택한 앱의 소스, Runner와 배포 상태를 확인하세요.", section: "page-overview", legacy: "updates" },
  source: { title: "GitHub · SDK", description: "앱의 저장소 연결, 인식된 설정과 소스 근거를 관리하세요.", section: "page-source", legacy: "sources" },
  ota: { title: "OTA 배포", description: "앱별 업데이트 서명과 게시 이력을 확인하세요.", section: "view-updates", legacy: "updates" },
  "ota-detail": { title: "배포별 기기 현황", description: "익명 설치별 다운로드·적용·재시작과 실패 후 복구 기록을 확인하세요.", section: "page-ota-detail", legacy: "updates" },
  runners: { title: "Runner", description: "자동 배포 정책과 PC Runner, 실행 로그를 관리하세요.", section: "page-runners", legacy: "updates" },
  builds: { title: "네이티브 빌드", description: "고정한 GitHub 커밋으로 빌드·서명을 요청하고 결과를 확인하세요.", section: "page-builds", legacy: "account" },
  credentials: { title: "인증서 · 키", description: "앱별 인증서, Google·푸시 키와 교체 이력을 관리하세요.", section: "page-credentials", legacy: "account" },
  "app-settings": { title: "앱 설정", description: "선택한 앱의 공개 설정과 설정 버전을 관리하세요.", section: "page-app-settings", legacy: "account" },
  activity: { title: "소스 반입 이력", description: "선택한 앱의 소스와 개발 검증 반입 기록을 확인하세요.", section: "page-activity", legacy: "history" },
  settings: { title: "작업실 설정", description: "현재 작업실과 소유자 계정을 확인하세요.", section: "view-account", legacy: "account" },
});
const appIdPattern = /^[a-z][a-z0-9_-]{2,95}$/;
const globalPaths = Object.freeze({ onboarding: "/onboarding", projects: "/projects", register: "/projects/new", settings: "/settings" });
const appSegments = Object.freeze({ overview: "", source: "source", ota: "ota", runners: "runners", builds: "builds", credentials: "credentials", "app-settings": "settings", activity: "activity" });
export function adminPath(page, appId = null, deploymentId = null) {
  if (["ota-detail", "ota-issues", "ota-unresolved", "ota-resolved"].includes(page)) return typeof appId === "string" && appIdPattern.test(appId) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deploymentId ?? "") ? `/apps/${appId}/ota/${deploymentId}${page === "ota-detail" ? "" : "/" + page.slice(4)}` : null;
  if (Object.hasOwn(globalPaths, page)) return globalPaths[page];
  if (!Object.hasOwn(appSegments, page) || typeof appId !== "string" || !appIdPattern.test(appId)) return null;
  return `/apps/${appId}${appSegments[page] ? "/" + appSegments[page] : ""}`;
}
export function parseAdminPath(pathname) {
  if (typeof pathname !== "string" || /[?#%\\\x00-\x20]/.test(pathname)) return null;
  if (pathname === "/") return { page: "projects", appId: null, path: "/projects" };
  for (const [page, path] of Object.entries(globalPaths)) if (pathname === path) return { page, appId: null, path };
  const detail = /^\/apps\/([a-z][a-z0-9_-]{2,95})\/ota\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(issues|unresolved|resolved))?$/.exec(pathname);
  if (detail) return { page: "ota-detail", appId: detail[1], deploymentId: detail[2], ...(detail[3] ? { filter: detail[3] } : {}), path: pathname };
  const match = /^\/apps\/([a-z][a-z0-9_-]{2,95})(?:\/(source|ota|runners|builds|credentials|settings|activity))?$/.exec(pathname);
  if (!match) return null;
  const page = !match[2] ? "overview" : match[2] === "settings" ? "app-settings" : match[2];
  return { page, appId: match[1], path: adminPath(page, match[1]) };
}
