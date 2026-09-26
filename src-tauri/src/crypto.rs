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
use zeroize::Zeroizing;

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

/// Отметка использования: продлевает окно авто-запирания
fn touch_vault() {
    if let Ok(mut g) = LAST_USE.lock() {
        *g = Some(std::time::Instant::now());
    }
}

/// Прошло ли окно бездействия — ключ пора стереть.
/// pub(crate): активный свипер в lib.rs опрашивает её раз в минуту —
/// ленивая проверка (только на крипто-операциях) оставляла ключ AES
/// в памяти, пока приложение свернуто
pub(crate) fn vault_idle_expired() -> bool {
    matches!(
        LAST_USE.lock().map(|g| *g).unwrap_or(None),
        Some(t) if t.elapsed() > VAULT_IDLE
    )
}

pub fn has_key() -> bool {
    // Протухший ключ гасим прямо здесь: UI-опрос крипто-статуса увидит
    // «заперто» и покажет гейт разблокировки
    if vault_idle_expired() {
        clear_key();
    }
    VAULT_KEY.lock().map(|g| g.is_some()).unwrap_or(false)
}

pub fn set_key(key: Zeroizing<Vec<u8>>) {
    if let Ok(mut g) = VAULT_KEY.lock() {
        // Старый ключ (если был) затираем, а не оставляем в памяти:
        // Zeroizing затирает буфер в своём Drop
        *g = Some(key);
    }
    touch_vault();
}

pub fn clear_key() {
    // Zeroizing внутри Option затирает буфер в Drop при take()
    if let Ok(mut g) = VAULT_KEY.lock() {
        g.take();
    }
    if let Ok(mut g) = LAST_USE.lock() {
        *g = None;
    }
}

/// PBKDF2-HMAC-SHA256: пароль + соль → 32-байтный ключ AES.
/// Легаси-KDF: нужен только для чтения старых crypto.json (до Argon2id).
/// Ключ обёрнут в Zeroizing — затирается при любом drop
pub fn derive_key(password: &str, salt: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut out = vec![0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    Zeroizing::new(out)
}

/// Argon2id (параметры OWASP: 19 MiB, t=2) — актуальный KDF хранилища.
/// Детерминирован: тот же пароль+соль → тот же ключ.
pub fn derive_key_argon2(password: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let mut out = vec![0u8; KEY_LEN];
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default());
    // Раньше expect: единственный panic-путь криптомодуля на пути с
    // пользовательским вводом — вместо паники процесса отдаём ошибку наружу
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| format!("argon2 derive failed: {e}"))?;
    Ok(Zeroizing::new(out))
}

pub fn new_salt() -> Vec<u8> {
    let mut salt = vec![0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Зашифровать строку текущим ключом. `enc:v1:…`; Err — хранилище заперто.
/// Ключ читается по месту (borrow) — без копий в heap
pub fn encrypt(plain: &str) -> Result<String, String> {
    if vault_idle_expired() {
        clear_key();
    }
    let guard = VAULT_KEY.lock().map_err(|e| e.to_string())?;
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
/// Ключ читается по месту (borrow) — без копий в heap
pub fn decrypt(stored: &str) -> Option<String> {
    if vault_idle_expired() {
        clear_key();
    }
    let guard = VAULT_KEY.lock().ok()?;
    let key = guard.as_ref()?;
    let result = decrypt_with(key, stored);
    if result.is_some() {
        touch_vault();
    }
    result
}

/// То же с явным ключом (миграция PBKDF2 → Argon2id)
pub fn decrypt_with(key: &[u8], stored: &str) -> Option<String> {
    let blob = B64.decode(stored.strip_prefix(PREFIX)?).ok()?;
    if blob.len() <= 12 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .ok()?;
    String::from_utf8(pt).ok()
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

/// Проверка пароля: строка-маркер, зашифрованная производным ключом
pub fn make_check(key: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), b"nocturn-key-check".as_slice())
        .map_err(|e| e.to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend(ct);
    Ok(format!("{PREFIX}{}", B64.encode(blob)))
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
        set_key(derive_key("master-пароль", b"salt-salt-salt-sa"));
        assert!(has_key());
        let secret = "sk-test-ключ-12345";
        let enc = encrypt(secret).expect("encrypt");
        assert!(is_encrypted(&enc));
        assert_ne!(enc, secret);
        assert_eq!(decrypt(&enc).as_deref(), Some(secret));
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
        clear_key();
        assert!(encrypt("x").is_err());
        assert!(decrypt("enc:v1:AAAA").is_none());
    }

    #[test]
    fn argon2_derive_is_deterministic_and_salt_sensitive() {
        let a1 = derive_key_argon2("мастер-пароль", b"salt-salt-salt-sa").expect("derive");
        let a2 = derive_key_argon2("мастер-пароль", b"salt-salt-salt-sa").expect("derive");
        let b = derive_key_argon2("мастер-пароль", b"another-salt-16!").expect("derive");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert_eq!(a1.len(), 32);
        // Не совпадает с легаси-KDF на тех же входах
        assert_ne!(a1, derive_key("мастер-пароль", b"salt-salt-salt-sa"));
        // Полнееценный раунд трип на argon2-ключе
        set_key(a1.clone());
        let enc = encrypt("sk-secret").expect("encrypt");
        assert_eq!(decrypt(&enc).as_deref(), Some("sk-secret"));
        // Ключ от другой соли не расшифровывает
        set_key(b);
        assert!(decrypt(&enc).is_none());
        clear_key();
    }
}
