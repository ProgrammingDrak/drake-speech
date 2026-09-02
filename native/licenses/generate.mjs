import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(scriptDir, "../service");
const outputPath = resolve(scriptDir, "../THIRD-PARTY-LICENSES.txt");
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
  cwd: serviceDir,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
}));

const packages = metadata.packages
  .filter((entry) => entry.name !== "drake-speech-service")
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const sections = [
  "Drake Speech native third-party licenses",
  "",
  "Generated from Cargo.lock by native/licenses/generate.mjs.",
  "Regenerate this file after every native dependency change.",
  ""
];

for (const entry of packages) {
  const packageDir = dirname(entry.manifest_path);
  const licenseFiles = readdirSync(packageDir)
    .filter((name) => /^(license|copying|copyright|notice)([._-].*)?$/i.test(name))
    .map((name) => join(packageDir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
  sections.push("=".repeat(78));
  sections.push(`${entry.name} ${entry.version}`);
  sections.push(`Declared license: ${entry.license ?? "NOASSERTION"}`);
  sections.push(`Source: ${entry.repository ?? entry.homepage ?? entry.source ?? "unknown"}`);
  sections.push("");
  if (!licenseFiles.length) {
    sections.push("No license document was packaged with this dependency.");
    sections.push("");
    continue;
  }
  for (const path of licenseFiles) {
    sections.push(`--- ${path.split("/").at(-1)} ---`);
    sections.push(readFileSync(path, "utf8").trimEnd());
    sections.push("");
  }
}

writeFileSync(outputPath, `${sections.join("\n")}\n`);
