import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../config/db";
import { HttpError } from "../utils/httpError";

type PaymentMethod = "cod" | "vnpay" | "bank_qr";
type Address = {
  recipientName: string;
  phone: string;
  province: string;
  district: string;
  ward: string;
  street: string;
};

const publicOrderFields = `
  id, order_number AS "orderNumber", user_id AS "userId", status,
  payment_method AS "paymentMethod", payment_status AS "paymentStatus",
  subtotal, shipping_fee AS "shippingFee", discount_amount AS "discountAmount",
  total, voucher_code AS "voucherCode", shipping_address AS "shippingAddress",
  shipping_carrier AS "shippingCarrier", tracking_number AS "trackingNumber",
  estimated_delivery_date AS "estimatedDeliveryDate",
  delivery_note AS "deliveryNote",
  customer_note AS "customerNote", payment_expires_at AS "paymentExpiresAt",
  created_at AS "createdAt"
`;

const toNumber = (value: string | number) => Number(value);
const voucherCodePattern = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

type VoucherRule = {
  discount_type: "fixed" | "percent";
  discount_value: string;
  minimum_subtotal: string;
  maximum_discount: string | null;
  usage_limit: number | null;
  used_count: number;
};

const normalizeVoucherCode = (code: string) => {
  const normalized = code.trim().toUpperCase();
  if (!voucherCodePattern.test(normalized)) {
    throw new HttpError(400, "Voucher code format is invalid.");
  }
  return normalized;
};

const calculateVoucherDiscount = (voucher: VoucherRule, subtotal: number) => {
  if (subtotal < toNumber(voucher.minimum_subtotal)) {
    throw new HttpError(400, "Order subtotal does not meet the voucher minimum.");
  }
  if (
    voucher.usage_limit !== null &&
    voucher.used_count >= voucher.usage_limit
  ) {
    throw new HttpError(400, "Voucher usage limit has been reached.");
  }

  let discount =
    voucher.discount_type === "percent"
      ? (subtotal * toNumber(voucher.discount_value)) / 100
      : toNumber(voucher.discount_value);
  if (voucher.maximum_discount !== null) {
    discount = Math.min(discount, toNumber(voucher.maximum_discount));
  }
  return Math.min(subtotal, Math.round(discount));
};

