const CLOSED_IPC_CODES = new Set([
  "EPIPE",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_IPC_DISCONNECTED",
]);

export function isClosedIpcError(error) {
  return CLOSED_IPC_CODES.has(error?.code);
}

export function recordChildError(errors, error) {
  if (!isClosedIpcError(error)) errors.push(error);
}

export function safeChildSend(child, message, onError = () => {}) {
  if (!child.connected) return false;
  try {
    child.send(message, (error) => {
      if (error) onError(error);
    });
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function safeChildDisconnect(child, onError = () => {}) {
  if (!child.connected) return false;
  try {
    child.disconnect();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
