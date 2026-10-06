// 계정·로그인 처리: 비밀번호는 scrypt 로 해시하고, 로그인 토큰은 해시만 DB 에 저장한다.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId, device) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    String(device || '').slice(0, 120),
    ts,
    ts,
  );
  return token;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function sessionIdOf(token) {
  // 기기 목록에서 "현재 기기"를 구분하고, 다른 기기 로그아웃에 쓰는 공개 식별자 (토큰 자체는 노출하지 않는다).
  return hashToken(token).slice(0, 16);
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function authenticate(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash, s.last_seen, u.id, u.email, u.plan, u.plan_until, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (Date.now() - Date.parse(row.last_seen) > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), row.token_hash);
  }
  return { id: row.id, email: row.email, plan: row.plan, planUntil: row.plan_until, createdAt: row.created_at, token };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateCredentials(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return '올바른 이메일 주소를 입력해 주세요.';
  if (typeof password !== 'string' || password.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (password.length > 200) return '비밀번호가 너무 깁니다.';
  return null;
}
