import postgres from "postgres";
import { config } from "../util/config";

// Single connection pool for the process. Only repo.ts (and migrate.ts) may import this —
// agents never see a connection string (I2).
export const sql = postgres(config.databaseUrl, {
  max: 5,
  onnotice: () => {},
});

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
