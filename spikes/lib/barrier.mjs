export async function releaseWhenReady(
  workers,
  startMessage,
  send = (worker, message) => worker.send(message),
) {
  await Promise.all(workers.map(waitUntilReady));
  for (const worker of workers) send(worker, startMessage);
}

function waitUntilReady(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== "ready") return;
      cleanup();
      resolve();
    };
    const onFailure = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onExit = (code) => {
      if (code !== null && code !== 0)
        onFailure(new Error(`workerが準備前に終了しました (exit ${code})。`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onFailure);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onFailure);
    worker.on("exit", onExit);
  });
}
