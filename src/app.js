// app.js
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import dotenv from "dotenv";
import compression from "compression";

import routes from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { razorpayWebhookHandler } from "./controllers/razorpayWebhookController.js";
import "./controllers/autoCancelController.js";

dotenv.config();

const app = express();
const RAZORPAY_WEBHOOK_PATH = "/api/orders/razorpay/webhook";

// ============================================================
// TRUST PROXY (NGINX / LOAD BALANCER)
// ============================================================
app.set("trust proxy", 1);

// ============================================================
// SECURITY HEADERS
// ============================================================
app.use(
  helmet({
    crossOriginOpenerPolicy: {
      policy: "same-origin-allow-popups",
    },
  })
);



// ============================================================
// RAW BODY FOR RAZORPAY WEBHOOK (MUST BE FIRST)
// ============================================================
app.post(
  RAZORPAY_WEBHOOK_PATH,
  express.raw({ type: "application/json" }),
  razorpayWebhookHandler
);


const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server, nginx errors, postman, curl
      if (!origin) return callback(null, true);

      // Allow known frontends
      if (ALLOWED_ORIGINS.has(origin)) {
        return callback(null, true);
      }

      // IMPORTANT:
      // Still allow so browser receives CORS headers
      // Authorization handled later
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH","PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Secret"],
  })
);



// ============================================================
// BLOCK NON-FRONTEND CLIENTS (AUTH GUARD)
// ============================================================
const API_CLIENT_SECRET = process.env.API_CLIENT_SECRET;

app.use((req, res, next) => {
  // ALWAYS allow preflight
  if (req.method === "OPTIONS") return next();

  if (req.path === RAZORPAY_WEBHOOK_PATH) return next();

  const origin = req.headers.origin;
  const clientSecret = req.headers["x-api-secret"];

  const isFrontend = origin && ALLOWED_ORIGINS.has(origin);
  const hasSecret = API_CLIENT_SECRET && clientSecret === API_CLIENT_SECRET;

  if (isFrontend || hasSecret) return next();

  return res.status(403).json({ message: "Forbidden" });
});


// ============================================================
// COMPRESSION (SAFE CONFIG)
// ============================================================
function shouldCompress(req, res) {
  const ct = String(res.getHeader?.("Content-Type") || "").toLowerCase();

  // Skip binary/media
  if (
    /^audio\/|^video\/|^image\/|application\/zip|application\/gzip|application\/octet-stream/.test(
      ct
    )
  ) {
    return false;
  }

  // Skip uploads completely
  if (req.path && req.path.includes("/uploads")) {
    return false;
  }

  return compression.filter(req, res);
}

app.use(
  compression({
    threshold: 1024,
    filter: shouldCompress,
  })
);

// ============================================================
// RATE LIMITING
// ============================================================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

// app.use("/api/auth/login", loginLimiter); comment out after test
app.use("/api/auth/register", registerLimiter);
app.use("/api", apiLimiter);

// ============================================================
// BODY PARSING (IMPORTANT: LIMITS)
// ============================================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ============================================================
// XSS SANITIZATION
// ============================================================
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

function sanitizeRecursively(value) {
  if (value == null) return value;
  if (typeof value === "string") return DOMPurify.sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeRecursively);
  if (typeof value === "object" && !Buffer.isBuffer(value)) {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = sanitizeRecursively(value[k]);
    }
    return out;
  }
  return value;
}

app.use((req, res, next) => {
  if (req.path === RAZORPAY_WEBHOOK_PATH) return next();
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    req.body = sanitizeRecursively(req.body);
  }
  next();
});

// ============================================================
// NOSQL INJECTION SANITIZE
// ============================================================
app.use((req, res, next) => {
  if (req.path === RAZORPAY_WEBHOOK_PATH) return next();

  if (req.body && !Buffer.isBuffer(req.body)) {
    req.body = mongoSanitize.sanitize(req.body);
  }
  if (req.params) req.params = mongoSanitize.sanitize(req.params);

  req.cleanedQuery =
    req.query && typeof req.query === "object"
      ? sanitizeRecursively(req.query)
      : {};

  next();
});

// ============================================================
// CACHE CONTROL FOR PUBLIC PRODUCTS
// ============================================================
app.use((req, res, next) => {
  if (req.method === "GET" && req.path.startsWith("/api/products")) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=30"
    );
  }
  next();
});

// ============================================================
// ROUTES
// ============================================================
app.use("/api", routes);

// ============================================================
// 404
// ============================================================
app.use((req, res) => {
  res.status(404).json({ message: "Not Found" });
});

// ============================================================
// ERROR HANDLER (MUST SET CORS HEADERS)
// ============================================================
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  errorHandler(err, req, res, next);
});

export default app;
