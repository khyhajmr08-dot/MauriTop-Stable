import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth } from './firebase';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMRU(amount: number) {
  const isAr = localStorage.getItem('app_language') !== 'fr';
  return `${amount.toLocaleString()} ${isAr ? 'أوقية جديدة' : 'MRU'}`;
}

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
} as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  // Do not log customer email, phone number, or provider details.
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  console.error("Firestore operation failed:", { operationType, path, code, message });
}

/**
 * Checks if an image URL is valid for the current environment.
 * Rejects hardcoded dev paths like /src/assets/ in production.
 */
export function isValidImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith('data:')) return true;
  if (url.startsWith('blob:')) return true;
  if (url.startsWith('http://') || url.startsWith('https://')) return true;
  if (url.startsWith('/assets/')) return true; // Vite production asset prefix
  
  // If we are in production, reject paths that look like source code assets
  if (import.meta.env.PROD) {
    if (url.includes('/src/assets/') || url.includes('localhost:') || url.includes('127.0.0.1:')) {
      return false;
    }
  } else {
    // In development, allow /src/assets/ paths
    if (url.startsWith('/src/assets/')) return true;
  }
  
  // Also, if it contains standard image extensions or starts with a slash, we can be more lenient in dev,
  // but let's default to false for generic invalid strings.
  return url.startsWith('/') || url.includes('://');
}
/**
 * Formats a string of digits into groups of 4 separated by non-breaking spaces (\u00A0).
 * Prevents numbers from ever wrapping onto multiple lines in mobile browsers.
 * Example: "12345678" -> "1234 5678"
 */
export function formatNumberSpacing(num: string): string {
  if (!num) return '';
  return num.replace(/\s+/g, '').replace(/(.{4})/g, '$1\u00A0').trim();
}

/**
 * Compresses an image and returns a base64 string.
 * Helps stay within Firestore's 1MB document limit.
 */
export async function compressImage(
  source: string | Blob,
  maxWidth = 800,
  maxHeight = 800,
  quality = 0.75
): Promise<string> {
  const isObjectUrl = typeof source !== "string";
  const imageUrl = isObjectUrl ? URL.createObjectURL(source) : source;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Image compression timed out."));
    }, 10000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      if (isObjectUrl) URL.revokeObjectURL(imageUrl);
    };

    img.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image canvas is unavailable.");
        context.drawImage(img, 0, 0, width, height);
        const result = canvas.toDataURL("image/webp", quality);
        cleanup();
        if (!result.startsWith("data:image/webp")) {
          reject(new Error("Image conversion failed."));
          return;
        }
        resolve(result);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    img.onerror = () => {
      cleanup();
      reject(new Error("Unable to load image for compression."));
    };
    img.src = imageUrl;
  });
}

/**
 * Triggers haptic feedback using the HTML5 Vibration API.
 * Safely guards against platforms that do not support it or have permission constraints.
 */
export const haptic = {
  light: () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(15);
      }
    } catch (e) {
      // Ignore security/permission/unsupported issues
    }
  },
  medium: () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(30);
      }
    } catch (e) {
      // Ignore
    }
  },
  success: () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([50, 50, 100]);
      }
    } catch (e) {
      // Ignore
    }
  },
  error: () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
      }
    } catch (e) {
      // Ignore
    }
  }
};

/**
 * Safely parses any Firestore timestamp, string, number, or object into a valid JS Date.
 */
export function parseDateSafe(rawDate: any): Date {
  if (!rawDate) return new Date();

  if (typeof rawDate.toDate === "function") {
    try {
      const d = rawDate.toDate();
      if (!isNaN(d.getTime())) return d;
    } catch {}
  }

  if (typeof rawDate === "object") {
    const sec = rawDate.seconds ?? rawDate._seconds;
    if (typeof sec === "number") {
      return new Date(sec * 1000);
    }
  }

  if (typeof rawDate === "number") {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) return d;
  }

  if (typeof rawDate === "string") {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) return d;
    const num = Number(rawDate);
    if (!isNaN(num)) return new Date(num);
  }

  const fallback = new Date(rawDate);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

/**
 * Safely formats any date value to localized string, preventing "Invalid Date" errors.
 */
export function formatDateSafe(
  rawDate: any,
  locale: string = "ar-MR",
  options?: Intl.DateTimeFormatOptions
): string {
  const dateObj = parseDateSafe(rawDate);
  try {
    return dateObj.toLocaleString(
      locale,
      options || { dateStyle: "medium", timeStyle: "short" }
    );
  } catch (e) {
    return dateObj.toLocaleDateString();
  }
}

export type NormalizedOrderStatus = 'pending' | 'approved' | 'shipped' | 'completed' | 'rejected';

/**
 * Normalizes different status strings from Firestore or user input into canonical states.
 * Ensures 'approved', 'accepted', 'processing' all map correctly so accepting orders displays reliably.
 */
export function normalizeOrderStatus(rawStatus?: string | null): NormalizedOrderStatus {
  const s = (rawStatus || '').toLowerCase().trim();
  if (['completed', 'complete', 'success', 'done', 'مكتمل'].includes(s)) return 'completed';
  if (['approved', 'accepted', 'accept', 'in_progress', 'processing', 'قيد التنفيذ', 'مقبول'].includes(s)) return 'approved';
  if (['shipped', 'shipping', 'تم الشحن'].includes(s)) return 'shipped';
  if (['rejected', 'refused', 'cancelled', 'canceled', 'مرفوض'].includes(s)) return 'rejected';
  return 'pending';
}

/**
 * Returns Arabic badge styles and labels for order statuses.
 */
export function getOrderStatusArabic(rawStatus?: string | null): {
  label: string;
  badgeClass: string;
  dotColor: string;
} {
  const norm = normalizeOrderStatus(rawStatus);
  switch (norm) {
    case 'completed':
      return {
        label: 'مكتمل الشحن بنجاح ✅',
        badgeClass: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
        dotColor: 'bg-emerald-400'
      };
    case 'approved':
      return {
        label: 'تم قبول الشحن (قيد المعالجة) ⚡',
        badgeClass: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30',
        dotColor: 'bg-cyan-400'
      };
    case 'shipped':
      return {
        label: 'تم الشحن والتسليم 📦',
        badgeClass: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
        dotColor: 'bg-blue-400'
      };
    case 'pending':
      return {
        label: 'بانتظار المراجعة والقبول ⏳',
        badgeClass: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
        dotColor: 'bg-amber-400'
      };
    case 'rejected':
      return {
        label: 'طلب مرفوض ❌',
        badgeClass: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
        dotColor: 'bg-rose-400'
      };
  }
}