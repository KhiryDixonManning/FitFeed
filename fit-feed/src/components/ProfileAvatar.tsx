
import React from "react";

interface ProfileAvatarProps {
	size?: number | string; // e.g., 40, "3rem", etc.
	className?: string;
}

const ProfileAvatar: React.FC<ProfileAvatarProps> = ({ size = 48, className = "" }) => {
	const dimension = typeof size === "number" ? `${size}px` : size;
	return (
		<div
			className={`rounded-full bg-linear-to-br from-blue-400 via-purple-400 to-pink-400 flex items-center justify-center shadow ${className}`}
			style={{ width: dimension, height: dimension }}
			aria-label="Profile avatar placeholder"
		>
		</div>
	);
};

export default ProfileAvatar;
