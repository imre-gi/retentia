import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WORKER_HOST =
  process.env.RETENTIA_WORKER_HOST || "127.0.0.1";
export const DEFAULT_WORKER_PORT = Number(
  process.env.RETENTIA_WORKER_PORT || "37777"
);

const PRIMARY_DATA_DIR = join(homedir(), ".retentia");
const DEFAULT_DATA_DIR = resolveDefaultDataDir();
export const WORKER_PID_FILE = join(DEFAULT_DATA_DIR, "worker.pid");
export const WORKER_LOG_DIR = join(DEFAULT_DATA_DIR, "logs");

export function getWorkerBaseUrl(host = DEFAULT_WORKER_HOST, port = DEFAULT_WORKER_PORT): string {
  return `http://${host}:${port}`;
}

function resolveDefaultDataDir(): string {
  const envDir =
    process.env.RETENTIA_DATA_DIR ||
    process.env.RETENTIA_HOME;
  if (envDir?.trim()) {
    return envDir.trim();
  }

  return PRIMARY_DATA_DIR;
}
