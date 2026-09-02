import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(scriptDir, "../service");
const outputPath = resolve(scriptDir, "../THIRD-PARTY-LICENSES.txt.gz");
const targets = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
const metadataByTarget = targets.map((target) => JSON.parse(execFileSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--filter-platform", target],
  { cwd: serviceDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
)));
const metadata = metadataByTarget[0];
const shippedPackageIds = new Set(metadataByTarget.flatMap((targetMetadata) => (
  targetMetadata.resolve.nodes.map((node) => node.id)
)));
const supplementalLicenses = new Map([
  ["dasp_sample@0.11.0", [resolve(scriptDir, "upstream/dasp_sample-0.11.0-LICENSE-MIT.txt")]],
  ["realfft@3.5.0", [resolve(scriptDir, "upstream/realfft-3.5.0-LICENSE-MIT.txt")]]
]);

const packages = metadata.packages
  .filter((entry) => entry.name !== "drake-speech-service" && shippedPackageIds.has(entry.id))
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
  const licenseFiles = [...readdirSync(packageDir)
    .filter((name) => /^(license|copying|copyright|notice)([._-].*)?$/i.test(name))
    .map((name) => join(packageDir, name))
    .filter((path) => statSync(path).isFile())
    .sort(), ...(supplementalLicenses.get(`${entry.name}@${entry.version}`) ?? [])];
  if (!licenseFiles.length) {
    throw new Error(`No license document is available for ${entry.name} ${entry.version}.`);
  }
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
  sections.push(`  License documents: ${documentIds.join(", ")}`);
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
