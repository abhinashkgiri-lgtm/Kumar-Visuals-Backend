import HomePageSetting from "../models/Home.model.js";
import Joi from "joi";
import {
  createUploadUrl,
  generateFrontendKey,
  publicUrlFromKey,
  deleteObjectWithVerify,
} from "../services/s3Service.js";

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "image/svg+xml",
]);

const relativePathSchema = Joi.string()
  .pattern(/^\/[^\s]*$/)
  .allow("", null);

const heroStatSchema = Joi.object({
  label: Joi.string().required(),
  value: Joi.string().required(),
  icon: Joi.string().allow("", null),
});

const heroSectionSchema = Joi.object({
  title: Joi.string().required(),
  subtitle: Joi.string().required(),
  primaryButtonText: Joi.string().allow("", null),
  primaryButtonLink: relativePathSchema,
  secondaryButtonText: Joi.string().allow("", null),
  secondaryButtonLink: relativePathSchema,
  backgroundImageUrl: Joi.string().allow("", null),
  tags: Joi.array().items(Joi.string()).default([]),
  stats: Joi.array().items(heroStatSchema).default([]),
}).required();

const categorySchema = Joi.object({
  name: Joi.string().required(),
  slug: Joi.string().required(),
  icon: Joi.string().allow("", null),
  isActive: Joi.boolean().default(true),
});

const sectionHeaderSchema = Joi.object({
  title: Joi.string().allow("", null),
  subtitle: Joi.string().allow("", null),
});

const testimonialSchema = Joi.object({
  name: Joi.string().required(),
  role: Joi.string().allow("", null),
  avatarUrl: Joi.string().allow("", null),
  rating: Joi.number().min(1).max(5).default(5),
  quote: Joi.string().required(),
  isActive: Joi.boolean().default(true),
});

const whyChooseItemSchema = Joi.object({
  icon: Joi.string().allow("", null),
  title: Joi.string().required(),
  description: Joi.string().required(),
  isActive: Joi.boolean().default(true),
});

const megaBundleSchema = Joi.object({
  isEnabled: Joi.boolean().default(false),

  badgeText: Joi.string().allow("", null),

  title: Joi.when("isEnabled", {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string().allow("", null),
  }),

  subtitle: Joi.string().allow("", null),
  description: Joi.string().allow("", null),

  playlistsCount: Joi.number().allow(null),
  discountPercent: Joi.number().allow(null),

  price: Joi.number().allow(null),
  originalPrice: Joi.number().allow(null),

  currency: Joi.string().default("INR"),

  ctaText: Joi.string().allow("", null),
  ctaLink: relativePathSchema,

  releaseDate: Joi.date().allow(null),
}).required();

const homePageSettingsSchema = Joi.object({
  hero: heroSectionSchema,
  categories: Joi.array().items(categorySchema).default([]),

  testimonialsEnabled: Joi.boolean().default(true),
  testimonialsHeader: sectionHeaderSchema.default({
    title: "Trusted By Producers",
    subtitle: "Success stories from our global community",
  }),
  testimonials: Joi.array().items(testimonialSchema).default([]),

  whyChooseEnabled: Joi.boolean().default(true),
  whyChooseHeader: sectionHeaderSchema.default({
    title: "Why Kumar Visuals",
    subtitle: "",
  }),
  whyChoose: Joi.array().items(whyChooseItemSchema).default([]),

  megaBundle: megaBundleSchema,
});

export const getFrontendImageUploadUrl = async (req, res, next) => {
  try {
    const schema = Joi.object({
      section: Joi.string()
        .valid("logo", "favicon", "hero", "banner", "other")
        .default("other"),
      filename: Joi.string().min(1).required(),
      contentType: Joi.string().required(),
    });

    const { error, value } = schema.validate(req.body, {
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: error.details[0].message,
      });
    }

    const { section, filename, contentType } = value;

    if (!IMAGE_MIMES.has(contentType)) {
      return res.status(400).json({
        message:
          "Invalid image type (PNG, JPEG, WEBP, SVG, ICO allowed)",
      });
    }

    const key = generateFrontendKey({ filename, section });

    const { uploadUrl, expiresIn } = await createUploadUrl({
      key,
      contentType,
    });

    const publicUrl = publicUrlFromKey(key);

    return res.status(200).json({
      uploadUrl,
      key,
      publicUrl,
      expiresIn,
    });
  } catch (err) {
    next(err);
  }
};

export const getHomePageSettings = async (req, res, next) => {
  try {
    const settings = await HomePageSetting.findOne().lean();
    return res.status(200).json(settings || {});
  } catch (err) {
    next(err);
  }
};

export const saveHomePageSettings = async (req, res, next) => {
  try {
    const previous = await HomePageSetting.findOne().lean();
    const incoming = req.body || {};

    applyDisabledSectionFallbacks(previous, incoming);

    const { error, value } = homePageSettingsSchema.validate(incoming, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        details: error.details.map((d) => d.message),
      });
    }

    if (value._id) delete value._id;

    const settings = await HomePageSetting.findOneAndUpdate(
      {},
      value,
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    scheduleFrontendCleanup(previous, settings);

    return res.status(200).json(settings);
  } catch (err) {
    next(err);
  }
};

function applyDisabledSectionFallbacks(previous, incoming) {
  if (!previous) return;

  if (incoming.testimonialsEnabled === false) {
    incoming.testimonials = previous.testimonials || [];
    incoming.testimonialsHeader =
      previous.testimonialsHeader;
  }

  if (incoming.whyChooseEnabled === false) {
    incoming.whyChoose = previous.whyChoose || [];
    incoming.whyChooseHeader =
      previous.whyChooseHeader;
  }

  if (incoming.megaBundle && incoming.megaBundle.isEnabled === false) {
    incoming.megaBundle = {
      ...(previous.megaBundle || {}),
      isEnabled: false,
    };
  }
}

async function scheduleFrontendCleanup(previous, settings) {
  const keysToDelete = [];

  if (
    previous?.hero?.backgroundImageUrl &&
    settings.hero?.backgroundImageUrl &&
    previous.hero.backgroundImageUrl !==
      settings.hero.backgroundImageUrl
  ) {
    const key = extractFrontendKey(
      previous.hero.backgroundImageUrl
    );
    if (key) keysToDelete.push(key);
  }

  for (const key of keysToDelete) {
    await deleteObjectWithVerify(key);
  }
}

function extractFrontendKey(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== "string")
    return null;

  try {
    if (
      urlOrKey.includes("amazonaws.com") ||
      urlOrKey.startsWith("http")
    ) {
      const u = new URL(urlOrKey);
      return u.pathname.replace(/^\/+/, "");
    }
  } catch {}

  return urlOrKey.startsWith("frontend/")
    ? urlOrKey
    : null;
}