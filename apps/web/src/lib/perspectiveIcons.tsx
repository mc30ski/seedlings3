/**
 * The one place a perspective's icon KEY becomes a drawable component.
 *
 * The database stores keys (`PERSPECTIVE_ICONS` in @repo/permissions) so
 * that no row points into a UI library.
 *
 * TWO TIERS, FOR BUNDLE SIZE, NOT FOR TASTE.
 *
 * The catalogue is every icon lucide ships — about 1,850. Importing them
 * all by name would put roughly a megabyte of JavaScript in front of every
 * first paint, because this map is reachable from the header chip, which is
 * always on screen. So:
 *
 *   · the twenty COMMON keys, plus the handful of legacy aliases, are
 *     imported statically and resolve synchronously — the chip draws on the
 *     first frame with no flash and no request;
 *   · everything else resolves from `lib/allLucideIcons`, a single async
 *     chunk fetched the first time anything asks for an icon outside that
 *     set. One chunk, shared: a picker rendering 1,835 glyphs triggers one
 *     module load, not 1,835.
 *
 * `useIconComponent` is how a component asks, because the answer can arrive
 * a frame late. `perspectiveIconFor` is the synchronous form and is honest
 * about its limit: it returns null for anything outside the static set.
 *
 * MOSTLY LUCIDE, DELIBERATELY NOT ONLY. `user-key` is the exception:
 * lucide has no person holding a key, and the nearest it offers (`UserCog`,
 * a person with a gear) was tried and is not the same picture. `react-icons`
 * is already a dependency, so the rule is "the right glyph", not "one set".
 */
import { useEffect, useState } from "react";
import { Icon } from "@chakra-ui/react";
import {
  Banknote, Briefcase, Building2, Calculator, ChartNoAxesColumn, ClipboardList,
  Eye, Flower2, GraduationCap, HardHat, Home, Key, Leaf, Share2, Shield,
  ShieldCheck, Star, TreeDeciduous, Truck, User, UserCog, Users, Wrench,
} from "lucide-react";
// The original Admin icon, kept because nothing in lucide draws it.
import { GrUserAdmin } from "react-icons/gr";

/**
 * Resolved synchronously, always in the main bundle: the twenty offered
 * before "Show more", plus the four legacy aliases whose keys are not
 * lucide names and so cannot be resolved by the lazy path.
 */
export const PERSPECTIVE_ICON_COMPONENTS: Record<string, React.ElementType> = {
  home: Home,
  user: User,
  "user-cog": UserCog,
  "user-key": GrUserAdmin,
  users: Users,
  shield: Shield,
  "shield-check": ShieldCheck,
  briefcase: Briefcase,
  clipboard: ClipboardList,
  wrench: Wrench,
  truck: Truck,
  leaf: Leaf,
  calculator: Calculator,
  banknote: Banknote,
  chart: ChartNoAxesColumn,
  key: Key,
  eye: Eye,
  star: Star,
  "graduation-cap": GraduationCap,
  "hard-hat": HardHat,
  // Legacy aliases. Not lucide spellings, kept because a role in the
  // database may already wear one. Each duplicates a glyph the picker
  // offers under its real name, so none of them appear in the picker.
  tree: TreeDeciduous,
  flower2: Flower2,
  building2: Building2,
  share2: Share2,
};

/**
 * Null for no icon, and for a key outside the static set — a row written by
 * a newer deploy must not crash an older one. Use `useIconComponent` where
 * the full catalogue matters; this only sees what is already in the bundle.
 */
export function perspectiveIconFor(key?: string | null): React.ElementType | null {
  if (!key) return null;
  return PERSPECTIVE_ICON_COMPONENTS[key] ?? null;
}

/**
 * One in-flight load, shared by every caller.
 *
 * Kept at module scope rather than inside the hook so that a grid of 1,835
 * icons mounting in the same frame produces exactly one `import()`. Once
 * settled, `loaded` answers synchronously, so later renders never flash.
 */
type Resolver = (key: string) => React.ElementType | null;
let loaded: Resolver | null = null;
let inFlight: Promise<Resolver> | null = null;

function loadAll(): Promise<Resolver> {
  if (loaded) return Promise.resolve(loaded);
  if (!inFlight) {
    inFlight = import("./allLucideIcons")
      .then((m) => {
        loaded = m.lucideByKebab;
        return loaded;
      })
      .catch((err) => {
        // Reset so a transient network failure is retried by the next
        // render rather than wedging every icon for the session.
        inFlight = null;
        throw err;
      });
  }
  return inFlight;
}

/**
 * The component for a key, resolving the lazy catalogue if it has to.
 *
 * Returns null while loading, so callers render nothing (or their own
 * fallback) for that frame. An icon arriving a beat late beats a spinner
 * the size of a glyph, and for anything common it never happens at all.
 */
export function useIconComponent(key?: string | null): React.ElementType | null {
  const staticHit = perspectiveIconFor(key);
  const [resolved, setResolved] = useState<React.ElementType | null>(() =>
    key && !staticHit && loaded ? loaded(key) : null,
  );

  useEffect(() => {
    if (!key || staticHit) return;
    if (loaded) {
      setResolved(loaded(key));
      return;
    }
    let live = true;
    loadAll()
      .then((resolve) => { if (live) setResolved(resolve(key)); })
      .catch(() => { if (live) setResolved(null); });
    return () => { live = false; };
  }, [key, staticHit]);

  return staticHit ?? resolved;
}

/** Warm the chunk ahead of a grid, so the picker opens filled in. */
export function preloadAllIcons(): void {
  void loadAll().catch(() => {});
}

/**
 * Draw a perspective icon by key.
 *
 * A component rather than a function because resolving outside the common
 * set needs a hook, and hooks cannot be called from inside a `.map()`.
 * Every instance shares the one module load, so a grid of these costs one
 * request however many cells it has.
 */
export function PerspectiveGlyph({
  iconKey,
  fallback,
  boxSize = 4,
  color,
}: {
  iconKey?: string | null;
  /** Drawn when the key is empty or unknown. Omit to draw nothing. */
  fallback?: React.ElementType;
  boxSize?: number;
  color?: string;
}) {
  const resolved = useIconComponent(iconKey);
  const Cmp = resolved ?? fallback;
  if (!Cmp) return null;
  return <Icon as={Cmp} boxSize={boxSize} color={color} />;
}
