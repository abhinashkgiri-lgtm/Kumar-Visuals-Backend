import Order from "../models/Order.model.js";
import User from "../models/User.model.js";


function parseDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @param {Object} query
 * @returns {{ from: Date, to: Date, prevFrom: Date, prevTo: Date }}
 */
function getPeriodFromQuery(query = {}) {
  const now = new Date();

  let from = parseDateOrNull(query.from);
  let to = parseDateOrNull(query.to);

  if (!from && !to) {
    to = now;
    from = new Date(now.getTime() - 29 * 86400000);
  } else if (from && !to) {
    to = now;
  } else if (!from && to) {
    from = new Date(to.getTime() - 29 * 86400000);
  }

  // Absolute fallback safety
  if (!from || !to) {
    to = now;
    from = new Date(now.getTime() - 29 * 86400000);
  }

  // Normalize end-of-day for inclusive range
  to.setHours(23, 59, 59, 999);

  const spanMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);

  return { from, to, prevFrom, prevTo };
}

/* =========================================================
   UTIL
   ========================================================= */

/**
 * Safe numeric coercion.
 */
function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const n = Number(value.toString?.() ?? value);
  return Number.isFinite(n) ? n : 0;
}

/* =========================================================
   ADMIN OVERVIEW
   ========================================================= */

export const getAdminOverviewStats = async (req, res, next) => {
  try {
    const { from, to, prevFrom, prevTo } = getPeriodFromQuery(
      req.cleanedQuery || req.query
    );

    const now = new Date();


    const [
      totalUsers,
      newUsersLast7Days,
      activeMemberships,
      currentAgg,
      prevAgg,
      newUsersCurrent,
      newUsersPrev,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({
        createdAt: { $gte: new Date(now.getTime() - 7 * 86400000) },
      }),
      User.countDocuments({
        "membership.status": "ACTIVE",
        "membership.expiresAt": { $gt: now },
      }),
      Order.aggregate([
        { $match: { status: "PAID", createdAt: { $gte: from, $lte: to } } },
        {
          $project: {
            total: { $ifNull: ["$total", 0] },
            itemsCount: {
              $cond: [{ $isArray: "$items" }, { $size: "$items" }, 0],
            },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
            downloadsApprox: { $sum: "$itemsCount" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { status: "PAID", createdAt: { $gte: prevFrom, $lte: prevTo } } },
        {
          $project: {
            total: { $ifNull: ["$total", 0] },
            itemsCount: {
              $cond: [{ $isArray: "$items" }, { $size: "$items" }, 0],
            },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$total" },
            orders: { $sum: 1 },
            downloadsApprox: { $sum: "$itemsCount" },
          },
        },
      ]),
      User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
      User.countDocuments({ createdAt: { $gte: prevFrom, $lte: prevTo } }),
    ]);

    const current = currentAgg[0] || {};
    const previous = prevAgg[0] || {};

    const revenueMonth = toNumber(current.revenue);
    const revenuePrev = toNumber(previous.revenue);

    const downloadsThisMonth = toNumber(current.downloadsApprox);
    const downloadsPrev = toNumber(previous.downloadsApprox);

    const revenueChangePercent =
      revenuePrev > 0
        ? ((revenueMonth - revenuePrev) / revenuePrev) * 100
        : revenueMonth > 0
        ? 100
        : 0;

    const downloadsChangePercent =
      downloadsPrev > 0
        ? ((downloadsThisMonth - downloadsPrev) / downloadsPrev) * 100
        : downloadsThisMonth > 0
        ? 100
        : 0;

    const growthRatePercent =
      newUsersPrev > 0
        ? ((newUsersCurrent - newUsersPrev) / newUsersPrev) * 100
        : newUsersCurrent > 0
        ? 100
        : 0;

    return res.json({
      period: { from, to, prevFrom, prevTo },
      totalUsers,
      newUsersLast7Days,
      totalOrders: toNumber(current.orders),
      revenueMonth,
      revenueChangePercent,
      activeMemberships,
      downloadsThisMonth,
      downloadsChangePercent,
      growthRatePercent,
    });
  } catch (err) {
    next(err);
  }
};

/* =========================================================
   REVENUE REPORT
   ========================================================= */
export const getRevenueReport = async (req, res, next) => {
  try {
    const querySource = req.cleanedQuery || req.query;

    const fromParam = querySource.from;
    const toParam = querySource.to;

    const fromDate = fromParam ? new Date(fromParam) : new Date("2000-01-01");
    const toDate = toParam ? new Date(toParam) : new Date();

    const groupBy = String(querySource.groupBy || "day");
    const by = String(querySource.by || "").toLowerCase();

    const statusList = String(querySource.status || "PAID")
      .split(",")
      .map((s) => s.trim().toUpperCase());

    const match = {
      status: { $in: statusList },
      createdAt: { $gte: fromDate, $lte: toDate },
    };

    if (by === "type") {
      const [row] = await Order.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            product: {
              $sum: {
                $cond: [{ $eq: ["$membershipPlanKey", null] }, "$total", 0],
              },
            },
            membership: {
              $sum: {
                $cond: [{ $ne: ["$membershipPlanKey", null] }, "$total", 0],
              },
            },
          },
        },
      ]);

      return res.json({
        totalRevenue: Number(row?.total || 0),
        byType: {
          PRODUCT: Number(row?.product || 0),
          MEMBERSHIP: Number(row?.membership || 0),
        },
      });
    }

    const days = (toDate.getTime() - fromDate.getTime()) / 86400000;
    const unit = groupBy === "month" || days > 60 ? "month" : "day";

    const groupId =
      unit === "month"
        ? { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } }
        : {
            y: { $year: "$createdAt" },
            m: { $month: "$createdAt" },
            d: { $dayOfMonth: "$createdAt" },
          };

    const rows = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: groupId,
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]);

    const points = rows.map((row) => {
      const { y, m, d } = row._id;
      return {
        label:
          unit === "month"
            ? `${y}-${String(m).padStart(2, "0")}`
            : `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        revenue: Number(row.revenue || 0),
        orders: Number(row.orders || 0),
      };
    });

    return res.json({
      from: fromDate,
      to: toDate,
      groupBy: unit,
      totalRevenue: points.reduce((sum, p) => sum + p.revenue, 0),
      totalOrders: points.reduce((sum, p) => sum + p.orders, 0),
      points,
    });
  } catch (err) {
    next(err);
  }
};
/* =========================================================
   USERS PAYMENTS REPORT
   ========================================================= */

export const getUsersPaymentsReport = async (req, res, next) => {
  try {
    const { from, to } = getPeriodFromQuery(req.cleanedQuery || req.query);

    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();
    const regex = search ? new RegExp(search, "i") : null;

    const pipeline = [
      { $match: { status: "PAID", createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: "$user",
          totalPaid: { $sum: { $ifNull: ["$total", 0] } },
          orderCount: { $sum: 1 },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userId: "$_id",
          name: "$user.name",
          email: "$user.email",
          roles: "$user.roles",
          totalPaid: 1,
          orderCount: 1,
          lastOrderAt: 1,
        },
      },
      ...(regex
        ? [{ $match: { $or: [{ name: regex }, { email: regex }] } }]
        : []),
      { $sort: { totalPaid: -1 } },
      {
        $facet: {
          meta: [{ $count: "total" }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
    ];

    const [result] = await Order.aggregate(pipeline);
    const meta = result?.meta?.[0];
    const data = result?.data || [];

    return res.json({
      from,
      to,
      data,
      pagination: {
        page,
        limit,
        total: meta?.total || 0,
        pages: Math.ceil((meta?.total || 0) / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};
