import { test, expect } from "@playwright/test";

// OPT-IN. Measures every element on 34 tabs across 14 themes — ~476 screens,
// ~47 minutes. Run it before a deploy, or after touching the theme tokens:
//
//   THEME_SWEEP=1 npx playwright test --project=super theme-contrast-sweep --workers=1
//
// It keeps the `-admin` suffix because it needs the super project's auth, and
// is gated on the env var instead: left ungated it added 47 minutes to every
// full-suite run, and renamed out of `-admin` it fell into the EMPLOYEE
// project, which cannot reach these tabs at all.

// Every Super tab, in dark mode, reporting two failure shapes:
//   LIGHT  — a pale surface that never got a dark value (the "menu not dark"
//            class of bug: a raw `gray.100` reads the same in every theme)
//   LOWCON — text under 3:1 against the surface behind it (the "dark badge
//            with black text" class)
const TABS = [
  "home", "jobs", "routes", "services", "tasks",
  "equipment", "collections", "vehicles",
  "clients", "properties", "users", "groups",
  "payments", "payroll", "pricing", "supplies", "ledger", "promotions", "forecast",
  "reconcile", "workdays", "compliance", "activity",
  "history", "timeline", "documents", "guides", "audit",
  "tools-mowing", "tools-mulch",
  "notify", "settings", "profile", "vanity",
];
const CAT: Record<string, string> = {
  home: "Work", jobs: "Work", routes: "Work", services: "Work", tasks: "Work",
  equipment: "Equipment", collections: "Equipment", vehicles: "Equipment",
  clients: "Directory", properties: "Directory", users: "Directory", groups: "Directory",
  payments: "Money", payroll: "Money", pricing: "Money", supplies: "Money",
  ledger: "Money", promotions: "Money", forecast: "Money",
  reconcile: "Records", workdays: "Records", compliance: "Records", activity: "Records",
  history: "Records", timeline: "Records", documents: "Records", guides: "Records", audit: "Records",
  "tools-mowing": "Tools", "tools-mulch": "Tools",
  notify: "System", settings: "System", profile: "System", vanity: "System",
};

const AUDIT = () => {
  const lum = (c: string) => {
    const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return -1;
    const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  };
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const light: any[] = [];
  const lowcon: any[] = [];
  const seenL = new Set<string>();
  const seenC = new Set<string>();

  for (const el of Array.from(document.querySelectorAll("*")) as HTMLElement[]) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;

    // Pale surface
    // Panels, not controls. A white primary button and a bright yellow badge
    // are deliberate and legible; an unthemed CARD is the bug being hunted.
    const isPanel = r.width >= 240 && r.height >= 56;
    if (isPanel && /^rgb\(/.test(cs.backgroundColor)) {
      const bl = lum(cs.backgroundColor);
      if (bl > 0.5) {
        const k = cs.backgroundColor + "|" + Math.round(r.width) + "x" + Math.round(r.height);
        if (!seenL.has(k)) {
          seenL.add(k);
          light.push({ bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height),
                       text: (el.textContent || "").trim().slice(0, 44) });
        }
      }
    }

    // Unreadable text: only leaf-ish nodes that actually render characters.
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0);
    if (!own) continue;
    // Composite every translucent layer down to the first opaque one. Simply
    // taking the nearest non-transparent background treats an rgba(0,0,0,.04)
    // hover veil as THE surface and scores black-on-white at 1.3:1 — which is
    // where most of this sweep's false positives came from.
    const parse = (c: string): [number, number, number, number] | null => {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
    };
    const layers: [number, number, number, number][] = [];
    let gradient = false;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      // A gradient paints the surface but reports no backgroundColor, so
      // compositing would sail straight past it to whatever is behind —
      // scoring the title bar's white text against the white PAGE at 1:1.
      // We cannot sample a gradient here, so this element is not judged.
      if (getComputedStyle(node).backgroundImage !== "none") { gradient = true; break; }
      const p = parse(getComputedStyle(node).backgroundColor);
      if (!p || p[3] === 0) continue;
      layers.push(p);
      if (p[3] === 1) break;
    }
    if (gradient) continue;
    if (!layers.length || layers[layers.length - 1][3] !== 1) continue;
    let comp = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      comp = [r * a + comp[0] * (1 - a), g * a + comp[1] * (1 - a), b * a + comp[2] * (1 - a), 1];
    }
    const bg = `rgb(${Math.round(comp[0])}, ${Math.round(comp[1])}, ${Math.round(comp[2])})`;
    const fl = lum(cs.color), bl2 = lum(bg);
    if (fl < 0 || bl2 < 0) continue; // color(srgb …) / unparsed — not a finding
    const cr = ratio(fl, bl2);
    if (cr < 3) {
      const k = cs.color + "|" + bg;
      if (!seenC.has(k)) {
        seenC.add(k);
        lowcon.push({ fg: cs.color, bg, ratio: Math.round(cr * 100) / 100,
                      text: (el.textContent || "").trim().slice(0, 44) });
      }
    }
  }
  return { light, lowcon };
};

