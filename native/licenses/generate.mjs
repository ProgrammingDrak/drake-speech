import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(scriptDir, "../service");
const outputPath = resolve(scriptDir, "../THIRD-PARTY-LICENSES.txt.gz");
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
const documents = new Map();

for (const entry of packages) {
  const packageDir = dirname(entry.manifest_path);
  const licenseFiles = readdirSync(packageDir)
    .filter((name) => /^(license|copying|copyright|notice)([._-].*)?$/i.test(name))
    .map((name) => join(packageDir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
  const documentIds = [];
  for (const path of licenseFiles) {
    const content = readFileSync(path, "utf8").trimEnd();
    const id = createHash("sha256").update(content).digest("hex").slice(0, 12);
    documentIds.push(id);
    if (!documents.has(id)) documents.set(id, content);
  }
  sections.push(`${entry.name} ${entry.version}`);
  sections.push(`  Declared license: ${entry.license ?? "NOASSERTION"}`);
  sections.push(`  Authors: ${entry.authors.join(", ") || "unknown"}`);
  sections.push(`  Source: ${entry.repository ?? entry.homepage ?? entry.source ?? "unknown"}`);
  if (!licenseFiles.length) {
    sections.push("  License documents: none packaged; use the declared license and source above.");
  } else {
    sections.push(`  License documents: ${documentIds.join(", ")}`);
  }
  sections.push("");
}

sections.push("License documents");
sections.push("");
for (const [id, content] of [...documents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  sections.push("=".repeat(78));
  sections.push(`Document ${id}`);
  sections.push("");
  sections.push(content);
  sections.push("");
}

writeFileSync(outputPath, gzipSync(`${sections.join("\n")}\n`, { level: 9, mtime: 0 }));
