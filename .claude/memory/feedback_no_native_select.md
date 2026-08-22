---
name: feedback-no-native-select
description: NEVER use the native HTML <select> in this web app. Always use the Chakra Select.Root pattern with createListCollection.
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:21:50.606Z
---

**NEVER use the native `<select>` element anywhere in the web app.** Always use the Chakra UI Select.Root pattern with `createListCollection`.

**Why:** The user has corrected this MULTIPLE times across the codebase. The app uses Chakra UI v3 throughout, and native dropdowns are visually inconsistent (different fonts, sizes, colors, no positioning control, broken inside dialogs/portals, ugly on mobile). The user has explicitly told me to use the Chakra pattern "every fucking time across the app" — this is one of their most repeated corrections.

**How to apply:** Whenever I need a dropdown / picker / single-select control in any tab, dialog, or form in [apps/web/](apps/web/), use this pattern:

```tsx
import { Select, createListCollection } from "@chakra-ui/react";

const items = [
  { label: "—", value: "" },
  ...options.map((o) => ({ label: o.name, value: o.id })),
];
const collection = useMemo(() => createListCollection({ items }), [items]);

<Select.Root
  collection={collection}
  value={[currentValue]}
  onValueChange={(e) => setValue(e.value[0] ?? "")}
  size="sm"
  positioning={{ strategy: "fixed", hideWhenDetached: true }}
>
  <Select.Control>
    <Select.Trigger w="full">
      <Select.ValueText placeholder="— Select —" />
    </Select.Trigger>
  </Select.Control>
  <Select.Positioner>
    <Select.Content>
      {items.map((it) => (
        <Select.Item key={it.value} item={it.value}>
          <Select.ItemText>{it.label}</Select.ItemText>
        </Select.Item>
      ))}
    </Select.Content>
  </Select.Positioner>
</Select.Root>
```

Key points:
- Always `positioning={{ strategy: "fixed", hideWhenDetached: true }}` — this is what makes it work correctly inside Dialog/Portal contexts (otherwise the dropdown gets clipped or hidden).
- `value` is always an array (Chakra v3 collection convention), even for single-select.
- Reference implementations (grep `Select.Root` in any of these for a working example): `apps/web/src/ui/tabs/InventoryTab.tsx` (renamed from the old EquipmentTab.tsx per the 2026-08-21 refactor — see [[project-tab-refactor-2026-08-21]]), `apps/web/src/ui/tabs/BusinessExpensesTab.tsx`, `apps/web/src/ui/tabs/SuppliesTab.tsx`, `apps/web/src/ui/tabs/SuperUnclaimedTab.tsx`. Copy from these.

Before writing ANY dropdown/picker in this app: search for `Select.Root` in a nearby file and mirror the pattern. Never write `<select>` or `<option>` tags.
