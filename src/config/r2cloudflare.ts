import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import dotenv from "dotenv";
import https from "https";
import sharp from "sharp";
dotenv.config();

const accountId = (process.env.R2_ACCOUNT_ID || "").trim();

export const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: (process.env.R2_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || "").trim(),
  },
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({
      // Alert 40 thường do SNI hoặc Cipher không khớp.
      // Cấu hình này ép buộc TLS 1.2 và giữ kết nối ổn định.
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      keepAlive: true,
      // Chặn lỗi handshake do chứng chỉ không khớp ở môi trường local
      rejectUnauthorized: false,
    }),
  }),
  forcePathStyle: true,
});

/**
 * Upload ảnh Base64 lên R2
 */
export const uploadToR2 = async (base64Data: string, folder: string) => {
  try {
    const publicDomain = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, "");

    const matches = base64Data.match(
      /^data:image\/([A-Za-z-+\/]+);base64,(.+)$/,
    );
    if (!matches) throw new Error("Định dạng ảnh không hợp lệ");

    const buffer = Buffer.from(matches[2], "base64");

    if (buffer.length > 25 * 1024 * 1024) {
      throw new Error("Ảnh quá lớn, vui lòng chọn file dưới 25MB");
    }

    // 1. Lấy kích thước ảnh gốc để tạo lớp phủ watermark vừa khít
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 1200;
    const height = metadata.height || 1800;

    // 2. Tạo Watermark chéo lặp lại (Pattern)
    // Chúng ta tạo một SVG tile nhỏ và để Sharp lặp lại nó (tile: true)
    const watermarkSvg = Buffer.from(
      `<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
    <style>
      .watermark-text {
        fill: rgba(255, 255, 255, 0.1);
        font-size: 32px;
        font-weight: 900;
        font-family: 'Inter', sans-serif;
        letter-spacing: 2px;
      }
    </style>
    <filter id="outline">
      <feMorphology in="SourceAlpha" result="expanded" operator="dilate" radius="1"/>
      <feFlood flood-color="rgba(0,0,0,0.05)" flood-opacity="1" result="color"/>
      <feComposite in="color" in2="expanded" operator="in" result="outline"/>
      <feMerge>
        <feMergeNode in="outline"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <text
      x="50%"
      y="50%"
      text-anchor="middle"
      transform="rotate(-30 250 250)"
      filter="url(#outline)"
      class="watermark-text"
    >
      TOENTEAM
    </text>
  </svg>`,
    );

    const optimizedBuffer = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: 1200,
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .composite([
        {
          input: watermarkSvg,
          tile: true, // Lặp lại watermark khắp toàn bộ bề mặt ảnh
          blend: "over",
        },
      ])
      .webp({
        quality: 75,
        effort: 4,
        smartSubsample: true,
        mixed: true,
      })
      .toBuffer();

    // 4. Upload lên R2
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.webp`;
    const key = `${folder}/${fileName}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: optimizedBuffer,
        ContentType: "image/webp",
        CacheControl: "max-age=31536000",
      }),
    );

    return `${publicDomain}/${key}`;
  } catch (error: any) {
    console.error("❌ R2 Upload Error:", error.message);
    throw error;
  }
};
/**
 * Xóa ảnh khỏi R2
 */
export const deleteFromR2 = async (fileUrl: string) => {
  try {
    if (!fileUrl) return;
    const publicDomain = process.env.R2_PUBLIC_DOMAIN || "";
    const key = fileUrl.replace(`${publicDomain}/`, "");

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
      }),
    );
    console.log(`✅ Deleted: ${key}`);
  } catch (error: any) {
    console.error("❌ R2 Delete Error:", error.message);
  }
};
