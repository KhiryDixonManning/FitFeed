// Loading skeletons that mirror the real layouts so content lands without
// layout shift. Same visual language as PostDetail's existing skeleton
// (bg-[var(--border)] blocks + animate-pulse).

export function PostCardSkeleton() {
  return (
    <div className="rounded-2xl shadow-lg bg-[var(--bg-secondary)] overflow-hidden flex flex-col animate-pulse">
      <div className="w-full aspect-square bg-[var(--border)]" />
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="w-9 h-9 rounded-full bg-[var(--border)] shrink-0" />
        <div className="flex-1 flex flex-col gap-1.5">
          <div className="h-3.5 bg-[var(--border)] rounded w-2/3" />
          <div className="h-3 bg-[var(--border)] rounded w-1/3" />
        </div>
      </div>
      <div className="flex gap-2 px-3 mt-3">
        <div className="flex-1 h-[72px] bg-[var(--border)] rounded-xl" />
        <div className="flex-1 h-[72px] bg-[var(--border)] rounded-xl" />
        <div className="flex-1 h-[72px] bg-[var(--border)] rounded-xl" />
      </div>
      <div className="flex items-center gap-4 px-3 py-4">
        <div className="h-5 w-10 bg-[var(--border)] rounded" />
        <div className="h-5 w-10 bg-[var(--border)] rounded" />
        <div className="ml-auto h-5 w-5 bg-[var(--border)] rounded" />
      </div>
    </div>
  );
}

// Square image tile with a caption line — matches Explore/Profile grid tiles.
export function GridTileSkeleton({ withCaption = true }: { withCaption?: boolean }) {
  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden animate-pulse">
      <div className="w-full aspect-square bg-[var(--border)]" />
      {withCaption && (
        <div className="p-3 flex flex-col gap-1.5">
          <div className="h-3.5 bg-[var(--border)] rounded w-3/4" />
          <div className="h-3 bg-[var(--border)] rounded-full w-1/3" />
        </div>
      )}
    </div>
  );
}

export function LeaderboardRowSkeleton() {
  return (
    <div className="flex gap-3 border border-[var(--border)] rounded-xl overflow-hidden animate-pulse">
      <div className="flex items-center justify-center w-10 shrink-0">
        <div className="h-5 w-6 bg-[var(--border)] rounded" />
      </div>
      <div className="w-16 h-16 sm:w-20 sm:h-20 bg-[var(--border)] shrink-0" />
      <div className="p-2 flex flex-col justify-center gap-1.5 flex-1">
        <div className="h-3 bg-[var(--border)] rounded w-1/4" />
        <div className="h-3.5 bg-[var(--border)] rounded w-1/2" />
        <div className="h-3 bg-[var(--border)] rounded w-1/3" />
      </div>
    </div>
  );
}

// Profile header: avatar circle + identity lines.
export function ProfileHeaderSkeleton() {
  return (
    <div className="px-4 md:px-0 mb-6 flex items-start gap-4 animate-pulse">
      <div className="w-20 h-20 rounded-full bg-[var(--border)] shrink-0" />
      <div className="flex-1 flex flex-col gap-2 pt-1.5">
        <div className="h-5 bg-[var(--border)] rounded w-1/3" />
        <div className="h-3.5 bg-[var(--border)] rounded w-1/2" />
        <div className="flex gap-4 mt-1">
          <div className="h-3 bg-[var(--border)] rounded w-16" />
          <div className="h-3 bg-[var(--border)] rounded w-16" />
        </div>
      </div>
    </div>
  );
}

// Insights: stat tiles + a chart-sized block.
export function InsightsSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="border border-[var(--border)] rounded-xl p-4 flex flex-col items-center gap-2">
            <div className="h-7 w-10 bg-[var(--border)] rounded" />
            <div className="h-3 w-16 bg-[var(--border)] rounded" />
          </div>
        ))}
      </div>
      <div className="border border-[var(--border)] rounded-xl p-4 mb-6 h-16" />
      <div className="border border-[var(--border)] rounded-xl p-4 mb-6">
        <div className="h-4 w-40 bg-[var(--border)] rounded mb-4" />
        <div className="h-48 bg-[var(--border)] rounded" />
      </div>
    </div>
  );
}
