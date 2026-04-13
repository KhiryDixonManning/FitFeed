import { auth } from "../firebase";
import { db } from "../firebase";
import { createUserWithEmailAndPassword, type UserCredential, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { FirebaseError } from "firebase/app";

export const signUp = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        console.log("User created:", userCredential.user);
        await setDoc(doc(db, 'users', userCredential.user.uid), {
            uid: userCredential.user.uid,
            email: userCredential.user.email,
            displayName: '',
            createdAt: new Date().toISOString(),
        });
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
        console.log("Welcome:", userCredential.user);
        // Upsert user doc — creates it for old accounts, leaves existing data intact
        await setDoc(doc(db, 'users', userCredential.user.uid), {
            uid: userCredential.user.uid,
            email: userCredential.user.email,
        }, { merge: true });
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
