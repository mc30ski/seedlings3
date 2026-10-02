import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE BOARD RE-ANNOUNCES ITSELF WHEN IT CHANGES.
 *
 * The trigger's loudest state ("never seen this") is keyed to BOARD_VERSION,
 * so bumping that constant puts the ring and the wiggle back on every user's
 * trophy once. The whole point is that a redesign gets LOOKED at instead of
 * sitting behind an icon people have trained themselves to ignore.
 *
 * That only works if somebody remembers to bump it, and nobody will. So this
 * gate fingerprints DayBoard.tsx: change the file and the build stops and
 * makes you choose.
 *
 *   • User-visible change  -> bump BOARD_VERSION, then update EXPECTED below.
 *   • Comment / refactor   -> leave BOARD_VERSION alone, just update EXPECTED.
 *                             Bumping re-nags everyone; a typo fix is not
 *                             worth that.
 *
 * Either way the decision is made on purpose rather than forgotten. The
 * failure message prints the hash to paste in.
 */

const BOARD = path.resolve(__dirname, "../../../web/src/ui/components/DayBoard.tsx");

/** sha256 of DayBoard.tsx as of the last deliberate review. */
const EXPECTED = "4d19b95e57af76f46c467c241721545efe4dec4b699261dda1356333b5ad9963";

describe("[build-gate] the board re-announces itself when it changes", () => {
  const src = readFileSync(BOARD, "utf8");

  it("reads the file it guards", () => {
    expect(src).toContain("export const BOARD_VERSION");
    expect(src.length).toBeGreaterThan(2000);
  });

  it("the trigger keys its loudest state off BOARD_VERSION", () => {
    const trigger = readFileSync(
      path.resolve(__dirname, "../../../web/src/ui/components/DayBoardButton.tsx"),
      "utf8",
    );
    // Storing a bare constant instead would mean a redesign never re-announces.
    expect(trigger).toMatch(/getItem\(everKey\) === BOARD_VERSION/);
    expect(trigger).toMatch(/setItem\(everKey, BOARD_VERSION\)/);
    // A pinned override ships a permanent nag. It is a review-only tool.
    expect(trigger, "a FORCE_* override must never be committed")
      .not.toMatch(/FORCE_[A-Z_]*\s*=\s*true/);
  });

  it("DayBoard.tsx is unchanged since BOARD_VERSION was last considered", () => {
    const actual = createHash("sha256").update(src).digest("hex");
    expect(
      actual,
      "DayBoard.tsx changed. Decide which this was:\n" +
        "  • a user would notice  -> bump BOARD_VERSION in DayBoard.tsx so the\n" +
        "    trigger re-announces the board, THEN paste the new hash below\n" +
        "  • cosmetic only        -> leave BOARD_VERSION alone, paste the hash\n" +
        `\nEXPECTED = "${actual}"\n`,
    ).toBe(EXPECTED);
  });
});
