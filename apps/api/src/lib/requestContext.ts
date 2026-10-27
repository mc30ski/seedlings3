/**
 * Per-request facts that the audit trail needs but no call site carries.
 *
 * WHY AMBIENT AND NOT A PARAMETER. `writeAudit` has 369 call sites. Adding
 * an argument to record the active perspective would mean editing all of
 * them, and every one a future contributor forgets to pass becomes a row
 * that quietly claims the person was acting at full breadth when they were
 * not. The value belongs to the REQUEST, not to the call, so it travels
 * with the request.
 *
 * WHAT THIS IS NOT. It is not a general-purpose grab bag and must not
 * become one. Anything a handler can pass explicitly, it should: ambient
 * state is invisible at the point of use, and that is a cost worth paying
 * only where the alternative is 369 opportunities to get it wrong.
 *
 * IT CAN NEVER GRANT ANYTHING. What is stored here is a label used in an
 * audit row. Authorization reads `req.principal`, which is resolved from
 * the database in `plugins/rbac.ts`; nothing in this module is consulted
 * by `can()`, by a route guard, or by any filter.
 *
 * ABSENT IS A LEGITIMATE ANSWER. Cron, pay links, display tokens and the
 * seed run outside any request and get `undefined` — correctly, because
 * no perspective was active. A missing field in the metadata means "no
 * perspective", never "we failed to look".
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestAuditContext = {
  /** The perspective in force, if the caller had narrowed themselves. */
  perspective?: { roleId: string; name?: string } | null;
};

const storage = new AsyncLocalStorage<RequestAuditContext>();

/** Run `fn` with this context attached to everything it awaits. */
export function withRequestAuditContext<T>(ctx: RequestAuditContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Open an EMPTY context for this request and run the rest inside it.
 *
 * Called from an `onRequest` hook, which is early enough that every later
 * hook and the handler itself run inside the same async context. The
 * perspective is not known yet at that point — `setRequestAuditContext`
 * fills it in later by MUTATING the object this created.
 *
 * WHY NOT `enterWith` AT THE POINT THE PERSPECTIVE IS RESOLVED. That was
 * the first attempt and it silently did nothing: `enterWith` binds the
 * store to the currently executing async resource, and Fastify runs the
 * handler in a sibling context rather than a descendant of the hook, so
 * the value was gone by the time `writeAudit` looked. It failed quietly —
 * audit rows simply had no perspective — which is the worst way for an
 * audit mechanism to fail.
 */
export function runWithRequestAuditContext(fn: () => void): void {
  storage.run({}, fn);
}

/**
 * Fill in the perspective on the context opened for this request.
 *
 * Mutates rather than replaces, because the store object is what every
 * later read resolves to. Does nothing outside a request — cron, pay links
 * and the seed have no context and need none.
 */
export function setRequestAuditContext(ctx: RequestAuditContext): void {
  const store = storage.getStore();
  if (!store) return;
  store.perspective = ctx.perspective;
}

/** The current context, or undefined outside a request. */
export function currentRequestAuditContext(): RequestAuditContext | undefined {
  return storage.getStore();
}
