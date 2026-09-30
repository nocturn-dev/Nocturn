//! Шифрование API-ключей: AES-256-GCM, ключ выводится из мастер-пароля
//! пользователя (Argon2id, 19 MiB, t=2, p=1). PBKDF2-HMAC-SHA256 (200k
//! итераций) оставлен как легаси-KDF только для чтения старых crypto.json.
//!
//! Формат зашифрованной строки: `enc:v1:<base64(nonce ‖ ciphertext)>`.
//! Производный ключ существует только в памяти процесса: родился при
//! создании пароля или разблокировке — умер вместе с приложением.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};
use zeroize::{Zeroize, Zeroizing};

const PREFIX: &str = "enc:v1:";
const KEY_LEN: usize = 32; // AES-256
const PBKDF2_ITERS: u32 = 200_000;
const KEY_CHECK_MARKER: &str = "nocturn-key-check";

/// Авто-запирание: 15 минут без операций шифрования/расшифровки —
/// ключ стирается из памяти. Окно времени фикс: настройки на этот счёт
/// сознательно нет, чтобы не соблазнять выключить безопасность вовсе.
const VAULT_IDLE: Duration = Duration::from_secs(15 * 60);

/// Всё состояние хранилища под ОДНИМ мьютексом: ключ и отметки
/// использования не могут разойтись, порядка блокировок нет вовсе —
/// взаимоблокировка и гонка «установили ключ, но не успели продлить окно»
/// невозможны по построению.
struct Vault {
    /// Производный ключ. None — хранилище заперто.
    /// Zeroizing: ключ затирается при любом drop (замена, авто-лок, выход)
    key: Option<Zeroizing<Vec<u8>>>,
    /// Последнее использование: (Instant, SystemTime). Два таймера сразу:
    /// Instant на Linux/macOS не идёт во время сна системы, и закрытый на
    /// ночь ноутбук продлевал бы окно на всё время сна. Истёк — если истёк
    /// ЛЮБОЙ из двух. SystemTime умеет скакать (NTP), поэтому он
    /// страхующий, не единственный
    last_use: Option<(Instant, SystemTime)>,
}

impl Vault {
    const fn new() -> Self {
        Vault {
            key: None,
            last_use: None,
        }
    }

    fn touch(&mut self) {
        self.last_use = Some((Instant::now(), SystemTime::now()));
    }

    /// Стереть ключ (Zeroizing затирает буфер в Drop) и отметки
    fn clear(&mut self) {
        self.key.take();
        self.last_use = None;
    }

    /// Истёк ли простой к моменту now/wall. Окно — параметр: тест авто-
    /// запирания гоняется без sleep и без глобального состояния
    fn idle_expired_at(&self, window: Duration, now: Instant, wall: SystemTime) -> bool {
        let Some((last_instant, last_wall)) = self.last_use else {
            return false;
        };
        if now.saturating_duration_since(last_instant) > window {
            return true;
        }
        // Часы ушли назад (NTP): duration_since вернёт Err — не считаем
        // истёкшим, Instant-таймер продолжает тикать
        wall.duration_since(last_wall)
            .map(|d| d > window)
            .unwrap_or(false)
    }
}

static VAULT: Mutex<Vault> = Mutex::new(Vault::new());

/// Единый гейт к состоянию: проверка простоя и стирание протухшего ключа —
/// под одной блокировкой. into_inner: при poison стирание не имеет права
/// быть no-op'ом (иначе ключ остаётся в памяти, а has_key() = false)
fn vault_guard() -> MutexGuard<'static, Vault> {
    let mut guard = VAULT.lock().unwrap_or_else(|p| p.into_inner());
    if guard.idle_expired_at(VAULT_IDLE, Instant::now(), SystemTime::now()) {
        guard.clear();
    }
    guard
}

/// Свипер lib.rs (раз в минуту): тот же единый гейт, что и у крипто-
/// операций — ключ не висит в памяти, пока приложение свернуто
pub(crate) fn vault_sweep() {
    drop(vault_guard());
}

