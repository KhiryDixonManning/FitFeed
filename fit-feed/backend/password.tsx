import { auth } from "../firebase";
import { createUserWithEmailAndPassword } from "firebase/auth";

export const signUp = async (email: string, password: string): Promise<UserCredential | null> => {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("User created:", user);
    } catch {
        console.error("Error code:", error.code);
        console.error("Error message:", error.message);
        return null;
    }
}