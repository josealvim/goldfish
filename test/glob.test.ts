import test from "node:test";
import assert from "node:assert/strict";
import { anyScopeMatches, matchesGlob, scopeMatchScore } from "../src/core/glob.ts";

test("matchesGlob handles recursive and single-segment wildcards", () => {
  assert.equal(matchesGlob("**", "anything/here.ts"), true);
  assert.equal(matchesGlob("services/**", "services/billing/worker.ts"), true);
  assert.equal(matchesGlob("services/**", "src/services/billing/worker.ts"), false);
  assert.equal(matchesGlob("**/auth/**", "auth/session.ts"), true);
  assert.equal(matchesGlob("**/auth/**", "services/auth/session.ts"), true);
  assert.equal(matchesGlob("**/auth/**", "src/authz/session.ts"), false);
  assert.equal(matchesGlob("*.ts", "index.ts"), true);
  assert.equal(matchesGlob("*.ts", "src/index.ts"), false);
});

test("matchesGlob handles ?, trailing slashes, and Windows separators", () => {
  assert.equal(matchesGlob("src/?oo.ts", "src/foo.ts"), true);
  assert.equal(matchesGlob("src/?oo.ts", "src/fooo.ts"), false);
  assert.equal(matchesGlob("src/?oo.ts", "src/f/oo.ts"), false);
  assert.equal(matchesGlob("services/billing/", "services/billing/worker.ts"), true);
  assert.equal(matchesGlob("services\\billing\\**", "services/billing/worker.ts"), true);
  assert.equal(matchesGlob("services/**", "services\\billing\\worker.ts"), true);
});

test("scope matching and scoring reflect overlap", () => {
  assert.equal(anyScopeMatches(["**/auth/**"], ["services/auth/session.ts"]), true);
  assert.equal(anyScopeMatches(["auth/**"], ["services/billing/session.ts"]), false);
  assert.equal(anyScopeMatches([], ["auth/session.ts"]), false);

  assert.equal(scopeMatchScore(["auth/**"], ["auth/session.ts"]), 0.2);
  assert.equal(scopeMatchScore(["auth/**"], ["billing/worker.ts"]), -0.12);
  assert.equal(scopeMatchScore([], ["auth/session.ts"]), 0.02);
  assert.equal(scopeMatchScore([], []), 0.04);
});
