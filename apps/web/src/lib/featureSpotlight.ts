"use client";

// ─────────────────────────────────────────────────────────────────────────────
// "SHOW ME" HAS TO ACTUALLY SHOW THEM.
//
// It shipped as a tab navigation and nothing more, and for the commonest case
// that is not a weak version of the feature, it is no feature at all:
// somebody already on the Jobs tab pressed Show me, the bar disappeared, and
// the app stayed exactly where it was. The second attempt added a ring around
// the control, which was better and still not enough — a 2px outline on a
// 26px icon in a busy header is something you find only if you already know
// where to look, which is precisely what the person does not.
//
// So this is a coach-mark: the page goes dark, the one control stays lit, and
// it STAYS that way until they press it. There is no reading required and
// nothing to hunt for, and because the dark part also swallows clicks there
// is nothing else to press by mistake.
//
// A FEATURE OPTS IN WITH ONE ATTRIBUTE. Put `data-whats-new="<announcement
// id>"` on the control. Nothing else — no registration, no import, no
// coupling to the bar, and the attribute is inert at every other moment.
// ─────────────────────────────────────────────────────────────────────────────

/** The attribute a feature tags its control with. */
export const SPOTLIGHT_ATTR = "data-whats-new";
/** Set on the lit element while the coach-mark is up; the CSS rings it. */
export const SPOTLIGHT_ACTIVE_ATTR = "data-whats-new-spotlight";
/** The overlay's own root, so only one can ever be on screen. */
const OVERLAY_ATTR = "data-whats-new-overlay";

/** Breathing room between the control and the dark. */
const HOLE_PAD = 6;

export function spotlightFeature(
  key: string,
  { timeoutMs = 12_000, caption }: { timeoutMs?: number; caption?: string } = {},
): void {
  if (typeof document === "undefined") return;
  const selector = `[${SPOTLIGHT_ATTR}="${CSS.escape(key)}"]`;

  whenElementAppears(selector, (el) => openCoachMark(el, caption), timeoutMs);
}

/**
 * Run something once an element exists, however long the app takes.
 *
 * NOT A FIXED DELAY. The thing being waited for usually does not exist yet:
 * a tab is switching, and what comes next may be behind a fetch that takes a
 * second on a cold serverless database. A timed guess is either too short
 * (acts on nothing) or too long (arrives after the person has stopped
 * looking). An observer fires when it actually appears.
 *
 * It also GIVES UP. Something that never renders for this person must not
 * leave an observer walking every mutation in the app for the session.
 */
export function whenElementAppears(
  selector: string,
  run: (el: HTMLElement) => void,
  timeoutMs = 12_000,
): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelector(selector);
  if (existing) { run(existing as HTMLElement); return; }
  let timer = 0;
  const obs = new MutationObserver(() => {
    const el = document.querySelector(selector);
    if (!el) return;
    obs.disconnect();
    window.clearTimeout(timer);
    run(el as HTMLElement);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  timer = window.setTimeout(() => obs.disconnect(), timeoutMs);
}

/**
 * Bring something into view and flash it — NOT the coach-mark.
 *
 * Used to land somebody on the What's new list after jumping to Profile.
 * Deliberately gentle: the coach-mark darkens the app and holds until you
 * press one control, which is right for "here is the new button" and wrong
 * for "here is the list you asked for" — you have already found what you
 * were looking for, and being locked out of the rest of the page is an
 * obstacle rather than a pointer.
 *
 * Inline styles, like everything else here, so it cannot be silenced by a
 * stylesheet arriving out of step with this file.
 */
export function revealElement(selector: string): void {
  whenElementAppears(selector, (el) => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const priorOutline = el.style.outline;
    const priorOffset = el.style.outlineOffset;
    const priorTransition = el.style.transition;
    el.style.transition = "outline-color 0.5s ease-out";
    el.style.outline = "2px solid rgba(59, 130, 246, 0.9)";
    el.style.outlineOffset = "3px";
    window.setTimeout(() => { el.style.outline = "2px solid rgba(59, 130, 246, 0)"; }, 1400);
    window.setTimeout(() => {
      el.style.outline = priorOutline;
      el.style.outlineOffset = priorOffset;
      el.style.transition = priorTransition;
    }, 2200);
  });
}

/**
 * Dim everything, leave one control lit, and wait.
 *
 * FOUR PANELS, NOT ONE DIV WITH A HOLE. A hole can be cut with `clip-path`
 * or a 9999px box-shadow, but both leave the whole screen covered by one
 * element, and then either everything is clickable (the dark is decoration)
 * or nothing is (including the control). Four rectangles round the target
 * leave a real gap: the control is reachable exactly as it normally is, and
 * the dark genuinely swallows everything else.
 */
