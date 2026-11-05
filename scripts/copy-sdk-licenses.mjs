import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const destination = "dist/licenses";
mkdirSync(destination, { recursive: true });
for (const dependency of ["supermemory", "supermemory-legacy"]) {
  const directory = join("node_modules", dependency);
  const { name, version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  copyFileSync(join(directory, "LICENSE"), join(destination, `${name}-${version}.txt`));
}
