'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot, Wrench, ClipboardList, CalendarClock, History, Settings2
} from 'lucide-react';

const NAV = [
  { label: 'Agents',     href: '/agents',    icon: Bot },
  { label: 'Tools',      href: '/tools',     icon: Wrench },
  { label: 'Tasks',      href: '/tasks',     icon: ClipboardList },
  { label: 'Scheduler',  href: '/scheduler', icon: CalendarClock },
  { label: 'Run History',href: '/history',   icon: History },
];

export default function Sidebar() {
  const path = usePathname();
  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <h1>InPro</h1>
        <span>AI Workflow Platform</span>
      </div>

      <div className="nav-section">
        <div className="nav-label">Workspace</div>
        {NAV.map(({ label, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`nav-item${path?.startsWith(href) ? ' active' : ''}`}
          >
            <Icon />
            {label}
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 'auto', padding: '0 8px' }}>
        <Link
          href="/settings"
          className={`nav-item${path?.startsWith('/settings') ? ' active' : ''}`}
        >
          <Settings2 width={16} height={16} />
          LLM Settings
        </Link>
      </div>
    </nav>
  );
}
