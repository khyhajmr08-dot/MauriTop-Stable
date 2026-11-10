import type { Service } from "../types";

const FALLBACK_SITE_URL = "https://mauritop-v2-4ozx.vercel.app";
function normalizeSiteUrl(value?: string): string {
  try {
    const parsed = new URL(value || FALLBACK_SITE_URL);
    if (parsed.protocol !== "https:") return FALLBACK_SITE_URL;
    return parsed.origin;
  } catch {
    return FALLBACK_SITE_URL;
  }
}

export const SITE_URL = normalizeSiteUrl(import.meta.env.VITE_PUBLIC_SITE_URL);
export const SITE_NAME = "MAURITOP";
export const SITE_LOGO = `${SITE_URL}/brand/mauritop-logo.jpg`;
export const SITE_IMAGE = `${SITE_URL}/og-image.jpg`;
export const SITE_DESCRIPTION =
  "MAURITOP منصة موريتانية لشراء وشحن الألعاب والخدمات الرقمية، مع عرض الأسعار ووسائل الدفع المتاحة بعملة MRU.";

export function getOrganizationSchema() {
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    logo: {
      "@type": "ImageObject",
      url: SITE_LOGO,
    },
    areaServed: {
      "@type": "Country",
      name: "Mauritania",
    },
  };
}

export function getWebSiteSchema() {
  return {
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: SITE_NAME,
    publisher: { "@id": `${SITE_URL}/#organization` },
    inLanguage: ["ar-MR", "fr"],
  };
}

export function getWebPageSchema(title: string, description: string, urlPath = "") {
  const path = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  const pageUrl = new URL(path, SITE_URL).toString();
  return {
    "@type": "WebPage",
    "@id": `${pageUrl}#webpage`,
    url: pageUrl,
    name: title,
    description,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    inLanguage: "ar-MR",
  };
}

export function getBreadcrumbSchema(items: Array<{ name: string; path: string }>) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${SITE_URL}/#breadcrumb`,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path.startsWith("/") ? item.path : `/${item.path}`, SITE_URL).toString(),
    })),
  };
}

export function getProductServiceSchema(service: Service) {
  const serviceUrl = new URL(`/services/${encodeURIComponent(service.id)}`, SITE_URL).toString();
  const name = service.nameAr || service.name;
  const description =
    service.descriptionAr ||
    service.description ||
    `تفاصيل خدمة ${name} وأسعارها الحالية وطرق طلبها عبر MAURITOP.`;
  const imageValue = service.imageUrl || service.image || SITE_IMAGE;
  let image = SITE_IMAGE;
  try {
    image = new URL(imageValue, SITE_URL).toString();
  } catch {
    // Keep the verified site image when a service image URL is malformed.
  }

  // Only emit an Offer when a real positive price exists in the service record.
  // Never invent a fallback price or a fabricated validity date.
  const rawPrice = service.priceMru ?? service.price;
  const numericPrice = Number(rawPrice);
  const hasActualPrice =
    rawPrice !== undefined &&
    rawPrice !== null &&
    Number.isFinite(numericPrice) &&
    numericPrice > 0;

  const product: Record<string, unknown> = {
    "@type": "Product",
    "@id": `${serviceUrl}#product`,
    name: `خدمة ${name} في موريتانيا | MAURITOP`,
    description,
    image,
    category: service.categoryAr || service.category || "خدمات رقمية",
    brand: { "@type": "Brand", name: SITE_NAME },
  };

  if (hasActualPrice) {
    product.offers = {
      "@type": "Offer",
      url: serviceUrl,
      priceCurrency: "MRU",
      price: numericPrice,
      availability:
        service.status === "inactive" || service.status === "deleted" || service.status === "متوقف"
          ? "https://schema.org/OutOfStock"
          : "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@id": `${SITE_URL}/#organization` },
    };
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      getOrganizationSchema(),
      product,
      getBreadcrumbSchema([
        { name: "الرئيسية", path: "/" },
        { name: "الخدمات", path: "/#services" },
        { name, path: `/services/${encodeURIComponent(service.id)}` },
      ]),
    ],
  };
}

export function getFAQSchema() {
  return {
    "@type": "FAQPage",
    "@id": `${SITE_URL}/#faq`,
    mainEntity: [
      {
        "@type": "Question",
        name: "كيف أطلب خدمة من MAURITOP؟",
        acceptedAnswer: {
          "@type": "Answer",
          text: "اختر الخدمة، اقرأ الحقول المطلوبة والسعر الظاهر، ثم أكمل خطوات الدفع وإرسال الطلب. يمكنك متابعة حالة الطلب من صفحة التتبع.",
        },
      },
      {
        "@type": "Question",
        name: "ما وسائل الدفع المتاحة؟",
        acceptedAnswer: {
          "@type": "Answer",
          text: "تعرض صفحة إتمام الطلب وسائل الدفع المفعّلة حاليًا، ومنها بنكيلي Bankily وسداد Sedad وغزة باي Gaza Pay عند تفعيلها.",
        },
      },
      {
        "@type": "Question",
        name: "هل أحتاج إلى كلمة مرور حساب اللعبة؟",
        acceptedAnswer: {
          "@type": "Answer",
          text: "أدخل فقط المعلومات التي يطلبها نموذج الخدمة داخل MAURITOP، ولا تشارك كلمة مرور حسابك عبر الرسائل أو قنوات غير موثوقة.",
        },
      },
      {
        "@type": "Question",
        name: "كم يستغرق تنفيذ الطلب؟",
        acceptedAnswer: {
          "@type": "Answer",
          text: "تختلف مدة المعالجة بحسب نوع الخدمة والتحقق من الدفع، وتظهر حالة الطلب في صفحة التتبع.",
        },
      },
    ],
  };
}

export function getHomepageCombinedSchema() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      getOrganizationSchema(),
      getWebSiteSchema(),
      getWebPageSchema(
        "MAURITOP | شحن الألعاب والخدمات الرقمية في موريتانيا",
        SITE_DESCRIPTION,
        "/"
      ),
      getBreadcrumbSchema([{ name: "الرئيسية", path: "/" }]),
      getFAQSchema(),
    ],
  };
}