pub fn has_key() -> bool {
    // Протухший ключ гасится прямо в гейте: UI-опрос крипто-статуса увидит
    // «заперто» и покажет гейт разблокировки
    vault_guard().key.is_some()
}

pub fn set_key(key: Zeroizing<Vec<u8>>) {
    let mut guard = VAULT.lock().unwrap_or_else(|p| p.into_inner());
    // Старый ключ (если был) затирается Drop'ом Zeroizing при замене.
    // Ключ и отметка ставятся под одной блокировкой: гонки нет
    guard.key = Some(key);
    guard.touch();
}

pub fn clear_key() {
    VAULT.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// PBKDF2-HMAC-SHA256: пароль + соль → 32-байтный ключ AES.
/// Легаси-KDF: нужен только для чтения старых crypto.json (до Argon2id);
/// 200k итераций — ниже текущей рекомендации OWASP (600k), для НОВЫХ
/// хранилищ не использовать. Ключ в Zeroizing с момента выделения
pub fn derive_key(password: &str, salt: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(vec![0u8; KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
}

/// Параметры Argon2id фиксируем ЯВНО, не через Params::default(): дефолт —
/// свойство версии крейта (в 0.4 было m=4 MiB, t=3, в 0.5 — OWASP), его
/// смена меняла бы вывод KDF и «неверным паролем» запирала все существующие
/// хранилища. Числа совпадают с default() argon2 0.5 — ключи пользователей
/// не меняются; подъём параметров = отдельная миграция с kdf-меткой
/// в crypto.json
fn argon2_params() -> Result<argon2::Params, String> {
    argon2::Params::new(19 * 1024, 2, 1, Some(KEY_LEN)).map_err(|e| format!("argon2 params: {e}"))
}

/// Argon2id — актуальный KDF хранилища. Детерминирован: тот же пароль+соль
/// → тот же ключ.
pub fn derive_key_argon2(password: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use argon2::{Algorithm, Argon2, Version};
    let params = argon2_params()?;
    // Zeroizing сразу: ранний `?` ниже не оставит незатёртый ключ
    let mut out = Zeroizing::new(vec![0u8; KEY_LEN]);
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    // Раньше expect: единственный panic-путь криптомодуля на пути с
    // пользовательским вводом — вместо паники процесса отдаём ошибку наружу
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| format!("argon2 derive failed: {e}"))?;
    Ok(out)
}

pub fn new_salt() -> Vec<u8> {
    let mut salt = vec![0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Зашифровать строку текущим ключом. `enc:v1:…`; Err — хранилище заперто.
/// Ключ читается по месту (borrow) — без копий в heap
pub fn encrypt(plain: &str) -> Result<String, String> {
    let mut guard = vault_guard();
    let result = {
        let key = guard.key.as_ref().ok_or("vault is locked")?;
        encrypt_with(key, plain)
    };
    if result.is_ok() {
        guard.touch();
    }
    result
}

/// То же с явным ключом (миграция PBKDF2 → Argon2id)
pub fn encrypt_with(key: &[u8], plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend(ct);
    Ok(format!("{PREFIX}{}", B64.encode(blob)))
}

/// Расшифровать строку с префиксом. None — не зашифровано или заперто.
/// Ключ читается по месту (borrow) — без копий в heap. Plaintext обёрнут
/// в Zeroizing: секрет затирается при drop, а не остаётся в освободившейся
/// heap-памяти
pub fn decrypt(stored: &str) -> Option<Zeroizing<String>> {
    let mut guard = vault_guard();
    let result = {
        let key = guard.key.as_ref()?;
        decrypt_with(key, stored)
    };
    if result.is_some() {
        guard.touch();
    }
    result
}

/// То же с явным ключом (миграция PBKDF2 → Argon2id)
pub fn decrypt_with(key: &[u8], stored: &str) -> Option<Zeroizing<String>> {
    let blob = B64.decode(stored.strip_prefix(PREFIX)?).ok()?;
    if blob.len() <= 12 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .ok()?;
    // Zeroizing: расшифрованный plaintext — секрет, затираем при drop, а не
    // оставляем в освободившейся heap-памяти
    match String::from_utf8(pt) {
        Ok(s) => Some(Zeroizing::new(s)),
        Err(e) => {
            // Битый UTF-8 — тот же секрет: затираем байты до отбрасывания
            let mut bytes = e.into_bytes();
            bytes.zeroize();
            None
        }
    }
}

/// Зашифровано ли поле (есть ли префикс)
pub fn is_encrypted(s: &str) -> bool {
    s.starts_with(PREFIX)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    // Байтовый проход вместо слайсинга строки: не-ASCII символы в битом
    // crypto.json раньше паниковали на нечётной char-границе
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some(((hi << 4) | lo) as u8)
        })
        .collect()
}

/// Проверка пароля: строка-маркер, зашифрованная производным ключом.
/// Тот же seal, что и для полей: вторая копия механизма (nonce/blob/
/// префикс) расходилась бы с encrypt_with при любой правке формата
pub fn make_check(key: &[u8]) -> Result<String, String> {
    encrypt_with(key, KEY_CHECK_MARKER)
}

pub fn verify_check(key: &[u8], check: &str) -> bool {
    decrypt_with(key, check).is_some_and(|pt| pt.as_str() == KEY_CHECK_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT — глобальный стат: cargo test гоняет тесты в параллельных
    /// потоках, и clear_key()/set_key() соседа под ногой давали спорадические
    /// падения. Тесты, мутирующие глобал, обязаны идти сериализованно
    static KEY_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn vault_auto_lock_expires_by_either_timer() {
        // Тест работает с локальным Vault, а не с глобалом: ни sleep, ни
        // KEY_LOCK, ни зависимости от аптайма машины не нужны
        const WINDOW: Duration = Duration::from_secs(2);
        let now = Instant::now();
        let wall = SystemTime::now();
        let ago = |secs: u64| {
            (
                now.checked_sub(Duration::from_secs(secs))
                    .expect("uptime too short for test"),
                wall - Duration::from_secs(secs),
            )
        };
        let vault_with = |last_use| Vault {
            key: None,
            last_use,
        };
        // Ни один таймер не истёк
        assert!(!vault_with(Some(ago(1))).idle_expired_at(WINDOW, now, wall));
        // Настенные часы ушли за окно (сон/hibernate) при свежем Instant —
        // ровно ради этого случая существует второй таймер
        let (i, _) = ago(0);
        let (_, w) = ago(3);
        assert!(vault_with(Some((i, w))).idle_expired_at(WINDOW, now, wall));
        // Instant истёк, настенные часы свежие
        let (i, _) = ago(3);
        let (_, w) = ago(0);
        assert!(vault_with(Some((i, w))).idle_expired_at(WINDOW, now, wall));
        // Настенные часы в будущем (NTP назад) при свежем Instant — не истёк
        let (i, _) = ago(0);
        assert!(!vault_with(Some((i, wall + Duration::from_secs(60))))
            .idle_expired_at(WINDOW, now, wall));
        // Отметок нет — не истёкло
        assert!(!vault_with(None).idle_expired_at(WINDOW, now, wall));
    }

    #[test]
    fn clear_wipes_key_and_marks() {
        let mut v = Vault::new();
        v.key = Some(Zeroizing::new(vec![1u8; KEY_LEN]));
        v.touch();
        v.clear();
        assert!(v.key.is_none());
        assert!(v.last_use.is_none());
    }

    #[test]
    fn argon2_params_match_crate_default() {
        // Страховка при `cargo update`: если дефолт argon2 когда-нибудь
        // сменится, явные параметры перестанут совпадать с тем, что считает
        // «по умолчанию» крейт — повод осознанно решить, нужна ли миграция
        let explicit = argon2::Params::new(19 * 1024, 2, 1, None).unwrap();
        assert_eq!(explicit, argon2::Params::default());
    }

    #[test]
    fn argon2_params_golden_vector() {
        // Закрепление ЯВНЫХ параметров (19 MiB, t=2, p=1, out=32) hex-вектором:
        // любая опечатка в числах или случайная правка меняет вывод KDF и
        // «неверным паролем» запирает существующие хранилища — это падает
        // здесь, в CI, а не у пользователя на разблокировке. Входы заморожены
        // навсегда: password "nocturn-golden-vector", salt b"nocturn-salt-0123",
        // Argon2id v0x13
        let key = derive_key_argon2("nocturn-golden-vector", b"nocturn-salt-0123").unwrap();
        assert_eq!(
            hex_encode(&key),
            "f72a0011cb945a13f0c37f961d2479b67f76e45bc12f0674e17423542713e801"
        );
    }

    #[test]
    fn hex_decode_rejects_non_ascii_without_panic() {
        // Регресс: не-ASCII с чётной байтовой длиной паниковал на char-границе
        assert_eq!(hex_decode("deadBEEF"), Some(vec![0xde, 0xad, 0xbe, 0xef]));
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zzzz"), None);
        assert_eq!(hex_decode("日日"), None); // 6 байт, не hex
        assert_eq!(hex_decode("д"), None);
    }

    #[test]
    fn roundtrip_with_key() {
        let _serial = KEY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        set_key(derive_key("master-пароль", b"salt-salt-salt-sa"));
        assert!(has_key());
        let secret = "sk-test-ключ-12345";
        let enc = encrypt(secret).expect("encrypt");
        assert!(is_encrypted(&enc));
        assert_ne!(enc, secret);
        assert_eq!(decrypt(&enc).as_deref().map(String::as_str), Some(secret));
        // неверный ключ → не расшифровывается
        set_key(derive_key("другой-пароль", b"salt-salt-salt-sa"));
        assert!(decrypt(&enc).is_none());
        clear_key();
        assert!(!has_key());
    }

    #[test]
    fn check_verifies_password() {
        let key = derive_key("pw", b"salt-salt-salt-sa");
        let check = make_check(&key).unwrap();
        assert!(verify_check(&key, &check));
        let wrong = derive_key("pw2", b"salt-salt-salt-sa");
        assert!(!verify_check(&wrong, &check));
        // Мусор и строка без префикса — false, без паники
        assert!(!verify_check(&key, ""));
        assert!(!verify_check(&key, "enc:v1:AAAA"));
    }

    #[test]
    fn locked_vault_encrypts_nothing() {
        let _serial = KEY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear_key();
        assert!(encrypt("x").is_err());
        assert!(decrypt("enc:v1:AAAA").is_none());
    }

    #[test]
    fn argon2_derive_is_deterministic_and_salt_sensitive() {
        // derive-часть не трогает глобал — мьютекс только вокруг set_key/clear_key
        let a1 = derive_key_argon2("мастер-пароль", b"salt-salt-salt-sa").expect("derive");
        let a2 = derive_key_argon2("мастер-пароль", b"salt-salt-salt-sa").expect("derive");
        let b = derive_key_argon2("мастер-пароль", b"another-salt-16!").expect("derive");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert_eq!(a1.len(), 32);
        // Не совпадает с легаси-KDF на тех же входах
        assert_ne!(a1, derive_key("мастер-пароль", b"salt-salt-salt-sa"));
        let _serial = KEY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Полный roundtrip на argon2-ключе
        set_key(a1.clone());
        let enc = encrypt("sk-secret").expect("encrypt");
        assert_eq!(
            decrypt(&enc).as_deref().map(String::as_str),
            Some("sk-secret")
        );
        // Ключ от другой соли не расшифровывает
        set_key(b);
        assert!(decrypt(&enc).is_none());
        clear_key();
    }
}
