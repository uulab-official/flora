/** Test timing only: hold an already-produced response without changing it. */
export function createResponseGate(timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("RESPONSE_GATE_DEADLINE");
  let arrive, resume, finish, timer;
  const arrival = new Promise(resolve => { arrive = resolve; });
  const release = new Promise(resolve => { resume = resolve; });
  const delivery = new Promise(resolve => { finish = resolve; });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RESPONSE_GATE_TIMEOUT")), timeoutMs); });
  const entered = Promise.race([arrival, deadline]), finished = Promise.race([delivery, deadline]);
  // Callers can fail before awaiting the second stage; keep cleanup safe while
  // still preserving the rejection for every explicit await.
  entered.catch(() => {}); finished.catch(() => {});
  return {
    entered, finished,
    async hold() { arrive(); await Promise.race([release, deadline]); },
    release() { resume(); },
    finish() { clearTimeout(timer); finish(); },
  };
}
