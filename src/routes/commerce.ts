import { Router } from "express";
import * as controller from "../controllers/commerce";
import { checkLogin, isAdmin, isStoreStaff } from "../middlewares/auth";

const commerceRouter = Router();

commerceRouter.get("/payments/vnpay/return", controller.getVnpayReturn);
commerceRouter.get("/payments/vnpay/ipn", controller.getVnpayIpn);
commerceRouter.get("/settings/cod", controller.getCodSettings);
commerceRouter.patch("/settings/cod", checkLogin, isAdmin, controller.updateCodSettings);
commerceRouter.get("/vouchers", checkLogin, isStoreStaff, controller.listVouchers);
commerceRouter.post("/vouchers", checkLogin, isStoreStaff, controller.createVoucher);
commerceRouter.patch("/vouchers/:id", checkLogin, isStoreStaff, controller.setVoucherStatus);
commerceRouter.get("/dashboard", checkLogin, isStoreStaff, controller.getDashboard);
commerceRouter.get("/staff/orders", checkLogin, isStoreStaff, controller.getStaffOrders);
commerceRouter.patch("/staff/orders/:id", checkLogin, isStoreStaff, controller.updateOrder);
commerceRouter.get("/staff/users", checkLogin, isAdmin, controller.listUsers);
commerceRouter.patch("/staff/users/:id/role", checkLogin, isAdmin, controller.updateUserRole);

commerceRouter.get("/cart", checkLogin, controller.getCart);
commerceRouter.put("/cart/:productId", checkLogin, controller.putCartItem);
commerceRouter.delete("/cart/:productId", checkLogin, controller.deleteCartItem);
commerceRouter.post("/orders", checkLogin, controller.createOrder);
commerceRouter.get("/orders", checkLogin, controller.getOrders);
commerceRouter.post("/orders/:id/cancel", checkLogin, controller.cancelOrder);
commerceRouter.get("/addresses", checkLogin, controller.getAddresses);
commerceRouter.post("/addresses", checkLogin, controller.saveAddress);
commerceRouter.get("/personal/:kind", checkLogin, controller.listPersonalProducts);
commerceRouter.put(
  "/personal/:kind/:productId",
  checkLogin,
  controller.togglePersonalProduct,
);

export default commerceRouter;
