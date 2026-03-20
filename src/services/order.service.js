import mongoose from "mongoose";
import Order from "../models/Order.model.js";
import Product from "../models/Product.model.js";
import User from "../models/User.model.js";
import PromoCode from "../models/PromoCode.model.js";
import MembershipPlan from "../models/MembershipPlan.model.js";

const PROMO_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;



export async function getMembershipMeta(planKey) {
  if (!planKey || typeof planKey !== "string") return null;

  const key = planKey.trim().toUpperCase();

  try {
    const plan = await MembershipPlan.findOne({
      key,
      isActive: true,
    }).lean();

    if (!plan) return null;

    return {
      key: plan.key,
      name: plan.name,
      price: plan.price,
      currency: plan.currency || "INR",
      maxDownloadsPerMonth: typeof plan.maxDownloadsPerMonth === "number" 
        ? plan.maxDownloadsPerMonth 
        : null,
      allowedFormats: Array.isArray(plan.allowedFormats) ? plan.allowedFormats : [],
      commercialUse: Boolean(plan.commercialUse),
      remixRequestsPerMonth: typeof plan.remixRequestsPerMonth === "number"
        ? plan.remixRequestsPerMonth
        : 0,
      tier: plan.key,
    };
  } catch (error) {
    console.error("Error fetching membership meta:", error);
    return null;
  }
}

export async function getActiveMembership(user) {
  if (!user || !user.membership) {
    return { planKey: null, meta: null };
  }

  if (user.isDeleted === true) {
    return { planKey: null, meta: null };
  }

  const { planKey, status, expiresAt } = user.membership;

  if (!planKey || status !== "ACTIVE" || !expiresAt) {
    return { planKey: null, meta: null };
  }

  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  
  if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
    return { planKey: null, meta: null };
  }

  const meta = await getMembershipMeta(planKey);
  if (!meta) {
    return { planKey: null, meta: null };
  }

  return { planKey, meta };
}

function validateProductIds(productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new Error("Products array is required");
  }

  if (productIds.length > 50) {
    throw new Error("Maximum 50 products per order");
  }

  return [...new Set(productIds.map((id) => id.toString()))];
}

async function fetchUserSecurely(userId) {
  const user = await User.findById(userId)
    .select("+isDeleted +isBanned purchasedProducts");

  if (!user || user.isDeleted) {
    throw new Error("User not found");
  }

  if (user.isBanned) {
    throw new Error("Account suspended");
  }

  return user;
}

function checkDuplicatePurchases(user, productIds) {
  const owned = Array.isArray(user.purchasedProducts)
    ? user.purchasedProducts
        .map((item) => item.product?.toString())
        .filter(Boolean)
    : [];

  const ownedSet = new Set(owned);
  return productIds.filter((id) => ownedSet.has(id));
}

async function fetchProductDetails(productIds) {
  const objectIds = [];
  const slugs = [];

  productIds.forEach((id) => {
    if (mongoose.Types.ObjectId.isValid(id)) {
      objectIds.push(new mongoose.Types.ObjectId(id));
    } else {
      slugs.push(id);
    }
  });

  const query = {
    visibility: "public",
    $or: []
  };

  if (objectIds.length > 0) {
    query.$or.push({ _id: { $in: objectIds } });
  }
  if (slugs.length > 0) {
    query.$or.push({ slug: { $in: slugs } });
  }

  if (query.$or.length === 0) {
    throw new Error("No valid product identifiers");
  }

  return Product.find(query).lean();
}

function validateProducts(products, requestedIds) {
  if (products.length !== requestedIds.length) {
    const found = new Set([
      ...products.map((p) => p._id.toString()),
      ...products.map((p) => p.slug)
    ]);

    const missing = requestedIds.filter((id) => !found.has(id));
    
    const formatted = missing.map((id) => ({ 
      id, 
      title: "Product not available" 
    }));

    const error = new Error("Some products are unavailable");
    error.notPurchasable = formatted;
    throw error;
  }

  products.forEach((product) => {
    if (typeof product.price !== "number" || product.price < 0) {
      throw new Error("Invalid product pricing");
    }
  });
}

