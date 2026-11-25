import { Request, Response } from "express";
import * as commerce from "../services/commerce";
import { AuthenticatedRequest } from "../types/authencation";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const userId = (req: AuthenticatedRequest) => {
  if (!req.user) throw new HttpError(401, "Authentication required.");
  return req.user.id;
};

const getParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] || "" : value || "";

const getQueryStrings = (req: Request) =>
  Object.fromEntries(
    Object.entries(req.query)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, String(value)]),
  );

export const cancelOrder = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.json(
      await commerce.cancelCustomerOrder(
        getParam(req.params.id),
        userId(req),
      ),
    );
  },
);

export const getCart = asyncHandler(async (req: AuthenticatedRequest, res) => {
  res.json(await commerce.getCart(userId(req)));
});

export const putCartItem = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    const quantity = Number(req.body?.quantity);
    res.json(
      await commerce.setCartItem(
        userId(req),
        getParam(req.params.productId),
        quantity,
      ),
    );
  },
);

export const deleteCartItem = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.json(
      await commerce.removeCartItem(
        userId(req),
        getParam(req.params.productId),
      ),
    );
  },
);

export const createOrder = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    const order = await commerce.createOrder(
      userId(req),
      req.body,
      req.ip || "127.0.0.1",
    );
    res.status(201).json(order);
  },
);

export const validateVoucher = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    if (typeof req.body?.code !== "string") {
      throw new HttpError(400, "Voucher code is required.");
    }
    res.json(await commerce.previewVoucher(userId(req), req.body.code));
  },
);

export const getOrders = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.json(await commerce.getOrders(userId(req)));
  },
);

export const getStaffOrders = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.json(await commerce.getOrders(userId(req), true));
  },
);

export const updateOrder = asyncHandler(async (req: AuthenticatedRequest, res) => {
  for (const field of [
    "status",
    "trackingNumber",
    "shippingCarrier",
    "estimatedDeliveryDate",
    "deliveryNote",
    "paymentStatus",
  ]) {
    if (req.body?.[field] !== undefined && typeof req.body[field] !== "string") {
      if (
        !["trackingNumber", "shippingCarrier", "estimatedDeliveryDate"].includes(field) ||
        req.body[field] !== null
      ) {
        throw new HttpError(400, `Invalid ${field}.`);
      }
    }
  }
  res.json(
    await commerce.updateOrder(getParam(req.params.id), {
      status: req.body?.status,
      trackingNumber: req.body?.trackingNumber,
      shippingCarrier: req.body?.shippingCarrier,
      estimatedDeliveryDate: req.body?.estimatedDeliveryDate,
      deliveryNote: req.body?.deliveryNote,
      paymentStatus: req.body?.paymentStatus,
    }, userId(req)),
  );
});

export const getCodSettings = asyncHandler(async (_req, res) => {
  res.json(await commerce.getCodSettings());
});

export const updateCodSettings = asyncHandler(async (req, res) => {
  res.json(await commerce.updateCodSettings(req.body));
});

export const getVnpayReturn = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await commerce.validateVnpayReturn(getQueryStrings(req));
    const frontend = process.env.FRONTEND_URLS?.split(",")[0]?.trim();
    if (!frontend) return res.json(result);
    const destination = new URL("/account/orders", frontend);
    destination.searchParams.set("payment", result.paid ? "success" : "failed");
    destination.searchParams.set("order", result.orderNumber);
    res.redirect(destination.toString());
  },
);

export const getVnpayIpn = asyncHandler(async (req: Request, res: Response) => {
  try {
    await commerce.validateVnpayReturn(getQueryStrings(req));
    res.json({ RspCode: "00", Message: "Confirm Success" });
  } catch (error) {
    if (error instanceof HttpError) {
      const code =
        error.statusCode === 404
          ? "01"
          : error.message.includes("amount")
            ? "04"
            : "97";
      return res.json({ RspCode: code, Message: error.message });
    }
    throw error;
  }
});

export const listVouchers = asyncHandler(async (_req, res) => {
  res.json(await commerce.listVouchers());
});

export const createVoucher = asyncHandler(async (req, res) => {
  res.status(201).json(await commerce.createVoucher(req.body));
});

export const setVoucherStatus = asyncHandler(async (req, res) => {
  if (typeof req.body?.isActive !== "boolean") {
    throw new HttpError(400, "Voucher active status must be a boolean.");
  }
  res.json(
    await commerce.setVoucherStatus(
      getParam(req.params.id),
      req.body?.isActive === true,
    ),
  );
});

export const getAddresses = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.json(await commerce.getAddresses(userId(req)));
  },
);

export const saveAddress = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.status(201).json(await commerce.saveAddress(userId(req), req.body));
  },
);

export const getReviews = asyncHandler(async (req, res) => {
  res.json(await commerce.getProductReviews(getParam(req.params.id)));
});

export const createReview = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    res.status(201).json(
      await commerce.createProductReview(
        getParam(req.params.id),
        userId(req),
        Number(req.body?.rating),
        typeof req.body?.comment === "string" ? req.body.comment : "",
      ),
    );
  },
);

export const listPersonalProducts = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    const kind = req.params.kind === "saved" ? "saved" : "favorites";
    res.json(await commerce.listPersonalProducts(userId(req), kind));
  },
);

export const togglePersonalProduct = asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    const kind = req.params.kind === "saved" ? "saved" : "favorites";
    res.json(
      await commerce.togglePersonalProduct(
        userId(req),
        getParam(req.params.productId),
        kind,
      ),
    );
  },
);

export const getDashboard = asyncHandler(async (_req, res) => {
  res.json(await commerce.getStaffDashboard());
});

export const listUsers = asyncHandler(async (_req, res) => {
  res.json(await commerce.listUsers());
});

export const updateUserRole = asyncHandler(async (req: AuthenticatedRequest, res) => {
  const id = getParam(req.params.id);
  if (id === req.user?.id && req.body?.role !== "admin") {
    throw new HttpError(400, "You cannot remove your own admin access.");
  }
  res.json(
    await commerce.setUserRole(
      id,
      req.body?.role,
    ),
  );
});
