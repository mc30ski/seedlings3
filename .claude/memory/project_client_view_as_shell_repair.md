---
name: project-client-view-as-shell-repair
description: "Client View-As was dead in the browser for four separate reasons, all of them 'the operator is not a client contact'. Repaired 2026-10-18."
metadata:
  node_type: memory
  type: project
---

Client "View as" (`clients.view-as`, `docs/features/client-view-as.md`) looked
fine on the server and was unusable in the browser. `/api/me` answers as the
OPERATOR during a session — impersonation applies to `/client/*` — so
`me.isClientContact` is false and `capabilities` comes back empty, and four
separate places read that as "a staff member who wandered into the portal":

1. `pages/index.tsx` shell-reconciliation effect flipped `topTab` straight
   back to `"staff"` after `setClientImpersonation` had set it to `"client"`.
2. The two customer tabs (`my-jobs` "My Properties", `statements`) were
   `visible: () => … && me.isClientContact` — the session rendered a portal
   with the tabs it exists to show missing.
3. `NoRoleNotice` painted its no-access screen over the portal, because zero
   capabilities means `hasCapabilityTab()` is false.
4. `ImpersonationBanner` gated the client branch on `perspectives.length > 0`,
   which is 0 inside a session — no notice it was running and no exit but
   clearing localStorage by hand.

Each fix is `|| clientViewAs`, a mount-read of `getClientImpersonation()`, and
touches nothing on the real-customer path.

**The trap that fix #4 walked into:** `ImpersonationBanner` read
`getClientImpersonation()` **during render**. localStorage does not exist on
the server, so the first client paint disagreed with the SSR output, React
threw the whole tree away ("Hydration failed… the entire root will switch to
client rendering"), and in dev the `<nextjs-portal>` error overlay sat over
the page intercepting every click. Playwright reports that as
`locator.click: Timeout` with "element is visible, enabled and stable" — it
looks like a flaky click and is not one. **Anything that reads localStorage
in a component that server-renders must read it in a `useEffect`, not in the
render body.**

Related: [[reference-view-as-endpoints]] (a different feature — worker view-as
on `GET /me/*`), [[feedback-e2e-localstorage-stamp-race]].
