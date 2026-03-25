import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

/* =========================
   ORDER ITEM SNAPSHOT
   ========================= */

const orderItemSchema = new Schema(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    titleSnapshot: {
      type: String,
      required: true,
    },

    priceSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },

    mrpSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },

    currencySnapshot: {
      type: String,
      required: true,
    },

    discountPercentSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

/* =========================
   ORDER SCHEMA
   ========================= */

const orderSchema = new Schema(
  {
    /* ---------- USER ---------- */
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /* ---------- ITEMS / MEMBERSHIP ---------- */
    items: {
      type: [orderItemSchema],
      validate: {
        validator: function (v) {
          const hasItems = Array.isArray(v) && v.length > 0;
          const hasMembership = !!this.membershipPlanKey;
          return hasItems || hasMembership;
        },
        message: "Order must have at least one product OR a membership plan",
      },
    },

    membershipPlanKey: {
      type: String,
      default: null,
      index: true,
    },

    membershipMonths: {
      type: Number,
      default: 1,
      min: 1,
    },

    /* ---------- AMOUNTS ---------- */
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
    },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    tax: {
      type: Number,
      default: 0,
      min: 0,
    },

    
    convenienceFee: {
    type: Number,
    default: 0,
    min: 0,
  },

    total: {
      type: Number,
      required: true,
      min: 0,
    },

        /* ---------- STATUS ---------- Added "PROCESSING"*/
        status: {
          type: String,
          enum: ["PENDING","PROCESSING", "PAID", "FAILED", "CANCELLED","REFUND_INITIATED", "REFUNDED"],
          default: "PENDING",
          index: true,
        },
    /* ---------- PAYMENT STATE ---------- */
    paymentStatus: {
      type: String,
      enum: ["CREATED", "CAPTURED", "FAILED", "REFUNDED"],
      default: "CREATED",
      index: true,
    },

    /* ---------- DELIVERY STATE ---------- */
    deliveryStatus: {
      type: String,
      enum: ["PENDING", "DELIVERED", "FAILED"],
      default: "PENDING",
      index: true,
    },

    cancelReason: {
      type: String,
      enum: [
        "PAYMENT_TIMEOUT",
        "MIN_PAYABLE_VIOLATION",
        "USER_CANCELLED",
        "ADMIN_CANCELLED",
        "SYSTEM_CANCELLED",
      ],
      default: null,
    },

    /* ---------- PAYMENT ---------- */
    paymentProvider: {
      type: String,
      enum: ["razorpay", "stripe", "paypal", "manual", "test"],
      default: "razorpay",
    },

    paymentOrderId: {
      type: String,
      index: true,
    },

    paymentId: {
      type: String,
      index: true,
    },

    paymentSignature: {
      type: String,
    },

    paymentIntentId: {
      type: String,
      index: true,
    },

    paymentRaw: Schema.Types.Mixed,

    /* ---------- PROMO ---------- */
    promoCode: {
      type: String,
      default: null,
    },

    promoDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    /* ---------- META ---------- */
    metadata: Schema.Types.Mixed,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

/* =========================
   INDEXES (IMPORTANT)
   ========================= */

// User order history
orderSchema.index({ user: 1, status: 1, createdAt: -1 });

// CRON OPTIMIZATION (auto-cancel pending orders)
orderSchema.index({ status: 1, createdAt: 1 });

const Order = models.Order || model("Order", orderSchema);
export default Order;
