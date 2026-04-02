import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyDaOa3Nj7bXGsDD5LKbjc-8loM1cTVB2yo",
    authDomain: "fitfeed-67ee8.firebaseapp.com",
    projectId: "fitfeed-67ee8",
    storageBucket: "fitfeed-67ee8.firebasestorage.app",
    messagingSenderId: "388462759865",
    appId: "1:388462759865:web:0b860b66cba67cbf1e7068",
    measurementId: "G-H70X69NC0J",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
