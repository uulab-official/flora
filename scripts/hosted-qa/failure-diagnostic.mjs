const selectorsAllowed = new Set(['#email', '#password', '#token', '#confirmation', '#auth-submit', '#setup-link', '#auth-status']);

/** Preserve actionable browser failures without messages, inputs, URLs or absolute paths. */
export function browserFailureDiagnostic(error) {
  const name = ['TimeoutError', 'AssertionError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'Error';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 16384) : '';
  const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 16384) : '';
  const operation = /^(?:locator|page)\.(?:fill|click|waitFor|waitForResponse|waitForURL|waitForFunction|goto|evaluate|screenshot|innerText|inputValue):/.exec(message)?.[0].slice(0, -1) ?? null;
  const selectors = [...new Set([...message.matchAll(/locator\(['"](#[a-z-]+)['"]\)/g)].map(match => match[1]).filter(value => selectorsAllowed.has(value)))];
  const frames = [...stack.matchAll(/\/scripts\/(hosted-qa\/capture\.mjs|dashboard-qa\/surface-depth\.mjs):([0-9]{1,6}):([0-9]{1,5})(?=[)\s]|$)/g)].slice(0, 4)
    .map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]) }));
  return { name, operation, selectors, frames };
}
