import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { apiPost, apiDelete } from "@/src/lib/api";

export async function doAction<T extends { id: string }>(
  item: T,
  name: string,
  domain: string,
  action: string,
  attr: keyof T,
  refresh: () => Promise<void>
) {
  try {
    const updated = await apiPost<T>(
      `/api/admin/${domain}/${item.id}/${action}`,
      {}
    );
    if (!updated) throw Error("Server did not return results.");
    await refresh();
    publishInlineMessage({
      type: "SUCCESS",
      text: `${name} '${item[attr]}' ${action} successful.`,
    });
  } catch (err) {
    publishInlineMessage({
      type: "ERROR",
      text: getErrorMessage(`${name} '${item[attr]}' ${action} failed.`, err),
    });
  }
}

export async function doDelete(
  id: string,
  name: string,
  domain: string,
  displayName: string,
  refresh: () => Promise<void>
) {
  try {
    const success = await apiDelete(`/api/admin/${domain}/${id}`);
    if (!success) throw Error("Server did not return success.");
    await refresh();
    publishInlineMessage({
      type: "SUCCESS",
      text: `${name}${displayName ? " '" + displayName + "'" : ""} delete successful.`,
    });
  } catch (err) {
    publishInlineMessage({
      type: "ERROR",
      text: getErrorMessage(
        `${name}${displayName ? "'" + displayName + "'" : ""} delete failed.`,
        err
      ),
    });
  }
}
