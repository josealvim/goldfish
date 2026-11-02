import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanProject } from "../src/core/scan.ts";

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

async function withRepo(callback: (root: string) => void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-scan-"));
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      workspaces: ["packages/*"],
      scripts: {
        test: "vitest run",
        build: "tsc",
        deploy: "API_KEY=abcdefghijklmnop deploy",
      },
    }),
  );
  write(
    root,
    "packages/billing/package.json",
    JSON.stringify({
      name: "@fixture/billing",
      main: "./index.ts",
      scripts: { test: "vitest run --dir ." },
    }),
  );
  write(root, "README.md", "# Fixture\n\n## Setup\n\n## Tests\n");
  write(root, "docs/adr.md", "# Decisions\n\n## Storage\n");
  write(root, "src/index.ts", "export {};\n");
  write(root, "src/core/store.ts", "export {};\n");
  write(root, "src/plugin/index.ts", "export {};\n");
  write(root, "packages/billing/index.ts", "export {};\n");
  write(root, ".github/workflows/ci.yml", "name: ci\n");
  write(root, "Makefile", "test:\n\tnpm test\n\ndev:\n\tnpm run dev\n");
  write(root, "node_modules/evil.js", "ignored\n");
  write(root, "dist/generated.js", "ignored\n");
  write(root, "secrets/token.md", "sensitive\n");
  write(root, ".env", "SECRET=value\n");
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scanProject maps manifests, components, docs, commands, CI, and skipped paths", async () => {
  await withRepo((root) => {
    const scan = scanProject(root, { includeGit: false });
    assert.equal(scan.git, undefined);
    assert.equal(scan.files.total > 5, true);
    assert.equal(scan.files.byExtension.ts, 4);
    assert.equal(scan.packages.length, 2);
    assert.equal(scan.packages.some((pkg) => pkg.name === "fixture"), true);
    assert.equal(scan.packages.some((pkg) => pkg.name === "@fixture/billing"), true);
    assert.equal(
      scan.packages.some((pkg) => pkg.entryPoints?.includes("packages/billing/index.ts")),
      true,
    );
    assert.equal(scan.commands.test?.length, 2);
    assert.match(scan.commands.deploy?.[0] ?? "", /\[REDACTED\]/);
    assert.doesNotMatch(scan.commands.deploy?.[0] ?? "", /abcdefghijklmnop/);
    assert.equal(scan.commands.Makefile?.includes("dev"), true);
    assert.equal(scan.entryPoints.includes("src/index.ts"), true);
    assert.equal(scan.entryPoints.includes("packages/billing/index.ts"), true);
    assert.equal(scan.docs.some((doc) => doc.path === "README.md"), true);
    assert.equal(scan.docs.some((doc) => doc.path === "docs/adr.md"), true);
    assert.equal(scan.ci.includes(".github/workflows/ci.yml"), true);
    assert.equal(scan.components.some((component) => component.path === "src"), true);
    assert.equal(
      scan.files.skipped.some((skip) => skip.path.includes("node_modules")),
      true,
    );
    assert.equal(scan.files.skipped.some((skip) => skip.path === ".env"), true);
    assert.equal(scan.files.sample.some((file) => file.startsWith("secrets/")), false);
  });
});

test("scanProject filters scope but keeps root manifests and docs", async () => {
  await withRepo((root) => {
    const scan = scanProject(root, { scope: "src/**", includeGit: false });
    assert.equal(scan.scope, "src/**");
    assert.equal(scan.files.sample.includes("src/index.ts"), true);
    assert.equal(scan.files.sample.includes("src/core/store.ts"), true);
    assert.equal(scan.files.sample.includes("package.json"), true);
    assert.equal(scan.files.sample.includes("README.md"), true);
    assert.equal(scan.files.sample.includes("docs/adr.md"), false);
  });
});

test("scanProject respects the maxFiles bound", async () => {
  await withRepo((root) => {
    const scan = scanProject(root, { maxFiles: 2, includeGit: false });
    assert.equal(scan.files.total, 2);
    assert.equal(scan.files.truncated, true);
    assert.equal(scan.files.sample.length, 2);
  });
});
