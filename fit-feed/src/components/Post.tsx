import React from "react";
import { useNavigate } from "react-router-dom";
import ProfileAvatar from "./ProfileAvatar";

interface PostProps {
	imageUrl: string;
	username: string;
	caption: string;
	likeCount: number;
	commentCount: number;
	// Optionally allow passing avatar props
	avatarSize?: number | string;
}

const Post: React.FC<PostProps> = ({
	imageUrl,
	username,
	caption,
	likeCount,
	commentCount,
	avatarSize = 40,
}) => {
	const navigate = useNavigate();

	const handleAvatarClick = () => {
		navigate("/profile");
	};
	return (
		<div className="rounded-2xl shadow-lg bg-white max-w-xs w-full overflow-hidden flex flex-col">
			{/* Image section */}
			<div className="bg-gray-200 flex items-center justify-center" style={{ minHeight: 180 }}>
				{imageUrl ? (
					<img
						src={imageUrl}
						alt="Post"
						className="object-cover w-full h-44"
						style={{ maxHeight: 180 }}
					/>
				) : (
					<svg className="w-20 h-20 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
						<rect width="20" height="20" x="2" y="2" rx="5"/>
						<circle cx="8.5" cy="8.5" r="2.5"/>
						<path d="M21 21l-6-6-4 4-5-5"/>
					</svg>
				)}
			</div>
			{/* Info section */}
			<div className="flex flex-row items-center gap-2 px-3 py-2 bg-white -mt-6 relative z-10 rounded-b-2xl shadow-md">
				<button
					onClick={handleAvatarClick}
					className="cursor-pointer hover:opacity-80 transition"
				>
					<ProfileAvatar size={avatarSize} className="border-2 border-white -mt-6" />
				</button>
				<div className="flex flex-col flex-1">
					<span className="font-semibold text-gray-900 leading-tight">{caption}</span>
					<span className="text-gray-500 text-sm">@{username}</span>
				</div>
			</div>
			{/* Actions section */}
			<div className="flex flex-row items-center justify-between px-3 py-2 bg-white">
				<div className="flex items-center gap-3">
					<div className="flex items-center gap-1">
                        <button className="hover:text-pink-500">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
                            </svg>
						</button>
						<span className="text-gray-700 text-sm">{likeCount}</span>
					</div>
					<div className="flex items-center gap-1">
                        <button className="hover:text-pink-500">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
                            </svg>
                        </button>
						<span className="text-gray-700 text-sm">{commentCount}</span>
					</div>
				</div>
				<div className="flex items-center gap-3">
					<button className="hover:text-pink-500">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
                        </svg>
					</button>
				</div>
			</div>
		</div>
	);
};

export default Post;

