import { getPosts, getUserPreferences, saveUserPreferences, type Post } from "./FirebaseDB";
import { apiFetch } from "./api";

// Ranked and following feeds now come from the server-trusted POST /feed
// endpoint (see feedApi.ts). The client-side getRankedFeed/getFollowingFeed
// helpers that used to fetch every post and rank them were removed once the
// feed migrated; only trending (used by the leaderboard) remains here.

export const getTrendingFeed = async (): Promise<Post[]> => {
    const posts = await getPosts();

    try {
        const trending = await apiFetch<Post[]>("/trending", { body: { posts } });
        return Array.isArray(trending) ? trending : posts;
    } catch (error) {
        console.warn("Trending API unavailable, falling back to unsorted posts:", error);
        return posts;
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
