# Giai đoạn 1: Build code TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Copy file cấu hình thư viện và cài đặt (dùng yarn vì có yarn.lock)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy toàn bộ code và build ra thư mục dist
COPY . .
RUN yarn build

# Giai đoạn 2: Môi trường chạy thực tế
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Chỉ cài đặt các thư viện cần thiết cho production (bỏ qua devDependencies)
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile

# Copy thư mục dist đã build xong từ Giai đoạn 1 sang
COPY --from=builder /app/dist ./dist

# Chạy file index.js trong thư mục dist (vì index.ts sẽ được compile thành index.js)
EXPOSE 4000
CMD ["node", "dist/index.js"]