import {
  collection, addDoc, DocumentReference, getDocs, query, orderBy, where,
  doc, getDoc, setDoc, updateDoc, increment, arrayUnion, arrayRemove, deleteDoc,
} from "firebase/firestore";
import { getStorage, ref, deleteObject } from "firebase/storage";
import { db } from "../firebase";
import { FirebaseError } from "firebase/app";
import { type Category } from "./constants/categories";

export interface User {
    uid: string;
    email: string;
    displayName?: string;
    username?: string;
    photoURL?: string;
    createdAt?: string;
}

export interface Post {
    id: string;
    authorId: string;
    content?: string;
    imageUrl?: string;
    category?: Category;
    likesCount: number;
    commentsCount?: number;
    createdAt: string;
    updatedAt?: string;
    outfitBreakdown?: string;
    likedBy?: string[];
    palette?: (string | { hex: string; name: string; percentage: number })[];
    aesthetic?: string;
    aestheticTags?: string[];
    detectedItems?: string[];
    styleDescription?: string;
    styleNotes?: string;
    aestheticScores?: Record<string, number>;
    analyzed?: boolean;
    outfitName?: string;
}

export interface Comment {
    id: string;
    postId: string;
    authorId: string;
    authorEmail: string;
    content: string;
    createdAt: string;
}

export const addPost = async (post: Omit<Post, "id" | "createdAt">): Promise<{ ref: DocumentReference; id: string } | null> => {
    try {
        const docRef = await addDoc(collection(db, "posts"), {
            ...post,
            createdAt: new Date(),
        });
        console.log("Post created with ID:", docRef.id);
        return { ref: docRef, id: docRef.id };
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unknown error:", error);
        }
        return null;
    }
};

export const getPosts = async (): Promise<Post[]> => {
    try {
        const postsRef = collection(db, "posts");
        const q = query(postsRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        const posts: Post[] = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate().toISOString() ?? new Date().toISOString(),
        } as Post));
        return posts;
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unknown error:", error);
        }
        return [];
    }
};

export const toggleLike = async (postId: string, uid: string): Promise<boolean> => {
    try {
        const postRef = doc(db, "posts", postId);
        const postSnap = await getDoc(postRef);

        if (!postSnap.exists()) return false;

        const likedBy: string[] = postSnap.data().likedBy || [];
        const alreadyLiked = likedBy.includes(uid);

        if (alreadyLiked) {
            await updateDoc(postRef, {
                likesCount: increment(-1),
                likedBy: arrayRemove(uid),
            });
            return false; // unliked
        } else {
            await updateDoc(postRef, {
                likesCount: increment(1),
                likedBy: arrayUnion(uid),
            });
            return true; // liked
        }
    } catch (error) {
        console.log("Error toggling like:", error);
        return false;
    }
};

export const getUserPreferences = async (uid: string): Promise<Record<string, number>> => {
    try {
        const docRef = doc(db, "userPreferences", uid);
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? (docSnap.data() as Record<string, number>) : {};
    } catch (error) {
        console.log("Error fetching preferences:", error);
        return {};
    }
};

export const saveUserPreferences = async (uid: string, preferences: Record<string, number>): Promise<void> => {
    try {
        const docRef = doc(db, "userPreferences", uid);
        await setDoc(docRef, preferences);
    } catch (error) {
        console.log("Error saving preferences:", error);
    }
};

/**
 * NOTE: getComments uses a composite index on (postId ASC, createdAt ASC).
 * If this query fails with a "requires an index" error, click the link in the
 * browser console — it opens the Firebase Console to create the index automatically.
 */
export const getComments = async (postId: string): Promise<Comment[]> => {
    try {
        const q = query(
            collection(db, "comments"),
            where("postId", "==", postId),
            orderBy("createdAt", "asc")
        );
        const snapshot = await getDocs(q);
        const comments = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Comment));
        console.log(`[getComments] Fetched ${comments.length} comments for post ${postId}`);
        return comments;
    } catch (error: any) {
        console.error("[getComments] Error:", error);
        if (error.code === "failed-precondition") {
            console.error("[getComments] Missing Firestore index. Click this link:", error.message);
        }
        return [];
    }
};

export const addComment = async (
    postId: string,
    authorId: string,
    authorEmail: string,
    content: string
): Promise<boolean> => {
    try {
        await addDoc(collection(db, "comments"), {
            postId,
            authorId,
            authorEmail,
            content,
            createdAt: new Date().toISOString(),
        });

        // Increment commentsCount on the post
        await updateDoc(doc(db, "posts", postId), {
            commentsCount: increment(1),
        });

        return true;
    } catch (error) {
        console.log("Error adding comment:", error);
        return false;
    }
};

export const deletePost = async (postId: string, uid: string): Promise<boolean> => {
    try {
        const postRef = doc(db, "posts", postId);
        const postSnap = await getDoc(postRef);

        if (!postSnap.exists()) return false;

        const postData = postSnap.data();

        // Only allow the author to delete
        if (postData.authorId !== uid) {
            console.error("Unauthorized: only the author can delete this post");
            return false;
        }

        // Delete image from Firebase Storage if it exists
        if (postData.imageUrl) {
            try {
                const storage = getStorage();
                const imageRef = ref(storage, postData.imageUrl);
                await deleteObject(imageRef);
            } catch (storageError) {
                // Storage delete can fail if file was already deleted or URL format changed
                // Continue with Firestore delete regardless
                console.warn("Storage delete failed, continuing:", storageError);
            }
        }

        // Delete the Firestore document
        await deleteDoc(postRef);

        // Delete associated comments
        const commentsQuery = query(
            collection(db, "comments"),
            where("postId", "==", postId)
        );
        const commentsSnapshot = await getDocs(commentsQuery);
        await Promise.all(
            commentsSnapshot.docs.map(commentDoc => deleteDoc(commentDoc.ref))
        );

        console.log(`[deletePost] Post ${postId} deleted successfully`);
        return true;
    } catch (error) {
        console.error("[deletePost] Error:", error);
        return false;
    }
};

export const followUser = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        await setDoc(doc(db, 'follows', followId), {
            followerId,
            followingId,
            createdAt: new Date().toISOString(),
        });
        return true;
    } catch (error) {
        console.error('[followUser] Error:', error);
        return false;
    }
};

export const unfollowUser = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        await deleteDoc(doc(db, 'follows', followId));
        return true;
    } catch (error) {
        console.error('[unfollowUser] Error:', error);
        return false;
    }
};

export const isFollowing = async (followerId: string, followingId: string): Promise<boolean> => {
    try {
        const followId = `${followerId}_${followingId}`;
        const followSnap = await getDoc(doc(db, 'follows', followId));
        return followSnap.exists();
    } catch {
        return false;
    }
};

export const getFollowerCount = async (uid: string): Promise<number> => {
    try {
        const q = query(collection(db, 'follows'), where('followingId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch {
        return 0;
    }
};

export const getFollowingCount = async (uid: string): Promise<number> => {
    try {
        const q = query(collection(db, 'follows'), where('followerId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch {
        return 0;
    }
};

export const getFollowingIds = async (uid: string): Promise<string[]> => {
    try {
        const q = query(collection(db, 'follows'), where('followerId', '==', uid));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => d.data().followingId);
    } catch {
        return [];
    }
};
