import Headbar from "../components/Headbar";
import ProfileAvatar from "../components/ProfileAvatar";

interface LeaderboardEntry {
    rank: number;
    username: string;
    likecount: number;
    imageUrl?: string;
}

const mockData: LeaderboardEntry[] = [
    { rank: 1, username: "username 1", likecount: 2039 },
    { rank: 2, username: "username 2", likecount: 1078 },
    { rank: 3, username: "username 3", likecount: 522 },
];

function PostThumbnail({ imageUrl }: { imageUrl?: string }) {
    return (
        <div className="w-14 h-14 bg-white rounded-2xl flex items-center justify-center border-2 border-gray-300 overflow-hidden shrink-0">
            {imageUrl ? (
                <img src={imageUrl} alt="post thumbnail" className="w-full h-full object-cover" />
            ) : (
                <svg
                    className="w-9 h-9 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                >
                    <rect width="18" height="18" x="3" y="3" rx="3" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5-4 4-2-2-5 5" />
                </svg>
            )}
        </div>
    );
}

export default function Leaderboard() {
    return (
        <div className="min-h-screen bg-white">
            <Headbar />
            <div className="flex flex-col items-center px-4 pt-8 gap-5">
                {/* Weekly Theme header */}
                <div className="bg-linear-to-r from-pink-400 via-rose-300 to-indigo-400 rounded-full px-10 py-3 shadow-md">
                    <span className="text-white font-bold text-2xl tracking-wide">Weekly Theme</span>
                </div>

                {/* Leaderboard entries */}
                <div className="flex flex-col gap-4 w-full max-w-md mt-2">
                    {mockData.map((entry) => (
                        <div
                            key={entry.rank}
                            className="flex items-center gap-4 bg-gray-200 rounded-full px-5 py-3 shadow-sm"
                        >
                            {/* Avatar */}
                            <ProfileAvatar size={56} className="shrink-0" />

                            {/* Username and score */}
                            <div className="flex flex-col flex-1 min-w-0">
                                <span className="font-bold text-gray-900 text-base leading-tight">
                                    @{entry.username}
                                </span>
                                <div className="flex items-center gap-1 mt-0.5">
                                    {/* Trending up arrow */}
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        strokeWidth={2.5}
                                        stroke="currentColor"
                                        className="w-5 h-5 text-gray-800 shrink-0"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"
                                        />
                                    </svg>
                                    <span className="font-semibold text-gray-800 text-base">{entry.likecount}</span>
                                </div>
                            </div>

                            {/* Post thumbnail Replace this with dynamic post image from entry */}
                            <PostThumbnail imageUrl={entry.imageUrl} />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}