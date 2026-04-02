import { useState } from 'react';
import { login, signUp } from '../Authentication';

export default function Login() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError]       = useState('');

  const handleSubmit = async () => {
    setError('');
    const result = isSignUp
      ? await signUp(email, password)
      : await login(email, password);
    if (!result) setError('Authentication failed. Check your credentials.');
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4">
      <h1 className="text-3xl font-bold text-[var(--text-h)]">FitFeed</h1>
      <div className="flex flex-col gap-3 w-80">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="border border-[var(--border)] rounded px-3 py-2 bg-[var(--bg)] text-[var(--text-h)]"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="border border-[var(--border)] rounded px-3 py-2 bg-[var(--bg)] text-[var(--text-h)]"
        />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <button
          onClick={handleSubmit}
          className="bg-[var(--accent)] text-white rounded px-4 py-2 font-medium hover:opacity-90 transition"
        >
          {isSignUp ? 'Sign Up' : 'Log In'}
        </button>
        <button
          onClick={() => setIsSignUp(s => !s)}
          className="text-sm text-[var(--text)] hover:text-[var(--text-h)]"
        >
          {isSignUp ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
