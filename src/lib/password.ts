// Password hashing (bcryptjs — pure JS, no native build needed on Windows).
import bcrypt from 'bcryptjs';

// bcrypt cost factor. 12 ≈ ~250ms/hash on modern hardware — a good brute-force cost.
// Existing 10-round hashes still verify; they upgrade to 12 on the next password change.
const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
