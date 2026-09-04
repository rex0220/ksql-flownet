import { spawn } from "node:child_process";

const command = process.env.CSV2_REAL_KSQL_FLOW_BIN;
const binArgs = JSON.parse(process.env.CSV2_REAL_KSQL_FLOW_BIN_ARGS ?? "[]");
if (!command || !Array.isArray(binArgs)) {
  process.stderr.write("CSV2 kSQL-Flow wrapper configuration is missing\n");
  process.exit(1);
}

const args = [...binArgs, ...process.argv.slice(2)];
if (args.includes("run") && args.includes("--export-csv"))
  args.push("--export-encoding", "sjis");

const child = spawn(command, args, {
  env: process.env,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"])
  process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  process.stderr.write(`kSQL-Flow launch failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exit(1);
});
child.once("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
