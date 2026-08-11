import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_UID,
  OWNER_USER_ID,
  assignTenantIdentity,
  loadTenantIdentities,
  tenantIdentitiesPath,
  tenantIdentityForUser,
} from "../server/tenant-identities.js";

test("tenant identities are assignable and reloadable from the data root", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-tenant-identities-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.DATA_ROOT;
  process.env.DATA_ROOT = root;
  context.after(() => {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
  });

  assert.equal(tenantIdentityForUser(OWNER_USER_ID)?.uid, OWNER_UID);
  const alice = assignTenantIdentity("11111111-1111-4111-8111-111111111111", "alice");
  assert.equal(alice.uid, OWNER_UID + 1);
  const bob = assignTenantIdentity("22222222-2222-4222-8222-222222222222", "bob");
  assert.equal(bob.uid, OWNER_UID + 2);

  assert.equal(loadTenantIdentities().length, 3);
  assert.equal(tenantIdentityForUser(alice.userId)?.label, "alice");
  assert.equal(tenantIdentityForUser(bob.userId)?.uid, OWNER_UID + 2);
  assert.ok(fs.existsSync(tenantIdentitiesPath()));
  assert.throws(() => assignTenantIdentity(alice.userId, "duplicate"), /already exists/);
});
