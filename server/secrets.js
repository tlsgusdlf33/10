// 민감 정보(정기결제 빌링키, 구글 연동 토큰) 암호화: AES-256-GCM.
// 키는 SECRET_KEY 환경변수(64자리 hex) 또는 data/secret.key 파일(최초 실행 시 자동 생성)에서 읽는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadSecretKey(dataDir, envValue) {
  if (envValue) {
    const key = Buffer.from(envValue, 'hex');
    if (key.length !== 32) throw new Error('SECRET_KEY 는 64자리 16진수(32바이트)여야 합니다.');
    return key;
  }
  const file = path.join(dataDir, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

export function createSealer(key) {
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    },
    open(sealed) {
      const [v, iv, tag, data] = String(sealed).split('.');
      if (v !== 'v1') throw new Error('알 수 없는 암호화 형식');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
