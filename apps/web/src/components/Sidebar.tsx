'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot, Wrench, ClipboardList, CalendarClock, History, Settings2, Sun, Moon, Play
} from 'lucide-react';

const NAV = [
  { label: 'Agents',     href: '/agents',     icon: Bot },
  { label: 'Tools',      href: '/tools',      icon: Wrench },
  { label: 'Tasks',      href: '/tasks',      icon: ClipboardList },
  { label: 'Task Runs',  href: '/task-runs',  icon: Play },
  { label: 'Scheduler',  href: '/scheduler',  icon: CalendarClock },
  { label: 'Run History',href: '/history',    icon: History },
];

export default function Sidebar() {
  const path = usePathname();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || (!stored && window.matchMedia('(prefers-color-scheme: light)').matches)) {
      setTheme('light');
      document.body.classList.add('light');
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'light') {
      document.body.classList.add('light');
    } else {
      document.body.classList.remove('light');
    }
  };

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

      <div style={{ marginTop: 'auto', padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          onClick={toggleTheme}
          className="nav-item"
          style={{ width: '100%', background: 'transparent', border: 'none', textAlign: 'left' }}
        >
          {theme === 'dark' ? <Sun width={16} height={16} /> : <Moon width={16} height={16} />}
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>
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
