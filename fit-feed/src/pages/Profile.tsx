import Headbar from "../components/Headbar";
import Post from "../components/Post";
import ProfileAvatar from "../components/ProfileAvatar";

interface PostData {
  id: string;
  imageUrl: string;
  caption: string;
  likeCount: number;
  commentCount: number;
}

export default function Profile() {
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
              <p className="text-gray-500">15 posts</p>
            </div>
          </div>

          {/* Bio Section */}
          <div className="flex-1 bg-white rounded-lg shadow-md p-6">
            <p className="text-gray-700 whitespace-pre-wrap">Bio goes here</p>
          </div>
        </div>
      </div>
    </div>
  );
}