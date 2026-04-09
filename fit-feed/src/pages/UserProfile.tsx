import { useState } from "react";
import Headbar from "../components/Headbar";
import Post from "../components/Post";
import ProfileAvatar from "../components/ProfileAvatar";
import { Link } from "react-router";

interface PostData {
  id: string;
  imageUrl: string;
  caption: string;
  likeCount: number;
  commentCount: number;
}

export default function UserProfile() {
  const [bio, setBio] = useState("");
  const [bioPreview, setBioPreview] = useState("");

  // Sample posts data - replace with real data from Firebase
  const samplePosts: PostData[] = [
    {
      id: "1",
      imageUrl: "",
      caption: "This is a sample caption",
      likeCount: 234,
      commentCount: 16,
    },
    {
      id: "2",
      imageUrl: "",
      caption: "Another sample post",
      likeCount: 189,
      commentCount: 42,
    },
    {
      id: "3",
      imageUrl: "",
      caption: "Third sample post",
      likeCount: 312,
      commentCount: 28,
    },
  ];

  const handleBioSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setBioPreview(bio);
    // Firebase update will go here
  };

  const handleLogout = () => {
    // Firebase logout will go here
    console.log("Logout clicked");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Headbar />
      
      <div className="flex flex-col lg:flex-row gap-8 p-6 max-w-7xl mx-auto">
        {/* Left Column - Posts */}
        <div className="flex-1 overflow-y-auto max-h-[calc(100vh-120px)] space-y-6">
          {samplePosts.map((post) => (
            <Post
              key={post.id}
              imageUrl={post.imageUrl}
              username="username"
              caption={post.caption}
              likeCount={post.likeCount}
              commentCount={post.commentCount}
              avatarSize={40}
            />
          ))}
        </div>

        {/* Right Column - Profile Info */}
        <div className="w-full lg:w-96 flex flex-col">
          {/* Profile Header */}
          <div className="relative mb-8">
            <div className="flex justify-center mb-4">
              <ProfileAvatar size={120} />
            </div>
            <div className="text-center">
              {/* Dynamic Username from fire base here*/}
              <h1 className="text-2xl font-bold text-gray-900">@username</h1>
            </div>
          </div>

          {/* Bio Section */}
          <div className="flex-1 bg-white rounded-lg shadow-md p-6 mb-6">
            {bioPreview ? (
              <div className="mb-4">
                <p className="text-gray-700 whitespace-pre-wrap">{bioPreview}</p>
              </div>
            ) : (
              <p className="text-gray-400 italic mb-4">No bio yet. Add one below!</p>
            )}

            {/* Bio Form */}
            <form onSubmit={handleBioSubmit} className="space-y-3">
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Write your bio..."
                className="w-full p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-400 resize-none"
                rows={5}
              />
              <button
                type="submit"
                className="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2 rounded-lg transition"
              >
                Save Bio
              </button>
            </form>
          </div>

          {/* Logout Button */}
          <div className="flex justify-end">
            <Link to="/login">
              <button
                onClick={handleLogout}
                className="p-3 rounded-lg border-2 border-red-500 hover:bg-red-50 transition"
                aria-label="Logout"
                title="Logout"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                  className="w-6 h-6 text-red-500"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3h12.75"
                  />
                </svg>
              </button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}