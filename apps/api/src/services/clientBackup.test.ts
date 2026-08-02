// Focused tests for clientBackup.ts. The Drive-facing code paths need
// integration with the real Google Drive API and aren't tested here —
// the tests below cover the pure logic (kill-switch, filename dedup)
// that could regress silently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClientBackupEnabled, runClientBackup } from "./clientBackup";

vi.mock("../db/prisma", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../lib/driveClient", () => ({
  ensureFolder: vi.fn(),
  findFileByName: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("./dataExport", () => ({
  buildDataSnapshot: vi.fn(),
}));

// Import the mocked modules so we can drive their return values per-test.
import { prisma } from "../db/prisma";
import { ensureFolder, findFileByName, uploadFile } from "../lib/driveClient";
import { buildDataSnapshot } from "./dataExport";

describe("isClientBackupEnabled", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when the setting is "true"', async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ value: "true" });
    expect(await isClientBackupEnabled()).toBe(true);
  });

  it("returns false when the setting is missing", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue(null);
    expect(await isClientBackupEnabled()).toBe(false);
  });

  it("returns false for any value other than exactly \"true\"", async () => {
    for (const v of ["false", "1", "yes", "TRUE", ""]) {
      (prisma.setting.findUnique as any).mockResolvedValue({ value: v });
      expect(await isClientBackupEnabled()).toBe(false);
    }
  });
});

describe("runClientBackup — kill switch", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("short-circuits when disabled — no Drive calls, no snapshot build", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ value: "false" });
    const result = await runClientBackup();
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(ensureFolder).not.toHaveBeenCalled();
    expect(buildDataSnapshot).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("runClientBackup — filename selection", () => {
  const OLD_ENV = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "test-root-folder";
    (prisma.setting.findUnique as any).mockResolvedValue({ value: "true" });
    (ensureFolder as any).mockResolvedValue("clients-folder-id");
    (buildDataSnapshot as any).mockResolvedValue({ exportedAt: "test", users: [] });
    (uploadFile as any).mockResolvedValue({ id: "file-id", name: "captured-by-caller" });
  });

  afterEach(() => {
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = OLD_ENV;
  });

  it("uses the bare date filename when no same-day file exists", async () => {
    (findFileByName as any).mockResolvedValue(null);
    const now = new Date("2026-08-02T07:00:00Z");
    await runClientBackup(now);
    const call = (uploadFile as any).mock.calls[0][0];
    expect(call.name).toBe("2026-08-02.json");
    expect(call.parentFolderId).toBe("clients-folder-id");
    expect(call.contentType).toBe("application/json");
  });

  it("appends -HHMM (UTC wall clock) when the date file already exists", async () => {
    (findFileByName as any).mockResolvedValue({ id: "prev-id", name: "2026-08-02.json" });
    const now = new Date("2026-08-02T07:00:00Z");
    await runClientBackup(now);
    const call = (uploadFile as any).mock.calls[0][0];
    expect(call.name).toBe("2026-08-02-0700.json");
  });

  it("queries by exact filename (not a paginated folder listing) so the dedup check scales past 100 files", async () => {
    (findFileByName as any).mockResolvedValue(null);
    await runClientBackup(new Date("2026-08-02T07:00:00Z"));
    // The whole point of findFileByName vs listChildren: exactly one
    // Drive query, name-scoped, no dependency on the folder's total
    // file count.
    expect(findFileByName).toHaveBeenCalledOnce();
    expect((findFileByName as any).mock.calls[0][0]).toBe("2026-08-02.json");
    expect((findFileByName as any).mock.calls[0][1]).toBe("clients-folder-id");
  });

  it("passes the serialized bytes to uploadFile and reports the exact byte size", async () => {
    (findFileByName as any).mockResolvedValue(null);
    (buildDataSnapshot as any).mockResolvedValue({ exportedAt: "x", users: [{ id: "u1" }] });
    const result = await runClientBackup(new Date("2026-08-02T07:00:00Z"));
    if (result.skipped) throw new Error("expected non-skipped result");
    const call = (uploadFile as any).mock.calls[0][0];
    expect(Buffer.isBuffer(call.bytes)).toBe(true);
    // Reported byteSize matches the bytes we handed to Drive — no
    // second serialization pass to fall out of sync.
    expect(result.byteSize).toBe(call.bytes.byteLength);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes bsdCutoffApplied=false-equivalent payload — always calls buildDataSnapshot with null", async () => {
    (findFileByName as any).mockResolvedValue(null);
    await runClientBackup(new Date("2026-08-02T07:00:00Z"));
    expect(buildDataSnapshot).toHaveBeenCalledWith(null);
  });
});

