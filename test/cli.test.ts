import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cli = path.join(repoRoot, "src", "cli", "main.ts");

function runCli(args: string[]) {
  return spawnSync(tsx, [cli, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function output(result: ReturnType<typeof runCli>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertOk(result: ReturnType<typeof runCli>): void {
  assert.equal(result.status, 0, output(result));
}

test("CLI end-to-end: seed, recall, eval, export/import, review, and audit", { timeout: 120_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-cli-"));
  const db = path.join(root, "memory.sqlite");
  const importDb = path.join(root, "import.sqlite");
  const exportDir = path.join(root, "export");
  try {
    const seed = runCli(["seed", "test/fixtures/seed.jsonl", "--db", db, "--project", repoRoot]);
    assertOk(seed);
    assert.match(String(seed.stdout), /Memory created/);

    const recall = runCli(["recall", "injection policy", "--db", db, "--project", repoRoot]);
    assertOk(recall);
    assert.match(String(recall.stdout), /Use optimistic writes/);

    const evalResult = runCli(["eval", "--db", db, "--project", repoRoot]);
    assertOk(evalResult);
    assert.match(String(evalResult.stdout), /Average recall@k=/);
    assert.doesNotMatch(String(evalResult.stdout), /FAIL/);

    const review = runCli(["review", "--db", db, "--project", repoRoot]);
    assertOk(review);
    assert.match(String(review.stdout), /inferred claim awaiting verification/);

    const listed = runCli(["list", "--kind", "decision", "--limit", "3", "--db", db, "--project", repoRoot]);
    assertOk(listed);
    assert.match(String(listed.stdout), /Memory list/);

    const health = runCli(["health", "--db", db, "--project", repoRoot]);
    assertOk(health);
    assert.match(String(health.stdout), /# Memory health/);
    assert.match(String(health.stdout), /Citation coverage/);

    const exported = runCli(["export", exportDir, "--db", db, "--project", repoRoot]);
    assertOk(exported);
    for (const file of ["nodes.jsonl", "sources.jsonl", "citations.jsonl", "edges.jsonl", "manifest.json"]) {
      assert.equal(existsSync(path.join(exportDir, file)), true, `${file} should exist`);
    }

    const imported = runCli(["import", exportDir, "--db", importDb, "--project", repoRoot]);
    assertOk(imported);
    assert.match(String(imported.stdout), /Imported 12 node\(s\)/);

    const stats = runCli(["stats", "--db", importDb, "--project", repoRoot]);
    assertOk(stats);
    assert.match(String(stats.stdout), /Nodes: 12/);

    const confirmed = runCli([
      "confirm",
      "gotcha/inferred-claims-must-not-auto-inject",
      "--as",
      "cited",
      "--db",
      db,
      "--project",
      repoRoot,
    ]);
    assertOk(confirmed);
    assert.match(String(confirmed.stdout), /Verification: confirmed/);

    const rejected = runCli([
      "reject",
      "gotcha/inferred-claims-must-not-auto-inject",
      "--reason",
      "Test rejection",
      "--db",
      db,
      "--project",
      repoRoot,
    ]);
    assertOk(rejected);
    assert.match(String(rejected.stdout), /Verification: rejected/);

    const revalidated = runCli(["revalidate", "--db", db, "--project", repoRoot]);
    assertOk(revalidated);
    assert.match(String(revalidated.stdout), /Checked/);

    const audit = runCli(["audit", "--db", db, "--project", repoRoot]);
    assertOk(audit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI reports errors for missing nodes and invalid proposals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-cli-errors-"));
  const db = path.join(root, "memory.sqlite");
  try {
    const missing = runCli(["get", "does/not/exist", "--db", db, "--project", repoRoot]);
    assert.equal(missing.status, 1);
    assert.match(String(missing.stderr), /No memory node found/);

    const invalid = runCli(["remember", "--json", '{"kind":"fact"}', "--db", db, "--project", repoRoot]);
    assert.equal(invalid.status, 1);
    assert.match(String(invalid.stderr), /requires kind, title, and body/i);

    const noQuery = runCli(["recall", "--db", db, "--project", repoRoot]);
    assert.equal(noQuery.status, 1);
    assert.match(String(noQuery.stderr), /Usage: memory recall/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
