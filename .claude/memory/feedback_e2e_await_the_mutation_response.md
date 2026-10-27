---
name: feedback-e2e-await-the-mutation-response
description: "Waiting for optimistic UI and then navigating aborts the in-flight POST; the row never exists and the failure lands somewhere unrelated."
metadata:
  node_type: memory
  type: feedback
---

`display-pairing-owner` clicked the pair confirm, waited for the screen's
NAME to appear, then navigated. The name can render before the server
answers, so the navigation aborted the request: the trace showed
`POST /api/displays/approve` with **status -1**, no `Display` row was ever
created, and the test failed two steps later on a missing "Re-pair this
screen" button — which looked like a UI regression and was not.

**After a mutation that a later step depends on, await the RESPONSE, not the
optimistic render:**

```ts
const approved = app.waitForResponse(
  (r) => r.url().includes("/api/displays/approve") && r.request().method() === "POST",
  { timeout: 30_000 },
);
await app.getByRole("alertdialog").getByRole("button", { name: /^Pair screen$/ }).click();
expect((await approved).status()).toBeLessThan(400);
```

**How to diagnose this class:** unzip the failing test's `trace.zip` and read
the network entries — a `-1` status is an aborted request and points straight
at the real step. Far faster than reasoning from the screenshot, which shows
the symptom (an absent row) and not the cause.

The tell that it is a race and not a regression: it passes when run alone on
an idle machine and fails once the dev server has been working for hours.

Related: [[feedback-e2e-fixed-sleeps-on-loading-lists]],
[[feedback-never-ship-a-red-spec]].
