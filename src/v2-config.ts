import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_V2_DATA_FILE = join(
  homedir(),
  ".retentia",
  "retentia-v2.db",
);

export function getV2DataFilePath(override?: string): string {
  return override?.trim() || process.env.RETENTIA_DB_FILE || DEFAULT_V2_DATA_FILE;
}
