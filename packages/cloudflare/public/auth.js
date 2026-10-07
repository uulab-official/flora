/** Password length is measured in Unicode codepoints, never UTF-16 input limits. */
export function validPassword(value) {
  if (typeof value !== "string" || !value.isWellFormed()) return false;
  const length = [...value].length;
  return length >= 15 && length <= 128 && new TextEncoder().encode(value).length <= 1024;
}

export function startAuth(env) {
  const { document } = env;
  const node = id => document.getElementById(id);
  const setup = env.location.pathname === "/setup";
  let busy = false; let closed = false; let generation = 0; let pending;
  function clear(all = false) { for (const id of ["password", "confirmation", "token", ...(all ? ["email"] : [])]) node(id).value = ""; }
  function status(text, alert = false) { const target = node("auth-status"); target.hidden = !text; target.textContent = text; target.setAttribute("role", alert ? "alert" : "status"); }
  function controls() {
    for (const id of ["email", "password", "auth-submit", "setup-mode"]) node(id).disabled = closed || busy;
    for (const id of ["token", "confirmation"]) node(id).disabled = closed || busy || !setup;
    node("auth-form").setAttribute("aria-busy", busy ? "true" : "false");
  }
  function mode() {
    if (busy || closed) return;
    clear();
    const recover = setup && node("setup-mode").value === "recover";
    node("auth-title").textContent = setup ? recover ? "소유자 비밀번호 복구" : "최초 비밀번호 등록" : "소유자 로그인";
    node("auth-submit").textContent = setup ? recover ? "승인 코드로 비밀번호 복구" : "승인 코드로 비밀번호 등록" : "로그인";
    node("auth-description").textContent = setup ? "소유자가 별도로 발급한 승인 코드가 있어야 합니다. 등록은 기본적으로 잠겨 있으며, 이메일만으로 가입할 수 없습니다." : "설정된 소유자 계정으로 로그인하면 반입한 앱 정보와 이력을 다시 볼 수 있습니다.";
    node("password-note").textContent = setup ? "15–128자 · 공백과 이모지를 포함할 수 있습니다. 붙여넣기를 허용하며 입력한 내용을 그대로 사용합니다." : "비밀번호 붙여넣기를 사용할 수 있습니다.";
    node("password").setAttribute("autocomplete", setup ? "new-password" : "current-password");
    status(""); controls();
  }
  async function submit() {
    if (busy || closed) return;
    const purpose = setup ? node("setup-mode").value : "login";
    if (setup && !["enroll", "recover"].includes(purpose)) return;
    let payload = { email: node("email").value, password: node("password").value };
    if (!payload.email || !payload.password) { status("소유자 이메일과 비밀번호를 입력해 주세요.", true); return; }
    if (setup) {
      payload.token = node("token").value; payload.confirmation = node("confirmation").value;
      if (!/^[A-Za-z0-9_-]{43}$/.test(payload.token)) { status("소유자가 발급한 유효한 승인 코드를 직접 입력해 주세요.", true); return; }
      if (!validPassword(payload.password)) { status("비밀번호는 15–128 Unicode 문자, UTF-8 1,024바이트 이내여야 합니다.", true); return; }
      if (payload.password !== payload.confirmation) { status("두 비밀번호가 일치하지 않습니다. 공백도 그대로 확인해 주세요.", true); return; }
    }
    let body = JSON.stringify(payload); payload = null;
    if (new TextEncoder().encode(body).length > 8192) { body = ""; status("입력한 내용이 허용 크기를 초과했습니다.", true); return; }
    busy = true; const version = ++generation; pending = new AbortController(); controls(); clear(); status("확인 중… 잠시 기다려 주세요.");
    try {
      const request = env.fetch("/api/auth/" + purpose, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body, signal: pending.signal });
      body = "";
      const response = await request;
      if (closed || version !== generation) return;
      if (!response.ok) {
        status(response.status === 429 ? "잠시 후 다시 시도해 주세요. 인증 시도 한도에 도달했습니다." : response.status === 409 ? "현재 다른 요청을 처리 중이거나 설정 권한을 사용할 수 없습니다. 잠시 후 승인 코드의 유효성을 확인해 주세요." : response.status === 401 || response.status === 403 ? "인증 정보를 확인하지 못했습니다. 이메일·비밀번호와 승인 코드의 유효성을 확인해 주세요." : "인증을 완료하지 못했습니다. 연결 상태를 확인하고 잠시 후 다시 시도해 주세요.", true);
        return;
      }
      const session = await response.json();
      if (closed || version !== generation) return;
      if (typeof session.csrfToken !== "string" || !session.csrfToken || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= (env.now?.() ?? Date.now())) throw new Error("INVALID_SESSION");
      clear(true); closed = true; env.location.replace("/");
    } catch {
      if (!closed && version === generation) status(setup ? "등록·복구 완료 여부를 확인하지 못했습니다. 새 비밀번호로 로그인을 먼저 확인해 주세요. 이미 사용된 승인 코드는 다시 사용할 수 없습니다." : "인증을 완료하지 못했습니다. 요청이 중단되었을 수 있으니 다시 입력해 주세요.", true);
    } finally { body = ""; if (version === generation) { busy = false; pending = null; controls(); } }
  }
  function close() { closed = true; busy = false; generation++; pending?.abort(); pending = null; clear(true); status(""); controls(); }
  node("setup-fields").hidden = !setup; node("confirmation-fields").hidden = !setup;
  node("setup-link").hidden = setup; node("auth-login-link").hidden = !setup;
  node("setup-mode").value = "enroll";
  node("auth-form").addEventListener("submit", event => { event.preventDefault(); return submit(); });
  node("setup-mode").addEventListener("change", mode);
  env.addEventListener?.("pagehide", close);
  env.addEventListener?.("pageshow", event => { if (event.persisted) { closed = false; clear(true); mode(); } });
  mode();
  return { submit, close };
}

if (typeof window !== "undefined") startAuth(window);
