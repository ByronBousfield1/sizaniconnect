import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ROLE_LABELS } from '../lib/format';
import type { Role } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
}

const NAV: NavItem[] = [
  { to: '/overview', label: 'Overview', roles: ['Admin', 'OperationsManager', 'SiteCoordinator'] },
  { to: '/desk', label: 'Event desk', roles: ['SiteCoordinator', 'OperationsManager', 'Volunteer'] },
  { to: '/households', label: 'Households', roles: ['SiteCoordinator', 'OperationsManager', 'Admin'] },
  { to: '/events', label: 'Distribution events', roles: ['SiteCoordinator', 'OperationsManager', 'Admin'] },
  { to: '/shifts', label: 'Shifts', roles: ['Volunteer', 'SiteCoordinator'] },
  { to: '/stock', label: 'Stock', roles: ['OperationsManager', 'SiteCoordinator', 'Admin'] },
  { to: '/donations', label: 'Donations', roles: ['OperationsManager', 'Admin'] },
  { to: '/reports', label: 'Reports', roles: ['OperationsManager', 'Admin'] },
  { to: '/donor', label: 'My giving', roles: ['Donor'] },
  { to: '/admin/users', label: 'Users', roles: ['Admin'] },
  { to: '/admin/sites', label: 'Sites', roles: ['Admin'] },
  { to: '/admin/audit', label: 'Audit log', roles: ['Admin'] },
];

export function Layout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (!user) return null;
  const items = NAV.filter((n) => n.roles.includes(user.role));

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          SizaniConnect
        </span>
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? 'Close menu' : 'Menu'}
        </button>
      </header>

      <nav id="primary-nav" className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Main">
        <span className="brand brand-side">
          <img src="/favicon.svg" alt="" width="32" height="32" />
          SizaniConnect
        </span>
        <ul>
          {items.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to}>{n.label}</NavLink>
            </li>
          ))}
        </ul>
        <div className="whoami">
          <p className="whoami-name">{user.fullName}</p>
          <p className="whoami-role">
            {ROLE_LABELS[user.role]}
            {user.siteName ? `, ${user.siteName}` : ''}
          </p>
          <button type="button" className="link-button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </nav>

      <main id="main" className="content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
