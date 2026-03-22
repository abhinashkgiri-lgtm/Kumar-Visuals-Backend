// src/controllers/orderController.js
import Joi from "joi";
import crypto from "node:crypto";
import mongoose from "mongoose";

import Order from "../models/Order.model.js";
import User from "../models/User.model.js";
import Product from "../models/Product.model.js";
import EmailTemplate from "../models/EmailTemplate.model.js";
import razorpay from "../services/razorpayClient.js";
import { sendEmail } from "../utils/mailer.js";
import { initiateRefund } from "../services/refund.service.js";

import {
  createPendingOrderForUser,
  createMembershipOrderForUser,
  markOrderPaidAndGrantAccess,
} from "../services/order.service.js";

import {
  buildOrderCompleteSubject,
  buildOrderCompleteEmailHtml,
} from "../templates/emailTemplates.js";

/* ========================= VALIDATION SCHEMAS ========================= */

const createOrderSchema = Joi.object({
  productIds: Joi.array()
    .items(Joi.string().hex().length(24))
    .min(1)
    .required(),
  currency: Joi.string().uppercase().default("INR"),
  promoCode: Joi.string().trim().uppercase().optional().allow("", null),
});

const createMembershipOrderSchema = Joi.object({
  planKey: Joi.string().trim().uppercase().required(),
  months: Joi.number().integer().min(1).default(1),
  currency: Joi.string().uppercase().default("INR"),
});

const verifySchema = Joi.object({
  orderId: Joi.string().hex().length(24).required(),
  razorpayOrderId: Joi.string().required(),
  razorpayPaymentId: Joi.string().required(),
  razorpaySignature: Joi.string().required(),
});

/* ========================= EMAIL HELPERS ========================= */

function renderTemplate(template, vars = {}) {
  if (!template) return "";

  return template.replaceAll(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const upperKey = key.toUpperCase();
    let v;
    if (vars[key] !== undefined && vars[key] !== null) {
      v = vars[key];
    } else if (vars[upperKey] !== undefined && vars[upperKey] !== null) {
      v = vars[upperKey];
    } else {
      v = "";
    }
    return String(v);
  });
}

async function getActiveTemplate(key) {
  if (!key) return null;
  const tpl = await EmailTemplate.findOne({ key }).lean();
  if (!tpl || tpl.isActive === false) return null;
  return tpl;
}

async function sendOrderCompleteEmail(orderId) {
  try {
    const order = await Order.findById(orderId)
      .populate("user", "name email")
      .populate("items.product", "title slug")
      .lean();

    if (!order || !order.user || !order.user.email) {
      console.warn(
        "[sendOrderCompleteEmail] Order or user not found for",
        orderId
      );
      return;
    }

    if (order.status !== "PAID" && order.status !== "REFUNDED") {
      return;
    }

    const realOrderId = order._id.toString();
    const orderCode = `#${realOrderId.toUpperCase()}`;
    const isMembership = !!order.membershipPlanKey;
    const orderType = isMembership ? "Membership" : "Product Purchase";
    const date = order.completedAt || order.createdAt || new Date();

    const totalStr =
      order.total?.toFixed && typeof order.total === "number"
        ? order.total.toFixed(2)
        : order.total ?? "";

    const createdAtStr = date.toLocaleString();
    const dateStr = date.toLocaleDateString();

    const vars = {
      // User details
      CUSTOMER_NAME: order.user.name || "Customer",
      CUSTOMER_EMAIL: order.user.email,
      customerName: order.user.name || "Customer",
      customerEmail: order.user.email,

      // Order details
      ORDER_ID: realOrderId,
      ORDER_CODE: orderCode,
      ORDER_TYPE: orderType,
      ORDER_STATUS: order.status,
      ORDER_CURRENCY: order.currency || "INR",
      ORDER_TOTAL: totalStr,
      ORDER_SUBTOTAL: order.subtotal ?? "",
      ORDER_TAX: order.tax ?? "",
      ORDER_PROMO_CODE: order.promoCode || "",
      ORDER_PROMO_DISCOUNT: order.promoDiscount || 0,
      ORDER_CREATED_AT: createdAtStr,
      ORDER_DATE: dateStr,

      orderId: realOrderId,
      orderCode,
      orderType,
      status: order.status,
      currency: order.currency || "INR",
      total: totalStr,
      subtotal: order.subtotal ?? "",
      tax: order.tax ?? "",
      promoCode: order.promoCode || "",
      promoDiscount: order.promoDiscount || 0,
      createdAt: createdAtStr,
      date: dateStr,

      // Membership details
      MEMBERSHIP_PLAN_KEY: order.membershipPlanKey || "",
      MEMBERSHIP_PLAN:
        order.membershipPlanName || order.membershipPlanKey || "",
      MEMBERSHIP_MONTHS: order.membershipMonths || "",
      membershipPlanKey: order.membershipPlanKey || "",
      membershipPlan: order.membershipPlanName || order.membershipPlanKey || "",
      membershipMonths: order.membershipMonths || "",
    };

    let subject;
    let html;

    try {
      let template = null;

      if (isMembership) {
        template = await getActiveTemplate("ORDER_COMPLETE_MEMBERSHIP");
        if (!template) {
          template = await getActiveTemplate("ORDER_COMPLETE");
        }
      } else {
        template = await getActiveTemplate("ORDER_COMPLETE");
      }

      if (template) {
        subject = renderTemplate(template.subjectTemplate, vars);
        html = renderTemplate(template.bodyHtml, vars);
      } else {
        subject = buildOrderCompleteSubject(vars);
        html = buildOrderCompleteEmailHtml(vars);
      }
    } catch (e) {
      console.error("[sendOrderCompleteEmail] template load error:", e);
      subject = buildOrderCompleteSubject(vars);
      html = buildOrderCompleteEmailHtml(vars);
    }

    await sendEmail({
      to: order.user.email,
      subject,
      html,
    });
  } catch (err) {
    console.error("[sendOrderCompleteEmail] failed:", err);
  }
}

