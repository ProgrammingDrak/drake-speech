import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
const packageRecords = [];
const standardDocuments = new Map();

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
    const filename = basename(path).toLowerCase();
    if (/^license[-_.]?mit$/.test(filename)) standardDocuments.set("MIT", id);
    if (/^license[-_.]?apache(?:[-_.]?2(?:\.0)?)?$/.test(filename)) standardDocuments.set("Apache-2.0", id);
  }
  packageRecords.push({ entry, documentIds });
}

for (const { entry, documentIds: packagedDocumentIds } of packageRecords) {
  const documentIds = [...packagedDocumentIds];
  let selectedFallback = null;
  if (!documentIds.length) {
    if (/\bMIT\b/.test(entry.license ?? "")) selectedFallback = "MIT";
    else if (/\bApache-2\.0\b/.test(entry.license ?? "")) selectedFallback = "Apache-2.0";
    const fallbackId = selectedFallback ? standardDocuments.get(selectedFallback) : null;
    if (!fallbackId) {
      throw new Error(`No license document is available for ${entry.name} ${entry.version}.`);
    }
    documentIds.push(fallbackId);
  }
  sections.push(`${entry.name} ${entry.version}`);
  sections.push(`  Declared license: ${entry.license ?? "NOASSERTION"}`);
  sections.push(`  Authors: ${entry.authors.join(", ") || "unknown"}`);
  sections.push(`  Source: ${entry.repository ?? entry.homepage ?? entry.source ?? "unknown"}`);
  if (selectedFallback) sections.push(`  Selected fallback license: ${selectedFallback}`);
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
