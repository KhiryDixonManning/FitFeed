import { Link } from 'react-router-dom';
import './Headbar.css';

export default function Headbar() {
  return (
    <header className="headbar">
      <div className="headbar__logo">
        <Link to="/">FitFeed</Link>
        <h1>TESTING</h1>
      </div>
      <nav className="headbar__nav">
        <Link to="/">Feed</Link>
        <Link to="/upload">Upload</Link>
        <Link to="/profile">Profile</Link>
      </nav>
    </header>
  );
}
