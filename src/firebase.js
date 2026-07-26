/**
 * Firebase Configuration & Initialization
 * Services: Auth (Google + Email/Password) + Firestore (data storage)
 */
import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: "AIzaSyDLBNFcVKoT-rcE2T4tf8Rz1hJYDajViIU",
  authDomain: "vivek-crypto-trader-b8d19.firebaseapp.com",
  projectId: "vivek-crypto-trader-b8d19",
  storageBucket: "vivek-crypto-trader-b8d19.firebasestorage.app",
  messagingSenderId: "239457253705",
  appId: "1:239457253705:web:230111e02de57ee5e28298",
  measurementId: "G-GJHMRCSV58"
}

// Initialize Firebase
const app = initializeApp(firebaseConfig)

// Auth
export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

// Firestore
export const db = getFirestore(app)

export default app
