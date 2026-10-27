/**
 * THE PERMISSION MODEL — shared by the API and the web app.
 *
 * Both halves live here because both halves need the same answer. The server
 * decides whether a route may run; the web app decides whether to render the
 * button that calls it. When those two diverge you get the Unclaim bug: the
 * UI said `isClaimer`, the server said `isClaimer || schedule.manage`, and a
 * claimer-less visit could not be released by anyone. G15 exists to stop
 * that, and the cheapest way to satisfy it is for there to be only one
 * implementation.
 *
 * This is only possible because `can()` is a pure function — no prisma, no
 * cache, no I/O (G3 fails the build otherwise). A principal is resolved once
 * on the server and, for the UI, arrives as `capabilities` on /api/me.
 */
export * from "./entitlements";
export * from "./perspectiveIcons";
export * from "./permissions";
