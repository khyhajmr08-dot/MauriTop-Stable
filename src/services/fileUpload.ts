import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  type UploadTaskSnapshot,
} from "firebase/storage";
import { storage } from "../lib/firebase";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function normalizeUploadInput(input: File | Blob | string): Promise<Blob> {
  if (typeof input === "string") {
    if (!input.startsWith("data:image/")) {
      throw new Error("Only image data URLs can be uploaded.");
    }
    const response = await fetch(input);
    if (!response.ok) throw new Error("Unable to read the selected image.");
    return response.blob();
  }
  return input;
}

/** Uploads an image to Firebase Storage and reports progress. */
export async function uploadFileWithProgress(
  file: File | Blob | string,
  path: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("Invalid storage path.");
  }

  const blob = await normalizeUploadInput(file);
  if (!blob.type.startsWith("image/")) {
    throw new Error("The uploaded file must be an image.");
  }
  if (blob.size <= 0 || blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("Image size must be between 1 byte and 10 MB.");
  }

  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), blob, {
      contentType: blob.type,
      cacheControl: "public,max-age=31536000,immutable",
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      task.cancel();
      reject(new Error("Upload timed out after 60 seconds."));
    }, 60000);

    task.on(
      "state_changed",
      (snapshot: UploadTaskSnapshot) => {
        onProgress?.(
          Math.round((snapshot.bytesTransferred / Math.max(snapshot.totalBytes, 1)) * 100)
        );
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
      async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          resolve(await getDownloadURL(task.snapshot.ref));
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}
