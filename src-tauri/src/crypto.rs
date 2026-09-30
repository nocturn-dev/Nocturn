//! Шифрование API-ключей: AES-256-GCM, ключ выводится из мастер-пароля
//! пользователя (PBKDF2-HMAC-SHA256, 200k итераций).
//!
//! Формат зашифрованной строки: `enc:v1:<base64(nonce ‖ ciphertext)>`.
//! Производный ключ существует только в памяти процесса: родился при
//! создании пароля или разблокировке — умер вместе с приложением.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

const PREFIX: &str = "enc:v1:";
const KEY_LEN: usize = 32; // AES-256
const PBKDF2_ITERS: u32 = 200_000;

/// Производный ключ в памяти. None — «хранилище» заперто.
/// Zeroizing: ключ затирается при любом drop (замена, авто-лок, выход)
static VAULT_KEY: Mutex<Option<Zeroizing<Vec<u8>>>> = Mutex::new(None);

/// Авто-запирание: 15 минут без операций шифрования/расшифровки —
/// ключ стирается из памяти. Окно времени фикс: настройки на этот счёт
/// сознательно нет, чтобы не соблазнять выключить безопасность вовсе.
const VAULT_IDLE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
static LAST_USE: Mutex<Option<std::time::Instant>> = Mutex::new(None);
/// Настенные часы — второй, страхующий таймер: Instant на Linux/macOS не
/// идёт во время сна системы, и закрытый на ночь ноутбук продлевал окно
/// авто-запирания на всё время сна. Истёк — если истёк ЛЮБОЙ из двух.
/// SystemTime умеет скакать (NTP), поэтому он страхующий, не единственный
static LAST_USE_WALL: Mutex<Option<std::time::SystemTime>> = Mutex::new(None);

/// Отметка использования: продлевает окно авто-запирания.
/// Порядок блокировок глобально строгий: VAULT_KEY → LAST_USE →
/// LAST_USE_WALL (обратного порядка нигде нет — взаимоблокировка
/// невозможна, свипер в lib.rs берёт их в том же порядке)
fn touch_vault() {
    // into_inner: poison — не повод молча не продлевать окно
    *LAST_USE.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
    *LAST_USE_WALL.lock().unwrap_or_else(|p| p.into_inner()) =
        Some(std::time::SystemTime::now());
}

/// Истёк ли простой к моменту now/wall. Окно — параметр: тест авто-
/// запирания гоняется без sleep и без допущения об аптайме машины
fn vault_idle_expired_at(
    window: std::time::Duration,
    now: std::time::Instant,
    wall: std::time::SystemTime,
) -> bool {
    let instant_idle = LAST_USE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_some_and(|t| now.duration_since(t) > window);
    if instant_idle {
        return true;
    }
    // Clock ушёл назад (NTP): duration_since errs — не считаем истёкшим,
    // Instant-таймер продолжает тикать
    LAST_USE_WALL
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_some_and(|t| wall.duration_since(t).map(|d| d > window).unwrap_or(false))
}

/// Единый гейт к VAULT_KEY: проверка простоя и стирание протухшего ключа —
/// под ОДНОЙ блокировкой. Раньше `if vault_idle_expired() { clear_key(); }`
/// в has_key/encrypt/decrypt оставлял окно, в котором clear_key стирал
/// только что установленный другим потоком ключ. into_inner: при poison
/// стирание не имеет права быть no-op'ом (ключ оставался в памяти при
/// has_key() = false)
fn vault_guard() -> std::sync::MutexGuard<'static, Option<Zeroizing<Vec<u8>>>> {
    let mut guard = VAULT_KEY.lock().unwrap_or_else(|p| p.into_inner());
    if vault_idle_expired_at(
        VAULT_IDLE,
        std::time::Instant::now(),
        std::time::SystemTime::now(),
    ) {
        guard.take();
        clear_last_use();
    }
    guard
}

/// Стереть отметки использования (сам ключ затирает в Drop take() у
/// вызывающего — Zeroizing внутри Option)
fn clear_last_use() {
    LAST_USE.lock().unwrap_or_else(|p| p.into_inner()).take();
    LAST_USE_WALL.lock().unwrap_or_else(|p| p.into_inner()).take();
}

/// Свипер lib.rs (раз в минуту): тот же единый гейт, что и у крипто-
/// операций, — без гонки «проверка, затем стирание»
pub(crate) fn vault_sweep() {
    drop(vault_guard());
}

pub fn has_key() -> bool {
    // Протухший ключ гасим прямо здесь: UI-опрос крипто-статуса увидит
    // «заперто» и покажет гейт разблокировки
    vault_guard().is_some()
}

pub fn set_key(key: Zeroizing<Vec<u8>>) {
    // Старый ключ (если был) затираем, а не оставляем в памяти:
    // Zeroizing затирает буфер в своём Drop. into_inner: poison не должен
    // молча терять установку ключа
    *VAULT_KEY.lock().unwrap_or_else(|p| p.into_inner()) = Some(key);
    touch_vault();
}

