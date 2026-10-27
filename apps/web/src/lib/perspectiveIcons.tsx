/**
 * The one place a perspective's icon KEY becomes a drawable component.
 *
 * The database stores keys (`PERSPECTIVE_ICONS` in @repo/permissions) so
 * that no row points into a UI library. This map is the other half. It is
 * typed as a complete `Record` over the key union, so adding a key without
 * a component is a build error rather than a blank space in the picker.
 *
 * MOSTLY LUCIDE, DELIBERATELY NOT ONLY. The icons that shipped before
 * the roles refactor were react-icons, and the lucide equivalents are
 * used here wherever one exists, because lucide is what the rest of this
 * app draws with. `user-key` is the exception: lucide has no person
 * holding a key, and the nearest it offers (`UserCog`, a person with a
 * gear) was tried and is not the same picture. `react-icons` is already
 * a dependency and this header already draws Feather and Grommet icons
 * side by side, so the real rule is "the right glyph", not "one set".
 */
import {
  Banknote,
  Briefcase,
  Calculator,
  ChartNoAxesColumn,
  ClipboardList,
  Eye,
  GraduationCap,
  HardHat,
  Home,
  Key,
  Leaf,
  Shield,
  ShieldCheck,
  Star,
  Truck,
  User,
  UserCog,
  Users,
  Wrench,
} from "lucide-react";
// The original Admin icon, kept because nothing in lucide draws it.
import { GrUserAdmin } from "react-icons/gr";
import type { PerspectiveIcon } from "@repo/permissions";

export const PERSPECTIVE_ICON_COMPONENTS: Record<PerspectiveIcon, React.ElementType> = {
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
};

/** Null for no icon and for a key this build does not know — a row
 *  written by a newer deploy must not crash an older one. */
export function perspectiveIconFor(key?: string | null): React.ElementType | null {
  if (!key) return null;
  return (PERSPECTIVE_ICON_COMPONENTS as Record<string, React.ElementType>)[key] ?? null;
}