function openCoachMark(target: HTMLElement, caption?: string) {
  // One at a time. A second press while one is up replaces it rather than
  // stacking a second layer of dark on the first.
  document.querySelector(`[${OVERLAY_ATTR}]`)?.remove();

  const root = document.createElement("div");
  root.setAttribute(OVERLAY_ATTR, "1");

  // THE APPEARANCE IS SET HERE, NOT IN A STYLESHEET.
  //
  // This overlay is built by this function, and it shipped relying on rules
  // in globals.css to make it dark. Those are two files that can arrive in a
  // browser out of step — which is exactly what happened: a session running
  // the current CSS against a stale JS chunk got transparent click-blockers,
  // a caption, and no dark whatsoever. The app looked completely normal with
  // a floating "Click to try it" label on it.
  //
  // An element created in JS carries its own look. Nothing to drift, and
  // nothing that depends on a stylesheet having kept up. The CSS file keeps
  // only the optional breathing animation, whose absence costs nothing.
  // HOW DARK. 0.84 was heavy enough that the app behind it read as switched
  // off rather than waiting; 0.55 — the first attempt — left everything
  // comfortably readable, so the eye had no reason to go anywhere in
  // particular. This sits between them: the page is plainly backgrounded
  // and one control is plainly not.
  const DIM = "rgba(0, 0, 0, 0.7)";
  const EDGE = "rgba(255, 255, 255, 0.5)";

  // FOUR INVISIBLE BLOCKERS AND ONE VISIBLE SPOTLIGHT, which is not one
  // thing too many. The dark has to do two jobs that no single element can:
  // swallow every click except on the control, and be a soft shape. Hit
  // testing ignores `mask` and ignores the hole in a box-shadow, so an
  // element that LOOKS like a ring with a hole is still a solid rectangle
  // to the pointer. These four are transparent and exist only to absorb
  // clicks; the light is drawn by the one below them.
  const panels = ["top", "right", "bottom", "left"].map((side) => {
    const d = document.createElement("div");
    d.className = "seedlings-spotlight-panel";
    d.dataset.side = side;
    // THE PANELS CARRY THE DARK THEMSELVES.
    //
    // They were transparent, with the darkening done by one element casting
    // a 9999px-spread box-shadow. That is the tidier trick and it did not
    // work: three attempts in a row rendered a perfectly bright app with a
    // floating caption on it, while the same code darkened correctly in a
    // headless Chromium here. The one version that ever darkened on the
    // real machine was the one with plain opaque rectangles.
    //
    // So the thing that must not fail is now a background colour on four
    // divs, which cannot be clipped by an ancestor, cannot be dropped for
    // exceeding a spread limit, and has no interaction with compositing.
    // The soft rounded edge is still there, added by `light` below, but it
    // is now a nicety on top of a dark that does not depend on it.
    Object.assign(d.style, {
      position: "fixed",
      zIndex: "1600",
      background: DIM,
    });
    root.appendChild(d);
    return d;
  });

  // THE SPOTLIGHT ITSELF: a box the size of the control casting an enormous
  // soft shadow outwards. That is what makes the edge feathered and the
  // shape the control's own — the first version left four hard-edged panels
  // around a square gap, so a round button sat in a white paper cut-out
  // with a ring drawn on top of it, two marks fighting over one control.
  const light = document.createElement("div");
  light.className = "seedlings-spotlight-light";
  // ROUNDS THE HOLE, nothing more. It sits exactly in the rectangular gap
  // the four panels leave and feathers its own dark into the corners, so a
  // round button gets a round hole instead of a punched square. A local
  // spread, not a page-sized one: the page is already dark.
  Object.assign(light.style, {
    position: "fixed",
    zIndex: "1600",
    pointerEvents: "none",
    boxShadow: `0 0 0 1px ${EDGE}, 0 0 12px 16px ${DIM}`,
  });
  light.style.animation = "seedlings-spotlight-breathe 2.6s ease-in-out infinite";
  root.appendChild(light);

  const hint = document.createElement("div");
  hint.className = "seedlings-spotlight-hint";
  Object.assign(hint.style, {
    position: "fixed",
    zIndex: "1602",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
    padding: "5px 11px",
    borderRadius: "9999px",
    fontSize: "12px",
    fontWeight: "500",
    background: "rgba(23, 23, 26, 0.92)",
    color: "#fff",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
    pointerEvents: "none",
  });
  // "Tap" on a laptop is somebody else's app. The pointer type is the only
  // honest way to know which word this person uses.
  hint.textContent =
    caption ??
    (window.matchMedia?.("(pointer: coarse)")?.matches ? "Tap to try it" : "Click to try it");
  root.appendChild(hint);

  document.body.appendChild(root);
  target.setAttribute(SPOTLIGHT_ACTIVE_ATTR, "1");
  // Lift the control above the blockers. Also set inline for the same
  // reason as everything else here: the mark must not depend on a
  // stylesheet to be usable, and a control sitting UNDER the blockers is
  // a control the person is being told to press and cannot.
  const priorPosition = target.style.position;
  const priorZ = target.style.zIndex;
  if (getComputedStyle(target).position === "static") target.style.position = "relative";
  target.style.zIndex = "1601";

  let hintHalf = 0;
  const place = () => {
    // The control can go away under us — the tab changes, the day collapses,
    // the list refetches and re-renders. Dark panels left over a page whose
    // lit control has vanished is the worst outcome available here, so a
    // missing target closes the whole thing rather than freezing it.
    if (!document.contains(target)) return close();
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return close();
    const top = Math.max(0, r.top - HOLE_PAD);
    const left = Math.max(0, r.left - HOLE_PAD);
    const right = Math.min(window.innerWidth, r.right + HOLE_PAD);
    const bottom = Math.min(window.innerHeight, r.bottom + HOLE_PAD);

    // The hole takes the control's OWN corner radius, so a pill button gets
    // a pill of light and a square one gets a square. `9999px` on a pill
    // clamps to something the browser will render; the pad keeps the light
    // concentric with the control rather than hugging it.
    const ownRadius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 6;
    Object.assign(light.style, {
      top: `${top}px`,
      left: `${left}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      borderRadius: `${Math.min(ownRadius + HOLE_PAD, 999)}px`,
    });

    const [t, rt, b, l] = panels;
    Object.assign(t.style, { top: "0px", left: "0px", width: "100%", height: `${top}px` });
    Object.assign(b.style, { top: `${bottom}px`, left: "0px", width: "100%", height: `${Math.max(0, window.innerHeight - bottom)}px` });
    Object.assign(l.style, { top: `${top}px`, left: "0px", width: `${left}px`, height: `${bottom - top}px` });
    Object.assign(rt.style, { top: `${top}px`, left: `${right}px`, width: `${Math.max(0, window.innerWidth - right)}px`, height: `${bottom - top}px` });

    // The hint sits under the hole, or above it when the control is near the
    // bottom of the window — on a phone the two are a few pixels apart and a
    // caption off the bottom edge is a caption nobody reads.
    const below = window.innerHeight - bottom > 56;
    hint.style.top = below ? `${bottom + 10}px` : `${Math.max(8, top - 34)}px`;
    // CLAMPED BY ITS OWN HALF-WIDTH, not by its centre. The pill is
    // translated -50%, so clamping the centre to 8px still hangs half the
    // caption off the screen — which is exactly what happened: the control
    // lives at the far left of the day header, and the hint read
    // "…here to try it". Measured rather than assumed, because the text is
    // caller-supplied and its width is whatever the theme's font makes it.
    //
    // Measured ONCE. `place()` runs on every scroll event, and reading a
    // rect forces the browser to lay out synchronously each time — for a
    // caption whose text never changes while the mark is up.
    if (hintHalf === 0) hintHalf = hint.getBoundingClientRect().width / 2;
    const half = hintHalf;
    const centre = r.left + r.width / 2;
    hint.style.left = `${Math.min(Math.max(centre, half + 8), window.innerWidth - half - 8)}px`;
  };

  let raf = 0;
  /**
   * SCROLL REPOSITIONS SYNCHRONOUSLY. This deferred to the next animation
   * frame, which is the usual advice and is wrong here: for that one frame
   * the hole is where the control USED to be, so the dark is sitting on the
   * control — and a tap landing in that frame is swallowed by the very
   * overlay telling you to tap. Playwright found it by scrolling and
   * clicking faster than a frame and waiting for ever; a person scrolling
   * with a thumb and tapping straight away can hit the same window.
   *
   * It is two style writes against a rect we have already measured, so
   * doing it inline costs less than the bug.
   */
  const onScroll = () => place();
  const replace = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };

  function close() {
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", replace);
    document.removeEventListener("keydown", onKey, true);
    target.removeEventListener("click", onHit, true);
    target.removeAttribute(SPOTLIGHT_ACTIVE_ATTR);
    // Put the control's own positioning back rather than leaving a z-index
    // on it for the rest of the session.
    target.style.position = priorPosition;
    target.style.zIndex = priorZ;
    root.remove();
  }

  // Dismissed by DOING THE THING — capture phase, so it closes even if the
  // control stops the event, and the control's own click runs as normal.
  const onHit = () => close();
  // …or by giving up. Without this a coach-mark is a trap: the person who
  // does not want it now has no way out, and dark panels that cannot be
  // dismissed are worse than the button doing nothing.
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

  target.addEventListener("click", onHit, { capture: true, once: true });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", replace);
  // CLICKING THE DARK DOES NOTHING AT ALL — it does not pass through and it
  // does not dismiss. The point of this is that there is one thing to press,
  // and a stray tap anywhere else cancelling the whole thing is how somebody
  // loses the pointer before they have found what it points at. Escape above
  // is the deliberate way out, so this is firm rather than a trap.
  root.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });

  // `center` rather than the default `start`: the destination is often a
  // small control inside a long scroll, and putting it under the sticky
  // header is the same as not scrolling at all.
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  place();
  // The smooth scroll animates, so the hole has to follow it rather than be
  // measured once at the start.
  const settle = window.setInterval(place, 50);
  window.setTimeout(() => window.clearInterval(settle), 900);
}