function calculateOrderTotals(products, currency) {
  const mismatch = products.find((p) => p.currency && p.currency !== currency);
  if (mismatch) {
    throw new Error(`Currency mismatch: expected ${currency}, found ${mismatch.currency}`);
  }

  const subtotal = products.reduce((sum, p) => sum + p.price, 0);
  const tax = 0;

  return {
    subtotal: Number(subtotal.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    total: Number((subtotal + tax).toFixed(2))
  };
}

async function applyPromoCode(promoCode, subtotal) {
  if (!promoCode) {
    return { discount: 0, code: null };
  }

  const code = promoCode.trim().toUpperCase();

  // DO NOT use lean() here — we need schema methods
  let promo = await PromoCode.findOne({ code, isActive: true });

  if (!promo) {
    throw new Error("Invalid or expired promo code");
  }

  // check expiry + usage limit using model method
  if (promo.isExpired()) {
    throw new Error("Promo code has expired or usage limit reached");
  }

  // check minimum order amount
  if (promo.minOrderAmount && subtotal < promo.minOrderAmount) {
    throw new Error(`Minimum order amount: ₹${promo.minOrderAmount}`);
  }

  // compute discount using schema method
  let discount = promo.computeDiscount(subtotal);

  // safety clamp
  discount = Math.min(discount, subtotal);
  discount = Number(discount.toFixed(2));

  if (discount <= 0) {
    throw new Error("Promo code cannot be applied");
  }

  return { discount, code };
}

function prepareOrderItems(products, currency) {
  return products.map((product) => ({
    product: product._id,
    titleSnapshot: product.title,
    priceSnapshot: product.price,
    mrpSnapshot: product.mrp || product.price,
    currencySnapshot: product.currency || currency,
    discountPercentSnapshot: product.mrp && product.mrp > product.price
      ? Math.round(((product.mrp - product.price) / product.mrp) * 100)
      : 0,
  }));
}

export async function createPendingOrderForUser({
  userId,
  productIds,
  currency = "INR",
  promoCode,
}) {
  const uniqueIds = validateProductIds(productIds);
  const user = await fetchUserSecurely(userId);

  const duplicates = checkDuplicatePurchases(user, uniqueIds);
  
  if (duplicates.length > 0) {
    const products = await Product.find({ _id: { $in: duplicates } })
      .select("title")
      .lean();

    const formatted = products.map((p) => ({
      id: p._id.toString(),
      title: p.title,
    }));

    if (formatted.length === 0) {
      duplicates.forEach((id) => formatted.push({ 
        id, 
        title: "Already owned" 
      }));
    }

    const error = new Error("Items already purchased");
    error.alreadyPurchased = formatted;
    throw error;
  }

  const products = await fetchProductDetails(uniqueIds);
  validateProducts(products, uniqueIds);

  const { subtotal, tax, total: baseTotal } = calculateOrderTotals(products, currency);
  const { discount, code } = await applyPromoCode(promoCode, subtotal);

  let total = Number((baseTotal - discount).toFixed(2));
  let convenienceFee = 0;

  if (total <= 0) {
    convenienceFee = 1;
    total = 1;
  }

  const finalTotal = Number((Math.max(0, subtotal + tax - discount) + convenienceFee).toFixed(2));

  if (Math.abs(finalTotal - total) > 0.01) {
    throw new Error("Order calculation mismatch");
  }

  const items = prepareOrderItems(products, currency);

  return Order.create({
    user: userId,
    items,
    currency,
    subtotal,
    tax,
    total,
    convenienceFee,
    status: "PENDING",
    paymentProvider: "razorpay",
    promoCode: code,
    promoDiscount: discount,
  });
}

export async function createMembershipOrderForUser({
  userId,
  planKey,
  months = 1,
  currency = "INR",
}) {
  const user = await fetchUserSecurely(userId);

  const key = planKey.trim().toUpperCase();
  const plan = await MembershipPlan.findOne({ key, isActive: true }).lean();

  if (!plan) {
    throw new Error("Membership plan not found");
  }

  const duration = Math.max(1, Math.min(months, 12));
  const subtotal = Number((plan.price * duration).toFixed(2));
  const tax = 0;
  const total = Number((subtotal + tax).toFixed(2));

  return Order.create({
    user: userId,
    items: [],
    currency: currency || plan.currency || "INR",
    subtotal,
    tax,
    convenienceFee: 0,
    total,
    status: "PENDING",
    paymentProvider: "razorpay",
    membershipPlanKey: key,
    membershipMonths: duration,
  });
}

async function updatePromoUsage(promoCode, session) {
  const result = await PromoCode.updateOne(
    {
      code: promoCode,
      isActive: true,
      $or: [
        { usageLimit: null },
        { usageLimit: 0 },
        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
      ],
    },
    { $inc: { usedCount: 1 } },
    { session }
  );

  if (result.modifiedCount !== 1) {
    throw new Error("Promo code usage limit exceeded");
  }

  PROMO_CACHE.delete(promoCode);
}

async function activateMembership(order, user, session) {
  const now = new Date();
  const current = user.membership || {};
  
  const currentExpiry = current.expiresAt instanceof Date 
    ? current.expiresAt 
    : current.expiresAt 
      ? new Date(current.expiresAt) 
      : null;

  const isActive = current.status === "ACTIVE" 
    && currentExpiry 
    && currentExpiry > now 
    && current.planKey === order.membershipPlanKey;

  if (!isActive) {
    user.membershipUsage = {
      periodStart: now,
      downloadsUsed: 0,
      remixRequestsUsed: 0,
    };
  }

  const baseDate = isActive ? currentExpiry : now;
  const expiresAt = new Date(baseDate);
  expiresAt.setMonth(expiresAt.getMonth() + (order.membershipMonths || 1));

  user.membership = {
    planKey: order.membershipPlanKey,
    status: "ACTIVE",
    startedAt: isActive ? current.startedAt : now,
    expiresAt,
  };

  user.markModified("membership");
  user.markModified("membershipUsage");
  
  await user.save({ session });
}

async function grantProductAccess(order, user, session) {
  const productIds = order.items
    .map((item) => item.product?.toString())
    .filter(Boolean);

  if (productIds.length === 0) return;

  const existing = new Set(
    (user.purchasedProducts || []).map((p) => p.product?.toString())
  );

  const newPurchases = productIds
    .filter((id) => !existing.has(id))
    .map((id) => ({
      product: id,
      purchasedAt: new Date(),
      source: "order",
    }));

  if (newPurchases.length > 0) {
    user.purchasedProducts.push(...newPurchases);
    user.markModified("purchasedProducts");
    await user.save({ session });
  }
}

export async function markOrderPaidAndGrantAccess({
  orderId,
  paymentId,
  paymentSignature,
  paymentRaw,
}) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new Error("Invalid order ID");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId).session(session);
    
    if (!order) {
      throw new Error("Order not found");
    }

    if (order.status === "PAID") {
      await session.commitTransaction();
      return order;
    }

    if (order.status !== "PENDING") {
      throw new Error(`Cannot process order with status: ${order.status}`);
    }

    order.status = "PAID";
    order.paymentId = paymentId;
    order.paymentSignature = paymentSignature;
    order.paymentRaw = paymentRaw;
    order.completedAt = new Date();

    await order.save({ session });

    if (order.promoCode) {
      await updatePromoUsage(order.promoCode, session);
    }

    const user = await User.findById(order.user)
      .select("+isDeleted +isBanned purchasedProducts membership membershipUsage")
      .session(session);

    if (!user || user.isDeleted || user.isBanned) {
      throw new Error("Invalid user state");
    }

    if (order.membershipPlanKey) {
      await activateMembership(order, user, session);
    } else {
      await grantProductAccess(order, user, session);
    }

    await session.commitTransaction();
    return order;

  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

export async function userHasPurchasedProduct({ userId, productId }) {
  if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(productId)) {
    return false;
  }

  try {
    const count = await Order.countDocuments({
      user: userId,
      status: "PAID",
      "items.product": productId,
    });

    return count > 0;
  } catch (error) {
    console.error("Error checking purchase:", error);
    return false;
  }
}