
import { Routes, Route } from 'react-router-dom';
import Feed from './pages/Feed';
import Upload from './pages/Upload';
import Profile from './pages/Profile';
import Leaderboard from './pages/Leaderboard';
import UserProfile from './pages/UserProfile';

export default function App() {
  return (
    <div>
      <Routes>
        <Route path="/" element={<Feed />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/user-profile" element={<UserProfile />} />
      </Routes>
    </div>
  );
}