import { getApp } from "firebase/app";
import { getMessaging, getToken, onMessage, isSupported, type MessagePayload } from "firebase/messaging";
import { arrayUnion, doc, updateDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

export const DEFAULT_VAPID_KEY = (import.meta.env.VITE_FIREBASE_VAPID_KEY || "").trim();

/** Register this device only for the currently authenticated account. */
export async function setupFCM(userId: string): Promise<string | null> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser || !userId || currentUser.uid !== userId) return null;
    if (!DEFAULT_VAPID_KEY || typeof Notification === "undefined") return null;
    if (Notification.permission === "denied" || !(await isSupported())) return null;

    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") return null;

    const messaging = getMessaging(getApp());
    const token = await getToken(messaging, { vapidKey: DEFAULT_VAPID_KEY });
    if (!token) return null;

    await updateDoc(doc(db, "users", currentUser.uid), {
      fcmToken: token,
      fcmTokens: arrayUnion(token),
      notificationsEnabled: true,
      updatedAt: new Date(),
    });
    return token;
  } catch (error) {
    console.warn("Push notification setup is unavailable:", error);
    return null;
  }
}

export async function listenForForegroundMessages(
  onMsg: (payload: MessagePayload) => void
): Promise<(() => void) | null> {
  try {
    if (!(await isSupported())) return null;
    return onMessage(getMessaging(getApp()), onMsg);
  } catch (error) {
    console.warn("Foreground notification listener is unavailable:", error);
    return null;
  }
}
