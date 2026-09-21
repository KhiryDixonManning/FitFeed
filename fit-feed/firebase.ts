import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// This is the Firebase *Web* config. It is a public client identifier, not a
// credential: it ships inside every browser bundle by design and grants no
// access on its own. Authorization comes from firestore.rules / storage.rules
// and from verified ID tokens on the API. Restricting it further is done in
// the Google Cloud console (HTTP referrer restrictions), not by hiding it.
// The hygiene scanner allowlists this one occurrence by path; an AIza... key
// anywhere else is still treated as a leak. See docs/security.md.
const firebaseConfig = {
  apiKey: "AIzaSyDaOa3Nj7bXGsDD5LKbjc-8loM1cTVB2yo",
  authDomain: "fitfeed-67ee8.firebaseapp.com",
  projectId: "fitfeed-67ee8",
  storageBucket: "fitfeed-67ee8.firebasestorage.app",
  messagingSenderId: "388462759865",
  appId: "1:388462759865:web:0b860b66cba67cbf1e7068",
  measurementId: "G-H70X69NC0J"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
