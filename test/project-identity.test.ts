import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveProjectIdentity,
} from "../src/core/project-identity.ts";
import {
  inspectProjectDb,
  openProjectStore,
  resolveProjectStore,
} from "../src/core/project-store.ts";
import { legacyDbPath, projectDbPath } from "../src/core/paths.ts";
import { MemoryStore } from "../src/core/store.ts";

delete process.env.GOLDFISH_DB;

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
}

test("stable Git project IDs survive a repository rename", () => {
  const parent = tempDir("goldfish-identity-");
  const repo = path.join(parent, "repo");
  try {
    initRepo(repo);
    const first = resolveProjectIdentity(repo, { create: true });
    assert.equal(first.kind, "git");
    assert.ok(first.projectId);
    assert.equal(first.anchor?.relativePath, ".");

    const moved = path.join(parent, "renamed");
    renameSync(repo, moved);
    const second = resolveProjectIdentity(moved, { create: true });
    assert.equal(second.kind, "git");
    assert.equal(second.projectId, first.projectId);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("nested project roots get distinct stable IDs and clones get a new ID", () => {
  const parent = tempDir("goldfish-identity-");
  const repo = path.join(parent, "repo");
  try {
    initRepo(repo);
    writeFileSync(path.join(repo, "README.md"), "# repo\n");
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=Goldfish Test",
        "-c",
        "user.email=goldfish@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { stdio: "ignore" },
    );

    const root = resolveProjectIdentity(repo, { create: true });
    const nestedDir = path.join(repo, "packages", "app");
    mkdirSync(nestedDir, { recursive: true });
    const nested = resolveProjectIdentity(nestedDir, { create: true });
    assert.equal(nested.anchor?.relativePath, "packages/app");
    assert.notEqual(nested.projectId, root.projectId);

    const clone = path.join(parent, "clone");
    execFileSync("git", ["clone", "-q", repo, clone], { stdio: "ignore" });
    const cloned = resolveProjectIdentity(clone, { create: true });
    assert.equal(cloned.kind, "git");
    assert.notEqual(cloned.projectId, root.projectId);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("linked worktrees have independent IDs that survive git worktree move", () => {
  const parent = tempDir("goldfish-identity-");
  const repo = path.join(parent, "repo");
  try {
    initRepo(repo);
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=Goldfish Test",
        "-c",
        "user.email=goldfish@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { stdio: "ignore" },
    );
    const main = resolveProjectIdentity(repo, { create: true });
    const worktree = path.join(parent, "worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "worktree-branch"], {
      stdio: "ignore",
    });
    const linked = resolveProjectIdentity(worktree, { create: true });
    assert.equal(linked.kind, "git");
    assert.notEqual(linked.projectId, main.projectId);
    assert.notEqual(linked.anchor?.gitDir, main.anchor?.gitDir);

    const moved = path.join(parent, "worktree-moved");
    execFileSync("git", ["-C", repo, "worktree", "move", worktree, moved], { stdio: "ignore" });
    const afterMove = resolveProjectIdentity(moved, { create: true });
    assert.equal(afterMove.projectId, linked.projectId);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("non-Git projects fall back to a path-derived identity", () => {
  const parent = tempDir("goldfish-identity-");
  try {
    const identity = resolveProjectIdentity(parent, { create: true });
    assert.equal(identity.kind, "path");
    assert.equal(identity.projectId, undefined);
    assert.equal(identity.reason, "not a Git worktree");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("legacy memory is adopted into a stable ID at the next open", async () => {
  const parent = tempDir("goldfish-adopt-");
  const repo = path.join(parent, "repo");
  const data = path.join(parent, "data");
  try {
    initRepo(repo);
    writeFileSync(path.join(repo, "README.md"), "# project\n");
    const legacyPath = legacyDbPath(repo, data);
    const legacy = await MemoryStore.open({ dbPath: legacyPath, projectRoot: repo });
    legacy.remember(
      {
        kind: "decision",
        title: "Legacy decision",
        body: "This decision predates the stable project identity.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    legacy.close();

    const before = await resolveProjectStore({ projectRoot: repo, dataRoot: data });
    assert.equal(before.storeKind, "legacy");
    assert.equal(before.pendingStabilization, true);
    assert.equal(before.legacyNodes, 1);

    const identity = resolveProjectIdentity(repo, { create: true });
    assert.equal(identity.kind, "git");
    assert.ok(identity.projectId);

    const pending = await resolveProjectStore({ projectRoot: repo, dataRoot: data });
    assert.equal(pending.storeKind, "legacy");
    assert.equal(pending.pendingAdoption, true);
    assert.equal(pending.stableDbPath, projectDbPath(identity.projectId!, data));

    const opened = await openProjectStore({
      projectRoot: repo,
      dataRoot: data,
      adopt: true,
    });
    try {
      assert.equal(opened.resolution.storeKind, "stable");
      assert.equal(opened.store.status().total, 1);
      assert.equal(opened.store.get("decision/legacy-decision")?.node.title, "Legacy decision");
      assert.match(opened.store.recall({ query: "legacy decision" }).cards[0]?.title ?? "", /Legacy/);
    } finally {
      opened.store.close();
    }

    const legacyInfo = await inspectProjectDb(legacyPath);
    assert.equal(legacyInfo.nodes, 1);
    const stableInfo = await inspectProjectDb(projectDbPath(identity.projectId!, data));
    assert.equal(stableInfo.nodes, 1);
    assert.equal(stableInfo.projectId, identity.projectId);

    const second = await openProjectStore({ projectRoot: repo, dataRoot: data, adopt: true });
    try {
      assert.equal(second.resolution.storeKind, "stable");
      assert.equal(second.adopted, undefined);
    } finally {
      second.store.close();
    }

    const legacyAgain = await MemoryStore.open({
      dbPath: legacyPath,
      projectRoot: repo,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    legacyAgain.remember(
      {
        kind: "gotcha",
        title: "Legacy-only write",
        body: "This write arrived after the stable copy.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    legacyAgain.close();

    const divergent = await resolveProjectStore({ projectRoot: repo, dataRoot: data });
    assert.equal(divergent.storeKind, "stable");
    assert.match(divergent.note ?? "", /newer updates/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("explicit database paths bypass stable identity resolution", async () => {
  const parent = tempDir("goldfish-adopt-");
  const repo = path.join(parent, "repo");
  const data = path.join(parent, "data");
  const explicit = path.join(parent, "custom.sqlite");
  try {
    initRepo(repo);
    const resolution = await resolveProjectStore({
      projectRoot: repo,
      dataRoot: data,
      dbPath: explicit,
    });
    assert.equal(resolution.storeKind, "explicit");
    assert.equal(resolution.dbPath, explicit);
    assert.equal(resolution.pendingAdoption, false);
    assert.equal(resolution.pendingStabilization, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