const THEMES = ["original", "dark", "contrast", "spring", "summer", "fall", "winter",
                "funkadelic", "retro", "coffeehouse", "espresso",
                "urban", "jelly", "juice"];

// A BUDGET, not a target. Each number is what that theme measured after the
// contrast work, and the point is that it can only go DOWN. This spec used
// to merely log: it passed green while a change to the `solid` token pushed
// dark from 2 unreadable elements to 31, across buttons on every tab. A
// logging test cannot catch that, so the count is now an assertion.
//
// Lower a number when you genuinely improve a theme. Do not raise one
// without reading the findings it prints first — they name the element.
const BUDGET: Record<string, number> = {
  original: 0, dark: 0, contrast: 0, spring: 0, summer: 0, fall: 0, winter: 0,
  funkadelic: 0, retro: 0, coffeehouse: 0, espresso: 0,
  urban: 0, jelly: 0, juice: 0,
};

const SWEEP_ENABLED = process.env.THEME_SWEEP === "1";

for (const THEME of THEMES)
test(`theme sweep: ${THEME}`, async ({ page }) => {
  test.skip(!SWEEP_ENABLED, "opt-in: set THEME_SWEEP=1 (takes ~47 minutes)");
  test.setTimeout(20 * 60_000);
  page.on("pageerror", (e) => console.log(`PAGEERROR ${e.message}`));

  await page.goto("/");
  await page.evaluate((T) => {
    localStorage.setItem("seedlings_theme", T);
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  }, THEME);

  let totalL = 0, totalC = 0;
  for (const tab of TABS) {
    await page.evaluate(
      ([t, c]) => {
        localStorage.setItem("seedlings_superTab", JSON.stringify(t));
        localStorage.setItem("seedlings_superCategory", JSON.stringify(c));
      },
      [tab, CAT[tab]],
    );
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2200);

    const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const want = THEME === "original" ? null : THEME;
    if (applied !== want) { console.log(`${THEME} [${tab}] THEME NOT APPLIED (${applied})`); continue; }

    // A tab that navigates while the audit is running destroys the execution
    // context mid-evaluate. That is a harness race, not a finding, so retry
    // once rather than failing the theme.
    let audited: { light: any[]; lowcon: any[] };
    try {
      audited = await page.evaluate(AUDIT);
    } catch {
      await page.waitForTimeout(1500);
      audited = await page.evaluate(AUDIT);
    }
    const { light, lowcon } = audited;
    if (THEME === "dark") totalL += light.length;
    totalC += lowcon.length;
    console.log(`${THEME} [${tab}] light=${light.length} lowcontrast=${lowcon.length}`);
    for (const l of light.slice(0, 6)) console.log(`   LIGHT  ${l.bg} ${l.w}x${l.h} "${l.text}"`);
    for (const c of lowcon.slice(0, 6)) console.log(`   LOWCON ${c.ratio}:1 ${c.fg} on ${c.bg} "${c.text}"`);
  }
  console.log(`==== ${THEME.toUpperCase()} TOTAL light=${totalL} lowcontrast=${totalC} ====`);
  expect(totalC, `${THEME}: unreadable elements rose above its budget — see the LOWCON lines above`)
    .toBeLessThanOrEqual(BUDGET[THEME]);
  if (THEME === "dark") {
    expect(totalL, "dark: a pale surface reappeared — see the LIGHT lines above")
      .toBeLessThanOrEqual(BUDGET.dark);
  }
});
