export function getErrorMessage(err: unknown): string {
  const anyErr = err as any;
  if (anyErr?.status === 401 || anyErr?.status === 403) {
    return "Not authorized or not approved. Use the DEV user switcher above.";
  }
  return typeof anyErr?.message === "string"
    ? anyErr.message
    : "Unexpected error";
}
