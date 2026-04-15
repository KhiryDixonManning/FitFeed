import { Link, useLocation } from 'react-router-dom';
import { logout } from '../Authentication';

const navItems = [
  { path: '/',            label: 'Feed',         icon: '🏠' },
  { path: '/upload',      label: 'Upload',        icon: '➕' },
  { path: '/leaderboard', label: 'Aura Farmers',  icon: '🏆' },
  { path: '/insights',    label: 'Insights',      icon: '📊' },
  { path: '/profile',     label: 'Profile',       icon: '👤' },
];

export default function Navbar() {
  const { pathname } = useLocation();

  return (
    <>
      {/* Desktop top navbar */}
      <nav className="hidden md:flex items-center justify-between px-6 py-3 border-b border-[var(--border)] bg-[var(--bg)]">
        <span className="font-bold text-xl text-[var(--text-h)]">FitFeed</span>
        <div className="flex gap-4 items-center">
          {navItems.map(({ path, label }) => (
            <Link
              key={path}
              to={path}
              className={`text-sm font-medium transition-colors ${
                pathname === path
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text)] hover:text-[var(--text-h)]'
              }`}
            >
              {label}
            </Link>
          ))}
          <button
            onClick={() => logout()}
            className="text-sm text-[var(--text)] hover:text-red-500 transition-colors ml-2"
          >
            Logout
          </button>
        </div>
      </nav>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[var(--bg)] border-t border-[var(--border)] flex items-center justify-around px-2 py-2 safe-area-bottom">
        {navItems.map(({ path, label, icon }) => (
          <Link
            key={path}
            to={path}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-colors ${
              pathname === path
                ? 'text-[var(--accent)]'
                : 'text-[var(--text)]'
            }`}
          >
            <span className="text-xl">{icon}</span>
            <span className="text-xs font-medium">{label}</span>
          </Link>
        ))}
        <button
          onClick={() => logout()}
          className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-[var(--text)] hover:text-red-500 transition-colors"
        >
          <span className="text-xl">🚪</span>
          <span className="text-xs font-medium">Out</span>
        </button>
      </nav>

      {/* Spacer so content is not hidden behind mobile bottom bar */}
      <div className="md:hidden" style={{ height: 'calc(64px + env(safe-area-inset-bottom))' }} />
    </>
  );
}
