// 데이터 저장소: Node.js 내장 SQLite(node:sqlite)를 사용해 별도 설치 없이 동작한다.
// 모든 데이터는 계정(user_id) 단위로 저장되므로 같은 계정으로 로그인한 PC·휴대폰이 같은 데이터를 본다.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 스키마 변경은 항상 "추가"만 한다. 업데이트 후에도 기존 데이터가 그대로 유지되도록
// user_version 으로 마이그레이션 단계를 관리한다.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'trial',
    plan_until TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE stores (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'friendly',
    emoji TEXT NOT NULL DEFAULT 'some',
    greeting TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    sample_replies TEXT NOT NULL DEFAULT '',
    avoid_words TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    rating INTEGER NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    menu TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    sentiment TEXT NOT NULL DEFAULT '',
    is_malicious INTEGER NOT NULL DEFAULT 0,
    malicious_reason TEXT NOT NULL DEFAULT '',
    drafts TEXT NOT NULL DEFAULT '[]',
    calm_reply TEXT NOT NULL DEFAULT '',
    guidance TEXT NOT NULL DEFAULT '',
    final_reply TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    posted_at TEXT
  );
  CREATE INDEX idx_reviews_user ON reviews(user_id, created_at DESC);
  CREATE TABLE usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    generations INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
  );
  `,
  // v1.1: 가게 프로필 확장, 답글 수정률·안전 경고, 정기결제, 공식 API 연동
  `
  ALTER TABLE stores ADD COLUMN owner_title TEXT NOT NULL DEFAULT '';
  ALTER TABLE stores ADD COLUMN signature_menus TEXT NOT NULL DEFAULT '';
  ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'paste';
  ALTER TABLE reviews ADD COLUMN external_id TEXT;
  ALTER TABLE reviews ADD COLUMN chosen_draft TEXT NOT NULL DEFAULT '';
  ALTER TABLE reviews ADD COLUMN edit_rate REAL;
  ALTER TABLE reviews ADD COLUMN approved_at TEXT;
  ALTER TABLE reviews ADD COLUMN publish_error TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX idx_reviews_external ON reviews(user_id, external_id) WHERE external_id IS NOT NULL;
  CREATE TABLE subscriptions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    customer_key TEXT NOT NULL,
    billing_key TEXT NOT NULL,
    card_label TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    next_billing_at TEXT NOT NULL,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    canceled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    payment_key TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);
  CREATE TABLE integrations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token TEXT NOT NULL DEFAULT '',
    access_expires_at INTEGER NOT NULL DEFAULT 0,
    account_name TEXT NOT NULL DEFAULT '',
    location_name TEXT NOT NULL DEFAULT '',
    location_title TEXT NOT NULL DEFAULT '',
    connected_at TEXT NOT NULL,
    last_synced_at TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, provider)
  );
  `,
];

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function now() {
  return new Date().toISOString();
}

export function currentMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
