import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { getEmailSettings } from "../services/emailSettingsService.js";

dotenv.config();

const { EMAIL_USER, EMAIL_PASS, EMAIL_FROM, SUPPORT_EMAIL, NODE_ENV } = process.env;

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error("Email credentials missing (EMAIL_USER / EMAIL_PASS)");
  process.exit(1);
}

/**
 * Create transporter
 */
function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

const transporter = createTransporter();

/**
 * Verify transporter on startup
 */
transporter.verify((err) => {
  if (err) {
    console.error("[MAILER_INIT_ERROR]", err.message);
  } else if (NODE_ENV !== "production") {
    console.log("Email transporter ready");
  }
});

/**
 * Send email with DB-configurable fallback support email
 */
export async function sendEmail({ to, subject, html, replyTo }) {
  if (!subject) {
    throw new Error("Missing required email field (subject)");
  }

  try {
    const settings = await getEmailSettings();

    const finalTo =
      to ||
      settings?.supportEmail ||
      SUPPORT_EMAIL ||
      EMAIL_USER;

    if (!finalTo) {
      throw new Error("No recipient email configured");
    }

    const finalReplyTo =
      replyTo ||
      settings?.supportEmail ||
      SUPPORT_EMAIL ||
      undefined;

    const from = EMAIL_FROM || `Kumar Music <${EMAIL_USER}>`;

    await transporter.sendMail({
      from,
      to: finalTo,
      subject,
      html,
      ...(finalReplyTo ? { replyTo: finalReplyTo } : {}),
    });

    if (NODE_ENV !== "production") {
      console.log(`Email sent → ${finalTo}`);
    }

  } catch (err) {
    console.error("[MAILER_SEND_ERROR]", err.message);
    throw new Error("Email delivery failed");
  }
}