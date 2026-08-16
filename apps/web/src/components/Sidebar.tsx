import { useRef, useState } from 'react';
import {
  Bot, Users, Inbox,
  Send, CheckCircle, FileText, BarChart2,
  Shield, Settings, Store, Sun, Moon,
  type LucideProps,
} from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import logo from '../assets/logo.png';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';

/**
 * `tab` is the routing vocabulary, not copy: `SIDEBAR_TABS` in AppContext reads
 * these exact strings off the URL through `slug()`/`fromSlug()`, and `activeTab`
 * is compared against them. So the visible label is a second field holding a
 * descriptor rather than a translation of `tab` — translating the tab value
 * would rewrite every address in the app.
 */
const m = defineMessages({
  aiWorkspace: { id: 'shell.sidebar.aiWorkspace', defaultMessage: 'AI Workspace' },
  clients: { id: 'shell.sidebar.clients', defaultMessage: 'Clients' },
  inboxes: { id: 'shell.sidebar.inboxes', defaultMessage: 'Inboxes' },
  chases: { id: 'shell.sidebar.chases', defaultMessage: 'Chases' },
  approvals: { id: 'shell.sidebar.approvals', defaultMessage: 'Approvals' },
  documents: { id: 'shell.sidebar.documents', defaultMessage: 'Documents' },
  analytics: { id: 'shell.sidebar.analytics', defaultMessage: 'Analytics' },
  team: { id: 'shell.sidebar.team', defaultMessage: 'Team' },
  settings: { id: 'shell.sidebar.settings', defaultMessage: 'Settings' },
  businessPortal: { id: 'shell.sidebar.businessPortal', defaultMessage: 'Business portal' },
  darkMode: { id: 'shell.sidebar.darkMode', defaultMessage: 'Dark mode' },
  lightMode: { id: 'shell.sidebar.lightMode', defaultMessage: 'Light mode' },
  logoAlt: {
    id: 'shell.sidebar.logoAlt',
    defaultMessage: 'Migrate Properly',
    description: 'Alt text for the product mark. A company name — leave untranslated.',
  },
});

const navItems = [
  { icon: Bot, tab: 'AI Workspace', label: m.aiWorkspace },
  { icon: Users, tab: 'Clients', label: m.clients },
  { icon: Inbox, tab: 'Inboxes', label: m.inboxes },
  { icon: Send, tab: 'Chases', label: m.chases },
  { icon: CheckCircle, tab: 'Approvals', label: m.approvals },
  { icon: FileText, tab: 'Documents', label: m.documents },
  { icon: BarChart2, tab: 'Analytics', label: m.analytics },
  { icon: Shield, tab: 'Team', label: m.team },
  { icon: Settings, tab: 'Settings', label: m.settings },
];

const RAIL_COLLAPSED = 80;
const RAIL_EXPANDED = 224;

// Dock magnification: an item sits at ICON_REST until the cursor comes within
// FALLOFF px of its centre, peaking at ICON_MAX directly under the cursor. The
// neighbours grow proportionally less, which is what gives the macOS Dock its
// bulge rather than a single popping icon.
const ICON_REST = 48;
const ICON_MAX = 62;
const FALLOFF = 130;

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Opens the business-portal launcher, which App renders above this rail. */
  onOpenBusinessPortal: () => void;
}

export function Sidebar({ activeTab, setActiveTab, onOpenBusinessPortal }: SidebarProps) {
  const { settings, updateSettings } = useAppContext();
  const intl = useIntl();
  const isLight = settings.theme === 'light';
  const mouseY = useMotionValue(Number.POSITIVE_INFINITY);
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.aside
      onMouseMove={(e) => mouseY.set(e.clientY)}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => {
        setExpanded(false);
        mouseY.set(Number.POSITIVE_INFINITY);
      }}
      initial={false}
      animate={{ width: expanded ? RAIL_EXPANDED : RAIL_COLLAPSED }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      className="h-full flex flex-col py-6 border-r border-white/5 bg-card shrink-0 gap-8 z-20 overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 shrink-0">
        {/* The mark already carries its own plate and rounded corners. */}
        <img
          src={logo}
          alt={intl.formatMessage(m.logoAlt)}
          className="w-12 h-12 rounded-2xl shrink-0 object-cover shadow-[0_0_18px_rgba(20,227,196,0.25)]"
        />
      </div>
      <nav className="flex flex-col gap-1.5 w-full px-4">
        {navItems.map((item) => (
          <DockItem
            key={item.tab}
            icon={item.icon}
            label={intl.formatMessage(item.label)}
            isActive={activeTab === item.tab}
            expanded={expanded}
            mouseY={mouseY}
            onClick={() => setActiveTab(item.tab)}
          />
        ))}
      </nav>

      {/* The client-facing portal is a separate shell, not another tab here. */}
      <div className="mt-auto w-full px-4 pt-4 border-t border-white/5">
        <DockItem
          icon={Store}
          label={intl.formatMessage(m.businessPortal)}
          isActive={false}
          expanded={expanded}
          mouseY={mouseY}
          onClick={onOpenBusinessPortal}
        />
        <DockItem
          icon={isLight ? Moon : Sun}
          label={intl.formatMessage(isLight ? m.darkMode : m.lightMode)}
          isActive={false}
          expanded={expanded}
          mouseY={mouseY}
          onClick={() => updateSettings({ theme: isLight ? 'dark' : 'light' })}
        />
      </div>
    </motion.aside>
  );
}

interface DockItemProps {
  icon: React.ComponentType<LucideProps>;
  label: string;
  isActive: boolean;
  expanded: boolean;
  mouseY: MotionValue<number>;
  onClick: () => void;
}

function DockItem({ icon: Icon, label, isActive, expanded, mouseY, onClick }: DockItemProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const distance = useTransform(mouseY, (y: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return FALLOFF;
    return y - (bounds.y + bounds.height / 2);
  });

  const sizeTarget = useTransform(
    distance,
    [-FALLOFF, 0, FALLOFF],
    [ICON_REST, ICON_MAX, ICON_REST],
    { clamp: true }
  );
  const size = useSpring(sizeTarget, { mass: 0.1, stiffness: 190, damping: 14 });
  const iconScale = useTransform(size, [ICON_REST, ICON_MAX], [1, 1.22]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      className="w-full flex items-center gap-3 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 rounded-2xl"
    >
      <motion.span
        style={{ height: size }}
        className={`shrink-0 w-12 rounded-2xl flex items-center justify-center transition-colors duration-300 ${
          isActive
            ? 'bg-brand text-white shadow-[0_0_20px_rgba(20,227,196,0.2)]'
            : 'text-zinc-500 group-hover:bg-white/5 group-hover:text-white'
        }`}
      >
        <motion.span style={{ scale: iconScale }} className="flex">
          <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
        </motion.span>
      </motion.span>
      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: expanded ? 1 : 0, x: expanded ? 0 : -8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className={`text-sm whitespace-nowrap ${
          isActive ? 'font-semibold text-white' : 'font-medium text-zinc-400 group-hover:text-white'
        }`}
      >
        {label}
      </motion.span>
    </button>
  );
}
