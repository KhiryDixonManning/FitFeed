import { auth } from "../firebase";
import { createUserWithEmailAndPassword, UserCredential } from "firebase/auth";
import { FirebaseError } from "firebase/app";

export const signUp = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        console.log("User created:", userCredential.user);
        return userCredential;
    } catch (error) {
        if (error instanceof FirebaseError) {
            console.log(error.code);
            console.log(error.message);
        } else {
            console.log("Unkown Error:", error);
        }
        return null;
    }
}