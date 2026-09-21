import { auth } from "../firebase";
import { createUserWithEmailAndPassword, type UserCredential, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { upsertOwnProfile } from "./profileService";

export const signUp = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        // Writes the private account doc and the public profile together.
        await upsertOwnProfile(userCredential.user);
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
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        // Upserts both docs — backfills a public profile for older accounts.
        await upsertOwnProfile(userCredential.user);
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
