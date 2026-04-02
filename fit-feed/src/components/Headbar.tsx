
import { Link } from 'react-router-dom';
import ProfileAvatar from './ProfileAvatar';

  export default function Headbar() {
  return (
    <header className="flex items-center justify-between px-4 py-4 bg-white border border- rounded-md mx-4 mt-4 shadow-lg drop-shadow-lg">
      {/* Left: Logo */}
      <div className="flex items-center">
        <div className="w-28 h-28 rounded-xl flex items-center justify-center bg-gradient-to-br from-pink-500 to-blue-500 mr-8">
          <span className="text-white text-3xl font-light">Logo</span>
        </div>
      </div>

      {/* Center: Navigation */}
      <div className="flex-1 flex items-center justify-center gap-12">
        <span className="text-3xl font-bold text-black drop-shadow-[2px_2px_2px_rgba(0,0,0,0.25)]">Fit Feed</span>
        <Link to="/" className="text-2xl font-bold text-black drop-shadow-[2px_2px_2px_rgba(0,0,0,0.25)] hover:text-blue-500">Feed</Link>
        <Link to="/leaderboard" className="text-2xl font-bold text-black drop-shadow-[2px_2px_2px_rgba(0,0,0,0.25)] cursor-pointer hover:text-blue-500">Leader Board</Link>
      </div>

      {/* Right: Profile and Add Button */}
      <div className="flex items-center gap-8">
        {/* Profile image placeholder */}
        <a href="/profile" className="cursor-pointer">
          <ProfileAvatar className="w-20 h-20 rounded-full shadow-md hover:opacity-80 transition-opacity" />
        </a>
        <a href="/upload" className="cursor-pointer">
          <button className="w-28 h-28 rounded-xl flex items-center justify-center bg-gradient-to-br from-pink-500 to-blue-500 text-white text-5xl font-light focus:outline-none hover:opacity-80 transition-opacity">
            +
          </button>
        </a> 
      </div>
    </header>
  );
}
