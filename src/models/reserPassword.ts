export interface PasswordReset {
  email: string;
  otp: string;
  expiresAt: Date;
}
