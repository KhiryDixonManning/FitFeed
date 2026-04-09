
import Headbar from "../components/Headbar";
import Post from "../components/Post";

interface PostData {
  id: string;
  imageUrl: string;
  username: string;
  caption: string;
  likeCount: number;
  commentCount: number;
}

export default function Feed() {
  // Sample posts data - replace with real data from Firebase
  const samplePosts: PostData[] = [
    {
      id: "1",
      imageUrl: "",
      username: "user1",
      caption: "This is a sample caption",
      likeCount: 234,
      commentCount: 16,
    },
    {
      id: "2",
      imageUrl: "",
      username: "user2",
      caption: "Another sample post",
      likeCount: 189,
      commentCount: 42,
    },
    {
      id: "3",
      imageUrl: "",
      username: "user3",
      caption: "Third sample post",
      likeCount: 312,
      commentCount: 28,
    },
    {
      id: "4",
      imageUrl: "",
      username: "user4",
      caption: "Fourth sample post",
      likeCount: 156,
      commentCount: 19,
    },
    {
      id: "5",
      imageUrl: "",
      username: "user5",
      caption: "Fifth sample post",
      likeCount: 423,
      commentCount: 67,
    },
    {
      id: "6",
      imageUrl: "",
      username: "user6",
      caption: "Sixth sample post",
      likeCount: 278,
      commentCount: 34,
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Headbar />
      <div className="p-6">
        <div className="grid grid-cols-2 gap-6 auto-rows-max">
          {samplePosts.map((post) => (
            <Post
              key={post.id}
              imageUrl={post.imageUrl}
              username={post.username}
              caption={post.caption}
              likeCount={post.likeCount}
              commentCount={post.commentCount}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
