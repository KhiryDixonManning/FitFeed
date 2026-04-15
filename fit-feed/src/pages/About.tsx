import { useNavigate } from 'react-router-dom';

export default function About() {
  const navigate = useNavigate();

  return (
    <div className="max-w-2xl mx-auto p-6 pb-24 animate-fade-in">
      <h1 className="text-3xl font-bold text-[var(--text-h)] mb-2">About FitFeed</h1>
      <p className="text-sm text-[var(--text)] mb-8">The third space for fashion</p>

      <div className="border border-[var(--border)] rounded-xl p-6 mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-h)] mb-3">What is FitFeed?</h2>
        <p className="text-sm text-[var(--text)] leading-relaxed">
          FitFeed is a community for real people who care about what they wear.
          Not influencers. Not brands. Just people sharing how they put together
          outfits from what they already own. Think of it as your fashion third space —
          a place to share, discover, and understand your personal style.
        </p>
      </div>

      <div className="border border-[var(--border)] rounded-xl p-6 mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-h)] mb-3">Who writes the style analysis?</h2>
        <p className="text-sm text-[var(--text)] leading-relaxed mb-3">
          Every post is automatically analyzed by our AI system powered by
          Anthropic Claude. It analyzes your outfit photo and returns:
        </p>
        <ul className="text-sm text-[var(--text)] space-y-2">
          {[
            'Dominant colors with creative fashion-forward names and percentages',
            'Aesthetic category and style tags',
            'Detected clothing items',
            'A creative outfit name based on the vibe',
            'Style notes written like a fashion editor',
            'Aesthetic composition scores',
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-[var(--accent)]">◎</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border border-[var(--border)] rounded-xl p-6 mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-h)] mb-3">Why should I upload?</h2>
        <div className="flex flex-col gap-3">
          {[
            { icon: '🧠', title: 'Understand your style', desc: 'Get AI analysis of your aesthetic, colors, and detected clothing pieces — free.' },
            { icon: '📊', title: 'Track your taste', desc: 'Your Style Profile builds over time based on what you interact with.' },
            { icon: '🌍', title: 'Join the community', desc: 'Discover people with similar aesthetics. Get Aura points for standout fits.' },
            { icon: '📈', title: 'See what works', desc: 'Creator Insights shows which of your styles perform best with the community.' },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="flex gap-3">
              <span className="text-2xl shrink-0">{icon}</span>
              <div>
                <p className="text-sm font-medium text-[var(--text-h)]">{title}</p>
                <p className="text-xs text-[var(--text)]">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border border-[var(--border)] rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold text-[var(--text-h)] mb-3">What is the Aura score?</h2>
        <p className="text-sm text-[var(--text)] leading-relaxed">
          The Aura score (◎) on every post is the total community engagement —
          likes plus comments. Posts with high Aura scores appear on the
          Aura Farmers leaderboard.
        </p>
      </div>

      <button
        onClick={() => navigate('/')}
        className="w-full bg-[var(--accent)] text-white rounded-xl py-3 font-medium hover:opacity-90 transition"
      >
        Start Exploring
      </button>
    </div>
  );
}
