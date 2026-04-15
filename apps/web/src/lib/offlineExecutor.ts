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
      case "ADD_PHOTO":
        // Photos are special — the payload should contain the base64 data
        // For now, skip photo upload in offline queue (complex)
        throw new Error("Photo upload not supported offline yet");
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
