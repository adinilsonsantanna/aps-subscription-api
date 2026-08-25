import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (!files.length) throw new Error("test suite refused: no test files configured");
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { encoding: "utf8", env: process.env });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
const match = String(result.stdout).match(/^1\.\.(\d+)$/m);
if (!match || Number(match[1]) < 1) throw new Error("test suite refused: zero tests executed");
process.exit(result.status ?? 1);