export const previewVoucher = async (userId: string, rawCode: string) => {
  if (typeof rawCode !== "string") {
    throw new HttpError(400, "Voucher code is required.");
  }
  const code = normalizeVoucherCode(rawCode);
  const { rows: cartRows } = await pool.query<{
    price: string;
    quantity: number;
  }>(
    `SELECT p.price, c.quantity
     FROM cart_items c JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1 AND p.is_active = TRUE`,
    [userId],
  );
  if (!cartRows.length) throw new HttpError(400, "Your cart is empty.");
  const subtotal = cartRows.reduce(
    (sum, item) => sum + toNumber(item.price) * item.quantity,
    0,
  );
  const { rows } = await pool.query<VoucherRule>(
    `SELECT discount_type, discount_value, minimum_subtotal,
            maximum_discount, usage_limit, used_count
     FROM vouchers WHERE code = $1 AND is_active = TRUE
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [code],
  );
  const voucher = rows[0];
  if (!voucher) throw new HttpError(400, "Voucher is invalid or expired.");
  const discountAmount = calculateVoucherDiscount(voucher, subtotal);
  return { code, subtotal, discountAmount };
};

const ensureAddress = (address: Address) => {
  const required = [
    address?.recipientName,
    address?.phone,
    address?.province,
    address?.district,
    address?.ward,
    address?.street,
  ];
  if (required.some((value) => typeof value !== "string" || !value.trim())) {
    throw new HttpError(400, "Please provide a complete delivery address.");
  }
  const fields: Array<[string, number]> = [
    [address.recipientName, 100],
    [address.province, 100],
    [address.district, 100],
    [address.ward, 100],
    [address.street, 300],
  ];
  if (
    fields.some(
      ([value, maxLength]) =>
        value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    throw new HttpError(400, "Delivery address contains invalid details.");
  }
  const digits = address.phone.replace(/\D/g, "");
  if (
    !/^\+?[0-9 ()-]{8,20}$/.test(address.phone.trim()) ||
    digits.length < 8 ||
    digits.length > 15
  ) {
    throw new HttpError(400, "Phone number format is invalid.");
  }
};

export const cancelCustomerOrder = async (orderId: string, userId: string) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      order_number: string;
      status: string;
      payment_method: PaymentMethod;
      payment_status: string;
      voucher_code: string | null;
    }>(
      `SELECT order_number, status, payment_method, payment_status, voucher_code
       FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId],
    );
    const order = rows[0];
    if (!order) throw new HttpError(404, "Order not found.");
    if (
      !["confirmed", "pending_payment"].includes(order.status) ||
      order.payment_status === "paid" ||
      order.payment_method === "vnpay"
    ) {
      throw new HttpError(409, "This order can no longer be cancelled online.");
    }
    const { rows: items } = await client.query<{
      product_id: string | null;
      quantity: number;
    }>(
      "SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
      [orderId],
    );
    for (const item of items) {
      if (!item.product_id) continue;
      const { rows: productRows } = await client.query<{ stock_quantity: number }>(
        `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = NOW()
         WHERE id = $1 RETURNING stock_quantity`,
        [item.product_id, item.quantity],
      );
      if (productRows[0]) {
        await client.query(
          `INSERT INTO inventory_movements
             (product_id, changed_by, quantity_delta, stock_after, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            item.product_id,
            userId,
            item.quantity,
            productRows[0].stock_quantity,
            `Cancelled order ${order.order_number}`,
          ],
        );
      }
    }
    if (order.voucher_code) {
      await client.query(
        "UPDATE vouchers SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1",
        [order.voucher_code],
      );
    }
    const { rows: cancelled } = await client.query(
      `UPDATE orders SET status = 'cancelled', payment_status = 'failed',
         updated_at = NOW() WHERE id = $1 RETURNING ${publicOrderFields}`,
      [orderId],
    );
    await client.query("COMMIT");
    return cancelled[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const expireUnpaidOrders = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: expiredOrders } = await client.query<{
      id: string;
      order_number: string;
      voucher_code: string | null;
    }>(
      `SELECT id, order_number, voucher_code FROM orders
       WHERE payment_status = 'pending' AND status = 'pending_payment'
         AND payment_expires_at <= NOW()
       ORDER BY payment_expires_at
       LIMIT 50 FOR UPDATE SKIP LOCKED`,
    );
    for (const order of expiredOrders) {
      const { rows: items } = await client.query<{
        product_id: string | null;
        quantity: number;
      }>(
        "SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
        [order.id],
      );
      for (const item of items) {
        if (!item.product_id) continue;
        const { rows: products } = await client.query<{ stock_quantity: number }>(
          `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = NOW()
           WHERE id = $1 RETURNING stock_quantity`,
          [item.product_id, item.quantity],
        );
        if (products[0]) {
          await client.query(
            `INSERT INTO inventory_movements
               (product_id, quantity_delta, stock_after, reason)
             VALUES ($1, $2, $3, $4)`,
            [
              item.product_id,
              item.quantity,
              products[0].stock_quantity,
              `Payment expired for ${order.order_number}`,
            ],
          );
        }
      }
      if (order.voucher_code) {
        await client.query(
          "UPDATE vouchers SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1",
          [order.voucher_code],
        );
      }
      await client.query(
        `UPDATE orders SET status = 'cancelled', payment_status = 'failed',
           updated_at = NOW() WHERE id = $1`,
        [order.id],
      );
      await client.query(
        `INSERT INTO payment_events (order_id, provider_reference, event_type, payload)
         VALUES ($1, $2, 'expired', '{}')
         ON CONFLICT (provider_reference) DO NOTHING`,
        [order.id, `expired:${order.id}`],
      );
    }
    await client.query("COMMIT");
    return expiredOrders.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getCart = async (userId: string) => {
  const { rows } = await pool.query(
    `SELECT p.id AS "productId", p.name, p.image, p.price,
            p.stock_quantity AS "stockQuantity", c.quantity
     FROM cart_items c JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1 AND p.is_active = TRUE ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    ...row,
    price: toNumber(row.price),
  }));
};

export const setCartItem = async (
  userId: string,
  productId: string,
  quantity: number,
) => {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new HttpError(400, "Quantity must be between 1 and 99.");
  }
  const { rows } = await pool.query<{ stock_quantity: number }>(
    "SELECT stock_quantity FROM products WHERE id = $1 AND is_active = TRUE",
    [productId],
  );
  if (!rows[0]) throw new HttpError(404, "Product is unavailable.");
  if (quantity > rows[0].stock_quantity) {
    throw new HttpError(409, "Requested quantity exceeds available stock.");
  }
  await pool.query(
    `INSERT INTO cart_items (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id)
     DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
    [userId, productId, quantity],
  );
  return getCart(userId);
};

export const removeCartItem = async (userId: string, productId: string) => {
  await pool.query(
    "DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2",
    [userId, productId],
  );
  return getCart(userId);
};

export const getCodSettings = async () => {
  const { rows } = await pool.query(
    `SELECT enabled, fee, free_shipping_threshold AS "freeShippingThreshold",
            max_order_amount AS "maxOrderAmount", allowed_provinces AS "allowedProvinces"
     FROM cod_settings WHERE id = TRUE`,
  );
  const settings = rows[0];
  return {
    ...settings,
    fee: toNumber(settings.fee),
    freeShippingThreshold:
      settings.freeShippingThreshold === null
        ? null
        : toNumber(settings.freeShippingThreshold),
    maxOrderAmount:
      settings.maxOrderAmount === null ? null : toNumber(settings.maxOrderAmount),
  };
};

const signVnpay = (params: Record<string, string>, secret: string) => {
  const query = Object.keys(params)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(params[key]).replace(/%20/g, "+")}`,
    )
    .join("&");
  return crypto.createHmac("sha512", secret).update(query).digest("hex");
};

