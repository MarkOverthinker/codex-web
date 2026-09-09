import fs from "node:fs";
import { readGitReview } from "./git-review.js";

try {
  const result = await readGitReview(JSON.parse(fs.readFileSync(0, "utf8")));
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : "读取变更失败。" }));
}