/* ========================= CONTROLLERS ========================= */

/**
 * 1. CREATE PRODUCT ORDER
 * Checks User model's purchasedProducts to prevent duplicates.
 */
export const createOrder = async (req, res, next) => {
  try {
    const { error, value } = createOrderSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({ message: error.details[0].message });
    }

    const { productIds, currency, promoCode } = value;
    const authUserId = req.user?.id;

    if (!authUserId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // 1. Fetch user to check existing purchases
    const user = await User.findById(authUserId).select(
      "purchasedProducts +isDeleted"
    );

    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // 2. Filter duplicates
 
    const alreadyPurchasedProductIds = (user.purchasedProducts || []).map(
      (item) => (item.product ? item.product.toString() : item.toString())
    );

    const purchasedIdSet = new Set(alreadyPurchasedProductIds);
    const duplicateIds = productIds.filter((pid) => purchasedIdSet.has(pid));

    if (duplicateIds.length > 0) {
      const duplicates = await Product.find({ _id: { $in: duplicateIds } })
        .select("title")
        .lean();

      return res.status(400).json({
        message:
          "Duplicate purchase detected. Some items are already in your library.",
        alreadyPurchased: duplicates.map((p) => ({
          id: p._id,
          title: p.title,
        })),
      });
    }

    // 3. Create Pending Order (DB)
    const order = await createPendingOrderForUser({
      userId: user._id.toString(),
      productIds,
      currency,
      promoCode: promoCode || undefined,
    });

    // Enforce minimum payable (backend truth)
    const MIN_PAYABLE = 1;

    if (typeof order.total !== "number" || order.total < MIN_PAYABLE) {
      // IMPORTANT: cancel the pending order to avoid orphan records
      order.status = "CANCELLED";
      await order.save();

      return res.status(400).json({
        message: "Order amount too low to process payment",
      });
    }


    // 4. Create Razorpay Order
    const amountInPaise = Math.round(order.total * 100);
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: order.currency,
      receipt: order._id.toString(),
      notes: {
        orderId: order._id.toString(),
        userId: user._id.toString(),
        type: "product_purchase",
      },
    });

    // 5. Link Razorpay ID to DB Order
    order.paymentOrderId = razorpayOrder.id;
    await order.save();

    return res.status(201).json({
      orderId: order._id,
      amount: order.total,
      currency: order.currency,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      promoCode: order.promoCode,
      promoDiscount: order.promoDiscount,
    });
  } catch (err) {
    // Specific error from order.service
    if (err && err.message === "One or more products are not purchasable") {
      return res.status(400).json({
        message: err.message,
        notPurchasable: err.notPurchasable || [],
      });
    }
    next(err);
  }
};

