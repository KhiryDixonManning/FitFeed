import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth } from '../../firebase';
import { db } from '../../firebase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      if (isSignUp) {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        // Save user profile to Firestore so other pages can look up email by uid
        await setDoc(doc(db, 'users', credential.user.uid), {
          uid: credential.user.uid,
          email: credential.user.email,
          displayName: '',
          createdAt: new Date().toISOString(),
        });
      } else {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        // Upsert user doc — creates it for old accounts, leaves existing data intact
        await setDoc(doc(db, 'users', credential.user.uid), {
          uid: credential.user.uid,
          email: credential.user.email,
        }, { merge: true });
      }
      // No redirect needed — onAuthStateChanged in App.tsx handles it
    } catch (err: any) {
      setError(err.code || 'Authentication failed');
    } finally {
      setLoading(false);
    }
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
          disabled={loading}
          className="bg-[var(--accent)] text-white rounded px-4 py-2 font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? 'Signing in...' : isSignUp ? 'Sign Up' : 'Log In'}
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
