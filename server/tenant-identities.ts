import fs from "node:fs";
import path from "node:path";

export type TenantIdentity = {
  userId: string;
  label: string;
  uid: number;
  gid: number;
};

export const WEB_IDENTITY = { uid: 10001, gid: 10001 } as const;

export const OWNER_USER_ID = "00000000-0000-4000-8000-000000000001";
export const OWNER_UID = 11001;

const OWNER_IDENTITY: TenantIdentity = {
  userId: OWNER_USER_ID,
  label: "owner",
  uid: OWNER_UID,
  gid: OWNER_UID,
};

/**
 * Tenant Unix identities live in a JSON file under the data root so new
 * tenants can be added at runtime without rebuilding the image. The built-in
 * owner identity is always available as the fallback.
 */
export function tenantIdentitiesPath(): string {
  const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), "data");
  return path.join(dataRoot, "tenant-identities.json");
}

export function loadTenantIdentities(): TenantIdentity[] {
  const identities: TenantIdentity[] = [OWNER_IDENTITY];
  try {
    const parsed = JSON.parse(fs.readFileSync(tenantIdentitiesPath(), "utf8")) as Record<string, Partial<TenantIdentity>>;
    for (const userId of Object.keys(parsed)) {
      if (userId === OWNER_USER_ID) continue;
      const entry = parsed[userId];
      if (entry && Number.isInteger(entry.uid) && Number.isInteger(entry.gid)) {
        identities.push({
          userId,
          label: typeof entry.label === "string" && entry.label ? entry.label : userId,
          uid: entry.uid as number,
          gid: entry.gid as number,
        });
      }
    }
  } catch {
    // A missing or malformed identity file falls back to the built-in owner.
  }
  return identities;
}

export function listTenantIdentities(): TenantIdentity[] {
  return loadTenantIdentities();
}

export function tenantIdentityForUser(userId: string): TenantIdentity | undefined {
  return loadTenantIdentities().find((identity) => identity.userId === userId);
}

export function assignTenantIdentity(userId: string, label: string): TenantIdentity {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid tenant user id");
  const identities = loadTenantIdentities();
  if (identities.some((identity) => identity.userId === userId)) {
    throw new Error(`Tenant identity already exists for ${label}`);
  }
  const nextUid = identities.reduce((max, identity) => Math.max(max, identity.uid), OWNER_UID) + 1;
  const entry: TenantIdentity = { userId, label, uid: nextUid, gid: nextUid };
  const file = tenantIdentitiesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const merged: Record<string, TenantIdentity> = {};
  for (const identity of identities) merged[identity.userId] = identity;
  merged[userId] = entry;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return entry;
}
