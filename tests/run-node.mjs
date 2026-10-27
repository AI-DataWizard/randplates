// run-node.mjs — run the same suite from the CLI: `node tests/run-node.mjs`
import { run as runMatcher } from "./matcher-tests.js";
import { run as runData } from "./data-tests.js";
import { run as runBackup } from "./backup-tests.js";
import { run as runGolden } from "./golden-tests.js";
import { run as runDeterminism } from "./determinism-tests.js";
const results = [
  ...(await runMatcher()),
  ...(await runData()),
  ...(await runBackup()),
  ...(await runGolden()),
  ...(await runDeterminism()),
];
let pass = 0;
for (const r of results) {
  if (r.ok) {
    pass++;
    console.log(`  ✔ [${r.suite}] ${r.name}`);
  } else {
    console.error(`  ✘ [${r.suite}] ${r.name}\n      ${r.err}`);
  }
}
console.log(
  `\n${pass === results.length ? "✅" : "❌"} ${pass}/${results.length} scenarios green`,
);
process.exit(pass === results.length ? 0 : 1);