/**
 * 2. CREATE MEMBERSHIP ORDER
 * Checks User model's membership status.
 */
export const createMembershipOrder = async (req, res, next) => {
  try {
    const { error, value } = createMembershipOrderSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({ message: error.details[0].message });
    }

    const authUserId = req.user?.id;
    const user = await User.findById(authUserId).select(
      "membership +isDeleted"
    );

    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { planKey, months, currency } = value;

    // Check if user already has THIS plan active
    if (
      user.membership &&
      user.membership.planKey === planKey &&
      user.membership.status === "ACTIVE"
    ) {
      // Optional: Check expiry date?
      // For now, blocking duplicate active plan purchase to prevent accidental double charge
      return res.status(400).json({
        message: `Your ${planKey} membership is already active.`,
      });
    }

    // 1. Create Pending Membership Order (DB)
    const order = await createMembershipOrderForUser({
      userId: user._id.toString(),
      planKey,
      months,
      currency,
    });

    // 2. Create Razorpay Order
    const amountInPaise = Math.round(order.total * 100);
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: order.currency,
      receipt: order._id.toString(),
      notes: {
        orderId: order._id.toString(),
        userId: user._id.toString(),
        type: "membership_purchase",
        plan: planKey,
      },
    });

    // 3. Link
    order.paymentOrderId = razorpayOrder.id;
    await order.save();

    return res.status(201).json({
      orderId: order._id,
      amount: order.total,
      currency: order.currency,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      membershipPlanKey: order.membershipPlanKey,
      membershipMonths: order.membershipMonths,
    });
  } catch (err) {
    next(err);
  }
};

/*
 * 3. VERIFY PAYMENT
 * Handles both Product and Membership verification via ID.
 */

export const verifyOrder = async (req, res, next) => {
  try {
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ message: "Payment verification unavailable" });
    }

    const { error, value } = verifySchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = value;
    const authUserId = req.user?.id;
    const user = await User.findById(authUserId).select("+isDeleted");

    if (!user || user.isDeleted) return res.status(401).json({ message: "Unauthorized" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // HANDLE
    if (order.status === "PAID") {
      // Check if the stored payment ID matches the incoming one
      if (order.paymentId === razorpayPaymentId) {
         return res.json({ success: true, message: "Order already verified via webhook" });
      }
      // If payment ID is different, then it's a conflict
      return res.status(400).json({ message: "Order already paid with a different payment ID" });
    }

    // STRICT STATUS GATE (Only block if NOT Pending AND NOT Paid)
    if (order.status !== "PENDING") {
      return res.status(400).json({
        message: `Order cannot be paid (status: ${order.status})`,
      });
    }


    if (order.user.toString() !== user._id.toString()) return res.status(403).json({ message: "Not your order" });
    if (order.paymentOrderId !== razorpayOrderId) return res.status(400).json({ message: "Order ID mismatch" });

    // Verify Signature
    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    // Process payment
    await markOrderPaidAndGrantAccess({
      orderId,
      paymentId: razorpayPaymentId,
      paymentSignature: razorpaySignature,
      paymentRaw: {
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        verifiedBy: "client-verify-endpoint",
      },
    });

    sendOrderCompleteEmail(orderId).catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
};



/**
 * 4. GET MY ORDERS
 */
export const getMyOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return res.json(orders);
  } catch (err) {
    next(err);
  }
};

/* ========================= MEMBERSHIP ACTIONS ========================= */

export const cancelMembership = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const user = await User.findById(userId).select("membership +isDeleted");

    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!user.membership || !user.membership.planKey) {
      return res
        .status(400)
        .json({ message: "You do not have an active membership." });
    }

    if (user.membership.status !== "ACTIVE") {
      return res.status(400).json({
        message: `Cannot cancel membership with status ${user.membership.status}.`,
      });
    }

    user.membership.status = "CANCELLED";
    await user.save();

    return res.status(200).json({
      message: "Membership cancelled. It will remain valid until expiry.",
      membership: user.membership,
    });
  } catch (err) {
    next(err);
  }
};

export const resumeMembership = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const user = await User.findById(userId).select("membership +isDeleted");

    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!user.membership || !user.membership.planKey) {
      return res
        .status(400)
        .json({ message: "No membership history found to resume." });
    }

    if (
      user.membership.status !== "CANCELLED" &&
      user.membership.status !== "EXPIRED"
    ) {
      return res.status(400).json({
        message: `Cannot resume membership from status ${user.membership.status}.`,
      });
    }

    user.membership.status = "ACTIVE";
    await user.save();

    return res.status(200).json({
      message: "Membership resumed successfully.",
      membership: user.membership,
    });
  } catch (err) {
    next(err);
  }
};

