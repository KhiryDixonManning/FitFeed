import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import Feed from './pages/Feed';
import Upload from './pages/Upload';
import Profile from './pages/Profile';
import PublicProfile from './pages/PublicProfile';
import Leaderboard from './pages/Leaderboard';
import PostDetail from './pages/PostDetail';
import Insights from './pages/Insights';
import About from './pages/About';
import Explore from './pages/Explore';
import Login from './pages/Login';
import Navbar from './components/Navbar';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        setDoc(doc(db, 'users', firebaseUser.uid), {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || '',
          createdAt: new Date().toISOString(),
        }, { merge: true }).catch(console.error);
      }
    });
    return unsubscribe;
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3">
        <span className="text-2xl font-bold tracking-tight text-[var(--text-h)] animate-pulse">FitFeed</span>
        <span className="text-xs uppercase tracking-widest text-[var(--text)] opacity-60">Loading</span>
      </div>
    );
  }

  return (
    <div>
      {user && <Navbar />}
      <Routes>
        <Route path="/login" element={!user ? <Login /> : <Navigate to="/" replace />} />
        <Route path="/" element={user ? <Feed uid={user.uid} /> : <Navigate to="/login" replace />} />
        <Route path="/upload" element={user ? <Upload uid={user.uid} /> : <Navigate to="/login" replace />} />
        <Route path="/profile" element={user ? <Profile uid={user.uid} /> : <Navigate to="/login" replace />} />
        <Route path="/profile/:uid" element={user ? <PublicProfile /> : <Navigate to="/login" replace />} />
        <Route path="/leaderboard" element={user ? <Leaderboard /> : <Navigate to="/login" replace />} />
        <Route path="/post/:postId" element={user ? <PostDetail /> : <Navigate to="/login" replace />} />
        <Route path="/insights" element={user ? <Insights uid={user.uid} /> : <Navigate to="/login" replace />} />
        <Route path="/about" element={<About />} />
        <Route path="/explore" element={user ? <Explore /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to={user ? "/" : "/login"} replace />} />
      </Routes>
    </div>
  );
}