const createVnpayUrl = (
  orderNumber: string,
  total: number,
  ipAddress: string,
) => {
  const host = process.env.VNPAY_URL;
  const tmnCode = process.env.VNPAY_TMN_CODE;
  const hashSecret = process.env.VNPAY_HASH_SECRET;
  const returnUrl = process.env.VNPAY_RETURN_URL;
  if (!host || !tmnCode || !hashSecret || !returnUrl) {
    throw new HttpError(503, "VNPay is not configured for this store.");
  }

  const now = new Date();
  const format = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  };
  const params: Record<string, string> = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: tmnCode,
    vnp_Amount: String(Math.round(total * 100)),
    vnp_CurrCode: "VND",
    vnp_TxnRef: orderNumber,
    vnp_OrderInfo: `Thanh toan don hang ${orderNumber}`,
    vnp_OrderType: "other",
    vnp_Locale: "vn",
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: ipAddress.replace(/^::ffff:/, "").slice(0, 45),
    vnp_CreateDate: format(now),
    vnp_ExpireDate: format(new Date(now.getTime() + 15 * 60 * 1000)),
  };
  const url = new URL(host);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("vnp_SecureHash", signVnpay(params, hashSecret));
  return url.toString();
};

export const createOrder = async (
  userId: string,
  input: {
    address: Address;
    paymentMethod: PaymentMethod;
    voucherCode?: string;
    customerNote?: string;
  },
  ipAddress: string,
) => {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Order details are required.");
  }
  ensureAddress(input.address);
  if (
    (input.voucherCode !== undefined && typeof input.voucherCode !== "string") ||
    (input.customerNote !== undefined && typeof input.customerNote !== "string")
  ) {
    throw new HttpError(400, "Order details are invalid.");
  }
  if (!["cod", "vnpay", "bank_qr"].includes(input.paymentMethod)) {
    throw new HttpError(400, "Unsupported payment method.");
  }
  if (input.paymentMethod === "vnpay") {
    if (
      !process.env.VNPAY_URL ||
      !process.env.VNPAY_TMN_CODE ||
      !process.env.VNPAY_HASH_SECRET ||
      !process.env.VNPAY_RETURN_URL
    ) {
      throw new HttpError(503, "VNPay is not configured for this store.");
    }
    try {
      const paymentHost = new URL(process.env.VNPAY_URL);
      const returnUrl = new URL(process.env.VNPAY_RETURN_URL);
      if (
        paymentHost.protocol !== "https:" ||
        (returnUrl.protocol !== "https:" &&
          !(returnUrl.protocol === "http:" && returnUrl.hostname === "localhost"))
      ) {
        throw new Error("VNPay URLs must use HTTPS except for localhost callbacks.");
      }
    } catch {
      throw new HttpError(503, "VNPay URLs are not valid.");
    }
  }
  if (
    input.paymentMethod === "bank_qr" &&
    (!process.env.VIETQR_BANK_ID || !process.env.VIETQR_ACCOUNT_NO)
  ) {
    throw new HttpError(503, "Bank QR payment is not configured for this store.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cartRows } = await client.query<{
      product_id: string;
      name: string;
      price: string;
      quantity: number;
      stock_quantity: number;
    }>(
      `SELECT p.id AS product_id, p.name, p.price, c.quantity, p.stock_quantity
       FROM cart_items c JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1 AND p.is_active = TRUE
       ORDER BY p.id FOR UPDATE OF p`,
      [userId],
    );
    if (!cartRows.length) throw new HttpError(400, "Your cart is empty.");
    for (const item of cartRows) {
      if (item.quantity > item.stock_quantity) {
        throw new HttpError(409, `${item.name} no longer has enough stock.`);
      }
    }

    const subtotal = cartRows.reduce(
      (sum, item) => sum + toNumber(item.price) * item.quantity,
      0,
    );
    let discount = 0;
    const rawVoucherCode = input.voucherCode?.trim();
    const voucherCode = rawVoucherCode
      ? normalizeVoucherCode(rawVoucherCode)
      : null;
    if (voucherCode) {
      const { rows: vouchers } = await client.query<VoucherRule>(
        `SELECT discount_type, discount_value, minimum_subtotal,
                maximum_discount, usage_limit, used_count
         FROM vouchers WHERE code = $1 AND is_active = TRUE
           AND (starts_at IS NULL OR starts_at <= NOW())
           AND (expires_at IS NULL OR expires_at > NOW())
         FOR UPDATE`,
        [voucherCode],
      );
      const voucher = vouchers[0];
      if (!voucher) throw new HttpError(400, "Voucher is invalid or expired.");
      discount = calculateVoucherDiscount(voucher, subtotal);
    }

    let shippingFee = 0;
    if (input.paymentMethod === "cod") {
      const settings = await client.query<{
        enabled: boolean;
        fee: string;
        free_shipping_threshold: string | null;
        max_order_amount: string | null;
        allowed_provinces: string[];
      }>(
        `SELECT enabled, fee, free_shipping_threshold, max_order_amount, allowed_provinces
         FROM cod_settings WHERE id = TRUE FOR UPDATE`,
      );
      const cod = settings.rows[0];
      if (!cod.enabled) throw new HttpError(400, "Cash on delivery is unavailable.");
      if (
        cod.allowed_provinces.length &&
        !cod.allowed_provinces.some(
          (province) =>
            province.toLocaleLowerCase() ===
            input.address.province.trim().toLocaleLowerCase(),
        )
      ) {
        throw new HttpError(400, "Cash on delivery is unavailable in this area.");
      }
      if (cod.max_order_amount && subtotal - discount > toNumber(cod.max_order_amount)) {
        throw new HttpError(400, "Order exceeds the COD amount limit.");
      }
      if (
        cod.free_shipping_threshold === null ||
        subtotal - discount < toNumber(cod.free_shipping_threshold)
      ) {
        shippingFee = toNumber(cod.fee);
      }
    }

    const total = Math.round(subtotal - discount + shippingFee);
    const orderNumber = `LY${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const orderResult = await client.query<{ id: string }>(
      `INSERT INTO orders
         (order_number, user_id, status, payment_method, subtotal, shipping_fee,
           discount_amount, total, voucher_code, shipping_address, customer_note,
           payment_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          CASE WHEN $4 = 'vnpay' THEN NOW() + INTERVAL '15 minutes'
               WHEN $4 = 'bank_qr' THEN NOW() + INTERVAL '24 hours'
               ELSE NULL END)
       RETURNING id`,
      [
        orderNumber,
        userId,
        input.paymentMethod === "cod" ? "confirmed" : "pending_payment",
        input.paymentMethod,
        subtotal,
        shippingFee,
        discount,
        total,
        voucherCode,
        JSON.stringify(input.address),
        input.customerNote?.trim().slice(0, 2000) || null,
      ],
    );
    const orderId = orderResult.rows[0].id;

    for (const item of cartRows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, item.name, item.price, item.quantity],
      );
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $2, updated_at = NOW()
         WHERE id = $1`,
        [item.product_id, item.quantity],
      );
      await client.query(
        `INSERT INTO inventory_movements
           (product_id, changed_by, quantity_delta, stock_after, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          item.product_id,
          userId,
          -item.quantity,
          item.stock_quantity - item.quantity,
          `Order ${orderNumber}`,
        ],
      );
    }
    if (voucherCode) {
      await client.query(
        "UPDATE vouchers SET used_count = used_count + 1 WHERE code = $1",
        [voucherCode],
      );
    }
    await client.query("DELETE FROM cart_items WHERE user_id = $1", [userId]);
    await client.query("COMMIT");

    const { rows } = await pool.query(
      `SELECT ${publicOrderFields} FROM orders WHERE id = $1`,
      [orderId],
    );
    let paymentUrl: string | undefined;
    let qrImageUrl: string | undefined;
    if (input.paymentMethod === "vnpay") {
      paymentUrl = createVnpayUrl(orderNumber, total, ipAddress);
    } else if (input.paymentMethod === "bank_qr") {
      const qr = new URL(
        `https://img.vietqr.io/image/${encodeURIComponent(process.env.VIETQR_BANK_ID!)}-${encodeURIComponent(process.env.VIETQR_ACCOUNT_NO!)}-compact2.png`,
      );
      qr.searchParams.set("amount", String(Math.round(total)));
      qr.searchParams.set("addInfo", orderNumber);
      if (process.env.VIETQR_ACCOUNT_NAME) {
        qr.searchParams.set("accountName", process.env.VIETQR_ACCOUNT_NAME);
      }
      qrImageUrl = qr.toString();
    }
    return { order: rows[0], paymentUrl, qrImageUrl };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getOrders = async (userId: string, isStaff = false) => {
  const { rows } = await pool.query(
    `SELECT ${publicOrderFields},
       (SELECT COALESCE(json_agg(json_build_object(
         'productId', product_id, 'name', product_name,
         'unitPrice', unit_price, 'quantity', quantity
       )), '[]'::json) FROM order_items WHERE order_id = orders.id) AS items
     FROM orders
     ${isStaff ? "" : "WHERE user_id = $1"}
     ORDER BY created_at DESC LIMIT 200`,
    isStaff ? [] : [userId],
  );
  return rows;
};