/* ========================= ADMIN CONTROLLERS ========================= */

export const adminGetOrders = async (req, res, next) => {
  try {
    const querySource = req.cleanedQuery || req.query;

    const rawQ = (querySource.search || querySource.q || querySource.term || "").toString().trim();
    const statusRaw = (querySource.status || "").toString().trim();
    const typeRaw = (querySource.type || "").toString().trim();
    const providerRaw = (querySource.paymentProvider || "").toString().trim();
    const userIdRaw = (querySource.userId || querySource.user || "").toString().trim();

    const page = Math.max(Number.parseInt(querySource.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(querySource.limit, 10) || 20, 1), 1000);
    const skip = (page - 1) * limit;

    const filter = {};

    if (userIdRaw) {
      filter.user = userIdRaw;
    }

    const allowedStatuses = ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED"];
    if (statusRaw && allowedStatuses.includes(statusRaw.toUpperCase())) {
      filter.status = statusRaw.toUpperCase();
    }

    if (typeRaw.toUpperCase() === "PRODUCT") {
      filter.membershipPlanKey = null;
    } else if (typeRaw.toUpperCase() === "MEMBERSHIP") {
      filter.membershipPlanKey = { $ne: null };
    }

    if (providerRaw) {
      filter.paymentProvider = providerRaw.toLowerCase();
    }

    const orConditions = [];
    if (rawQ) {
      const escaped = rawQ.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const regex = new RegExp(escaped, "i");

      const matchingUsers = await User.find({ email: regex }).select("_id").lean();
      const userIds = matchingUsers.map((u) => u._id);
      
      if (userIds.length) {
        orConditions.push({ user: { $in: userIds } });
      }

      orConditions.push(
        { paymentOrderId: regex },
        { paymentId: regex }
      );

      const idSearch = rawQ.replace(/^#/, "").trim();
      if (idSearch.length > 0) {
        orConditions.push({
          $expr: {
            $regexMatch: {
              input: { $toString: "$_id" },
              regex: escaped,
              options: "i",
            },
          },
        });
      }
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
    }

    const sortParam = (querySource.sort || "latest").toString();
    let sort = { createdAt: -1 };
    switch (sortParam) {
      case "oldest":
        sort = { createdAt: 1 };
        break;
      case "amount-low":
        sort = { total: 1 };
        break;
      case "amount-high":
        sort = { total: -1 };
        break;
    }

    const requiredFields = "_id user userEmail amount total status type membershipPlanKey membership createdAt";

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .select(requiredFields)
        .populate("user", "name email")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.json({
      data: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};



async function revokeOrderAccess(order) {
  if (!order.user) return;

  if (order.membershipPlanKey) {
    await User.updateOne(
      { _id: order.user },
      {
        $set: {
          "membership.status": "REFUNDED",
          "membership.expiresAt": new Date(),
        },
      }
    );
  } else {
    for (const item of order.items || []) {
      const productId =
        item.product?._id?.toString() ||
        item.product?.toString();

      if (!productId) continue;

      await User.updateOne(
        { _id: order.user },
        {
          $pull: {
            purchasedProducts: {
              product: new mongoose.Types.ObjectId(productId),
            },
          },
        }
      );
    }
  }
}

export const refundOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid order id" });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.status !== "PAID") {
      return res.status(400).json({
        message: `Refund not allowed when order status is '${order.status}'`,
      });
    }

    if (!order.paymentId) {
      return res.status(400).json({
        message: "Payment ID missing",
      });
    }

    await revokeOrderAccess(order);
    const refund = await initiateRefund(order);

    return res.json({
      message: "Refund initiated, access revoked",
      refundId: refund.id,
      orderId: order._id,
      status: order.status, 
    });
  } catch (err) {
    next(err);
  }
};



export const adminGetOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid order id" });
    }

    const order = await Order.findById(id)
      .populate("user", "name email")
      .populate("items.product", "title slug price mrp")
      .lean();

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    return res.json({ order });
  } catch (err) {
    next(err);
  }
};

export const adminGetAllOrders = adminGetOrders;