pub fn clear_key() {
    // Zeroizing внутри Option затирает буфер в Drop при take().
    // into_inner: полное стирание не имеет права быть no-op'ом при poison
    VAULT_KEY.lock().unwrap_or_else(|p| p.into_inner()).take();
    clear_last_use();
}

/// PBKDF2-HMAC-SHA256: пароль + соль → 32-байтный ключ AES.
/// Легаси-KDF: нужен только для чтения старых crypto.json (до Argon2id);
/// 200k итераций — ниже текущей рекомендации OWASP (600k), для НОВЫХ
/// хранилищ не использовать. Ключ в Zeroizing с момента выделения:
/// буфер не живёт вне обёртки ни на одном такте
pub fn derive_key(password: &str, salt: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(vec![0u8; KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
}

/// Argon2id — актуальный KDF хранилища. Детерминирован: тот же пароль+соль
/// → тот же ключ.
pub fn derive_key_argon2(password: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    // Параметры фиксируем ЯВНО, не через Params::default(): дефолт —
    // свойство версии крейта (в 0.4 было m=4 MiB, t=3, в 0.5 — OWASP),
    // смена дефолта меняла бы вывод KDF и «неверным паролем» запирала все
    // существующие хранилища. Числа совпадают с default() текущего 0.5 —
    // ключи пользователей не меняются; подъём параметров = отдельная
    // миграция с kdf-меткой в crypto.json
    let params =
        Params::new(19 * 1024, 2, 1, Some(KEY_LEN)).map_err(|e| format!("argon2 params: {e}"))?;
    // Zeroizing сразу: ранний `?` ниже раньше дропал незатёртый производный
    // ключ (обёртка стояла только на выходе)
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
    let guard = vault_guard();
    let key = guard.as_ref().ok_or("vault is locked")?;
    let result = encrypt_with(key, plain);
    if result.is_ok() {
        touch_vault();
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
/// heap-памяти (см. политику в шапке модуля)
pub fn decrypt(stored: &str) -> Option<Zeroizing<String>> {
    let guard = vault_guard();
    let key = guard.as_ref()?;
    let result = decrypt_with(key, stored);
    if result.is_some() {
        touch_vault();
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
    encrypt_with(key, "nocturn-key-check")
}

pub fn verify_check(key: &[u8], check: &str) -> bool {
    let blob = match B64.decode(check.strip_prefix(PREFIX).unwrap_or("")) {
        Ok(b) => b,
        Err(_) => return false,
    };
    if blob.len() <= 12 {
        return false;
    }
    let cipher = match Aes256Gcm::new_from_slice(key) {
        Ok(c) => c,
        Err(_) => return false,
    };
    cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .map(|pt| pt == b"nocturn-key-check")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// VAULT_KEY — глобальный стат: cargo test гоняет тесты в параллельных
    /// потоках, и clear_key()/set_key() соседа под ногой давали спорадические
    /// падения. Мутирующие глобал тесты обязаны идти сериализованно
    static KEY_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn vault_auto_lock_expires_by_either_timer() {
        // Окно 2 с: тест не зависит ни от sleep, ни от аптайма машины
        // (Instant считается от старта системы, вычитание 15 минут могло
        // бы паниковать на свежезагруженной)
        const WINDOW: std::time::Duration = std::time::Duration::from_secs(2);
        let now = std::time::Instant::now();
        let wall = std::time::SystemTime::now();
        let fresh = |d: std::time::Duration| d - std::time::Duration::from_secs(1);
        let stale = |d: std::time::Duration| d + std::time::Duration::from_secs(1);
        // Ни один таймер не истёк — не истёкло
        *LAST_USE.lock().unwrap() = Some(now - fresh(WINDOW));
        *LAST_USE_WALL.lock().unwrap() = Some(wall - fresh(WINDOW));
        assert!(!vault_idle_expired_at(WINDOW, now, wall));
        // Настенные часы ушли за окно (сон/hibernate) при свежем Instant —
        // ровно ради этого случая существует второй таймер
        *LAST_USE.lock().unwrap() = Some(now);
        *LAST_USE_WALL.lock().unwrap() = Some(wall - stale(WINDOW));
        assert!(vault_idle_expired_at(WINDOW, now, wall));
        // Instant истёк, настенные часы свежие — истечение по любому из двух
        *LAST_USE.lock().unwrap() = Some(now - stale(WINDOW));
        *LAST_USE_WALL.lock().unwrap() = Some(wall);
        assert!(vault_idle_expired_at(WINDOW, now, wall));
        // Отметок нет — не истёкло (наличие ключа проверяет vault_guard)
        *LAST_USE.lock().unwrap() = None;
        *LAST_USE_WALL.lock().unwrap() = None;
        assert!(!vault_idle_expired_at(WINDOW, now, wall));
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
        assert_eq!(
            decrypt(&enc).as_deref().map(String::as_str),
            Some(secret)
        );
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