export const updateOrder = async (
  orderId: string,
  input: {
    status?: string;
    trackingNumber?: string | null;
    shippingCarrier?: string | null;
    estimatedDeliveryDate?: string | null;
    deliveryNote?: string;
    paymentStatus?: string;
  },
  changedBy?: string,
) => {
  const allowedStatuses = [
    "confirmed",
    "processing",
    "picked_up",
    "in_transit",
    "shipped",
    "delivered",
    "cancelled",
  ];
  if (input.status && !allowedStatuses.includes(input.status)) {
    throw new HttpError(400, "Unsupported order status.");
  }
  if (
    input.trackingNumber !== undefined &&
    input.trackingNumber !== null &&
    (input.trackingNumber.length > 80 ||
      (input.trackingNumber.trim() !== "" &&
        !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/.test(
          input.trackingNumber.trim(),
        )))
  ) {
    throw new HttpError(400, "Tracking number format is invalid.");
  }
  if (
    input.shippingCarrier !== undefined &&
    input.shippingCarrier !== null &&
    (input.shippingCarrier.length > 80 ||
      input.shippingCarrier.trim().length > 80 ||
      /[\u0000-\u001f\u007f]/.test(input.shippingCarrier))
  ) {
    throw new HttpError(400, "Shipping carrier is invalid.");
  }
  if (
    input.estimatedDeliveryDate !== undefined &&
    input.estimatedDeliveryDate !== null &&
    input.estimatedDeliveryDate !== "" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(input.estimatedDeliveryDate) ||
      Number.isNaN(Date.parse(`${input.estimatedDeliveryDate}T00:00:00Z`)) ||
      new Date(`${input.estimatedDeliveryDate}T00:00:00Z`)
        .toISOString()
        .slice(0, 10) !== input.estimatedDeliveryDate)
  ) {
    throw new HttpError(400, "Estimated delivery date is invalid.");
  }
  if (input.deliveryNote !== undefined && input.deliveryNote.length > 2000) {
    throw new HttpError(400, "Delivery note is too long.");
  }
  if (input.paymentStatus && input.paymentStatus !== "paid") {
    throw new HttpError(400, "Staff can only confirm received payments.");
  }
  if (input.status === "cancelled" && input.paymentStatus === "paid") {
    throw new HttpError(400, "A cancelled order cannot be marked as paid.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query<{
      order_number: string;
      status: string;
      payment_method: PaymentMethod;
      payment_status: string;
      voucher_code: string | null;
    }>(
      `SELECT order_number, status, payment_method, payment_status, voucher_code
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const current = currentRows[0];
    if (!current) throw new HttpError(404, "Order not found.");
    if (input.paymentStatus === "paid" && current.payment_method === "vnpay") {
      throw new HttpError(409, "VNPay payments can only be confirmed by its signed callback.");
    }
    if (
      input.paymentStatus === "paid" &&
      (current.status === "cancelled" || current.payment_status !== "pending")
    ) {
      throw new HttpError(409, "This order is no longer awaiting payment confirmation.");
    }
    if (
      input.paymentStatus === "paid" &&
      current.payment_method === "cod" &&
      current.status !== "delivered"
    ) {
      throw new HttpError(409, "COD can only be confirmed after delivery.");
    }

    if (input.status) {
      const transitions: Record<string, string[]> = {
        pending_payment: ["cancelled"],
        confirmed: ["processing", "cancelled"],
        processing: ["picked_up", "in_transit", "shipped", "cancelled"],
        picked_up: ["in_transit", "delivered"],
        in_transit: ["delivered"],
        shipped: ["delivered"],
      };
      if (input.status !== current.status && !transitions[current.status]?.includes(input.status)) {
        throw new HttpError(409, "This order status transition is not allowed.");
      }
    }
    if (
      input.status === "cancelled" &&
      current.payment_method === "vnpay" &&
      current.payment_status === "pending"
    ) {
      throw new HttpError(409, "Wait for VNPay to finish or expire before cancelling this order.");
    }
    if (input.status === "cancelled") {
      if (current.payment_status === "paid") {
        throw new HttpError(409, "Paid orders need a refund workflow before cancellation.");
      }
      const { rows: items } = await client.query<{
        product_id: string | null;
        quantity: number;
      }>(
        "SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
        [orderId],
      );
      for (const item of items) {
        if (!item.product_id) continue;
        const { rows: productRows } = await client.query<{ stock_quantity: number }>(
          `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = NOW()
           WHERE id = $1 RETURNING stock_quantity`,
          [item.product_id, item.quantity],
        );
        if (productRows[0]) {
          await client.query(
            `INSERT INTO inventory_movements
               (product_id, changed_by, quantity_delta, stock_after, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              item.product_id,
              changedBy || null,
              item.quantity,
              productRows[0].stock_quantity,
              `Cancelled order ${current.order_number}`,
            ],
          );
        }
      }
      if (current.voucher_code) {
        await client.query(
          "UPDATE vouchers SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1",
          [current.voucher_code],
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE orders SET
         status = COALESCE($2, CASE WHEN $10 = 'paid' AND status = 'pending_payment'
           THEN 'confirmed' ELSE status END),
         tracking_number = CASE WHEN $3 THEN NULLIF($4, '') ELSE tracking_number END,
         delivery_note = COALESCE($5, delivery_note),
         shipping_carrier = CASE WHEN $6 THEN NULLIF($7, '') ELSE shipping_carrier END,
         estimated_delivery_date = CASE WHEN $8 THEN $9::date ELSE estimated_delivery_date END,
         payment_status = CASE
           WHEN $2 = 'cancelled' AND payment_status = 'pending' THEN 'failed'
           ELSE COALESCE($10, payment_status)
         END,
         updated_at = NOW()
       WHERE id = $1 RETURNING ${publicOrderFields}`,
      [
        orderId,
        input.status || null,
        input.trackingNumber !== undefined,
        input.trackingNumber?.trim() || null,
        input.deliveryNote?.trim() || null,
        input.shippingCarrier !== undefined,
        input.shippingCarrier?.trim() || null,
        input.estimatedDeliveryDate !== undefined,
        input.estimatedDeliveryDate || null,
        input.paymentStatus || null,
      ],
    );
    if (
      input.paymentStatus === "paid" &&
      ["bank_qr", "cod"].includes(current.payment_method)
    ) {
      await client.query(
        `INSERT INTO payment_events (order_id, provider_reference, event_type, payload)
         VALUES ($1, $2, 'manually_confirmed', $3)
         ON CONFLICT (provider_reference) DO NOTHING`,
        [orderId, `manual:${orderId}`, JSON.stringify({ confirmedBy: changedBy || null })],
      );
    }
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const validateVnpayReturn = async (query: Record<string, string>) => {
  const secret = process.env.VNPAY_HASH_SECRET;
  if (!secret || !process.env.VNPAY_TMN_CODE) {
    throw new HttpError(503, "VNPay is not configured.");
  }
  if (query.vnp_TmnCode !== process.env.VNPAY_TMN_CODE) {
    throw new HttpError(400, "Payment merchant does not match.");
  }
  const receivedHash = query.vnp_SecureHash;
  const params = Object.fromEntries(
    Object.entries(query).filter(
      ([key]) => key !== "vnp_SecureHash" && key !== "vnp_SecureHashType",
    ),
  );
  if (!receivedHash) throw new HttpError(400, "Missing payment signature.");
  const expectedHash = signVnpay(params, secret);
  const expected = Buffer.from(expectedHash, "hex");
  const received = Buffer.from(receivedHash, "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw new HttpError(400, "Invalid payment signature.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      order_number: string;
      total: string;
      status: string;
      payment_status: string;
      voucher_code: string | null;
    }>(
      `SELECT id, order_number, total, status, payment_status, voucher_code
       FROM orders WHERE order_number = $1 FOR UPDATE`,
      [query.vnp_TxnRef],
    );
    const order = rows[0];
    if (!order) throw new HttpError(404, "Payment order was not found.");
    if (Number(query.vnp_Amount) !== Math.round(toNumber(order.total) * 100)) {
      throw new HttpError(400, "Payment amount does not match the order.");
    }
    if (order.payment_status !== "pending") {
      await client.query("COMMIT");
      return {
        orderNumber: order.order_number,
        paid: order.payment_status === "paid",
      };
    }

    const isPaid =
      query.vnp_ResponseCode === "00" && query.vnp_TransactionStatus === "00";
    await client.query(
      `UPDATE orders SET payment_status = $2,
         status = CASE WHEN $2 = 'paid' THEN 'confirmed' ELSE 'cancelled' END,
         updated_at = NOW() WHERE id = $1`,
      [order.id, isPaid ? "paid" : "failed"],
    );
    if (!isPaid) {
      const { rows: items } = await client.query<{
        product_id: string | null;
        quantity: number;
      }>(
        "SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id",
        [order.id],
      );
      for (const item of items) {
        if (!item.product_id) continue;
        const { rows: productRows } = await client.query<{ stock_quantity: number }>(
          `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = NOW()
           WHERE id = $1 RETURNING stock_quantity`,
          [item.product_id, item.quantity],
        );
        if (productRows[0]) {
          await client.query(
            `INSERT INTO inventory_movements
               (product_id, quantity_delta, stock_after, reason)
             VALUES ($1, $2, $3, $4)`,
            [
              item.product_id,
              item.quantity,
              productRows[0].stock_quantity,
              `Failed payment ${order.order_number}`,
            ],
          );
        }
      }
      if (order.voucher_code) {
        await client.query(
          "UPDATE vouchers SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1",
          [order.voucher_code],
        );
      }
    }
    await client.query(
      `INSERT INTO payment_events (order_id, provider_reference, event_type, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider_reference) DO NOTHING`,
      [
        order.id,
        query.vnp_TransactionNo || `${query.vnp_TxnRef}:${query.vnp_ResponseCode}`,
        isPaid ? "paid" : "failed",
        JSON.stringify(query),
      ],
    );
    await client.query("COMMIT");
    return { orderNumber: order.order_number, paid: isPaid };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const listVouchers = async () => {
  const { rows } = await pool.query(
    `SELECT id, code, discount_type AS "discountType",
            discount_value AS "discountValue",
            minimum_subtotal AS "minimumSubtotal",
            maximum_discount AS "maximumDiscount",
            usage_limit AS "usageLimit", used_count AS "usedCount",
            starts_at AS "startsAt", expires_at AS "expiresAt", is_active AS "isActive"
     FROM vouchers ORDER BY created_at DESC`,
  );
  return rows;
};

export const createVoucher = async (input: {
  code: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  minimumSubtotal?: number;
  maximumDiscount?: number;
  usageLimit?: number;
  expiresAt?: string;
}) => {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.code !== "string" ||
    !["fixed", "percent"].includes(input.discountType) ||
    !Number.isFinite(input.discountValue) ||
    input.discountValue < 1 ||
    (input.discountType === "percent" && input.discountValue > 100) ||
    (input.discountType === "fixed" && !Number.isInteger(input.discountValue)) ||
    (input.minimumSubtotal !== undefined &&
      (!Number.isInteger(input.minimumSubtotal) || input.minimumSubtotal < 0)) ||
    (input.maximumDiscount !== undefined &&
      (!Number.isInteger(input.maximumDiscount) || input.maximumDiscount < 0)) ||
    (input.usageLimit !== undefined &&
      (!Number.isInteger(input.usageLimit) ||
        input.usageLimit < 1 ||
        input.usageLimit > 1_000_000)) ||
    (input.expiresAt !== undefined &&
      (typeof input.expiresAt !== "string" ||
        Number.isNaN(Date.parse(input.expiresAt)) ||
        Date.parse(input.expiresAt) <= Date.now()))
  ) {
    throw new HttpError(400, "Voucher details are invalid.");
  }
  const code = normalizeVoucherCode(input.code);
  const { rows } = await pool.query(
    `INSERT INTO vouchers
       (code, discount_type, discount_value, minimum_subtotal,
        maximum_discount, usage_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, code, discount_type AS "discountType",
       discount_value AS "discountValue", is_active AS "isActive"`,
    [
      code,
      input.discountType,
      input.discountValue,
      input.minimumSubtotal || 0,
      input.maximumDiscount ?? null,
      input.usageLimit || null,
      input.expiresAt || null,
    ],
  );
  return rows[0];
};

export const updateCodSettings = async (input: {
  enabled: boolean;
  fee: number;
  freeShippingThreshold: number | null;
  maxOrderAmount: number | null;
  allowedProvinces: string[];
}) => {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.enabled !== "boolean" ||
    !Number.isFinite(input.fee) ||
    input.fee < 0 ||
    !Array.isArray(input.allowedProvinces) ||
    input.allowedProvinces.some((province) => typeof province !== "string") ||
    (input.freeShippingThreshold !== null &&
      (!Number.isFinite(input.freeShippingThreshold) ||
        input.freeShippingThreshold < 0)) ||
    (input.maxOrderAmount !== null &&
      (!Number.isFinite(input.maxOrderAmount) || input.maxOrderAmount < 0))
  ) {
    throw new HttpError(400, "COD settings are invalid.");
  }
  const { rows } = await pool.query(
    `UPDATE cod_settings SET enabled = $1, fee = $2,
       free_shipping_threshold = $3, max_order_amount = $4,
       allowed_provinces = $5, updated_at = NOW()
     WHERE id = TRUE
     RETURNING enabled, fee, free_shipping_threshold AS "freeShippingThreshold",
       max_order_amount AS "maxOrderAmount", allowed_provinces AS "allowedProvinces"`,
    [
      input.enabled,
      input.fee,
      input.freeShippingThreshold,
      input.maxOrderAmount,
      input.allowedProvinces,
    ],
  );
  return rows[0];
};

export const getAddresses = async (userId: string) => {
  const { rows } = await pool.query(
    `SELECT id, recipient_name AS "recipientName", phone, province, district,
            ward, street, is_default AS "isDefault"
     FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return rows;
};

export const saveAddress = async (userId: string, address: Address) => {
  ensureAddress(address);
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM addresses
       WHERE user_id = $1 AND recipient_name = $2 AND phone = $3
         AND province = $4 AND district = $5 AND ward = $6 AND street = $7
       LIMIT 1 FOR UPDATE`,
      [
        userId,
        address.recipientName.trim(),
        address.phone.trim(),
        address.province.trim(),
        address.district.trim(),
        address.ward.trim(),
        address.street.trim(),
      ],
    );
    await client.query("UPDATE addresses SET is_default = FALSE WHERE user_id = $1", [
      userId,
    ]);
    if (existing[0]) {
      const { rows } = await client.query(
        `UPDATE addresses SET is_default = TRUE WHERE id = $1
         RETURNING id, recipient_name AS "recipientName", phone, province,
           district, ward, street, is_default AS "isDefault"`,
        [existing[0].id],
      );
      await client.query("COMMIT");
      return rows[0];
    }
    const { rows } = await client.query(
      `INSERT INTO addresses
         (user_id, recipient_name, phone, province, district, ward, street, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING id, recipient_name AS "recipientName", phone, province,
         district, ward, street, is_default AS "isDefault"`,
      [
        userId,
        address.recipientName.trim(),
        address.phone.trim(),
        address.province.trim(),
        address.district.trim(),
        address.ward.trim(),
        address.street.trim(),
      ],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getProductReviews = async (productId: string) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at AS "createdAt",
            u.full_name AS "customerName",
            AVG(r.rating) OVER () AS "averageRating",
            COUNT(*) OVER () AS "reviewCount"
     FROM product_reviews r JOIN users u ON u.id = r.user_id
     WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [productId],
  );
  return {
    averageRating: rows[0] ? Number(rows[0].averageRating) : 0,
    reviewCount: rows[0] ? Number(rows[0].reviewCount) : 0,
    reviews: rows.map((row) => ({
      ...row,
      averageRating: undefined,
      reviewCount: undefined,
    })),
  };
};

export const createProductReview = async (
  productId: string,
  userId: string,
  rating: number,
  comment: string,
) => {
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    throw new HttpError(400, "Rating must be between 1 and 10.");
  }
  const purchased = await pool.query(
    `SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE i.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered'
     LIMIT 1`,
    [productId, userId],
  );
  if (!purchased.rowCount) {
    throw new HttpError(403, "Only customers with a delivered order can review this item.");
  }
  const { rows } = await pool.query(
    `INSERT INTO product_reviews (product_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, user_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = NOW()
     RETURNING id, rating, comment, created_at AS "createdAt"`,
    [productId, userId, rating, comment.trim().slice(0, 2000)],
  );
  return rows[0];
};

export const listPersonalProducts = async (
  userId: string,
  kind: "favorites" | "saved",
) => {
  const table = kind === "favorites" ? "favorites" : "saved_items";
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.image, p.price,
            p.stock_quantity AS "stockQuantity", p.is_active AS "isActive"
     FROM ${table} x JOIN products p ON p.id = x.product_id
     WHERE x.user_id = $1 ORDER BY x.created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({ ...row, price: toNumber(row.price) }));
};

export const togglePersonalProduct = async (
  userId: string,
  productId: string,
  kind: "favorites" | "saved",
) => {
  const table = kind === "favorites" ? "favorites" : "saved_items";
  const { rows } = await pool.query(
    `DELETE FROM ${table} WHERE user_id = $1 AND product_id = $2
     RETURNING product_id`,
    [userId, productId],
  );
  if (rows.length) return { saved: false };
  const result = await pool.query(
    `INSERT INTO ${table} (user_id, product_id)
     SELECT $1, id FROM products WHERE id = $2 AND is_active = TRUE
     ON CONFLICT DO NOTHING RETURNING product_id`,
    [userId, productId],
  );
  if (!result.rowCount) throw new HttpError(404, "Product not found.");
  return { saved: true };
};

export const getStaffDashboard = async () => {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE created_at::date = CURRENT_DATE) AS "ordersToday",
       (SELECT COUNT(*) FROM orders WHERE status IN ('pending_payment', 'confirmed', 'processing', 'picked_up', 'in_transit', 'shipped')) AS "openOrders",
       (SELECT COUNT(*) FROM orders WHERE status IN ('picked_up', 'in_transit', 'shipped')) AS "inTransit",
       (SELECT COALESCE(SUM(total), 0) FROM orders
        WHERE payment_status = 'paid' AND created_at::date = CURRENT_DATE) AS "revenueToday",
       (SELECT COUNT(*) FROM products WHERE is_active AND stock_quantity <= reorder_threshold) AS "lowStock"`,
  );
  const item = rows[0];
  return {
    ordersToday: Number(item.ordersToday),
    openOrders: Number(item.openOrders),
    inTransit: Number(item.inTransit),
    revenueToday: Number(item.revenueToday),
    lowStock: Number(item.lowStock),
  };
};

export const listUsers = async () => {
  const { rows } = await pool.query(
    `SELECT id, username, email, full_name AS "fullName", role,
            is_active AS "isActive", created_at AS "createdAt"
     FROM users ORDER BY created_at DESC LIMIT 500`,
  );
  return rows;
};

export const setUserRole = async (
  userId: string,
  role: "user" | "store_manager" | "admin",
) => {
  if (!["user", "store_manager", "admin"].includes(role)) {
    throw new HttpError(400, "Unsupported user role.");
  }
  const { rows } = await pool.query(
    `UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, username, email, role`,
    [userId, role],
  );
  if (!rows[0]) throw new HttpError(404, "User not found.");
  return rows[0];
};

export const setVoucherStatus = async (voucherId: string, isActive: boolean) => {
  const { rows } = await pool.query(
    `UPDATE vouchers SET is_active = $2 WHERE id = $1
     RETURNING id, code, is_active AS "isActive"`,
    [voucherId, isActive],
  );
  if (!rows[0]) throw new HttpError(404, "Voucher not found.");
  return rows[0];
};
