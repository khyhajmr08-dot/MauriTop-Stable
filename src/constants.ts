export const APP_NAME = "MAURITOP";
export const CURRENCY = "MRU";

// Sensitive contact details are provided only through deployment environment
// settings; no historical account number is assumed to be current.
export const OFFICIAL_PHONE = (import.meta.env.VITE_OFFICIAL_PHONE || "").replace(/[^0-9]/g, "");
export const SUPPORT_WHATSAPP_PHONE = (import.meta.env.VITE_SUPPORT_WHATSAPP_PHONE || "").replace(/[^0-9]/g, "");
export const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL || "").trim();
