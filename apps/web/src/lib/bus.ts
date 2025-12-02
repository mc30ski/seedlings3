export function openAdminEquipmentSearchOnce(q: string) {
  // Fire a custom event — anything can call this (e.g., your clickable qrSlug)
  window.dispatchEvent(
    new CustomEvent("admin:openEquipmentSearch", { detail: { q } })
  );
}

export function openClientPropertySearch(q: string, forAdmin: boolean) {
  window.dispatchEvent(
    new CustomEvent("open:clientPropertySearch", { detail: { q, forAdmin } })
  );
}
