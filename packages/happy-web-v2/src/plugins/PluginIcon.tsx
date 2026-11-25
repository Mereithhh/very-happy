/**
 * B-974d: a plugin's icon. Only the wire's built-in names (`PLUGIN_ICONS`) or
 * one emoji (DESIGN B-973 §2.1) — never an SVG or image URL from the plugin.
 */
import {
  Bell,
  Bot,
  Calendar,
  ChartColumn,
  Check,
  Clock,
  Code,
  Database,
  File,
  Flag,
  Folder,
  Globe,
  Heart,
  House,
  Inbox,
  KanbanSquare,
  Layers,
  List,
  Mail,
  Map,
  Package,
  Puzzle,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  SquareTerminal,
  Star,
  Tag,
  User,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { PluginIcon as PluginIconName } from '@slopus/happy-wire';
import { iconKind } from './pluginModel';

const ICONS: Record<PluginIconName, LucideIcon> = {
  puzzle: Puzzle,
  kanban: KanbanSquare,
  bot: Bot,
  inbox: Inbox,
  bell: Bell,
  chart: ChartColumn,
  list: List,
  terminal: SquareTerminal,
  calendar: Calendar,
  check: Check,
  clock: Clock,
  code: Code,
  database: Database,
  file: File,
  flag: Flag,
  folder: Folder,
  globe: Globe,
  heart: Heart,
  home: House,
  layers: Layers,
  mail: Mail,
  map: Map,
  package: Package,
  rocket: Rocket,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  star: Star,
  tag: Tag,
  user: User,
  zap: Zap,
};

export function PluginIcon({ icon, size = 16, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const kind = iconKind(icon);
  if (kind.kind === 'emoji') {
    return (
      <span className={['plg-icon-emoji', className].filter(Boolean).join(' ')} style={{ fontSize: size, lineHeight: 1, width: size, height: size }} aria-hidden>
        {kind.text}
      </span>
    );
  }
  const Icon = ICONS[kind.name];
  return <Icon size={size} className={className} aria-hidden />;
}
