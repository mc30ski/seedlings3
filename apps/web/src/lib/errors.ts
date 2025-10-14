export function getErrorMessage(err: unknown): string {
  const anyErr = err as any;
  if (anyErr?.status === 401 || anyErr?.status === 403) {
    return "Not authorized or not approved.";
  }
  return typeof anyErr?.message === "string"
    ? anyErr.message
    : "Unexpected error";
}
