// ================================================================
//  🔥 FIREBASE CONFIG — i-did-my-chores
// ================================================================
import { initializeApp }          from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getAuth, GoogleAuthProvider }
                                  from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';
import { getFirestore }           from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyDN0k7B09CatV2cDziBoNpXC5VHTj8TkpI",
  authDomain:        "i-did-my-chores.firebaseapp.com",
  projectId:         "i-did-my-chores",
  storageBucket:     "i-did-my-chores.firebasestorage.app",
  messagingSenderId: "202804748521",
  appId:             "1:202804748521:web:e05ecb9de2a1811eed1078"
};

export const app       = initializeApp(firebaseConfig);
export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

