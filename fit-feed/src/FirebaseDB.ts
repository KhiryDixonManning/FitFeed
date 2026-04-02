import { collection, addDoc, DocumentReference, getDocs, query, orderBy, doc, getDoc, setDoc } from "firebase/firestore";
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
    category?: string;
    likesCount: number;
    commentsCount?: number;
    createdAt: Date;
    updatedAt?: Date;
    category?: Category;
    outfitBreakdown?: string;
    likesCount?: number;
    commentsCount?: number;
}

export const addPost = async (post: Omit<Post, "createdAt">): Promise<DocumentReference<Post> | null> => {
    try {
        const docRef = await addDoc(collection(db, "posts"), {
            ...post,
            createdAt: new Date(),
        });
        console.log("Post created with ID:", docRef.id);
        return docRef as DocumentReference<Post>;
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unknown error:", error);
        }
        return null;
    }
}

export const getPosts = async (): Promise<Post[]> => {
    try {
        const postsRef = collection(db, "posts");
        const q = query(postsRef, orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        const posts: Post[] = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt.toDate(),
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
