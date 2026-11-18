# Backend

Express API backed by PostgreSQL using `pg`. The schema is created by
`src/db/migrate.ts` and is also applied when the server starts.

## Run locally

1. Copy `.env.example` to `.env` and set PostgreSQL, JWT, Google OAuth, and
   bootstrap-admin values.
2. Install dependencies with `npm install`.
3. Initialize the schema with `npm run db:init`.
4. Start the API with `npm run dev`.

Google ID tokens are verified against Google before user records are created.
Public signup and password login routes are not exposed. The first admin must
sign in with the address configured in `BOOTSTRAP_ADMIN_EMAIL`; later admins
grant or revoke the `store_manager` and `admin` roles from the staff console.

## Roles

| Role | Access |
| --- | --- |
| `admin` | Full store operations, COD policy, staff role assignment, products, inventory, vouchers, orders, and delivery/payment reconciliation. |
| `store_manager` | Product/category and inventory operations, vouchers, order processing, delivery status/tracking, and manual bank-transfer/COD receipt confirmation. Cannot change roles or payment/COD configuration. |
| `user` (customer) | Google sign-in, personal profile/addresses, cart, checkout, own orders and eligible cancellation, favorites, save-for-later, and reviews after a delivered purchase. |

The migration creates users, products, addresses, cart items, orders, vouchers,
reviews, favorites, saved items, and inventory/payment audit tables. Checkout
reserves stock in a transaction. VNPay return/IPN callbacks require a valid HMAC signature
and matching order amount; configure `/api/payments/vnpay/ipn` in the merchant
portal for server-to-server payment confirmation. Unpaid online orders release
their stock reservation when the payment window expires. VietQR transfers are not auto-confirmed: staff must
verify the bank transfer and confirm receipt in the order dashboard. This
schema migration does not copy old MongoDB records.

Set the VNPay sandbox and VietQR values in `.env` to enable those checkout
options. Keep production credentials outside source control. The default
delivery workflow is store-managed: staff update order status and tracking
number; no carrier API is connected.

## Structure

- `src/models`: domain types for products, categories, and users.
- `src/services`: PostgreSQL queries and transaction logic.
- `src/controllers` and `src/routes`: HTTP API.
- `src/db/migrate.ts`: idempotent PostgreSQL schema setup.

The API supports catalog search, categories, inventory summaries, cart and
checkout, configurable COD limits, order fulfillment, vouchers, verified
buyer reviews (1–10), favorites, and saved-for-later lists.
