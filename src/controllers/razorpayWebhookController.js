import crypto from "node:crypto";
import Order from "../models/Order.model.js";
import { markOrderPaidAndGrantAccess } from "../services/order.service.js";
import { initiateRefund } from "../services/refund.service.js";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const handlePaymentEvent = async (event, payment, res) => {
  const razorpayOrderId = payment.order_id;
  const razorpayPaymentId = payment.id;

  const order = await Order.findOne({ paymentOrderId: razorpayOrderId });
  if (!order) return res.status(200).send("Order not found");

  if (order.status === "PAID" && event === "payment.captured") {
    return res.status(200).send("Already processed");
  }

  if (order.status === "CANCELLED") {
    return res.status(200).send("Order cancelled earlier");
  }

  if (event === "payment.failed") {
    if (order.status === "PENDING") {
      order.status = "FAILED";
      order.cancelReason = "PAYMENT_FAILED";
      order.paymentRaw = {
        source: "razorpay-webhook",
        event,
        payload: payment,
      };
      await order.save();
    }
    return res.status(200).send("Payment failed handled");
  }

  if (event === "payment.captured") {
    if (order.status !== "PENDING") {
      return res.status(200).send("Order not pending");
    }

    try {
      await markOrderPaidAndGrantAccess({
        orderId: order._id.toString(),
        paymentId: razorpayPaymentId || "unknown", // ⚠️ safe fallback
        paymentSignature: "razorpay-webhook",
        paymentRaw: {
          source: "razorpay-webhook",
          event,
          payload: payment,
        },
      });

      return res.status(200).send("Payment captured & delivered");
    } catch (err) {
      console.error("Delivery failed:", err);

      order.status = "FAILED";
      order.cancelReason = "SYSTEM_CANCELLED";
      await order.save();

      await initiateRefund(order);

      return res
        .status(200)
        .send("Delivery failed, refund initiated");
    }
  }
};

const handleRefundEvent = async (refund, res) => {
  const paymentId = refund.payment_id;

  const order = await Order.findOne({
    $or: [
      { paymentId },
      { "paymentRaw.razorpayPaymentId": paymentId },
      { "paymentRaw.payload.id": paymentId },
    ],
  });

  if (!order) {
    console.warn("Refund webhook: order not found", paymentId);
    return res.status(200).send("Order not found");
  }

  if (order.status === "REFUNDED") {
    return res.status(200).send("Already refunded");
  }

  if (order.status !== "PAID") {
    return res.status(200).send("Refund ignored");
  }

  order.status = "REFUNDED";
  order.paymentRaw = {
    ...(order.paymentRaw || {}),
    refundCompletedAt: new Date(),
    refund,
  };

  await order.save();

  return res.status(200).send("Refund completed (status updated)");
};

export const razorpayWebhookHandler = async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) {
      console.error("Webhook secret missing");
      return res.status(500).send("Webhook not configured");
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return res.status(400).send("Signature missing");
    }

    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body);

    const expectedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.warn("Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const payload = JSON.parse(body.toString("utf8"));
    const event = payload.event;

    /* ================= PAYMENT EVENTS ================= */

    if (event === "payment.captured" || event === "payment.failed") {
      const payment = payload?.payload?.payment?.entity;
      if (!payment) return res.status(200).send("Invalid payment payload");

      return handlePaymentEvent(event, payment, res);
    }

    /* ================= ORDER EVENTS (NEW) ================= */

    if (event === "order.paid") {
      const razorpayOrder = payload?.payload?.order?.entity;

      if (!razorpayOrder) {
        return res.status(200).send("Invalid order payload");
      }

      const order = await Order.findOne({
        paymentOrderId: razorpayOrder.id,
      });

      if (!order || order.status === "PAID") {
        return res.status(200).send("Ignored");
      }

      return handlePaymentEvent(
        "payment.captured",
        {
          id: razorpayOrder.payment_id || "unknown",
          order_id: razorpayOrder.id,
        },
        res
      );
    }

    /* ================= REFUND EVENTS ================= */

    if (event === "refund.processed") {
      const refund = payload?.payload?.refund?.entity;
      if (!refund) return res.status(200).send("Invalid refund payload");

      return handleRefundEvent(refund, res);
    }

    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("Webhook fatal error:", err);
    return res.status(500).send("Internal error");
  }
};