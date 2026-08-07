// Dev-only suppression for a known-benign React 18 warning triggered by
// Chakra v3's mergeRefs pattern.
//
// Chakra v3 was written targeting React 19, whose callback-ref contract
// lets a ref callback RETURN a cleanup function (mirrors useEffect's
// return). React 18 doesn't understand that contract yet and warns:
//
//   "Unexpected return value from a callback ref in <X>.
//    A callback ref should not return a function."
//
// The cleanup return is intentional and safe on React 18 (React just
// ignores it). Once we upgrade to React 19, the warning goes away on its
// own AND React starts respecting the cleanup return. Until then, this
// suppression silences the message so the console isn't flooded on every
// Chakra-heavy render / navigation.
//
// One-time boot warning is printed (in orange) so the suppression stays
// visible — the whole point of the reminder is "don't forget this is on."
//
// If ANY of these change, revisit this file:
//   • React upgraded 18 → 19 → delete this file and its import.
//   • Chakra downgraded v3 → v2 → same.
//   • You suspect a real "ref returning function" bug in our own code →
//     temporarily disable this suppression and re-add the JSX-level
//     diagnostic (git history: apps/web/src/lib/refReturnDiagnostic.ts
//     at commit that introduced this file).

const INSTALLED_KEY = "__seedlings_refWarningSuppression_installed";
const ROUTER_HOOK_KEY = "__seedlings_refWarningSuppression_routerHooked";

// The reminder message itself — printed on boot AND on every client-side
// route change so it stays impossible to miss. Kept identical across
// callsites so the user recognizes it visually.
//
// Wording is intentional: makes clear this is an INTENTIONAL piece of
// the app's own code (not a browser extension, not a Next.js internal,
// not left over from a debug session). "Active" phrasing signals it's
// a currently-maintained decision that should be revisited after the
// React upgrade — not fire-and-forget.
function printNotice() {
  // eslint-disable-next-line no-console
  console.warn(
    "%c[seedlings · intentional dev-only patch]%c This app actively suppresses React 18's 'callback ref should not return a function' warning — a known false positive from Chakra v3's mergeRefs (Chakra targets React 19's cleanup-return contract). Implemented in src/lib/chakraRefWarningSuppression.ts. Delete that file + its _app.tsx import when we upgrade to React 19.",
    "color:#a16207;font-weight:bold;background:#fef3c7;padding:2px 6px;border-radius:4px",
    "color:#a16207",
  );
}

function install() {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "development") return;

  // Patch console.error ONCE per session (HMR-safe via sentinel). The
  // notice is printed on every module load regardless — see below.
  if (!(window as any)[INSTALLED_KEY]) {
    (window as any)[INSTALLED_KEY] = true;

    const origError = console.error;
    console.error = function (this: any, ...args: unknown[]) {
      const first = args[0];
      // Match React's specific warning text; stable across 18.x. Both
      // substrings must be present so unrelated messages aren't swallowed.
      if (
        typeof first === "string"
        && first.includes("callback ref")
        && first.includes("return a function")
      ) {
        return;
      }
      return origError.apply(this, args as any);
    };
  }

  // Fire the reminder immediately on module load (hard-refresh + first
  // page visit) so it appears in fresh consoles.
  printNotice();

  // Also fire the reminder on every client-side route change. Next.js's
  // soft-navigation between pages doesn't re-run this module, so without
  // the router hook the notice would only appear on hard refresh — easy
  // to miss when the tab has been open for a while.
  if (!(window as any)[ROUTER_HOOK_KEY]) {
    (window as any)[ROUTER_HOOK_KEY] = true;
    // Dynamic require so this file has no top-level dependency on
    // next/router — keeps the module independently importable and dodges
    // any SSR edge cases.

    try {
      const Router = require("next/router").default;
      if (Router?.events?.on) {
        Router.events.on("routeChangeComplete", printNotice);
      }
    } catch {
      // If Next's router isn't available (non-Next context), silently
      // skip. The one-time boot notice still fires.
    }
  }
}

install();
