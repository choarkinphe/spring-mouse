import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

// Keep request dump files inside the persistent data volume. process.cwd()/logs
// is unreliable in standalone/cluster deployments and may point at a container's
// ephemeral layer or differ between workers.
export const REQUEST_LOGS_DIR = path.resolve(
  process.env.REQUEST_LOGS_DIR || path.join(DATA_DIR, "request-logs"),
);
