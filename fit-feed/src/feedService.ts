import { getPosts } from "./FirebaseDB";
import { getUserPreferences, saveUserPreferences } from "./FirebaseDB";

const PYTHON_API = "/api";

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
