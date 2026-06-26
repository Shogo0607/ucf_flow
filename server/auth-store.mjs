import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DB_PATH = process.env.AUTH_DB_PATH || path.resolve(process.cwd(), "data", "auth-db.json");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

export const DEMO_ACCOUNTS = [
  { email: "admin@example.test", name: "検証管理者", password: "Password123!", role: "admin" },
  { email: "user@example.test", name: "検証ユーザ", password: "Password123!", role: "user" }
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

async function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AuthStore {
  constructor({ filePath = DEFAULT_DB_PATH, seedDemoAccounts = false } = {}) {
    this.filePath = filePath;
    this.seedDemoAccounts = seedDemoAccounts;
    this.writeQueue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.db = JSON.parse(raw);
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
      this.db = { users: [], sessions: [] };
      await this.save();
    }
    if (!Array.isArray(this.db.users)) this.db.users = [];
    if (!Array.isArray(this.db.sessions)) this.db.sessions = [];
    if (this.seedDemoAccounts) await this.ensureDemoAccounts();
    await this.pruneExpiredSessions();
  }

  async save() {
    const payload = JSON.stringify(this.db, null, 2);
    await fs.writeFile(this.filePath, payload + "\n", "utf8");
  }

  async ensureReady() {
    await this.ready;
  }

  async withWriteLock(fn) {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async ensureDemoAccounts() {
    for (const account of DEMO_ACCOUNTS) {
      const existing = this.findUserByEmail(account.email);
      if (!existing) {
        await this.createUserRecord(account, { allowAdmin: true });
      } else {
        let changed = false;
        if (existing.role !== account.role) {
          existing.role = account.role;
          changed = true;
        }
        if (existing.status !== "active") {
          existing.status = "active";
          changed = true;
        }
        if (changed) {
          existing.updatedAt = nowIso();
          await this.save();
        }
      }
    }
  }

  validateUserInput({ email, name, password }, { requirePassword = true } = {}) {
    const cleanEmail = normalizeEmail(email);
    const cleanName = String(name || "").trim();
    const cleanPassword = String(password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new AuthError(400, "invalid_email", "有効なメールアドレスを入力してください。");
    }
    if (cleanName.length < 1 || cleanName.length > 80) {
      throw new AuthError(400, "invalid_name", "名前は1〜80文字で入力してください。");
    }
    if (requirePassword && cleanPassword.length < 8) {
      throw new AuthError(400, "weak_password", "パスワードは8文字以上で入力してください。");
    }
    return { email: cleanEmail, name: cleanName, password: cleanPassword };
  }

  findUserByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    return this.db.users.find((user) => user.email === cleanEmail) || null;
  }

  findUserById(id) {
    return this.db.users.find((user) => user.id === id) || null;
  }

  async hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scrypt(password, salt);
    return `scrypt:${salt}:${hash}`;
  }

  async verifyPassword(password, passwordHash) {
    const [scheme, salt, hash] = String(passwordHash || "").split(":");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = await scrypt(password, salt);
    return timingSafeEqualHex(candidate, hash);
  }

  async createUser(input, { allowAdmin = false } = {}) {
    await this.ensureReady();
    return this.withWriteLock(() => this.createUserRecord(input, { allowAdmin }));
  }

  async createUserRecord(input, { allowAdmin = false } = {}) {
    const { email, name, password } = this.validateUserInput(input);
    if (this.findUserByEmail(email)) {
      throw new AuthError(409, "email_exists", "このメールアドレスはすでに登録されています。");
    }
    const role = allowAdmin && input.role === "admin" ? "admin" : "user";
    const status = input.status === "disabled" ? "disabled" : "active";
    const timestamp = nowIso();
    const user = {
      id: crypto.randomUUID(),
      email,
      name,
      role,
      status,
      passwordHash: await this.hashPassword(password),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: null
    };
    this.db.users.push(user);
    await this.save();
    return publicUser(user);
  }

  async authenticate(email, password) {
    await this.ensureReady();
    const user = this.findUserByEmail(email);
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new AuthError(401, "invalid_credentials", "メールアドレスまたはパスワードが正しくありません。");
    }
    if (user.status !== "active") {
      throw new AuthError(403, "user_disabled", "このユーザは無効化されています。");
    }
    user.lastLoginAt = nowIso();
    user.updatedAt = user.updatedAt || user.lastLoginAt;
    const session = await this.createSession(user.id);
    await this.save();
    return { user: publicUser(user), session };
  }

  async createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.db.sessions.push({
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      userId,
      createdAt: nowIso(),
      expiresAt
    });
    return { token, expiresAt };
  }

  async getUserForSession(token) {
    await this.ensureReady();
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.db.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.deleteSession(token);
      return null;
    }
    const user = this.findUserById(session.userId);
    if (!user || user.status !== "active") return null;
    return publicUser(user);
  }

  async deleteSession(token) {
    await this.ensureReady();
    const tokenHash = hashToken(token);
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter((item) => item.tokenHash !== tokenHash);
    if (this.db.sessions.length !== before) await this.save();
  }

  async pruneExpiredSessions() {
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter((item) => Date.parse(item.expiresAt) > Date.now());
    if (this.db.sessions.length !== before) await this.save();
  }

  listUsers() {
    return this.db.users
      .slice()
      .sort((a, b) => a.email.localeCompare(b.email))
      .map(publicUser);
  }

  activeAdminCount(exceptUserId = null) {
    return this.db.users.filter((user) => user.id !== exceptUserId && user.role === "admin" && user.status === "active").length;
  }

  async updateUser(id, patch) {
    await this.ensureReady();
    return this.withWriteLock(() => this.updateUserRecord(id, patch));
  }

  async updateUserRecord(id, patch) {
    const user = this.findUserById(id);
    if (!user) throw new AuthError(404, "user_not_found", "ユーザが見つかりません。");

    if (patch.email != null) {
      const email = normalizeEmail(patch.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, "invalid_email", "有効なメールアドレスを入力してください。");
      const duplicate = this.findUserByEmail(email);
      if (duplicate && duplicate.id !== id) throw new AuthError(409, "email_exists", "このメールアドレスはすでに登録されています。");
      user.email = email;
    }
    if (patch.name != null) {
      const name = String(patch.name || "").trim();
      if (name.length < 1 || name.length > 80) throw new AuthError(400, "invalid_name", "名前は1〜80文字で入力してください。");
      user.name = name;
    }
    if (patch.role != null) {
      if (!["admin", "user"].includes(patch.role)) throw new AuthError(400, "invalid_role", "ロールが正しくありません。");
      if (user.role === "admin" && patch.role !== "admin" && this.activeAdminCount(id) < 1) {
        throw new AuthError(400, "last_admin", "最後の有効な管理者は一般ユーザに変更できません。");
      }
      user.role = patch.role;
    }
    if (patch.status != null) {
      if (!["active", "disabled"].includes(patch.status)) throw new AuthError(400, "invalid_status", "ステータスが正しくありません。");
      if (user.status === "active" && patch.status === "disabled" && user.role === "admin" && this.activeAdminCount(id) < 1) {
        throw new AuthError(400, "last_admin", "最後の有効な管理者は無効化できません。");
      }
      user.status = patch.status;
      if (patch.status === "disabled") {
        this.db.sessions = this.db.sessions.filter((session) => session.userId !== id);
      }
    }
    user.updatedAt = nowIso();
    await this.save();
    return publicUser(user);
  }

  async resetPassword(id, password) {
    await this.ensureReady();
    return this.withWriteLock(() => this.resetPasswordRecord(id, password));
  }

  async resetPasswordRecord(id, password) {
    const user = this.findUserById(id);
    if (!user) throw new AuthError(404, "user_not_found", "ユーザが見つかりません。");
    if (String(password || "").length < 8) throw new AuthError(400, "weak_password", "パスワードは8文字以上で入力してください。");
    user.passwordHash = await this.hashPassword(password);
    user.updatedAt = nowIso();
    this.db.sessions = this.db.sessions.filter((session) => session.userId !== id);
    await this.save();
    return publicUser(user);
  }
}

export function createAuthStore(options) {
  return new AuthStore(options);
}
