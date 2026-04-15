import {
  collection, addDoc, DocumentReference, getDocs, query, orderBy, where,
  doc, getDoc, setDoc, updateDoc, increment, arrayUnion, arrayRemove,
} from "firebase/firestore";
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
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Comment));
    } catch (error) {
        console.log("Error fetching comments:", error);
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
