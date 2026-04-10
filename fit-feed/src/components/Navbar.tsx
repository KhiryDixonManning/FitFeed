import { Link, useLocation } from 'react-router-dom';
import { logout } from '../Authentication';

const navItems = [
  { path: '/',            label: 'Feed'        },
  { path: '/upload',      label: 'Upload'      },
  { path: '/leaderboard', label: 'Leaderboard' },
  { path: '/profile',     label: 'Profile'     },
];

export default function Navbar() {
  const { pathname } = useLocation();

  return (
    <nav className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)] bg-[var(--bg)]">
      <span className="font-bold text-xl text-[var(--text-h)] pr-2">FitFeed</span>
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
          className="text-sm text-[var(--text)] hover:text-red-500 transition-colors ml-2 mr-2 sm:mr-0"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
