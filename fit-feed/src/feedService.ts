import { getPosts, getUserPreferences, saveUserPreferences, getFollowingIds } from "./FirebaseDB";
import { PYTHON_API } from './config';

export const getRankedFeed = async (uid: string): Promise<any[]> => {
    const [posts, userPreferences] = await Promise.all([
        getPosts(),
        getUserPreferences(uid),
    ]);

    try {
        const response = await fetch(`${PYTHON_API}/rank`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ posts, userPreferences }),
        });

        if (!response.ok) throw new Error("API error");
        return await response.json();
    } catch (error) {
        console.warn("Python API unavailable, falling back to unranked feed:", error);
        return posts;
    }
};

export const getTrendingFeed = async (): Promise<any[]> => {
    const posts = await getPosts();

    try {
        const response = await fetch(`${PYTHON_API}/trending`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ posts }),
        });

        if (!response.ok) throw new Error("API error");
        return await response.json();
    } catch (error) {
        console.warn("Python API unavailable:", error);
        return posts;
    }
};

export const getFollowingFeed = async (uid: string): Promise<any[]> => {
    try {
        const followingIds = await getFollowingIds(uid);
        if (followingIds.length === 0) return [];
        const allPosts = await getPosts();
        return allPosts.filter(post => followingIds.includes(post.authorId));
    } catch {
        return [];
    }
};

export const recordInteraction = async (
    uid: string,
    category: string,
    interactionType: "like" | "comment"
): Promise<void> => {
    const current = await getUserPreferences(uid);
    if (!current[category]) current[category] = 0;
    current[category] += interactionType === "like" ? 1 : 2;
    await saveUserPreferences(uid, current);
};
