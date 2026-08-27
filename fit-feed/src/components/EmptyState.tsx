interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  title: string;
  message?: string;
  action?: EmptyStateAction;
  /** compact: tighter vertical rhythm for in-card / secondary placements */
  compact?: boolean;
}

// Shared editorial empty state: typography-led, generous whitespace, and a
// small muted swatch motif that echoes the color-palette chips (the app's
// core visual identity) without becoming an illustration card.
export default function EmptyState({ title, message, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center text-center px-6 animate-fade-in ${compact ? 'py-8' : 'py-16'}`}>
      <div className="flex gap-1.5 mb-4" aria-hidden="true">
        <span className="w-2.5 h-2.5 rounded-full bg-[var(--border)]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)] opacity-40" />
        <span className="w-2.5 h-2.5 rounded-full bg-[var(--border)]" />
      </div>
      <h3 className="text-base font-semibold text-[var(--text-h)] tracking-tight mb-1">
        {title}
      </h3>
      {message && (
        <p className="text-sm text-[var(--text)] max-w-xs leading-relaxed">
          {message}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-5 border border-[var(--border)] rounded-full px-4 py-1.5 text-sm font-medium text-[var(--text-h)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
