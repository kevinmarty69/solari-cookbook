import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"

const scrypt = promisify(nodeScrypt)

interface UserRecord {
  id: string
  name?: string
  email: string
  passwordSalt: string
  passwordHash: string
  createdAt: string
}

interface SessionRecord {
  tokenHash: string
  userId: string
  expiresAt: string
}

interface AuthData {
  users: UserRecord[]
  sessions: SessionRecord[]
}

export interface AuthUser {
  id: string
  name: string
  email: string
}

export class AuthError extends Error {
  constructor(readonly code: "EMAIL_TAKEN" | "INVALID_CREDENTIALS" | "INVALID_INPUT", message: string) {
    super(message)
  }
}

function encode(value: Buffer): string {
  return value.toString("base64url")
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("INVALID_INPUT", "A valid email is required")
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError("INVALID_INPUT", "A valid email is required")
  }
  return email
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new AuthError("INVALID_INPUT", "Password must contain 12 to 128 characters")
  }
  return value
}

function normalizeName(value: unknown, email: string): string {
  if (value === undefined) return email.split("@", 1)[0]
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 80) {
    throw new AuthError("INVALID_INPUT", "Name must contain 2 to 80 characters")
  }
  return value.trim().replace(/\s+/g, " ")
}

async function passwordHash(password: string, salt: string): Promise<string> {
  return encode(await scrypt(password, salt, 64) as Buffer)
}

function equalHash(left: string, right: string): boolean {
  const first = Buffer.from(left, "base64url")
  const second = Buffer.from(right, "base64url")
  return first.length === second.length && timingSafeEqual(first, second)
}

export class AuthStore {
  private lock = Promise.resolve()
  private readonly dummySalt = randomBytes(16).toString("base64url")

  constructor(
    private readonly file: string,
    private readonly sessionMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(): Promise<AuthData> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as AuthData
      if (!Array.isArray(data.users) || !Array.isArray(data.sessions)) throw new Error("invalid auth store")
      return data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { users: [], sessions: [] }
      throw error
    }
  }

  private async write(data: AuthData): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  private async mutate<T>(operation: (data: AuthData) => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.lock
    this.lock = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const data = await this.read()
      data.sessions = data.sessions.filter(({ expiresAt }) => Date.parse(expiresAt) > this.now())
      const result = await operation(data)
      await this.write(data)
      return result
    } finally {
      release()
    }
  }

  private session(data: AuthData, user: UserRecord): { user: AuthUser; token: string; expiresAt: string } {
    const token = randomBytes(32).toString("base64url")
    const expiresAt = new Date(this.now() + this.sessionMs).toISOString()
    data.sessions.push({ tokenHash: tokenHash(token), userId: user.id, expiresAt })
    return { user: { id: user.id, name: user.name ?? user.email.split("@", 1)[0], email: user.email }, token, expiresAt }
  }

  async signup(emailValue: unknown, passwordValue: unknown, nameValue?: unknown): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
    const email = normalizeEmail(emailValue)
    const password = validatePassword(passwordValue)
    const name = normalizeName(nameValue, email)
    const salt = randomBytes(16).toString("base64url")
    const hashed = await passwordHash(password, salt)
    return this.mutate(async (data) => {
      if (data.users.some((user) => user.email === email)) throw new AuthError("EMAIL_TAKEN", "An account already exists for this email")
      const user = { id: randomUUID(), name, email, passwordSalt: salt, passwordHash: hashed, createdAt: new Date(this.now()).toISOString() }
      data.users.push(user)
      return this.session(data, user)
    })
  }

  async login(emailValue: unknown, passwordValue: unknown): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
    const email = normalizeEmail(emailValue)
    const passwordValid = typeof passwordValue === "string" && passwordValue.length > 0 && passwordValue.length <= 128
    const password = passwordValid ? passwordValue : "invalid-login-password"
    const data = await this.read()
    const user = data.users.find((candidate) => candidate.email === email)
    const candidate = await passwordHash(password, user?.passwordSalt ?? this.dummySalt)
    if (!passwordValid || !user || !equalHash(candidate, user.passwordHash)) throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password")
    return this.mutate(async (current) => {
      const freshUser = current.users.find((candidateUser) => candidateUser.id === user.id)
      if (!freshUser) throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password")
      return this.session(current, freshUser)
    })
  }

  async authenticate(token: string | undefined): Promise<AuthUser | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const hashedToken = tokenHash(token)
    const data = await this.read()
    const session = data.sessions.find((candidate) => equalHash(candidate.tokenHash, hashedToken) && Date.parse(candidate.expiresAt) > this.now())
    const user = session && data.users.find((candidate) => candidate.id === session.userId)
    return user && { id: user.id, name: user.name ?? user.email.split("@", 1)[0], email: user.email }
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return
    const hashedToken = tokenHash(token)
    await this.mutate(async (data) => {
      data.sessions = data.sessions.filter((session) => !equalHash(session.tokenHash, hashedToken))
    })
  }
}
