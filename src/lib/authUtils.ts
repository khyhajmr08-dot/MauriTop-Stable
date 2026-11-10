import { doc, getDoc, setDoc, serverTimestamp, collection, addDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

export async function updateUserLoginMetadata(userOrId: any): Promise<void> {
  try {
    const uid = typeof userOrId === "string" ? userOrId : userOrId?.uid;
    const currentUser = auth.currentUser;
    if (!uid || !currentUser || currentUser.uid !== uid) return;

    const userRef = doc(db, "users", uid);
    const snapshot = await getDoc(userRef);
    const device = typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
      ? "Mobile"
      : "Desktop";

    if (!snapshot.exists()) {
      await setDoc(userRef, {
        uid,
        name: userOrId?.displayName || currentUser.displayName || "",
        email: currentUser.email || "",
        role: "user",
        blocked: false,
        createdAt: serverTimestamp(),
        reviewStatus: "Active",
        lastLogin: serverTimestamp(),
        lastDevice: device,
      });
      return;
    }

    await setDoc(userRef, {
      lastLogin: serverTimestamp(),
      lastDevice: device,
      sessionActive: true,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    console.warn("Login metadata update skipped:", error);
  }
}

export async function createAdminLog(
  adminId: string,
  _adminName: string,
  targetUserId: string,
  _targetUserName: string,
  action: string,
  details: string,
  reason: string,
  _previousValue?: unknown,
  _newValue?: unknown
): Promise<void> {
  try {
    if (!auth.currentUser || auth.currentUser.uid !== adminId) return;
    const safeText = (value: string) => value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/(?:\+?222[\s-]?)?\b\d[\d\s-]{6,}\d\b/g, "[phone]")
      .slice(0, 700);

    await addDoc(collection(db, "audit_logs"), {
      action: safeText(action),
      performedByUid: adminId,
      targetId: safeText(targetUserId),
      details: safeText([details, reason].filter(Boolean).join(" — ")),
      timestamp: serverTimestamp(),
    });
  } catch (error) {
    console.warn("Admin audit record skipped:", error);
  }
}
