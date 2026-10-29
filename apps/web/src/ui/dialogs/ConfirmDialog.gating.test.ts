// ─────────────────────────────────────────────────────────────────────────────
// A CONFIRM BUTTON MUST BE SATISFIABLE.
//
// `ConfirmDialog` gates Confirm on `requiredInputValue` — type the name to
// prove you mean it — and rendered the text box only when a separate
// `inputPlaceholder` was passed. Set one without the other and you got a
// dialog with no box and a button that could never be enabled.
//
// It shipped to production. Suspend and Delete on a role were both dead,
// and the only symptom was the button looking a shade pale: no error, no
// refusal, nothing to tell the operator they were not simply unauthorised.
//
// The rule these assert is one sentence — if the confirm depends on typed
// input, the input is on screen — and it is pure arithmetic over the
// props, which is why it can be tested without rendering anything.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

/** The dialog's own two derivations, kept in step with the component. */
function gating(props: {
  inputPlaceholder?: string;
  requiredInputValue?: string;
  inputOptional?: boolean;
  inputValue: string;
}) {
  const { inputPlaceholder, requiredInputValue, inputOptional, inputValue } = props;
  const hasInput = !!inputPlaceholder || requiredInputValue != null;
  const typedMatchesRequired =
    requiredInputValue == null ||
    inputValue.trim().toLowerCase() === requiredInputValue.trim().toLowerCase();
  const canConfirm =
    (!hasInput || inputOptional || inputValue.trim().length > 0) && typedMatchesRequired;
  return { hasInput, canConfirm };
}

describe("ConfirmDialog gating", () => {
  it("shows the box whenever the confirm depends on typed input", () => {
    // THE REGRESSION. No placeholder, a required value — this returned
    // hasInput:false and canConfirm:false together, which is a button
    // nobody can ever press.
    const g = gating({ requiredInputValue: "District Lead", inputValue: "" });
    expect(g.hasInput, "a gated confirm must render its input").toBe(true);
    expect(g.canConfirm).toBe(false);
  });

  it("is never gated on input it does not show", () => {
    // The invariant, stated directly: canConfirm:false for an empty box is
    // only acceptable when the box exists.
    for (const props of [
      { requiredInputValue: "Role", inputValue: "" },
      { inputPlaceholder: "type it", inputValue: "" },
      { inputPlaceholder: "p", requiredInputValue: "Role", inputValue: "" },
    ]) {
      const g = gating(props);
      if (!g.canConfirm) {
        expect(g.hasInput, `unsatisfiable: ${JSON.stringify(props)}`).toBe(true);
      }
    }
  });

  it("enables once the typed value matches, trimmed and case-insensitively", () => {
    expect(gating({ requiredInputValue: "District Lead", inputValue: "district lead" }).canConfirm).toBe(true);
    expect(gating({ requiredInputValue: "District Lead", inputValue: "  District Lead " }).canConfirm).toBe(true);
    expect(gating({ requiredInputValue: "District Lead", inputValue: "District" }).canConfirm).toBe(false);
  });

  it("a plain dialog with no input confirms immediately", () => {
    const g = gating({ inputValue: "" });
    expect(g.hasInput).toBe(false);
    expect(g.canConfirm).toBe(true);
  });
});
