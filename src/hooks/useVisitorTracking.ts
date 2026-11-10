import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { doc, setDoc, serverTimestamp, deleteField } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useAuth } from "../lib/useAuth";

function getSessionId(): string {
  const key = "visitor_session_id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `session-${Date.now().toString(36)}`;
  }
}

/**
 * Minimal visitor presence signal.
 * It deliberately excludes names, emails, phone numbers and raw user-agent data.
 */
export function useVisitorTracking(): void {
  const { user } = useAuth();
  const location = useLocation();
  const lastTrackedRef = useRef<{ path: string; time: number }>({ path: "", time: 0 });
  const path = location.pathname;

  useEffect(() => {
    let active = true;
    const track = async () => {
      const now = Date.now();
      if (lastTrackedRef.current.path === path && now - lastTrackedRef.current.time < 30000) return;

      try {
        const sessionId = getSessionId();
        const device = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Mobile" : "Desktop";
        await setDoc(doc(db, "active_visitors", sessionId), {
          sessionId,
          // Remove legacy personal fields from existing visitor documents.
          email: deleteField(),
          name: deleteField(),
          phone: deleteField(),
          userAgent: deleteField(),
          isRegistered: Boolean(user?.uid),
          device,
          path: path.slice(0, 240),
          lastActive: serverTimestamp(),
        }, { merge: true });
        if (active) lastTrackedRef.current = { path, time: Date.now() };
      } catch (error) {
        console.warn("Visitor presence update skipped:", error);
      }
    };

    void track();
    const interval = window.setInterval(() => void track(), 120000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [user?.uid, path]);
}
