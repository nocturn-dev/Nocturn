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

const PREFIX: &str = "enc:v1:";
const KEY_LEN: usize = 32; // AES-256
const PBKDF2_ITERS: u32 = 200_000;

/// Производный ключ в памяти. None — «хранилище» заперто.
static VAULT_KEY: Mutex<Option<Vec<u8>>> = Mutex::new(None);

pub fn has_key() -> bool {
    VAULT_KEY.lock().map(|g| g.is_some()).unwrap_or(false)
}

pub fn set_key(key: Vec<u8>) {
    if let Ok(mut g) = VAULT_KEY.lock() {
        *g = Some(key);
    }
}

pub fn clear_key() {
    if let Ok(mut g) = VAULT_KEY.lock() {
        *g = None;
    }
}

/// PBKDF2-HMAC-SHA256: пароль + соль → 32-байтный ключ AES
pub fn derive_key(password: &str, salt: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, PBKDF2_ITERS, &mut out);
    out
}

pub fn new_salt() -> Vec<u8> {
    let mut salt = vec![0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Зашифровать строку текущим ключом. `enc:v1:…`; Err — хранилище заперто
pub fn encrypt(plain: &str) -> Result<String, String> {
    let key = VAULT_KEY
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("vault is locked")?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend(ct);
    Ok(format!("{PREFIX}{}", B64.encode(blob)))
}

/// Расшифровать строку с префиксом. None — не зашифровано или заперто
pub fn decrypt(stored: &str) -> Option<String> {
    let blob = B64.decode(stored.strip_prefix(PREFIX)?).ok()?;
    if blob.len() <= 12 {
        return None;
    }
    let key = VAULT_KEY.lock().ok()?.clone()?;
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
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
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
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
}
