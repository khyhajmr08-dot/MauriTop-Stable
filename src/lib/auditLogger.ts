import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";

export interface AuditEventInput {
  action: string;
  performedBy?: string;
  performedByUid?: string;
  role?: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  [key: string]: unknown;
}

function redactPersonalData(value: unknown): string {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?222[\s-]?)?\b\d[\d\s-]{6,}\d\b/g, "[phone]")
    .slice(0, 700);
}

/** Best-effort client audit entry. Server authorization remains authoritative. */
export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    await addDoc(collection(db, "audit_logs"), {
      action: redactPersonalData(event.action).slice(0, 100),
      performedByUid: uid,
      role: redactPersonalData(event.role).slice(0, 60),
      targetId: redactPersonalData(event.targetId).slice(0, 160),
      targetTitle: redactPersonalData(event.targetTitle).slice(0, 160),
      details: redactPersonalData(event.details),
      timestamp: serverTimestamp(),
    });
  } catch (error) {
    console.warn("Audit event could not be recorded:", error);
  }
}
