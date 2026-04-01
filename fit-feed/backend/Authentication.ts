import { auth } from "../firebase.js";
import { createUserWithEmailAndPassword, type UserCredential, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { FirebaseError } from "firebase/app";

export const signUp = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        console.log("User created:", userCredential.user);
        return userCredential;
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unkown Error:", error);
        }
        return null;
    }
}

export const login = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const user = await signInWithEmailAndPassword(auth, email, password);
        console.log("Welcome:", user.user);
        return user;
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unkown Error:", error);
        }
        return null;
    }
}

export const logout = async (): Promise<void> => {
    try {
        await signOut(auth);
        console.log("User logged off");
    } catch (error: unknown) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unkown Error:", error);
        }
    }
}

//Should implement a useAuth hook latter
