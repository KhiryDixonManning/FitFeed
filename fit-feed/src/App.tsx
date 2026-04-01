
import { Routes, Route } from 'react-router-dom';
import Headbar from './components/Headbar';
import Feed from './pages/Feed';
import Upload from './pages/Upload';
import Profile from './pages/Profile';

export default function App() {
  return (
    <div>
      <Routes>
        <Route path="/" element={<Feed />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/profile" element={<Profile />} />
      </Routes>
    </div>
  );
}
