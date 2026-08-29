const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const NON_TERMINAL_STATES = new Set(["RUNNING", "PENDING"]);

function responseState(response) {
  return (
    response?.state ??
    response?.status ??
    response?.terminalCondition?.state ??
    null
  );
}

export function assessCloudRunExecution({ response, error } = {}) {
  if (error) {
    const status = Number(error.status ?? error.statusCode ?? 0) || null;
    return {
      stopped: false,
      verdict:
        status === 401 || status === 403 ? "PERMISSION_DENIED" : "API_ERROR",
      state: null,
      failClosed: true,
    };
  }
  const state = responseState(response);
  if (TERMINAL_STATES.has(state)) {
    return { stopped: true, verdict: "TERMINAL", state, failClosed: false };
  }
  if (NON_TERMINAL_STATES.has(state)) {
    return { stopped: false, verdict: "NON_TERMINAL", state, failClosed: true };
  }
  return { stopped: false, verdict: "UNKNOWN_STATE", state, failClosed: true };
}
