// ─────────────────────────────────────────────────────────────────────────────
// Google Drive client wrapper for the CompanyDocument → Drive backup feature.
//
// Zero runtime dependencies — uses only global fetch + Node built-ins so we
// don't have to pull the multi-MB `googleapis` package into the API bundle
// just to do a handful of Drive operations.
//
// Auth model — see docs/features/documents-gdrive-backup.md:
//   - Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
//     GOOGLE_OAUTH_REFRESH_TOKEN (issued once via
//     apps/api/scripts/oauth-drive-consent.ts).
//   - Every call to Drive is preceded by exchanging the refresh token for a
//     short-lived (1 hour) access token. In-process cache re-uses the token
//     across calls within the same worker run.
//
// Scope: full `.../auth/drive` — see docs for why we can't use `.drive.file`.
//
// Operations exposed here are the minimum needed by the sync worker:
//   - ensureFolder(name, parentId)          — mkdir -p, idempotent
//   - findFolderByName(name, parentId)      — mkdir helper
//   - uploadFile(...)                       — resumable upload for larger PDFs
//   - deleteFile(id)                        — hard delete
//   - listChildren(folderId)                — for the connectivity check + UI
//   - getFile(id)                           — folder-exists probe
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

type CachedToken = { accessToken: string; expiresAt: number };
let cached: CachedToken | null = null;

/** Reset the in-process token cache — test seams + config-change guardrail. */
export function resetDriveTokenCache(): void {
  cached = null;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Refresh 60 seconds before actual expiry to avoid mid-request expiration.
  if (cached && cached.expiresAt - 60_000 > now) return cached.accessToken;

  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as any;
  if (!res.ok) {
    const detail = json.error_description ?? json.error ?? JSON.stringify(json);
    if (json.error === "invalid_grant") {
      throw new DriveAuthError(
        `Google refused the refresh token (invalid_grant). Re-run apps/api/scripts/oauth-drive-consent.ts to reissue. Detail: ${detail}`,
      );
    }
    throw new Error(`Token refresh failed (${res.status}): ${detail}`);
  }
  cached = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cached.accessToken;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * Distinguishable from generic network errors so callers (worker,
 * Timeline alerter) can prompt for a fresh consent flow specifically.
 */
export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveAuthError";
  }
}

async function driveJson(
  method: string,
  pathOrUrl: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${DRIVE_API}${pathOrUrl}`);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url.toString(), { method, headers, body });
  const text = await res.text();
  const json = text ? safeJsonParse(text) : null;
  if (!res.ok) {
    const detail = json?.error?.message ?? text;
    throw new DriveApiError(res.status, `${method} ${url.pathname} failed (${res.status}): ${detail}`, json?.error);
  }
  return json;
}

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Structured Drive API error — `status` is the HTTP code, `detail` is
 * Google's error object if present. Callers use `status === 404` to
 * detect "target doesn't exist" (which for `.file` scope also masks as
 * "no permission").
 */
export class DriveApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ─── Read operations ─────────────────────────────────────────────────────

export async function getFile(id: string, fields = "id,name,mimeType,parents,trashed") {
  return driveJson("GET", `/files/${encodeURIComponent(id)}`, { query: { fields } });
}

export async function listChildren(
  parentId: string,
  opts: { pageSize?: number } = {},
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const list = await driveJson("GET", `/files`, {
    query: {
      q: `'${parentId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType)",
      pageSize: String(opts.pageSize ?? 100),
    },
  });
  return (list.files ?? []) as Array<{ id: string; name: string; mimeType: string }>;
}

// ─── Folder operations ───────────────────────────────────────────────────

