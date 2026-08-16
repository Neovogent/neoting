import { useRef, useState } from 'react';
import {
  Bot, Users, Inbox,
  Send, CheckCircle, FileText, BarChart2,
  Shield, Settings, Store, Sun, Moon,
  type LucideProps,
} from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import logo from '../assets/logo.png';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';

const navItems = [
  { icon: Bot, label: 'AI Workspace' },
  { icon: Users, label: 'Clients' },
  { icon: Inbox, label: 'Inboxes' },
  { icon: Send, label: 'Chases' },
  { icon: CheckCircle, label: 'Approvals' },
  { icon: FileText, label: 'Documents' },
  { icon: BarChart2, label: 'Analytics' },
  { icon: Shield, label: 'Team' },
  { icon: Settings, label: 'Settings' },
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
          alt="Migrate Properly"
          className="w-12 h-12 rounded-2xl shrink-0 object-cover shadow-[0_0_18px_rgba(20,227,196,0.25)]"
        />
      </div>
      <nav className="flex flex-col gap-1.5 w-full px-4">
        {navItems.map((item) => (
          <DockItem
            key={item.label}
            icon={item.icon}
            label={item.label}
            isActive={activeTab === item.label}
            expanded={expanded}
            mouseY={mouseY}
            onClick={() => setActiveTab(item.label)}
          />
        ))}
      </nav>

      {/* The client-facing portal is a separate shell, not another tab here. */}
      <div className="mt-auto w-full px-4 pt-4 border-t border-white/5">
        <DockItem
          icon={Store}
          label="Business portal"
          isActive={false}
          expanded={expanded}
          mouseY={mouseY}
          onClick={onOpenBusinessPortal}
        />
        <DockItem
          icon={isLight ? Moon : Sun}
          label={isLight ? 'Dark mode' : 'Light mode'}
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
