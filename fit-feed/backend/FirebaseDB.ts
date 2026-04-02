import { collection, addDoc, DocumentReference, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { FirebaseError } from "firebase/app";

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
    createdAt: Date;
    updatedAt?: Date;
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
            console.log("Unkown error:", error);
        }
        return [];
    }
};