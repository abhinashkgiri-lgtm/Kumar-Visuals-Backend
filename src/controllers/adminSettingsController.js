import Joi from "joi";
import SiteSettings from "../models/SiteSettings.model.js";
import { deleteObjectWithVerify } from "../services/s3Service.js";

const faqSchema = Joi.object({
  question: Joi.string().trim().required(),
  answer: Joi.string().trim().required(),
});

const socialLinksSchema = Joi.object({
  facebook: Joi.string().uri().allow("", null),
  instagram: Joi.string().uri().allow("", null),
  twitter: Joi.string().uri().allow("", null),
  youtube: Joi.string().uri().allow("", null),
  tiktok: Joi.string().uri().allow("", null),
  soundcloud: Joi.string().uri().allow("", null),
  spotify: Joi.string().uri().allow("", null),
}).optional();

const sectionHeaderSchema = Joi.object({
  badge: Joi.string().trim().allow("", null),
  title: Joi.string().trim().allow("", null),
  subtitle: Joi.string().trim().allow("", null),
}).optional();

const homepageBannerSchema = Joi.object({
  title: Joi.string().trim().allow("", null),
  subtitle: Joi.string().trim().allow("", null),
  description: Joi.string().trim().allow("", null),
  imageUrl: Joi.string().uri().allow("", null),
  ctaText: Joi.string().trim().allow("", null),
  ctaLink: Joi.string().allow("", null),
});

const discountBannerSchema = Joi.object({
  enabled: Joi.boolean().default(false),
  imageUrl: Joi.string().uri().allow("", null),
  title: Joi.string().trim().allow("", null),
  subtitle: Joi.string().trim().allow("", null),
  ctaText: Joi.string().trim().allow("", null),
  ctaLink: Joi.string().allow("", null),
}).optional();

const testimonialSchema = Joi.object({
  name: Joi.string().trim().allow("", null),
  role: Joi.string().trim().allow("", null),
  message: Joi.string().trim().allow("", null),
  avatarUrl: Joi.string().uri().allow("", null),
});

const siteSettingsSchema = Joi.object({
  maintenanceMode: Joi.boolean().optional(),
  allowSignup: Joi.boolean().optional(),

  contactEmail: Joi.string().email().allow("", null),
  supportEmail: Joi.string().email().allow("", null),

  maxUploadSize: Joi.number().min(1).max(500).optional(),

  addressLine1: Joi.string().trim().allow("", null),
  addressLine2: Joi.string().trim().allow("", null),
  city: Joi.string().trim().allow("", null),
  state: Joi.string().trim().allow("", null),
  country: Joi.string().trim().allow("", null),
  postalCode: Joi.string().trim().allow("", null),
  phonePrimary: Joi.string().trim().allow("", null),
  phoneSecondary: Joi.string().trim().allow("", null),

  aboutKumar: Joi.string().allow("", null),

  logoUrl: Joi.string().uri().allow("", null),
  faviconUrl: Joi.string().uri().allow("", null),
  brandName: Joi.string().trim().allow("", null),

  shopHeader: sectionHeaderSchema,
  philosophyHeader: sectionHeaderSchema,

  footerDescription: Joi.string().trim().allow("", null),
  footerCopyright: Joi.string().trim().allow("", null),

  socialLinks: socialLinksSchema,

  faqs: Joi.array().items(faqSchema).max(50).optional(),

  testimonials: Joi.array().items(testimonialSchema).optional(),
  homepageBanner: homepageBannerSchema.optional(),

  discountBanner: discountBannerSchema,
});

function extractFrontendKey(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;

  if (urlOrKey.startsWith("frontend/")) return urlOrKey;

  try {
    const parsed = new URL(urlOrKey);
    const path = (parsed.pathname || "").replace(/^\/+/, "");
    if (path) return path;
  } catch {}

  const bucket = process.env.S3_BUCKET_NAME;
  if (bucket) {
    const idx = urlOrKey.indexOf(`${bucket}/`);
    if (idx !== -1) {
      return urlOrKey.slice(idx + bucket.length + 1);
    }
  }

  return null;
}

function runS3Cleanup(items) {
  if (!Array.isArray(items) || items.length === 0) return;

  setImmediate(async () => {
    try {
      const tasks = items.map((item) =>
        deleteObjectWithVerify(item.key, {
          retries: 3,
          backoffMs: 300,
        }).then(
          (result) => ({ status: "fulfilled", item, result }),
          (error) => ({ status: "rejected", item, error })
        )
      );

      const results = await Promise.all(tasks);

      for (const r of results) {
        if (r.status === "fulfilled" && !r.result?.success) {
          console.error(
            "[SITE_SETTINGS] cleanup failed",
            r.item.field,
            r.item.key,
            r.result?.error
          );
        }

        if (r.status === "rejected") {
          console.error(
            "[SITE_SETTINGS] cleanup crashed",
            r.item.field,
            r.item.key,
            r.error
          );
        }
      }
    } catch (err) {
      console.error("[SITE_SETTINGS] cleanup fatal error", err);
    }
  });
}

export const getSiteSettings = async (req, res, next) => {
  try {
    const doc = await SiteSettings.getSingleton();
    return res.json({ settings: doc });
  } catch (err) {
    next(err);
  }
};

export const updateSiteSettings = async (req, res, next) => {
  try {
    const { error, value } = siteSettingsSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        details: error.details.map((d) => d.message),
      });
    }

    const doc = await SiteSettings.getSingleton();

    const prevLogoUrl = doc.logoUrl;
    const prevFaviconUrl = doc.faviconUrl;
    const prevBannerUrl = doc.discountBanner?.imageUrl;

    Object.assign(doc, value);
    await doc.save();

    const keysToDelete = [];

    if (prevLogoUrl && prevLogoUrl !== doc.logoUrl) {
      const key = extractFrontendKey(prevLogoUrl);
      if (key) keysToDelete.push({ key, field: "logoUrl" });
    }

    if (prevFaviconUrl && prevFaviconUrl !== doc.faviconUrl) {
      const key = extractFrontendKey(prevFaviconUrl);
      if (key) keysToDelete.push({ key, field: "faviconUrl" });
    }

    if (prevBannerUrl && prevBannerUrl !== doc.discountBanner?.imageUrl) {
      const key = extractFrontendKey(prevBannerUrl);
      if (key) keysToDelete.push({
        key,
        field: "discountBanner.imageUrl",
      });
    }

    runS3Cleanup(keysToDelete);

    return res.json({
      message: "Settings updated",
      settings: doc,
    });
  } catch (err) {
    next(err);
  }
};