/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_SITE_URL?: string;
  readonly VITE_OFFICIAL_PHONE?: string;
  readonly VITE_SUPPORT_WHATSAPP_PHONE?: string;
  readonly VITE_SUPPORT_EMAIL?: string;
  readonly VITE_FIREBASE_VAPID_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
