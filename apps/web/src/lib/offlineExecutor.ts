import { apiPost, apiDelete } from "@/src/lib/api";
import { setActionExecutor, type QueuedAction } from "./offlineQueue";

export function initOfflineExecutor() {
  setActionExecutor(async (action: QueuedAction) => {
    const { type, payload } = action;
    const occId = action.occurrenceId;

    switch (type) {
      case "START_JOB":
        await apiPost(`/api/occurrences/${occId}/start`, payload);
        break;
      case "COMPLETE_JOB":
        await apiPost(`/api/occurrences/${occId}/complete`, payload);
        break;
      case "PAUSE_JOB":
        await apiPost(`/api/occurrences/${occId}/pause`, payload);
        break;
      case "RESUME_JOB":
        await apiPost(`/api/occurrences/${occId}/resume`, payload);
        break;
      case "ADD_PHOTO": {
        // Photos: payload has { base64, fileName, contentType }
        const { base64, fileName, contentType } = payload as { base64: string; fileName: string; contentType: string };
        // Step 1: Get upload URL
        const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
          `/api/occurrences/${occId}/photos/upload-url`,
          { fileName, contentType },
        );
        // Step 2: Convert base64 back to blob and upload to R2
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: contentType });
        const uploadRes = await fetch(uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
        if (!uploadRes.ok) throw new Error(`R2 upload failed: ${uploadRes.status}`);
        // Step 3: Confirm
        await apiPost(`/api/occurrences/${occId}/photos/confirm`, { key, fileName, contentType });
        break;
      }
      case "ADD_EXPENSE":
        await apiPost(`/api/occurrences/${occId}/expenses`, payload);
        break;
      case "POST_COMMENT":
        await apiPost(`/api/occurrences/${occId}/comments`, payload);
        break;
      case "SET_REMINDER":
        await apiPost(`/api/occurrences/${occId}/reminder`, payload);
        break;
      case "CLEAR_REMINDER":
        await apiPost(`/api/occurrences/${occId}/reminder/clear`, payload);
        break;
      case "PIN":
        await apiPost(`/api/occurrences/${occId}/pin`);
        break;
      case "UNPIN":
        await apiPost(`/api/occurrences/${occId}/unpin`);
        break;
      case "LIKE":
        await apiPost(`/api/occurrences/${occId}/like`);
        break;
      case "UNLIKE":
        await apiPost(`/api/occurrences/${occId}/unlike`);
        break;
      case "DISMISS_REMINDER":
        await apiPost(`/api/standalone-reminders/${occId}/dismiss`);
        break;
      default:
        throw new Error(`Unknown action type: ${type}`);
    }
  });
}
