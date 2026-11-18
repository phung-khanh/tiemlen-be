import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import { AuthenticatedRequest } from "../types/authencation";

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string;
  name?: string;
  picture?: string;
  iss?: string;
}

interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: "user" | "store_manager" | "admin";
  avatar: string | null;
  fullName: string | null;
  phone: string | null;
}

const publicUserFields = `
  id, username, email, role, avatar,
  full_name AS "fullName", phone
`;

const issueToken = (user: Pick<UserRecord, "id" | "email">) => {
  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error("JWT_SECRET_KEY is not configured");
  return jwt.sign({ id: user.id, email: user.email }, secret, {
    expiresIn: "30d",
  });
};

const verifyGoogleCredential = async (credential: string) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");

  const tokenInfoUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
  tokenInfoUrl.searchParams.set("id_token", credential);
  const response = await fetch(tokenInfoUrl);
  if (!response.ok) return null;

  const identity = (await response.json()) as GoogleTokenInfo;
  if (
    identity.aud !== clientId ||
    !identity.sub ||
    !identity.email ||
    identity.email_verified !== "true" ||
    !["accounts.google.com", "https://accounts.google.com"].includes(
      identity.iss || "",
    )
  ) {
    return null;
  }

  return identity;
};

export const signInWithGoogle = async (credential: string) => {
  if (!process.env.JWT_SECRET_KEY) {
    throw new Error("JWT_SECRET_KEY is not configured");
  }
  const identity = await verifyGoogleCredential(credential);
  if (!identity) {
    return {
      statusCode: 401,
      payload: { message: "Google sign-in could not be verified." },
    };
  }

  const email = identity.email!.trim().toLowerCase();
  const bootstrapEmail =
    process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<
      UserRecord & { google_subject: string | null }
    >(
      `SELECT ${publicUserFields}, google_subject
       FROM users
       WHERE email = $1 OR google_subject = $2
       FOR UPDATE`,
      [email, identity.sub],
    );
    if (existing.rows.length > 1) {
      await client.query("ROLLBACK");
      return {
        statusCode: 409,
        payload: {
          message: "Google identity conflicts with an existing account.",
        },
      };
    }

    let user: UserRecord;
    if (existing.rows[0]) {
      const current = existing.rows[0];
      if (current.google_subject && current.google_subject !== identity.sub) {
        await client.query("ROLLBACK");
        return {
          statusCode: 409,
          payload: {
            message: "This account is linked to a different Google identity.",
          },
        };
      }

      const updated = await client.query<UserRecord>(
        `UPDATE users
         SET google_subject = $2,
             login_method = 'google',
             full_name = COALESCE(full_name, $3),
             avatar = COALESCE(avatar, $4),
             role = CASE WHEN $5::text IS NOT NULL AND email = $5 THEN 'admin' ELSE role END,
             updated_at = NOW()
         WHERE id = $1 AND is_active = TRUE
         RETURNING ${publicUserFields}`,
        [
          current.id,
          identity.sub,
          identity.name || null,
          identity.picture || null,
          bootstrapEmail || null,
        ],
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return {
          statusCode: 403,
          payload: { message: "This account is disabled." },
        };
      }
      user = updated.rows[0];
    } else {
      const usernameBase = (email.split("@")[0] || "customer")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 40);
      const username = `${usernameBase || "customer"}-${identity.sub!.slice(-8)}`;
      const created = await client.query<UserRecord>(
        `INSERT INTO users
           (username, email, role, login_method, google_subject, full_name, avatar)
         VALUES ($1, $2, CASE WHEN $3::text IS NOT NULL AND $2 = $3 THEN 'admin' ELSE 'user' END,
                 'google', $4, $5, $6)
         RETURNING ${publicUserFields}`,
        [
          username,
          email,
          bootstrapEmail || null,
          identity.sub,
          identity.name || null,
          identity.picture || null,
        ],
      );
      user = created.rows[0];
    }

    await client.query("COMMIT");
    return {
      statusCode: 200,
      payload: { token: issueToken(user), user },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getCurrentUser = async (userId: string) => {
  const { rows } = await pool.query<UserRecord>(
    `SELECT ${publicUserFields} FROM users WHERE id = $1 AND is_active = TRUE`,
    [userId],
  );
  return rows[0] || null;
};

export const updateCurrentUser = async (
  userId: string,
  input: { fullName: string; phone: string },
) => {
  const { rows } = await pool.query<UserRecord>(
    `UPDATE users
     SET full_name = $2, phone = $3, updated_at = NOW()
     WHERE id = $1 AND is_active = TRUE
     RETURNING ${publicUserFields}`,
    [userId, input.fullName.trim(), input.phone.trim()],
  );
  return rows[0] || null;
};

export const getRequestUser = (request: AuthenticatedRequest) => request.user;
