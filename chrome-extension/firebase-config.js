/**
 * Firebase Configuration for Chrome Extension
 * Uses the same Firebase project as the main app
 */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDLBNFcVKoT-rcE2T4tf8Rz1hJYDajViIU",
  authDomain: "vivek-crypto-trader-b8d19.firebaseapp.com",
  projectId: "vivek-crypto-trader-b8d19",
  storageBucket: "vivek-crypto-trader-b8d19.firebasestorage.app",
  messagingSenderId: "239457253705",
  appId: "1:239457253705:web:230111e02de57ee5e28298"
};

// Firestore REST API base
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.FIREBASE_CONFIG = FIREBASE_CONFIG;
  window.FIRESTORE_BASE = FIRESTORE_BASE;
}
