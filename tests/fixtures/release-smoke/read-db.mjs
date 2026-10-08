import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/app/package.json");
const init = require("sql.js");
const SQL = await init({ locateFile: (file) => path.join("/app/node_modules/sql.js/dist", file) });
const db = new SQL.Database(fs.readFileSync("/app/data/db/data.sqlite"));
const count = (query) => db.exec(query)[0]?.values?.[0]?.[0] || 0;
const result = {
  usageRows: count("SELECT COUNT(*) FROM usageHistory"),
  attempts: count("SELECT COUNT(*) FROM routingAttempts"),
  completedAttempts: count("SELECT COUNT(*) FROM routingAttempts WHERE outcome='valid_terminal'"),
  selectedAccounts: count("SELECT COUNT(DISTINCT connectionId) FROM routingAttempts WHERE connectionId IS NOT NULL"),
};
db.close();
console.log(JSON.stringify(result));
if (result.usageRows < 12 || result.completedAttempts < 12 || result.selectedAccounts < 2) process.exit(1);
