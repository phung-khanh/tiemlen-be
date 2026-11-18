export interface User {
  id: string;
  username: string;
  email: string;
  password: string | null;
  role: "user" | "store_manager" | "admin";
  loginMethod: "password" | "google" | "facebook";
  isActive: boolean;
  avatar: string | null;
  createdAt: Date;
  updatedAt: Date;
}