export async function findFolderByName(name: string, parentId: string): Promise<string | null> {
  // Drive's `name` query needs single-quoted strings with `'` escaped
  // as `\'`. Fold anything that would break the query into a safe form.
  const safeName = name.replace(/'/g, "\\'");
  const res = await driveJson("GET", `/files`, {
    query: {
      q: `name='${safeName}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`,
      fields: "files(id)",
      pageSize: "10",
    },
  });
  const files = (res.files ?? []) as Array<{ id: string }>;
  return files[0]?.id ?? null;
}

/** mkdir -p semantics: return existing folder id or create-and-return. */
export async function ensureFolder(name: string, parentId: string): Promise<string> {
  const existing = await findFolderByName(name, parentId);
  if (existing) return existing;
  const created = await driveJson("POST", `/files`, {
    body: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
  });
  return created.id as string;
}

// ─── File operations ─────────────────────────────────────────────────────

/**
 * Upload a file into a Drive folder using the resumable upload protocol.
 * Handles files up to any size Drive supports (the sync worker only ever
 * uploads up to DOCUMENT_MAX_SIZE_MB, but the protocol is what it is).
 *
 * If `existingFileId` is provided, we PATCH the existing file's bytes in
 * place — same Drive `fileId`, new bytes. Used when the operator restores
 * a previous CompanyDocumentVersion (Drive's currentFile mirrors app's
 * currentVersion pointer). For the create path, omit `existingFileId`
 * and we POST a new file into the folder.
 */
export async function uploadFile(params: {
  parentFolderId: string;
  name: string;
  contentType: string;
  bytes: Buffer;
  existingFileId?: string | null;
}): Promise<{ id: string; name: string; size: number }> {
  const { parentFolderId, name, contentType, bytes, existingFileId } = params;

  const initUrl = existingFileId
    ? `${UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable`
    : `${UPLOAD_API}/files?uploadType=resumable`;
  const initMethod = existingFileId ? "PATCH" : "POST";

  const token = await getAccessToken();

  // Step 1: initiate — POST metadata, get an upload URL back in `Location`.
  const initBody = existingFileId ? { name } : { name, parents: [parentFolderId] };
  const initRes = await fetch(initUrl, {
    method: initMethod,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(bytes.length),
    },
    body: JSON.stringify(initBody),
  });
  if (!initRes.ok) {
    const detail = await initRes.text();
    throw new DriveApiError(initRes.status, `Resumable upload init failed (${initRes.status}): ${detail}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) {
    throw new Error("Resumable upload init returned no Location header");
  }

  // Step 2: PUT the bytes. For files <=5MB we could just single-shot;
  // for larger files chunking would be nicer but Drive accepts the
  // entire body in one PUT up to hundreds of MB. Our documents cap at
  // DOCUMENT_MAX_SIZE_MB (default 25MB), so one PUT is fine.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
    },
    // Node's Buffer is a Uint8Array at runtime and fetch accepts it fine —
    // the type mismatch is a lib.dom / @types/node conflict, not a real
    // incompatibility. Cast through unknown to bypass.
    body: bytes as unknown as BodyInit,
  });
  const putJson = (await putRes.json()) as any;
  if (!putRes.ok) {
    throw new DriveApiError(putRes.status, `Upload PUT failed (${putRes.status}): ${JSON.stringify(putJson)}`, putJson?.error);
  }
  return { id: putJson.id, name: putJson.name, size: Number(putJson.size ?? bytes.length) };
}

/**
 * Upload a small in-memory JSON blob (metadata / manifest files) as a
 * Drive file. Uses the multipart upload since JSON files are always
 * tiny — no need for resumable protocol overhead.
 */
export async function uploadJson(params: {
  parentFolderId: string;
  name: string;
  data: unknown;
  existingFileId?: string | null;
}): Promise<{ id: string; name: string }> {
  const { parentFolderId, name, data, existingFileId } = params;
  const jsonStr = JSON.stringify(data, null, 2);
  const bytes = Buffer.from(jsonStr, "utf-8");
  return uploadFile({
    parentFolderId,
    name,
    contentType: "application/json",
    bytes,
    existingFileId,
  });
}

/**
 * Rename a file/folder and/or move it to a different parent. Used by
 * the MOVE_TO_DELETED task: rename the doc folder to include the
 * human title, and swap its parent from the taxonomy folder to
 * `_deleted/YYYY-MM/`.
 */
export async function moveAndRenameFile(params: {
  fileId: string;
  newName?: string;
  addParentId?: string;
  removeParentId?: string;
}): Promise<void> {
  const { fileId, newName, addParentId, removeParentId } = params;
  const token = await getAccessToken();
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  if (addParentId) url.searchParams.set("addParents", addParentId);
  if (removeParentId) url.searchParams.set("removeParents", removeParentId);
  url.searchParams.set("fields", "id,parents,name");
  const body = newName ? { name: newName } : {};
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new DriveApiError(res.status, `PATCH /files/${fileId} failed (${res.status}): ${detail}`);
  }
}

export async function deleteFile(id: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return; // Already gone — treat as success.
  if (!res.ok) {
    const detail = await res.text();
    throw new DriveApiError(res.status, `DELETE /files/${id} failed (${res.status}): ${detail}`);
  }
}
