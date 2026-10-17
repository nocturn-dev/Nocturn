import { STORAGE_KEYS } from "./storageKeys";
/**
 * Локальный профиль пользователя («Профиль пользователя» в настройках):
 * имя, аватар, роль, предпочтения. Всё живёт ТОЛЬКО в localStorage этого
 * устройства. Принцип анонимности: каждое личное поле имеет собственный
 * share-тумблер — в модель уходит только явно разрешённое; аватар — чистый
 * UI-элемент и в промт не попадает никогда. По умолчанию всё выключено.
 */

export type RoleId =
  | ""
  | "software_engineer"
  | "product"
  | "design"
  | "data"
  | "student"
  | "other";

export type AnswersLang = "" | "ru" | "en" | "zh" | "ja";
export type Tone = "" | "neutral" | "concise" | "detailed" | "friendly" | "formal";

export interface UserProfile {
  /** UI + инъекция при nameShare */
  name: string;
  nameShare: boolean;
  /** dataURL (≤256px), чистый UI — модели не отправляется */
  avatar: string;
  role: RoleId;
  /** Свой вариант роли при role === "other" */
  roleCustom: string;
  roleShare: boolean;
  answersLang: AnswersLang;
  langShare: boolean;
  tone: Tone;
  toneShare: boolean;
  stack: string;
  stackShare: boolean;
  focus: string;
  focusShare: boolean;
  instructions: string;
  instructionsShare: boolean;
}

export const DEFAULT_PROFILE: UserProfile = {
  name: "",
  nameShare: false,
  avatar: "",
  role: "",
  roleCustom: "",
  roleShare: false,
  answersLang: "",
  langShare: false,
  tone: "",
  toneShare: false,
  stack: "",
  stackShare: false,
  focus: "",
  focusShare: false,
  instructions: "",
  instructionsShare: false,
};

const KEY = STORAGE_KEYS.userProfile;

/** Кэш АВЕТАРА: UserCard читает его на каждый рендер сообщения —
 *  localStorage дёргать на этом нельзя */
let avatarCache: string | null | undefined;
/** Кэш всего профиля: ChatArea читает имя на каждый рендер ленты (~60 раз/с
 *  во время стрима), а в localStorage лежит data-URL аватара — полный
 *  JSON.parse на каждый рендер грел главный поток. Инвалидируется только
 *  saveProfile (единственный писатель); смена профиля в другом окне
 *  подхватится при следующем saveProfile этого окна */
let profileCache: UserProfile | null = null;

export function loadProfile(): UserProfile {
  if (profileCache) return profileCache;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const p = { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<UserProfile>) };
    avatarCache = p.avatar || "";
    profileCache = p;
    return p;
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** Сохранить профиль. false — запись не удалась (обычно квота localStorage,
 *  чаще всего из-за data-URL аватара): кэш при этом не трогаем, иначе UI
 *  и buildProfileBlock показывали бы то, чего после рестарта не будет.
 *  Вызывающий код обязан сообщить пользователю о сбое */
export function saveProfile(p: UserProfile): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    return false;
  }
  avatarCache = p.avatar || "";
  profileCache = { ...p };
  return true;
}

/** Аватар для ленты (кэш, без чтения localStorage на каждый рендер) */
export function getUserAvatar(): string {
  if (avatarCache === undefined) {
    try {
      avatarCache = (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UserProfile>).avatar ?? "";
    } catch {
      avatarCache = "";
    }
  }
  return avatarCache ?? "";
}

/** Имя для UI-приветствия (локально, share-тумблер тут не важен) */
export function getUserDisplayName(): string {
  return loadProfile().name.trim();
}

/** Канонические английские подписи ролей: модель видит стабильный текст
 *  независимо от языка интерфейса */
const ROLE_EN: Record<Exclude<RoleId, "">, string> = {
  software_engineer: "software engineer",
  product: "product management",
  design: "design",
  data: "data science",
  student: "student",
  other: "",
};

const LANG_EN: Record<Exclude<AnswersLang, "">, string> = {
  ru: "Russian",
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
};

const TONE_EN: Record<Exclude<Tone, "">, string> = {
  neutral: "neutral",
  concise: "concise, to the point",
  detailed: "detailed and thorough",
  friendly: "friendly and casual",
  formal: "formal and professional",
};

/** Свободный текст пользователя уходит в system-блок модели: перенос строки
 *  рисовал бы новый пункт списка (инъекция в системные инструкции), а
 *  вставленный по ошибке секрет уезжал бы провайдеру. null — поле не
 *  инъектируем */
const sanitizeShared = (raw: string): string | null => {
  const v = raw.replace(/[\r\n]+/g, " ").trim();
  if (!v) return null;
  // Явные маркеры секретов: чаще всего это случайная вставка не в то поле
  if (
    /\bsk-[a-z0-9_-]{8,}/i.test(v) ||
    /\b(api[-_ ]?key|access[-_ ]?token|secret|password|пароль|секрет|токен)\b\s*[:=]/i.test(v)
  ) {
    return null;
  }
  return v;
};

/** Собрать system-блок профиля из ТОЛЬКО расшаренных полей.
 *  null — нечего инъектировать (всё выключено или пусто) */
export function buildProfileBlock(): string | null {
  const p = loadProfile();
  const lines: string[] = [];
  const add = (share: boolean, value: string, line: (v: string) => string) => {
    const v = sanitizeShared(value);
    if (share && v) lines.push(`- ${line(v)}`);
  };
  add(p.nameShare, p.name, (v) => `Name: ${v} (address the user by name)`);
  const roleEn = p.role ? ROLE_EN[p.role] : "";
  add(
    p.roleShare,
    p.role === "other" ? p.roleCustom : roleEn,
    (v) => `Field of work: ${v}`,
  );
  if (p.langShare && p.answersLang) {
    lines.push(`- Always respond in ${LANG_EN[p.answersLang]}`);
  }
  if (p.toneShare && p.tone) {
    lines.push(`- Preferred answer style: ${TONE_EN[p.tone]}`);
  }
  add(p.stackShare, p.stack, (v) => `Preferred stack/tools: ${v}`);
  add(p.focusShare, p.focus, (v) => `Currently working on: ${v}`);
  add(p.instructionsShare, p.instructions, (v) => `Extra user instructions: ${v}`);
  if (lines.length === 0) return null;
  return `User profile (stored locally, shared by the user):\n${lines.join("\n")}`;
}
