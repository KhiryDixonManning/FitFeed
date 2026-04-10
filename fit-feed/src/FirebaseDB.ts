import {
  collection, addDoc, DocumentReference, getDocs, query, orderBy,
  doc, getDoc, setDoc, updateDoc, increment, arrayUnion, arrayRemove,
} from "firebase/firestore";
import { db } from "../firebase";
import { FirebaseError } from "firebase/app";
import { type Category } from "./constants/categories";

export interface User {
    uid: string;
    email: string;
    displayName?: string;
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
}

export const addPost = async (post: Omit<Post, "id" | "createdAt">): Promise<DocumentReference | null> => {
    try {
        const docRef = await addDoc(collection(db, "posts"), {
            ...post,
            createdAt: new Date(),
        });
        console.log("Post created with ID:", docRef.id);
        return docRef;
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
