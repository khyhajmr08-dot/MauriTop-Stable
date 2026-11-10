import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import crypto from "crypto";

import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/live" });
const PORT = Number(process.env.PORT || 3000);

let initializationPromise: Promise<void> | null = null;

// Wait for Firebase/Admin and route registration before handling requests.
app.use((req, res, next) => {
  if (!initializationPromise) return res.status(503).json({ error: "SERVER_INITIALIZING" });
  initializationPromise.then(() => next()).catch(next);
});

async function startServer() {
  let adminApp: App | undefined;
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      if (
        !serviceAccount ||
        typeof serviceAccount.client_email !== "string" ||
        typeof serviceAccount.private_key !== "string" ||
        serviceAccount.project_id !== firebaseConfig.projectId
      ) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be a valid service-account JSON for the configured Firebase project.");
      }
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: firebaseConfig.projectId
      });
    } else {
      // Google-hosted runtimes may provide ADC automatically; Vercel requires
      // a service-account secret to be configured for Admin/Firestore access.
      adminApp = initializeApp({
        projectId: firebaseConfig.projectId
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown initialization error";
    console.error("[Firebase Admin] Initialization failed:", message);
  }

  let db: Firestore | null = null;
  const getDb = () => {
    if (!db) {
      try {
        db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);
      } catch (e) {
        console.error("Failed to get Firestore instance:", e);
        throw new Error("Firestore not initialized. Check Firebase Admin setup.");
      }
    }
    return db;
  };

  app.use(express.json({ limit: "1mb" }));
  
  // Lazy init Gemini client to avoid crashes if API_KEY is missing
  let ai: GoogleGenAI | null = null;
  const getAi = () => {
    if (!ai) {
      if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY environment variable is required");
      ai = new GoogleGenAI({ 
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          }
        }
      });
    }
    return ai;
  };

  // Read-only health check: verify the actual Firestore connection, not only process startup.
  app.get("/api/health", async (_req, res) => {
    try {
      await getDb().collection("settings").doc("global").get();
      return res.json({
        status: "ok",
        nodeEnv: process.env.NODE_ENV,
        checks: {
          firestore: "ok",
          firebaseAdmin: Boolean(adminApp),
          serviceAccountSecretConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        }
      });
    } catch (error) {
      console.error("[Health] Firestore connectivity check failed:", error);
      return res.status(503).json({
        status: "degraded",
        nodeEnv: process.env.NODE_ENV,
        checks: {
          firestore: "unavailable",
          firebaseAdmin: Boolean(adminApp),
          serviceAccountSecretConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
          reason: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
            ? "FIRESTORE_CONNECTION_FAILED"
            : "FIREBASE_ADMIN_CREDENTIALS_MISSING"
        }
      });
    }
  });

  // Helper to verify Firebase ID Token (for authenticated user or admin requests)
  const verifyAuthToken = async (req: express.Request): Promise<DecodedIdToken | null> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.split("Bearer ")[1];
    try {
      if (adminApp) {
        return await getAuth(adminApp).verifyIdToken(token);
      }
    } catch (e) {
      console.warn("[Auth] Failed to verify ID token:", e);
    }
    return null;
  };

  const isOwnerUser = (decoded: DecodedIdToken | null) => {
    if (!decoded) return false;
    const email = (decoded.email || "").toLowerCase().trim();
    return email === "khyhajmr08@gmail.com" || decoded.uid === "PqXqqCgdC1eYPz4HKHHLtDRejPD3";
  };

  // Maintenance Middleware for Order Endpoints (Fail-closed on error for safety)
  const checkMaintenance = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const firestore = getDb();
      const settingsDoc = await firestore.collection("settings").doc("global").get();
      if (settingsDoc.exists) {
        const data = settingsDoc.data();
        if (data?.maintenanceMode === true) {
          // Allow owner to bypass maintenance
          const decoded = await verifyAuthToken(req);
          if (decoded && isOwnerUser(decoded)) {
            return next();
          }
          return res.status(503).json({
            error: "MAINTENANCE_MODE",
            message: "المنصة قيد الصيانة المجدولة حالياً لتحسين الخدمات. لا يمكن قبول طلبات جديدة في الوقت الحالي."
          });
        }
      }
      return next();
    } catch (err) {
      console.error("[Maintenance Check] Error verifying maintenance state:", err);
      // Safe fail-closed: do not silently allow order creation if maintenance check throws
      return res.status(503).json({
        error: "SERVICE_UNAVAILABLE",
        message: "تعذر التحقق من حالة المنصة في الوقت الحالي. يرجى المحاولة بعد لحظات."
      });
    }
  };

  // Secure Server-Authoritative Order Creation API (Supports Guests and Authenticated Users with Atomic Idempotency)
  app.post("/api/orders", checkMaintenance, async (req, res) => {
    try {
      const { 
        serviceId, 
        amount: requestedAmount, 
        fields: clientFields, 
        paymentMethod, 
        senderPhone, 
        proofImageUrl, 
        attemptId,
        guestEmail,
        guestName
      } = req.body;

      if (!serviceId) {
        return res.status(400).json({ error: "SERVICE_REQUIRED", message: "معرّف الخدمة مطلوب" });
      }

      if (!attemptId || typeof attemptId !== "string" || attemptId.trim().length < 8) {
        return res.status(400).json({ error: "ATTEMPT_ID_REQUIRED", message: "رمز المحاولة (attemptId) غير صالح" });
      }

      const clientAttemptId = attemptId.trim();
      const firestore = getDb();

      // 1. Fetch Trusted Service Configuration
      let serviceData: any = null;
      const serviceDoc = await firestore.collection("services").doc(serviceId).get();
      if (serviceDoc.exists) {
        serviceData = serviceDoc.data();
      }

      if (!serviceData || serviceData.isDeleted === true || ['deleted', 'inactive', 'draft'].includes((serviceData.status || '').toLowerCase())) {
        return res.status(400).json({ error: "SERVICE_UNAVAILABLE", message: "هذه الخدمة غير متوفرة حالياً" });
      }

      const pricingMode = serviceData.pricingMode || "fixed";
      const isQuoteMode = pricingMode === "quote";

      // 2. Validate Payment Method Configuration
      let trustedPaymentMethod = paymentMethod;
      if (isQuoteMode) {
        trustedPaymentMethod = "quote";
      } else {
        if (!paymentMethod || typeof paymentMethod !== "string") {
          return res.status(400).json({ error: "PAYMENT_METHOD_REQUIRED", message: "يرجى تحديد طريقة دفع صالحة" });
        }

        const paymentSettingsDoc = await firestore.collection("settings").doc("payment_methods").get();
        const paymentMethods = paymentSettingsDoc.exists ? paymentSettingsDoc.data()?.methods || paymentSettingsDoc.data() : null;
        const methodConfig = paymentMethods ? paymentMethods[paymentMethod] : null;

        if (!methodConfig) {
          return res.status(400).json({ error: "PAYMENT_METHOD_INVALID", message: "طريقة الدفع المحددة غير معروفة" });
        }

        if (methodConfig.enabled === false) {
          return res.status(400).json({ 
            error: "PAYMENT_METHOD_DISABLED", 
            message: `طريقة الدفع (${methodConfig.labelAr || paymentMethod}) معطلة حالياً. يرجى اختيار وسيلة أخرى.` 
          });
        }
      }

      // 3. Compute and Validate Server-Authoritative Price
      let finalAmount = 0;
      if (!isQuoteMode) {
        const parsedClientAmount = Number(requestedAmount);
        if (isNaN(parsedClientAmount) || parsedClientAmount <= 0) {
          return res.status(400).json({ error: "INVALID_AMOUNT", message: "المبلغ المطلوب غير صالح" });
        }

        if (pricingMode === "fixed") {
          const expectedPrice = Number(serviceData.priceMru || serviceData.suggestedPrice || serviceData.price || 0);
          if (expectedPrice > 0 && parsedClientAmount !== expectedPrice) {
            return res.status(400).json({ error: "PRICE_MISMATCH", message: `سعر الخدمة الرسمي هو ${expectedPrice} MRU` });
          }
          finalAmount = expectedPrice > 0 ? expectedPrice : parsedClientAmount;
        } else if (pricingMode === "range") {
          const min = Number(serviceData.minAmountMru || serviceData.minAmount || 0);
          const max = Number(serviceData.maxAmountMru || serviceData.maxAmount || Infinity);
          if (parsedClientAmount < min || parsedClientAmount > max) {
            return res.status(400).json({ 
              error: "AMOUNT_OUT_OF_RANGE", 
              message: `المبلغ يجب أن يكون بين ${min} و ${max} MRU` 
            });
          }
          finalAmount = parsedClientAmount;
        } else {
          finalAmount = parsedClientAmount;
        }
      }

      // 4. Validate Required Service Fields
      const safeFields: Record<string, any> = {};
      if (Array.isArray(serviceData.fields)) {
        for (const f of serviceData.fields) {
          const val = (clientFields && clientFields[f.id] !== undefined) ? String(clientFields[f.id]).trim() : "";
          if (f.required && !val) {
            return res.status(400).json({ error: "FIELD_REQUIRED", message: `الحقل (${f.labelAr || f.label}) مطلوب` });
          }
          if (f.pattern && val && !new RegExp(f.pattern).test(val)) {
            return res.status(400).json({ error: "FIELD_INVALID", message: `صيغة الحقل (${f.labelAr || f.label}) غير صحيحة` });
          }
          safeFields[f.id] = val;
        }
      }

      // 5. Determine Authenticated User or Guest identity
      const decodedUser = await verifyAuthToken(req);
      const isGuest = !decodedUser;
      const effectiveUserId = decodedUser ? decodedUser.uid : `guest_${clientAttemptId.slice(0, 16)}`;
      const effectiveUserEmail = decodedUser ? (decodedUser.email || "") : (guestEmail ? String(guestEmail).trim() : "");
      const effectiveUserName = decodedUser 
        ? (decodedUser.name || decodedUser.email?.split('@')[0] || "عميل مسجل") 
        : (guestName ? String(guestName).trim() : "زائر ضيف");

      // Verify not blocked if authenticated
      if (decodedUser) {
        const userDoc = await firestore.collection("users").doc(decodedUser.uid).get();
        if (userDoc.exists && userDoc.data()?.blocked === true) {
          return res.status(403).json({ error: "USER_BLOCKED", message: "حسابك محظور من إجراء طلبات جديدة" });
        }
      }

      // 6. Compute Cryptographic Payload Hash for Idempotency Protection
      const payloadString = JSON.stringify({
        serviceId,
        finalAmount,
        safeFields,
        trustedPaymentMethod,
        senderPhone: senderPhone ? String(senderPhone).trim() : "",
        effectiveUserId
      });
      const payloadHash = crypto.createHash("sha256").update(payloadString).digest("hex");

      // Stable tracking token for guest orders
      const trackingToken = crypto.randomBytes(24).toString("hex");

      // 7. Atomic Idempotency Check & Order Insertion in Firestore Transaction
      const idempotencyRef = firestore.collection("order_idempotency").doc(clientAttemptId);
      
      const transactionResult = await firestore.runTransaction(async (transaction) => {
        const idempSnap = await transaction.get(idempotencyRef);

        if (idempSnap.exists) {
          const prev = idempSnap.data();
          if (prev?.payloadHash !== payloadHash) {
            throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
          }
          // Same attempt and same payload: Return already created canonical order
          return {
            isReplay: true,
            orderId: prev.orderId,
            trackingToken: prev.trackingToken || null
          };
        }

        // Generate Canonical Order Document
        const newOrderRef = firestore.collection("orders").doc();
        const orderId = newOrderRef.id;

        const orderData = {
          id: orderId,
          userId: effectiveUserId,
          isGuest: isGuest,
          userName: effectiveUserName,
          userEmail: effectiveUserEmail,
          serviceId: serviceId,
          serviceName: serviceData.nameAr || serviceData.name || "خدمة رقمية",
          serviceType: serviceData.nameAr || serviceData.name || "خدمة رقمية",
          amount: finalAmount,
          total: finalAmount,
          fee: 0,
          status: "pending",
          fields: safeFields,
          paymentMethod: trustedPaymentMethod,
          senderPhone: isQuoteMode ? "" : (senderPhone ? String(senderPhone).trim() : ""),
          proofImageUrl: proofImageUrl || "",
          proofUrl: proofImageUrl || "",
          attemptId: clientAttemptId,
          trackingToken: isGuest ? trackingToken : null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };

        transaction.set(newOrderRef, orderData);

        transaction.set(idempotencyRef, {
          attemptId: clientAttemptId,
          orderId: orderId,
          payloadHash: payloadHash,
          trackingToken: isGuest ? trackingToken : null,
          createdAt: FieldValue.serverTimestamp()
        });

        return {
          isReplay: false,
          orderId: orderId,
          trackingToken: isGuest ? trackingToken : null
        };
      });

      return res.status(200).json({
        success: true,
        orderId: transactionResult.orderId,
        trackingToken: transactionResult.trackingToken,
        isReplay: transactionResult.isReplay,
        serviceName: serviceData.nameAr || serviceData.name,
        amount: finalAmount,
        trackingUrl: transactionResult.trackingToken ? `/orders?token=${transactionResult.trackingToken}` : `/orders`
      });

    } catch (err: any) {
      if (err.message === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        return res.status(409).json({ 
          error: "IDEMPOTENCY_CONFLICT", 
          message: "رمز المحاولة هذا تم استخدامه مسبقاً ببيانات مختلفة. يرجى تحديث الصفحة وإعادة المحاولة." 
        });
      }
      console.error("[Create Order Error]:", err);
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "حدث خطأ غير متوقع أثناء حفظ الطلب" });
    }
  });

  // Guest Order Tracking Endpoint (Protected by Secret Tracking Token)
  app.get("/api/orders/track", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== "string" || token.length < 16) {
        return res.status(400).json({ error: "TOKEN_REQUIRED", message: "رمز التتبع غير صالح" });
      }

      const firestore = getDb();
      const snapshot = await firestore.collection("orders")
        .where("trackingToken", "==", token.trim())
        .limit(1)
        .get();

      if (snapshot.empty) {
        return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "لم يتم العثور على طلب مطابق لرمز التتبع" });
      }

      const orderData = snapshot.docs[0].data();
      return res.json({
        success: true,
        order: {
          id: snapshot.docs[0].id,
          serviceName: orderData.serviceName || orderData.serviceType,
          amount: orderData.amount,
          status: orderData.status,
          pinCode: orderData.pinCode || null,
          adminNote: orderData.adminNote || null,
          rejectionReason: orderData.rejectionReason || null,
          createdAt: orderData.createdAt
        }
      });
    } catch (err) {
      console.error("[Track Order Error]:", err);
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "فشل التحقق من حالة الطلب" });
    }
  });

  // Privileged Order Status Update & Atomic Referral Reward Processing
  app.post("/api/admin/orders/:orderId/status", async (req, res) => {
    try {
      const { orderId } = req.params;
      const { status, adminNote, rejectionReason, pinCode } = req.body;

      const decoded = await verifyAuthToken(req);
      if (!decoded) {
        return res.status(401).json({ error: "UNAUTHORIZED", message: "تسجيل الدخول الإداري مطلوب" });
      }

      const firestore = getDb();
      const isOwner = isOwnerUser(decoded);

      // Check staff role if not owner
      if (!isOwner) {
        const staffDoc = await firestore.collection("staff").doc(decoded.uid).get();
        const role = staffDoc.exists && staffDoc.data()?.active ? staffDoc.data()?.role : null;
        if (!['orders_manager', 'admin'].includes(role)) {
          return res.status(403).json({ error: "FORBIDDEN", message: "ليس لديك صلاحية لتعديل حالة الطلب" });
        }
      }

      const validStatuses = ['pending', 'approved', 'shipped', 'completed', 'rejected'];
      const targetStatus = (status || '').toLowerCase();
      if (!validStatuses.includes(targetStatus)) {
        return res.status(400).json({ error: "INVALID_STATUS", message: "حالة الطلب غير صالحة" });
      }

      if (targetStatus === 'rejected' && (!rejectionReason || !String(rejectionReason).trim())) {
        return res.status(400).json({ error: "REJECTION_REASON_REQUIRED", message: "سبب الرفض إلزامي للعميل" });
      }

      const orderRef = firestore.collection("orders").doc(orderId);

      // Atomic Update with Referral Rewarding
      const updateResult = await firestore.runTransaction(async (transaction) => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) {
          throw new Error("ORDER_NOT_FOUND");
        }
        const currentData = orderSnap.data() || {};
        const currentStatus = (currentData.status || "pending").toLowerCase();

        // Valid status transition rule enforcement:
        // Do not allow completed orders to be reverted to pending or approved without owner
        if (currentStatus === "completed" && targetStatus !== "completed" && !isOwner) {
          throw new Error("COMPLETED_ORDER_IMMUTABLE");
        }

        const updates: any = {
          status: targetStatus,
          updatedAt: FieldValue.serverTimestamp()
        };

        if (adminNote !== undefined) updates.adminNote = adminNote ? String(adminNote).trim() : null;
        if (rejectionReason !== undefined) updates.rejectionReason = rejectionReason ? String(rejectionReason).trim() : null;
        if (pinCode !== undefined) updates.pinCode = pinCode ? String(pinCode).trim() : null;
        if (targetStatus === "completed") {
          updates.completedAt = FieldValue.serverTimestamp();
        }

        transaction.update(orderRef, updates);

        // Atomic Referral Rewarding: Only on genuinely completed order, exactly once, 30 MRU
        let referralRewarded = false;
        if (targetStatus === "completed" && currentData.userId && !currentData.isGuest) {
          const userRef = firestore.collection("users").doc(currentData.userId);
          const userSnap = await transaction.get(userRef);
          if (userSnap.exists) {
            const userData = userSnap.data() || {};
            if (userData.referredBy && !userData.isReferralRewarded) {
              const referrerRef = firestore.collection("users").doc(userData.referredBy);
              const referrerSnap = await transaction.get(referrerRef);
              if (referrerSnap.exists) {
                const referrerData = referrerSnap.data() || {};
                const currentEarnings = Number(referrerData.referralEarnings || 0);
                const currentCount = Number(referrerData.referralsCount || 0);
                const currentPoints = Number(referrerData.loyaltyPoints || 0);

                transaction.update(userRef, {
                  isReferralRewarded: true,
                  firstCompletedOrderAt: FieldValue.serverTimestamp()
                });

                transaction.update(referrerRef, {
                  referralsCount: currentCount + 1,
                  referralEarnings: currentEarnings + 30,
                  loyaltyPoints: currentPoints + 30,
                  updatedAt: FieldValue.serverTimestamp()
                });

                referralRewarded = true;
              }
            }
          }
        }

        return { success: true, referralRewarded };
      });

      return res.json({ success: true, status: targetStatus, referralRewarded: updateResult.referralRewarded });

    } catch (err: any) {
      if (err.message === "ORDER_NOT_FOUND") {
        return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "الطلب غير موجود" });
      }
      if (err.message === "COMPLETED_ORDER_IMMUTABLE") {
        return res.status(400).json({ error: "COMPLETED_ORDER_IMMUTABLE", message: "الطلب المكتمل لا يمكن تعديله إلا بواسطة المالك" });
      }
      console.error("[Admin Update Order Error]:", err);
      return res.status(500).json({ error: "INTERNAL_ERROR", message: "فشل تحديث حالة الطلب" });
    }
  });

  // Cloud Messaging Dispatch Route for Status Updates
  app.post("/api/send-fcm", async (req, res) => {
    try {
      const { token, title, body } = req.body;
      if (!token) {
        return res.status(400).json({ error: "FCM Token is required." });
      }

      console.log(`[Cloud Messaging Server] Triggered Notification dispatch:`);
      console.log(`- Token: ${token.substring(0, 20)}...`);
      console.log(`- Title: "${title}"`);
      console.log(`- Body: "${body}"`);

      // Real integration check: If the developer provides an FCM service key, we can execute OAuth to send a real Web Push
      let isRealSendAttempted = false;
      const fcmKey = process.env.FCM_SERVER_KEY;
      if (fcmKey) {
        try {
          // This allows users to test real push notifications when they configure the FCM server key
          const response = await fetch(`https://fcm.googleapis.com/fcm/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `key=${fcmKey}`
            },
            body: JSON.stringify({
              to: token,
              notification: { title, body, sound: "default" },
              data: { click_action: "FLUTTER_NOTIFICATION_CLICK" }
            })
          });
          if (response.ok) {
            isRealSendAttempted = true;
          }
        } catch (fcmErr) {
          console.warn("[Cloud Messaging Server] Failed real FCM sending:", fcmErr);
        }
      }

      return res.json({
        success: true,
        message: "Notification dispatched successfully",
        isDemoMock: !isRealSendAttempted,
        details: {
          title,
          body,
          tokenPreview: `${token.substring(0, 15)}...`,
          systemTimestamp: new Date().toISOString(),
          status: isRealSendAttempted ? "Real FCM Delivered" : "Pre-production simulation (Please configure FCM_SERVER_KEY in settings to establish direct socket line)"
        }
      });
    } catch (err: any) {
      console.error("Error in /api/send-fcm:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // Dynamic Sitemap Generator for Search Engines
  const generateSitemapXml = async (hostUrl: string = "https://mauritop-v2-4ozx.vercel.app") => {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    const lastMod = new Date().toISOString().split('T')[0];

    // Static primary pages
    const staticPages = [
      { path: '', priority: '1.0', changefreq: 'daily' },
      { path: '/service-cards', priority: '0.9', changefreq: 'weekly' },
      { path: '/calculator', priority: '0.8', changefreq: 'monthly' },
      { path: '/contact', priority: '0.7', changefreq: 'monthly' },
      { path: '/assistant', priority: '0.7', changefreq: 'weekly' },
      { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
      { path: '/terms', priority: '0.3', changefreq: 'yearly' },
    ];

    staticPages.forEach(p => {
      const fullUrl = p.path === '' ? `${hostUrl}/` : `${hostUrl}${p.path}`;
      xml += `  <url>\n    <loc>${fullUrl}</loc>\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>\n`;
    });

    // Default core real service IDs matching actual catalog
    const defaultServiceIds = [
      'pubg', 'freefire', 'cod-mobile', 'tod-vip', 'shahid-vip', 
      'netflix', 'spotify-premium', 'apple-10', 'apple-25', 'playstation-10', 
      'googleplay-10', 'fb-ads', 'fb-verification', 'icloud-service', 'visa-recharge'
    ];

    const serviceIdsSet = new Set<string>(defaultServiceIds);

    try {
      const firestore = getDb();
      const servicesSnapshot = await firestore.collection("services").get();
      servicesSnapshot.forEach(doc => {
        const data = doc.data();
        // Only index active services
        if (doc.id && data.status !== 'Deleted' && data.status !== 'deleted' && data.status !== 'Draft') {
          serviceIdsSet.add(doc.id);
        }
      });
    } catch (e) {
      console.warn("Firestore services fetch for sitemap failed, using catalog:", e);
    }

    serviceIdsSet.forEach(sId => {
      xml += `  <url>\n    <loc>${hostUrl}/services/${sId}</loc>\n    <lastmod>${lastMod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
    });

    xml += '</urlset>';
    return xml;
  };

  const handleSitemapRequest = async (req: express.Request, res: express.Response) => {
    try {
      const hostUrl = "https://mauritop-v2-4ozx.vercel.app";
      const xml = await generateSitemapXml(hostUrl);
      res.header('Content-Type', 'application/xml; charset=utf-8');
      res.status(200).send(xml);
    } catch (e) {
      console.error("Error generating dynamic sitemap:", e);
      res.status(500).send("Error generating sitemap");
    }
  };

  app.get("/sitemap.xml", handleSitemapRequest);
  app.get("/api/sitemap.xml", handleSitemapRequest);

  // Serve IndexNow Key file directly at both standard locations
  const handleIndexNowKey = (_req: express.Request, res: express.Response) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send("mauritop2026indexnowkey884729");
  };
  app.get("/mauritop2026indexnowkey.txt", handleIndexNowKey);
  app.get("/mauritop2026indexnowkey884729.txt", handleIndexNowKey);

  // Local SEO & IndexNow Health Check
  app.get("/api/indexnow/verify-local", async (req, res) => {
    try {
      const apiKey = "mauritop2026indexnowkey884729";
      return res.json({
        ok: true,
        key: apiKey,
        keyFileExpected: "/mauritop2026indexnowkey.txt",
        keyFileAltExpected: "/mauritop2026indexnowkey884729.txt",
        keyContentMatches: true,
        sitemapUrl: "https://mauritop-v2-4ozx.vercel.app/sitemap.xml",
        robotsUrl: "https://mauritop-v2-4ozx.vercel.app/robots.txt",
        gscVerificationFile: "/googleriFWxrL7v_Sp3WfPE6csBOVKzakjy3ROeZIhwOZxHFA.html",
        status: "Local verification files and routes are active and ready"
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message });
    }
  });

  // IndexNow & Instant SEO Indexing API Route
  app.post("/api/indexnow/submit", express.json(), async (req, res) => {
    try {
      const { urls, host } = req.body || {};
      const targetHost = host || (req.get('host') || "remix-remix-remix-mauripay-1590.ai.studio");
      const apiKey = "mauritop2026indexnowkey884729";
      const keyLocation = `https://${targetHost}/mauritop2026indexnowkey.txt`;

      let urlList: string[] = [];
      if (Array.isArray(urls) && urls.length > 0) {
        urlList = urls.map((u: string) => u.startsWith("http") ? u : `https://${targetHost}${u.startsWith("/") ? "" : "/"}${u}`);
      } else {
        urlList = [
          `https://${targetHost}/`,
          `https://${targetHost}/service-cards`,
          `https://${targetHost}/calculator`,
          `https://${targetHost}/contact`,
          `https://${targetHost}/assistant`,
          `https://${targetHost}/services/freefire`,
          `https://${targetHost}/services/pubg`,
          `https://${targetHost}/services/netflix`,
          `https://${targetHost}/services/canva`,
          `https://${targetHost}/services/spotify`
        ];
      }

      const payload = {
        host: targetHost,
        key: apiKey,
        keyLocation: keyLocation,
        urlList: urlList
      };

      const results: Record<string, any> = {};

      // 1. Submit to IndexNow Protocol central endpoint (api.indexnow.org)
      try {
        const indexNowRes = await fetch("https://api.indexnow.org/indexnow", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload)
        });
        const status = indexNowRes.status;
        const isOk = status === 200 || status === 202;
        let message = "";
        let explanation = "";

        if (status === 200) {
          message = "تم استلام الروابط ومعالجتها بنجاح بواسطة بروتوكول IndexNow (200 OK)";
        } else if (status === 202) {
          message = "تم قبول الطلب بنجاح وهو قيد التحقق وتوزيع الروابط على المحركات (202 Accepted)";
        } else if (status === 400) {
          message = "طلب غير صالح: بنية البيانات غير صحيحة (400 Bad Request)";
          explanation = "تحقق من صحة أسماء الحقول ومحتوى JSON.";
        } else if (status === 403) {
          message = "تم رفض الطلب لتعذر التحقق من المفتاح الخارجي (403 Forbidden)";
          explanation = `محركات البحث تحاول تنزيل ملف المفتاح من https://${targetHost}/mauritop2026indexnowkey.txt للتحقق من ملكيتك للنطاق. في بيئة التطوير أو المعاينة المؤقتة، لا يمكن لمحركات البحث الوصول إلى نطاق الإنتاج حتى يتم ربط وتفعيل DNS الرسمي لـ ${targetHost}.`;
        } else if (status === 422) {
          message = "الروابط لا تنتمي للمجال المحدد أو بنية المفتاح غير صحيحة (422 Unprocessable Entity)";
          explanation = `تأكد من أن جميع الروابط تبدأ بـ https://${targetHost}/`;
        } else if (status === 429) {
          message = "تم تجاوز حد الطلبات المسموح به مؤقتاً (429 Too Many Requests)";
          explanation = "يرجى الانتظار بضع دقائق قبل إرسال دفعة جديدة.";
        } else {
          message = `استجابة خادم IndexNow: كود ${status}`;
        }

        results.indexNowOrg = {
          endpoint: "https://api.indexnow.org/indexnow",
          status,
          ok: isOk,
          message,
          explanation
        };
      } catch (err: any) {
        results.indexNowOrg = {
          endpoint: "https://api.indexnow.org/indexnow",
          status: 0,
          ok: false,
          error: err?.message || "تعذر الاتصال بـ api.indexnow.org",
          explanation: "تحقق من اتصال الشبكة بالخادم المركزي لـ IndexNow."
        };
      }

      // 2. Submit to Microsoft Bing IndexNow endpoint
      try {
        const bingRes = await fetch("https://www.bing.com/indexnow", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload)
        });
        const status = bingRes.status;
        const isOk = status === 200 || status === 202;
        let message = "";
        let explanation = "";

        if (status === 200) {
          message = "تم قبول الروابط بنجاح في محرك بحث Bing (200 OK)";
        } else if (status === 202) {
          message = "تم استلام الطلب بنجاح وهو قيد المعالجة في Bing (202 Accepted)";
        } else if (status === 403) {
          message = "تعذر التحقق من ملكية النطاق في Bing (403 Forbidden)";
          explanation = `Bing يبحث عن المفتاح على https://${targetHost}/mauritop2026indexnowkey.txt للتحقق من ملكية الموقع.`;
        } else {
          message = `استجابة Bing: كود ${status}`;
        }

        results.bing = {
          endpoint: "https://www.bing.com/indexnow",
          status,
          ok: isOk,
          message,
          explanation
        };
      } catch (err: any) {
        results.bing = {
          endpoint: "https://www.bing.com/indexnow",
          status: 0,
          ok: false,
          error: err?.message || "تعذر الاتصال بـ Bing IndexNow"
        };
      }

      // 3. Google Search Console & Sitemap Discovery Status (Google Ping is deprecated since 2024)
      results.google = {
        method: "Google Search Console & Sitemap.xml",
        status: "Active",
        ok: true,
        deprecatedPingRemoved: true,
        sitemapUrl: `https://${targetHost}/sitemap.xml`,
        gscSitemapsUrl: `https://search.google.com/search-console/sitemaps?resource_id=https%3A%2F%2F${encodeURIComponent(targetHost)}%2F`,
        gscInspectUrl: `https://search.google.com/search-console/inspect?resource_id=https%3A%2F%2F${encodeURIComponent(targetHost)}%2F`,
        verificationFile: `https://${targetHost}/googleriFWxrL7v_Sp3WfPE6csBOVKzakjy3ROeZIhwOZxHFA.html`,
        message: "تم إلغاء نظام Google Ping القديم رسمياً من قبل شركة Google. تعتمد الفهرسة المعتمدة على تقديم sitemap.xml عبر Google Search Console واكتشاف robots.txt التلقائي."
      };

      const accepted = !!(results.indexNowOrg?.ok || results.bing?.ok);

      return res.json({
        success: accepted,
        accepted: accepted,
        submittedUrlsCount: urlList.length,
        submittedUrls: urlList,
        keyUsed: apiKey,
        keyLocation: keyLocation,
        timestamp: new Date().toISOString(),
        results
      });
    } catch (error: any) {
      console.error("IndexNow submission error:", error);
      return res.status(500).json({ success: false, accepted: false, error: error?.message || "خطأ في السيرفر الداخلي" });
    }
  });

  app.get("/api/chat", (req, res) => {
    return res.json({ message: "Mouri Top Gemini API chat endpoint is active. Use POST to communicate." });
  });

  // Secure context-aware text chatbot route
  app.post("/api/chat", async (req, res) => {
    try {
      const { contents } = req.body;
      if (!contents || !Array.isArray(contents)) {
        return res.status(400).json({ error: "Invalid contents parameter. Must be an array." });
      }

      const client = getAi();
      const response = await client.models.generateContent({
        model: "gemini-1.5-flash",
        contents,
        config: {
          systemInstruction: `أنت "المساعد الذكي" الرسمي والخبير لمنصة موري توب (Mouri Top)، وهي المنصة الأولى والرائدة في موريتانيا لشحن الألعاب والاشتراكات الرقمية.

هويتك وأسلوبك:
- أنت خبير مبيعات ودعم فني محترف، ودود جداً، وصبور.
- تتحدث بلهجة موريتانية مهذبة (حسانية مبسطة) ممزوجة بالعربية الفصحى لضمان الوضوح التام لكل المستخدمين، أو بالفرنسية إذا بدأ المستخدم الحديث بها.
- هدفك الأساسي هو مساعدة المستخدمين في اختيار الخدمات المناسبة، شرح كيفية الشحن والطلب، وحل مشكلاتهم التقنية بروح المبادرة.
- **القاعدة الذهبية: تجنب التكرار الممل.** لا تبدأ كل جملة بنفس العبارة (مثل "أهلاً بك" في كل رد). نوع في تحياتك وردودك لتكون طبيعية وبشرية.
- كن ذكياً في استنتاج ما يريده المستخدم. إذا سأل عن "جواهر" فهو يقصد غالباً فري فاير. إذا سأل عن "شدات" فهو يقصد ببجي. إذا سأل عن "نقاط" فقد يقصد فيفا أو موبايل ليجندز.

معلومات التواصل والمنصة:
1. رقم الإدارة والدعم الفني الرسمي (واتساب) هو: 32014902 (أو +22232014902). هذا هو الرقم الوحيد المعتمد للتواصل المباشر مع المدير. إذا سأل المستخدم عن "رقم الإدارة" أو "التواصل" أو "واتساب"، قدم له هذا الرقم فوراً وبفخر.
2. طرق الدفع المتاحة في موريتانيا: بنكيلي (Bankily)، مصرفي (Masrvi)، كليك (BMCI Click)، السداد (Sedad)، وأيضاً PayPal و USDT للمغتربين. تطبيق MauriPay هو وسيلتنا المفضلة لتسهيل العمليات.
3. أهم الخدمات المتوفرة:
   - ألعاب: شحن فري فاير (جواهر بالـ ID)، ببجي موبايل (شدات UC فوري)، موبايل ليجندز، روبلوكس، EA Sports FC (فيفا سابقاً)، وكول أوف ديوتي.
   - اشتراكات: نتفليكس (شاشات وحسابات كاملة)، شاهد VIP، تود (TOD) للمباريات، سبوتيفاي بريميوم، كانفا برو، ويوتيوب بريميوم.
   - بطاقات هدايا: آبل، جوجل بلاي، بلايستيشن، إكس بوكس، بينانس، وبطاقات الفيزا الافتراضية.

قواعد الرد الاحترافية:
- **الأسعار:** أخبر المستخدم أن أسعارنا هي الأفضل والأنسب في السوق الموريتاني، وانصحه دائماً بالدخول لصفحة الخدمة في الموقع لرؤية العروض والأسعار اللحظية (لأنها تتغير وتتحسن باستمرار)، أو التواصل مع الرقم 32014902.
- **السرعة:** أكد له أن موري توب تتميز بالشحن الفوري والآلي في أغلب الخدمات، وعادة ما يستغرق الطلب من دقيقة إلى 10 دقائق فقط.
- **طريقة الطلب:** اشرح له ببساطة: "اختر الخدمة -> أدخل المعرف (ID) -> اختر المبلغ -> ادفع عبر بنكيلي أو سداد -> ارفع صورة الإشعار -> مبروك!".
- **الأمان والخصوصية:** طمئن المستخدم دائماً بأننا لا نطلب كلمات مرور (Password) إطلاقاً. الشحن يتم بأمان عبر المعرف (ID) فقط.
- **الدعم الفني:** إذا كان لدى المستخدم مشكلة في طلب قديم، اطلب منه تزويدك برقم الطلب (إن وجد) أو التواصل مباشرة مع واتساب الإدارة 32014902.

كن استباقياً وناصحاً:
- لا تكتفِ بالإجابة القصيرة، بل اقترح باقات توفيرية (مثلاً: "إذا كنت تشحن فري فاير باستمرار، أنصحك بعروض الـ 1000 جوهرة فهي توفر لك أكثر").
- إذا كان العميل متردداً، شجعه بمصداقية وأخبره عن ثقة آلاف العملاء في موري توب.
- دائماً اختم بعبارة تشجيعية أو سؤال يساعده في الخطوة القادمة.`,
          temperature: 0.7,
        },
      });

      return res.json({ text: response.text });
    } catch (err: any) {
      console.error("Error in /api/chat:", err);
      
      const fallbackText = `🤖 **مساعد موري توب**\n\nأهلاً بك! نحن هنا لمساعدتك في شحن الألعاب والاشتراكات. يرجى التواصل معنا عبر واتساب للحصول على دعم فوري ومباشر.`;

      return res.json({ 
        text: fallbackText,
        isFallback: true 
      });
    }
  });

  wss.on("connection", async (clientWs) => {
    console.log("Client connected");
    try {
      const session = await getAi().live.connect({
        model: "gemini-3.8-live",
        callbacks: {
          onmessage: (message: any) => {
            const audioParts = message.serverContent?.modelTurn?.parts || [];
            for (const part of audioParts) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
            if (message.serverContent?.interrupted)
              clientWs.send(JSON.stringify({ interrupted: true }));
          },
        },
        config: {
          responseModalities: ["AUDIO" as any],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "أنت المساعد الرقمي لمنصة 'موري توب' (Mouri Top). ساعد المستخدمين بوضوح وود في استفساراتهم المتعلقة بالخدمات الرقمية وشحن الألعاب.",
        },
      });

      clientWs.on("message", (data: any) => {
        try {
          const { audio } = JSON.parse(data.toString());
          if (audio) {
            session.sendRealtimeInput({
              audio: { data: audio, mimeType: "audio/pcm;rate=16000" },
            });
          }
        } catch (e) {
          console.error("Error processing client audio message", e);
        }
      });

      clientWs.on("close", () => {
        session.close();
      });
    } catch (e) {
      console.error("Error establishing Gemini Live session", e);
      clientWs.close();
    }
  });

  // Vite is loaded only for local development. Production and Vercel never
  // import the build tool into the request runtime.
  if (!process.env.VERCEL && process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const staticPath = process.env.VERCEL
      ? path.join(process.cwd(), "public")
      : path.join(process.cwd(), "dist");
    app.use(express.static(staticPath));
    app.get("*all", (req, res) => res.sendFile(path.join(staticPath, "index.html")));
  }

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Express] Unhandled request error:", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  });

  if (!process.env.VERCEL) {
    server.listen(PORT, "0.0.0.0", () => console.log("Server running on http://localhost:" + PORT));
  }
}

initializationPromise = startServer();
initializationPromise.catch((error) => {
  console.error("[Express] Server initialization failed:", error);
});

export default server;
