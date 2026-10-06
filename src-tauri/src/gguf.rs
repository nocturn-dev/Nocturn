//! GGUF-контейнер (v2/v3): read-only разбор + валидация + inspect.
//! Шаг 1 волны «GGUF Lab» (PLAN.md §28). Спека и инварианты —
//! docs/internal/GGUF_LAB_RESEARCH.md §1 (первоисточники: ggml docs/gguf.md,
//! gguf.cpp, gguf-py master на 10.2026); ссылки на § — туда.
//!
//! Читается ТОЛЬКО header-регион (KV + таблица тензоров, единицы МиБ):
//! данные тензоров не читаются вовсе — для inspect их размеры вычисляются
//! из dims+типа (§1.1), а стриминговая копия (шаг 3) работает по offsets.
//! Поэтому mmap здесь не нужен; он появится в шаге 3 у пишущей стороны.
//!
//! Ключевой инвариант формата, из-за которого «немного поправить файл»
//! нельзя (§1.1): offset каждого тензора обязан быть РОВНО кумулятивной
//! суммой pad(nbytes) всех предыдущих tensor_info в порядке следования —
//! C-ридер llama.cpp отвергает любые «дыры». Отсюда же: валидатор здесь
//! повторяет проверки gguf.cpp (§1.7), а не «спеку мягко».

use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Emitter;

const MAGIC: [u8; 4] = *b"GGUF";
/// Пишем только v3 (шаг 3); читаем v2/v3. v1 llama.cpp не читает (§1.2).
const DEFAULT_ALIGNMENT: u32 = 32;
/// GGML_TYPE_COUNT на master 10.2026: NVFP4=40, Q1_0=41, Q2_0=42 (§1.3).
/// Старые билды llama.cpp эти типы не поймут — в отчёте будет предупреждение.
const GGML_TYPE_COUNT: i32 = 43;

// Защитные капы парсера. Реальные модели: <2k тензоров, <100 KV-ключей,
// KV-регион <20 МиБ (токенайзер 256k-словаря ~5 МиБ). Капы держат
// враждебный/битый файл от OOM-аллокаций по объявленным длинам.
const MAX_TENSORS: u64 = 100_000;
const MAX_KV_PAIRS: u64 = 100_000;
const MAX_KV_REGION_BYTES: u64 = 256 << 20;
const MAX_KEY_BYTES: u64 = 65_535;
/// [код] gguf.cpp: длина имени < GGML_MAX_NAME=64 (char name[64] с NUL),
/// хотя спека говорит «at most 64 bytes» (§1.8) — строже спеки сознательно.
const MAX_TENSOR_NAME_BYTES: u64 = 63;
/// GGUF_MAX_STRING_LENGTH [код]: формат разрешает строки до 1 ГиБ, но
/// удерживать такие не можем — кап на УДЕРЖИВАЕМЫЕ строки отдельный.
const MAX_STRING_BYTES: u64 = 1 << 30;
const MAX_ARRAY_ELEMS: u64 = 1 << 30;
const RETAIN_STRING_CAP: u64 = 1 << 20;
const RETAIN_ARRAY_CAP: usize = 4096;
/// Реальные модели ≤ ~150 слоёв; кап для bool-массивов паттернов.
const MAX_LAYERS_CAP: usize = 1024;

// ---------------------------------------------------------------------------
// Типы тензоров и значения метаданных
// ---------------------------------------------------------------------------

/// Геометрия нужна для nbytes (и потом для валидации плана резки, шаг 3);
/// де/квантование НЕ входит в объём этого инструмента вообще (§6.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GgmlType {
    pub code: i32,
    pub name: &'static str,
    pub block_size: u32,
    pub type_size: u32,
}

const fn t(code: i32, name: &'static str, block_size: u32, type_size: u32) -> GgmlType {
    GgmlType {
        code,
        name,
        block_size,
        type_size,
    }
}

/// Таблица §1.3 (ggml.h master 10.2026). Удалённые из формата коды
/// (Q4_2/Q4_3, Q4_0_4_4-8_8, IQ4_NL_4_4-8_8) не читаются — валидных файлов
/// с ними не существует.
pub fn ggml_type(code: i32) -> Option<GgmlType> {
    Some(match code {
        0 => t(0, "F32", 1, 4),
        1 => t(1, "F16", 1, 2),
        2 => t(2, "Q4_0", 32, 18),
        3 => t(3, "Q4_1", 32, 20),
        6 => t(6, "Q5_0", 32, 22),
        7 => t(7, "Q5_1", 32, 24),
        8 => t(8, "Q8_0", 32, 34),
        9 => t(9, "Q8_1", 32, 36),
        10 => t(10, "Q2_K", 256, 84),
        11 => t(11, "Q3_K", 256, 110),
        12 => t(12, "Q4_K", 256, 144),
        13 => t(13, "Q5_K", 256, 176),
        14 => t(14, "Q6_K", 256, 210),
        15 => t(15, "Q8_K", 256, 292),
        16 => t(16, "IQ2_XXS", 256, 66),
        17 => t(17, "IQ2_XS", 256, 74),
        18 => t(18, "IQ3_XXS", 256, 98),
        19 => t(19, "IQ1_S", 256, 50),
        20 => t(20, "IQ4_NL", 32, 18),
        21 => t(21, "IQ3_S", 256, 110),
        22 => t(22, "IQ2_S", 256, 82),
        23 => t(23, "IQ4_XS", 256, 136),
        24 => t(24, "I8", 1, 1),
        25 => t(25, "I16", 1, 2),
        26 => t(26, "I32", 1, 4),
        27 => t(27, "I64", 1, 8),
        28 => t(28, "F64", 1, 8),
        29 => t(29, "IQ1_M", 256, 56),
        30 => t(30, "BF16", 1, 2),
        34 => t(34, "TQ1_0", 256, 54),
        35 => t(35, "TQ2_0", 256, 66),
        39 => t(39, "MXFP4", 32, 17),
        40 => t(40, "NVFP4", 64, 36),
        41 => t(41, "Q1_0", 128, 18),
        42 => t(42, "Q2_0", 64, 18),
        _ => return None,
    })
}

/// Коды типов значений KV (§1.1); код — 4 байта в потоке.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ValueType {
    UInt8,
    Int8,
    UInt16,
    Int16,
    UInt32,
    Int32,
    Float32,
    Bool,
    String,
    Array,
    UInt64,
    Int64,
    Float64,
}

impl ValueType {
    fn from_code(code: u32) -> Option<Self> {
        Some(match code {
            0 => Self::UInt8,
            1 => Self::Int8,
            2 => Self::UInt16,
            3 => Self::Int16,
            4 => Self::UInt32,
            5 => Self::Int32,
            6 => Self::Float32,
            7 => Self::Bool,
            8 => Self::String,
            9 => Self::Array,
            10 => Self::UInt64,
            11 => Self::Int64,
            12 => Self::Float64,
            _ => return None,
        })
    }

    /// Размер скаляра в байтах; None у String/Array (переменная длина).
    fn fixed_size(self) -> Option<u64> {
        Some(match self {
            Self::UInt8 | Self::Int8 | Self::Bool => 1,
            Self::UInt16 | Self::Int16 => 2,
            Self::UInt32 | Self::Int32 | Self::Float32 => 4,
            Self::UInt64 | Self::Int64 | Self::Float64 => 8,
            Self::String | Self::Array => return None,
        })
    }

    fn is_int(self) -> bool {
        matches!(
            self,
            Self::UInt8
                | Self::Int8
                | Self::UInt16
                | Self::Int16
                | Self::UInt32
                | Self::Int32
                | Self::UInt64
                | Self::Int64
        )
    }
}

/// Удержанные значения KV. Строковые массивы (токенайзер), большие числовые
/// (scores, token_type) и float-скаляры (rope_freq_base и т.п. — понадобятся
/// planner'у на шаге 3, добавим удержание вместе с ним) не удерживаются —
/// только структурно валидируются проходом (§1.4 ресёрча: «копировать
/// сквозняком, не парсить поэлементно»).
#[derive(Debug, Clone)]
enum Retained {
    Str(String),
    Int(i64),
    Ints(Vec<i64>),
    Bools(Vec<bool>),
}

/// Per-layer скаляр/массив (head_count, head_count_kv, feed_forward_length,
/// expert_used_count) — при хирургии режется ПО МАППИНГУ слоёв, не хвостом
/// (§1.6, §2.2); для этого массив нужно удержать целиком.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LayerSpec {
    Scalar(i64),
    Array(Vec<i64>),
}

/// Sliding-window паттерн (§1.6): scalar u32 = период (слой il — SWA iff
/// `il % period < period-1`), либо bool-массив per-layer (gemma3n/4).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SwaPattern {
    Period(u32),
    Layers(Vec<bool>),
}

// ---------------------------------------------------------------------------
// Структуры inspect (для UI шага 5 и для planner'а шага 3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TensorInfo {
    pub name: String,
    pub n_dims: u32,
    /// ggml-порядок: dims[0] — БЫСТРАЯ размерность (§1.1)
    pub dims: Vec<u64>,
    pub type_name: &'static str,
    pub type_code: i32,
    /// Относительно data_start; кратен alignment (инвариант непрерывности)
    pub offset: u64,
    pub nbytes: u64,
}

/// Флаги арха — вход политики хирургии §6.3 (deny-list гибридов,
/// предупреждения SWA-фаз, MTP-хвост).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchFlags {
    pub swa: bool,
    pub moe: bool,
    pub hybrid_ssm: bool,
    pub hybrid_conv: bool,
    pub nextn: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufMeta {
    pub version: u32,
    pub architecture: Option<String>,
    pub alignment: u32,
    pub file_type: Option<i64>,
    pub quantization_version: Option<i64>,
    pub block_count: Option<i64>,
    pub nextn_predict_layers: Option<i64>,
    pub leading_dense_block_count: Option<i64>,
    pub expert_count: Option<i64>,
    pub head_count: Option<LayerSpec>,
    pub head_count_kv: Option<LayerSpec>,
    pub feed_forward_length: Option<LayerSpec>,
    pub expert_used_count: Option<LayerSpec>,
    pub sliding_window: Option<i64>,
    pub sliding_window_pattern: Option<SwaPattern>,
    pub has_tokenizer: bool,
    /// Все ключи KV (для UI и отчётов); значения — только удержанные
    pub kv_keys: Vec<String>,
}

/// Слой, сгруппированный по префиксу `blk.N.` (§2.2: так его видят все скрипты).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerInfo {
    pub index: u64,
    pub total_bytes: u64,
    pub tensors: Vec<TensorInfo>,
    pub has_attention: bool,
    pub has_moe_experts: bool,
    pub has_ssm: bool,
    pub has_conv: bool,
    pub has_nextn: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerReport {
    pub layers: Vec<LayerInfo>,
    /// Не-блочные тензоры: token_embd, output, output_norm, rope-факторы…
    pub global: Vec<TensorInfo>,
}

/// Спан KV-пары в файле (шаг 3b): границы пары + структура значения.
/// Хирургии нужны точные адреса, чтобы СПЛАЙСИТЬ пары (массив по маппингу
/// короче оригинала) без перекодировки остального региона — токенайзер
/// копируется байт-в-байт со сдвигом, а не пересобирается.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct KvSpan {
    /// Абсолютный старт ключа (начало пары)
    pub key_start: u64,
    /// Абсолютный конец значения (конец пары)
    pub end: u64,
    pub vt: ValueType,
    /// Массив: (тип элемента, длина, абсолютный старт элементов)
    pub arr: Option<(ValueType, u64, u64)>,
    /// Фиксширинный скаляр: (адрес значения, ширина в байтах)
    pub scalar: Option<(u64, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufFile {
    pub meta: GgufMeta,
    pub tensors: Vec<TensorInfo>,
    pub flags: ArchFlags,
    /// Абсолютный offset data-секции = pad(конец таблицы тензоров, alignment)
    pub data_start: u64,
    pub file_len: u64,
    /// Некритичные проблемы (спека требует, код прощает): идут в отчёт
    pub warnings: Vec<String>,
    /// Абсолютный конец KV-региона = начало таблицы тензоров (шаг 3a:
    /// вербатим-копия KV с патчем block_count)
    pub kv_end: u64,
    /// Спаны ВСЕХ KV-пар (шаг 3b) — вход для сплайс-правок плана
    pub kv_spans: Vec<(String, KvSpan)>,
}

impl GgufFile {
    pub fn open(path: &Path) -> Result<GgufFile, String> {
        let file = File::open(path).map_err(|e| format!("gguf: open failed: {e}"))?;
        let file_len = file
            .metadata()
            .map_err(|e| format!("gguf: metadata failed: {e}"))?
            .len();
        Parser {
            r: BufReader::new(file),
            pos: 0,
            file_len,
        }
        .parse()
    }

    /// Суммарный размер данных выживших тензоров — оценка выходного файла
    /// для pre-flight проверки места (шаг 3).
    pub fn total_tensor_bytes(&self) -> u64 {
        self.tensors.iter().map(|t| t.nbytes).sum()
    }

    /// Группировка тензоров по `blk.N.`; глобальные — отдельно (§2.2).
    pub fn layers(&self) -> LayerReport {
        let mut layers: Vec<LayerInfo> = Vec::new();
        let mut global = Vec::new();
        for t in &self.tensors {
            match layer_index(&t.name) {
                Some(idx) => match layers.iter_mut().find(|l| l.index == idx) {
                    Some(l) => {
                        l.total_bytes += t.nbytes;
                        l.tensors.push(t.clone());
                        // флаги — по ВСЕМ тензорам слоя, не только по первому:
                        // первый тензор слоя обычно attn_norm, а MoE/SSM-признаки
                        // приходят с более поздними тензорами
                        l.has_attention |= name_is_attention(&t.name);
                        l.has_moe_experts |= name_is_moe(&t.name);
                        l.has_ssm |= name_is_ssm(&t.name);
                        l.has_conv |= name_is_conv(&t.name);
                        l.has_nextn |= name_is_nextn(&t.name);
                    }
                    None => layers.push(LayerInfo {
                        index: idx,
                        total_bytes: t.nbytes,
                        tensors: vec![t.clone()],
                        has_attention: name_is_attention(&t.name),
                        has_moe_experts: name_is_moe(&t.name),
                        has_ssm: name_is_ssm(&t.name),
                        has_conv: name_is_conv(&t.name),
                        has_nextn: name_is_nextn(&t.name),
                    }),
                },
                None => global.push(t.clone()),
            }
        }
        layers.sort_by_key(|l| l.index);
        LayerReport { layers, global }
    }
}

fn layer_index(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("blk.")?;
    let digits: &str = rest.split('.').next()?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn name_is_attention(name: &str) -> bool {
    name.contains(".attn_") || name.contains(".attn_norm")
}
fn name_is_moe(name: &str) -> bool {
    // [код] фактические имена с «s»: ffn_gate_exps/ffn_down_exps/ffn_up_exps (§1.6);
    // суффикс .weight/.bias обязателен к учёту — имя не заканчивается на _exps
    name.contains("_exps.") || name.ends_with("_exps") || name.contains(".ffn_gate_inp")
}
fn name_is_ssm(name: &str) -> bool {
    name.contains(".ssm_")
}
fn name_is_conv(name: &str) -> bool {
    name.contains(".shortconv.") || name.contains(".conv1d")
}
fn name_is_nextn(name: &str) -> bool {
    name.contains(".nextn.")
}

// ---------------------------------------------------------------------------
// Парсер
// ---------------------------------------------------------------------------

struct Parser {
    r: BufReader<File>,
    pos: u64,
    file_len: u64,
}

impl Parser {
    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), String> {
        self.r
            .read_exact(buf)
            .map_err(|_| format!("gguf: unexpected end of file at byte {}", self.pos))?;
        self.pos += buf.len() as u64;
        Ok(())
    }

    fn read_le<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut b = [0u8; N];
        self.read_exact(&mut b)?;
        Ok(b)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let mut b = [0u8; 1];
        self.read_exact(&mut b)?;
        Ok(b[0])
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.read_le()?))
    }
    fn read_u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.read_le()?))
    }
    fn read_i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.read_le()?))
    }
    fn read_f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.read_le()?))
    }
    fn read_f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.read_le()?))
    }

    /// Пропуск объявленных байтов (содержимое не нужно и не читается).
    /// Seek за EOF легален — «дыру» поймает либо кап бюджета KV-региона,
    /// либо последующий read_exact, либо проверка усечения файла.
    fn skip(&mut self, n: u64) -> Result<(), String> {
        let Some(target) = self.pos.checked_add(n) else {
            return Err(format!(
                "gguf: declared length {n} overflows u64 at byte {}",
                self.pos
            ));
        };
        self.r
            .seek(SeekFrom::Start(target))
            .map_err(|e| format!("gguf: seek failed at byte {}: {e}", self.pos))?;
        self.pos = target;
        Ok(())
    }

    fn read_string(&mut self, cap: u64, what: &str) -> Result<String, String> {
        let len = self.read_u64()?;
        if len > cap {
            return Err(format!(
                "gguf: {what} length {len} exceeds limit {cap} at byte {}",
                self.pos
            ));
        }
        let mut buf = vec![0u8; len as usize];
        self.read_exact(&mut buf)?;
        // Валидные GGUF пишут UTF-8; битые байты не повод валить файл
        // (ридер llama.cpp тоже не строго проверяет) — lossy.
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn skip_string(&mut self) -> Result<(), String> {
        let len = self.read_u64()?;
        if len > MAX_STRING_BYTES {
            return Err(format!(
                "gguf: string length {len} exceeds format limit at byte {}",
                self.pos
            ));
        }
        self.skip(len)
    }

    fn parse(mut self) -> Result<GgufFile, String> {
        // === HEADER (24 байта, §1.1): tensor_count идёт РАНЬШЕ kv_count —
        // перепутанные местами поля дают «файл не читается вовсе» (§1.7-1).
        let magic = self.read_le::<4>()?;
        if magic != MAGIC {
            return Err(format!(
                "gguf: bad magic {magic:?} (expected {MAGIC:?}) — not a GGUF file"
            ));
        }
        let version = self.read_u32()?;
        // Эвристика big-endian v3 [код]: BE-файл на LE-хосте даёт version
        // с нулевым младшим полусловом (§1.2). BE-модели экзотика — отказ
        // с внятной ошибкой вместо тихого мусора.
        if version & 0xFFFF == 0 {
            return Err(format!(
                "gguf: version {version:#010x} looks big-endian — LE GGUF only"
            ));
        }
        match version {
            2 | 3 => {}
            1 => return Err("gguf: version 1 is no longer supported by llama.cpp".into()),
            other => return Err(format!("gguf: unsupported version {other}")),
        }
        let tensor_count = self.read_u64()?;
        let kv_count = self.read_u64()?;
        if tensor_count > MAX_TENSORS || kv_count > MAX_KV_PAIRS {
            return Err(format!(
                "gguf: declared counts (tensors {tensor_count}, kv {kv_count}) exceed sane limits"
            ));
        }

        // === METADATA KV (§1.1) ===
        let mut retained: Vec<(String, Retained)> = Vec::new();
        let mut kv_keys: Vec<String> = Vec::new();
        let mut seen_keys: HashSet<String> = HashSet::new();
        let mut alignment: Option<u32> = None;
        let mut kv_spans: Vec<(String, KvSpan)> = Vec::new();
        let kv_region_start = self.pos;
        for i in 0..kv_count {
            // Кап бюджета СТРОГО по объявленным длинам — враждебный файл
            // с array len 2^40 отсекается до любых больших аллокаций.
            if self.pos - kv_region_start > MAX_KV_REGION_BYTES {
                return Err(format!(
                    "gguf: kv region exceeds {MAX_KV_REGION_BYTES} bytes (hostile or corrupt) after {i} pairs"
                ));
            }
            let key_start = self.pos;
            let key = self.read_string(MAX_KEY_BYTES, "kv key")?;
            if key.is_empty() {
                return Err("gguf: empty kv key".into());
            }
            if !seen_keys.insert(key.clone()) {
                // Дубликат ключа — хард-ошибка в обоих ридерах (§1.7-5)
                return Err(format!("gguf: duplicate kv key '{key}'"));
            }
            let type_code = self.read_u32()?;
            let vt = ValueType::from_code(type_code).ok_or_else(|| {
                format!("gguf: kv '{key}' has unknown value type {type_code}")
            })?;
            // Спан (шаг 3b): для массива тип элемента и длина читаются на
            // уровне цикла — спану нужен абсолютный старт элементов
            let value_start = self.pos;
            let mut arr_span = None;
            let value = if vt == ValueType::Array {
                let elem_code = self.read_u32()?;
                let et = ValueType::from_code(elem_code).ok_or_else(|| {
                    format!("gguf: kv '{key}' array has unknown element type {elem_code}")
                })?;
                let len = self.read_u64()?;
                if len > MAX_ARRAY_ELEMS {
                    return Err(format!(
                        "gguf: kv '{key}' array length {len} exceeds format limit"
                    ));
                }
                arr_span = Some((et, len, self.pos));
                self.read_kv_array_content(&key, et, len)?
            } else {
                self.read_kv_value(&key, vt)?
            };
            if vt == ValueType::UInt32 && key == "general.alignment" {
                if let Some(Retained::Int(a)) = value {
                    let a = u32::try_from(a)
                        .map_err(|_| format!("gguf: general.alignment {a} does not fit u32"))?;
                    // Спека говорит «multiple of 8», код строже — степень
                    // двойки (§1.8); non-pow2 даёт битые offsets у C-ридера.
                    if !a.is_power_of_two() {
                        return Err(format!(
                            "gguf: general.alignment {a} must be a power of two"
                        ));
                    }
                    alignment = Some(a);
                }
            }
            kv_spans.push((
                key.clone(),
                KvSpan {
                    key_start,
                    end: self.pos,
                    vt,
                    arr: arr_span,
                    scalar: vt.fixed_size().map(|w| (value_start, w as u32)),
                },
            ));
            kv_keys.push(key);
            if let Some(v) = value {
                retained.push((kv_keys.last().unwrap().clone(), v));
            }
        }

        let meta = resolve_meta(version, &retained, kv_keys, alignment);
        // Конец KV = начало таблицы тензоров — граница вербатим-копии (шаг 3a)
        let kv_end = self.pos;

        // === TENSOR INFOS (§1.1): имя, n_dims, dims, type, offset ===
        let align = meta.alignment;
        let mut tensors: Vec<TensorInfo> = Vec::new();
        let mut seen_names: HashSet<String> = HashSet::new();
        let mut running: u64 = 0; // кумулятивная сумма pad(nbytes) — инвариант §1.1
        let mut quants_present = false;
        for i in 0..tensor_count {
            let name = self.read_string(MAX_TENSOR_NAME_BYTES + 1, "tensor name")?;
            if name.is_empty() {
                return Err(format!("gguf: tensor #{i} has empty name"));
            }
            if name.len() as u64 > MAX_TENSOR_NAME_BYTES {
                // §1.7-8: ≥ 64 байт — отказ читающего билда
                return Err(format!(
                    "gguf: tensor name is too long ({} bytes): '{name}'",
                    name.len()
                ));
            }
            if !seen_names.insert(name.clone()) {
                return Err(format!("gguf: duplicate tensor name '{name}'"));
            }
            let n_dims = self.read_u32()?;
            if !(1..=4).contains(&n_dims) {
                // GGML_MAX_DIMS=4; ноль/пять — битый файл (§1.7)
                return Err(format!("gguf: tensor '{name}' has invalid n_dims {n_dims}"));
            }
            let mut dims = Vec::with_capacity(n_dims as usize);
            for d in 0..n_dims {
                let v = self.read_u64()?;
                if v == 0 {
                    return Err(format!("gguf: tensor '{name}' dim #{d} is zero"));
                }
                dims.push(v);
            }
            let type_code = self.read_i32()?;
            if !(0..GGML_TYPE_COUNT).contains(&type_code) {
                return Err(format!(
                    "gguf: tensor '{name}' has unknown type {type_code} (≥ GGML_TYPE_COUNT)"
                ));
            }
            let ty = ggml_type(type_code)
                .ok_or_else(|| format!("gguf: tensor '{name}' uses removed type {type_code}"))?;
            if ty.block_size > 1 {
                quants_present = true;
                if dims[0] % u64::from(ty.block_size) != 0 {
                    // [код] «not a multiple of block size» — хард-ошибка (§1.7-6)
                    return Err(format!(
                        "gguf: tensor '{name}' ne[0]={} is not a multiple of block size {} for {}",
                        dims[0], ty.block_size, ty.name
                    ));
                }
            }
            let offset = self.read_u64()?;
            if offset != running {
                // Инвариант непрерывности (§1.1): текст ошибки — как у C-ридера
                return Err(format!(
                    "gguf: tensor '{name}' has offset {offset}, expected {running}"
                ));
            }
            let nbytes = tensor_nbytes(&ty, &dims)
                .ok_or_else(|| format!("gguf: tensor '{name}' size overflows u64"))?;
            running = running
                .checked_add(pad_to(nbytes, align))
                .ok_or_else(|| format!("gguf: tensor '{name}' pushes data end past u64"))?;
            tensors.push(TensorInfo {
                name,
                n_dims,
                dims,
                type_name: ty.name,
                type_code,
                offset,
                nbytes,
            });
        }

        // === PADDING + данные: data_start = pad(конец таблицы, alignment) (§1.4) ===
        let data_start = pad_to(self.pos, align);
        // Паддинг после ПОСЛЕДНЕГО тензора писатели могут не писать — требуем
        // только фактические байты данных последнего тензора.
        let min_file = match tensors.last() {
            Some(last) => data_start
                .checked_add(last.offset)
                .and_then(|v| v.checked_add(last.nbytes))
                .ok_or_else(|| "gguf: tensor data end overflows u64".to_string())?,
            None => data_start,
        };
        if self.file_len < min_file {
            return Err(format!(
                "gguf: file truncated: {} bytes, tensor data needs {min_file}",
                self.file_len
            ));
        }

        let mut warnings = Vec::new();
        if meta.architecture.is_none() {
            warnings.push(
                "general.architecture is missing — arch-specific keys were not resolved".into(),
            );
        }
        if quants_present && meta.quantization_version.is_none() {
            // Спека требует quantization_version при квантах; llama.cpp читает
            // и без него — предупреждение, не отказ (§1.7-7).
            warnings
                .push("quantized tensors present but general.quantization_version is missing".into());
        }

        let flags = detect_flags(&meta, &tensors);
        Ok(GgufFile {
            meta,
            tensors,
            flags,
            data_start,
            file_len: self.file_len,
            warnings,
            kv_end,
            kv_spans,
        })
    }

    /// Разбор одного значения KV. Возвращает Some только для удержанных
    /// значений (все скаляры, числовые/bool массивы ≤ капа, строки из белого
    /// списка); остальное структурно валидируется и пропускается.
    fn read_kv_value(&mut self, key: &str, vt: ValueType) -> Result<Option<Retained>, String> {
        Ok(match vt {
            ValueType::UInt8 => Some(Retained::Int(i64::from(self.read_u8()?))),
            ValueType::Int8 => Some(Retained::Int(i64::from(self.read_u8()? as i8))),
            ValueType::UInt16 => {
                let b = self.read_le::<2>()?;
                Some(Retained::Int(i64::from(u16::from_le_bytes(b))))
            }
            ValueType::Int16 => {
                let b = self.read_le::<2>()?;
                Some(Retained::Int(i64::from(i16::from_le_bytes(b))))
            }
            ValueType::UInt32 => Some(Retained::Int(i64::from(self.read_u32()?))),
            ValueType::Int32 => Some(Retained::Int(i64::from(self.read_i32()?))),
            ValueType::UInt64 => {
                // u64 > i64::MAX в реальных метаданных не встречается;
                // сатурация вместо ошибки — значение не критично
                let v = self.read_u64()?;
                Some(Retained::Int(i64::try_from(v).unwrap_or(i64::MAX)))
            }
            ValueType::Int64 => {
                let b = self.read_le::<8>()?;
                Some(Retained::Int(i64::from_le_bytes(b)))
            }
            ValueType::Float32 | ValueType::Float64 => {
                // float-скаляры не удерживаем (см. doc Retained) — читаем и идём дальше
                if vt == ValueType::Float32 {
                    self.read_f32()?;
                } else {
                    self.read_f64()?;
                }
                None
            }
            ValueType::Bool => {
                // Спека: «anything else is invalid» (§1.1) — строго 0/1
                match self.read_u8()? {
                    0 => Some(Retained::Int(0)),
                    1 => Some(Retained::Int(1)),
                    other => {
                        return Err(format!("gguf: kv '{key}' bool value {other} is invalid"))
                    }
                }
            }
            ValueType::String => {
                if key == "general.architecture" {
                    let s = self.read_string(RETAIN_STRING_CAP, "general.architecture")?;
                    Some(Retained::Str(s))
                } else {
                    self.skip_string()?;
                    None
                }
            }
            // Массивы разбираются на уровне цикла KV (спану нужны elem/len) —
            // сюда попасть не должно
            ValueType::Array => {
                return Err("gguf: internal: array value outside the kv loop".into());
            }
        })
    }

    /// Содержимое массива: тип элемента и длина читает ВЫЗЫВАЮЩИЙ (уровень
    /// цикла — спану нужен elems_start), здесь только обход/удержание
    fn read_kv_array_content(
        &mut self,
        key: &str,
        et: ValueType,
        len: u64,
    ) -> Result<Option<Retained>, String> {
        match et {
            ValueType::String => {
                // Токенайзер: массив строк, валидируем каждую длину,
                // содержимое не удерживаем (§1.4 ресёрча)
                for _ in 0..len {
                    self.skip_string()?;
                }
                Ok(None)
            }
            ValueType::Array => {
                Err(format!("gguf: kv '{key}' has nested array of arrays"))
            }
            ValueType::Bool => {
                if len as usize > MAX_LAYERS_CAP {
                    self.skip(len)?;
                    return Ok(None);
                }
                let mut v = Vec::with_capacity(len as usize);
                for _ in 0..len {
                    match self.read_u8()? {
                        0 => v.push(false),
                        1 => v.push(true),
                        other => {
                            return Err(format!(
                                "gguf: kv '{key}' bool array element {other} is invalid"
                            ))
                        }
                    }
                }
                Ok(Some(Retained::Bools(v)))
            }
            _ => {
                let step = et
                    .fixed_size()
                    .expect("remaining value types are fixed-size scalars");
                if len as usize <= RETAIN_ARRAY_CAP && et.is_int() {
                    let mut out = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        out.push(self.read_le_int(et)?);
                    }
                    Ok(Some(Retained::Ints(out)))
                } else {
                    // Числовые большие (token_type/scores) или float —
                    // сквозняком; переполнение длины ловит checked_mul
                    let total = step
                        .checked_mul(len)
                        .ok_or_else(|| format!("gguf: kv '{key}' array size overflows"))?;
                    self.skip(total)?;
                    Ok(None)
                }
            }
        }
    }

    fn read_le_int(&mut self, et: ValueType) -> Result<i64, String> {
        Ok(match et {
            ValueType::UInt8 => i64::from(self.read_u8()?),
            ValueType::Int8 => i64::from(self.read_u8()? as i8),
            ValueType::UInt16 => i64::from(u16::from_le_bytes(self.read_le::<2>()?)),
            ValueType::Int16 => i64::from(i16::from_le_bytes(self.read_le::<2>()?)),
            ValueType::UInt32 => i64::from(self.read_u32()?),
            ValueType::Int32 => i64::from(self.read_i32()?),
            ValueType::UInt64 => i64::try_from(self.read_u64()?).unwrap_or(i64::MAX),
            ValueType::Int64 => i64::from_le_bytes(self.read_le::<8>()?),
            _ => unreachable!("read_le_int called for non-int type"),
        })
    }
}

fn tensor_nbytes(ty: &GgmlType, dims: &[u64]) -> Option<u64> {
    // [код] nbytes = (ne[0]/blck)*type_size*ne[1]*ne[2]*ne[3] (§1.1);
    // ne[0] > 0 проверен при разборе dims.
    let blocks = dims[0] / u64::from(ty.block_size);
    let mut n = blocks.checked_mul(u64::from(ty.type_size))?;
    for d in &dims[1..] {
        n = n.checked_mul(*d)?;
    }
    Some(n)
}

fn pad_to(v: u64, align: u32) -> u64 {
    debug_assert!(align.is_power_of_two());
    v.div_ceil(u64::from(align)) * u64::from(align)
}

/// Удержанные KV → GgufMeta: арх-специфичные ключи резолвятся post-parse,
/// потому что general.architecture может стоять ПОСЛЕ {arch}.*-ключей в потоке.
fn resolve_meta(
    version: u32,
    retained: &[(String, Retained)],
    kv_keys: Vec<String>,
    alignment: Option<u32>,
) -> GgufMeta {
    let find = |k: &str| retained.iter().find(|(key, _)| key == k).map(|(_, v)| v);
    let get_str = |k: &str| match find(k) {
        Some(Retained::Str(s)) => Some(s.clone()),
        _ => None,
    };
    let get_int = |k: &str| match find(k) {
        Some(Retained::Int(i)) => Some(*i),
        _ => None,
    };
    let get_ints = |k: &str| match find(k) {
        Some(Retained::Ints(a)) => Some(LayerSpec::Array(a.clone())),
        Some(Retained::Int(i)) => Some(LayerSpec::Scalar(*i)),
        _ => None,
    };
    let architecture = get_str("general.architecture");
    // Отдельная владеемая строка: arch нужен ПОСЛЕ перемещения architecture
    // в структуру (E0505), клонирование — байты, не производительность
    let arch = architecture.clone().unwrap_or_default();
    let sliding_window_pattern = find(&format!("{arch}.attention.sliding_window_pattern"))
        .and_then(|v| match v {
            Retained::Int(i) => u32::try_from(*i).ok().map(SwaPattern::Period),
            Retained::Bools(b) => Some(SwaPattern::Layers(b.clone())),
            _ => None,
        });
    GgufMeta {
        version,
        architecture,
        alignment: alignment.unwrap_or(DEFAULT_ALIGNMENT),
        file_type: get_int("general.file_type"),
        quantization_version: get_int("general.quantization_version"),
        block_count: get_int(&format!("{arch}.block_count")),
        nextn_predict_layers: get_int(&format!("{arch}.nextn_predict_layers")),
        leading_dense_block_count: get_int(&format!("{arch}.leading_dense_block_count")),
        expert_count: get_int(&format!("{arch}.expert_count")),
        head_count: get_ints(&format!("{arch}.attention.head_count")),
        head_count_kv: get_ints(&format!("{arch}.attention.head_count_kv")),
        feed_forward_length: get_ints(&format!("{arch}.feed_forward_length")),
        expert_used_count: get_ints(&format!("{arch}.expert_used_count")),
        sliding_window: get_int(&format!("{arch}.attention.sliding_window")),
        sliding_window_pattern,
        has_tokenizer: kv_keys.iter().any(|k| k == "tokenizer.ggml.tokens"),
        kv_keys,
    }
}

fn detect_flags(meta: &GgufMeta, tensors: &[TensorInfo]) -> ArchFlags {
    let mut f = ArchFlags {
        swa: meta.sliding_window.is_some() || meta.sliding_window_pattern.is_some(),
        moe: false,
        hybrid_ssm: false,
        hybrid_conv: false,
        // [код] MTP-блоки Qwen3 с ОБЫЧНЫМИ именами blk.* определяются по
        // ключу, а не по суффиксу тензоров (§1.6)
        nextn: meta.nextn_predict_layers.unwrap_or(0) > 0,
    };
    for t in tensors {
        f.moe |= name_is_moe(&t.name);
        f.hybrid_ssm |= name_is_ssm(&t.name);
        f.hybrid_conv |= name_is_conv(&t.name);
        f.nextn |= name_is_nextn(&t.name);
    }
    f
}

// ---------------------------------------------------------------------------
// Конвейер Ollama: скачивание (pull) и экспорт блоба (шаг 2 волны §28.2).
// Детали API — GGUF_LAB_RESEARCH.md §4 (api.md/openapi.yaml на 10.2026).
// ---------------------------------------------------------------------------

/// Ollama-сервер живёт на фиксированном порту; как detect_local_runtimes
/// (chat.rs) и пресет lmstudio — без конфига. HTTP-клиент — общий
/// network::shared_client (прокси/CA применяются автоматически).
const OLLAMA_URL: &str = "http://127.0.0.1:11434";
/// Stall-детект вместо total-таймаута: pull многогигабайтной модели
/// легитимно идёт десятки минут, а «замерло навсегда» — это 60 с без единого
/// байта (§4.6: соединение с Ollama — долгоживущий NDJSON-поток).
const PULL_STALL_SECS: u64 = 60;
/// Буфер копирования блоба: 8 МиБ — в 2–4 раза больше alignment-паддинга
/// любых тензоров, при этом буфер не раздувает RSS (§3.3 ресёрча).
const COPY_CHUNK: usize = 8 << 20;
/// Прогресс копии не чаще 32 МиБ — IPC-канал не спамим (dictation: 1 МиБ на
/// 57 МБ; тут файлы на порядки больше).
const EMIT_CHUNK: u64 = 32 << 20;

/// Одна операция GGUF Lab за раз (§28.3): pull/export/surgery —
/// мульти-гигабайтный диск-IO, параллелить — гарантированный трэшинг.
static GGUF_BUSY: AtomicBool = AtomicBool::new(false);
/// Кооперативная отмена: циклы pull/copy проверяют между чанками.
static GGUF_CANCEL: AtomicBool = AtomicBool::new(false);

/// Прогресс-строка NDJSON из /api/pull (§4.1): completed может отсутствовать
/// до старта скачивания слоя — поле опционально.
#[derive(Debug, Clone, Serialize)]
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Debug)]
pub enum PullEvent {
    Progress(PullProgress),
    /// {"status":"success"} — поток после этого закрывается
    Done,
    /// {"error": "..."} — отказ на стороне Ollama
    Error(String),
}

/// Чистая функция — под golden-тесты формата строк (как parse_ollama_tags
/// в chat.rs). Неизвестные поля игнорируются: Ollama добавляет поля между
/// версиями, парсер не должен ломаться (§4.1).
pub fn parse_pull_line(line: &str) -> Result<PullEvent, String> {
    let v: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| format!("gguf pull: bad NDJSON line ({e}): {line}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Ok(PullEvent::Error(err.to_string()));
    }
    let status = v
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    if status == "success" {
        return Ok(PullEvent::Done);
    }
    Ok(PullEvent::Progress(PullProgress {
        status,
        digest: v.get("digest").and_then(|d| d.as_str()).map(String::from),
        total: v.get("total").and_then(|t| t.as_u64()),
        completed: v.get("completed").and_then(|c| c.as_u64()),
    }))
}

/// Разбор ответа /api/show: details.format («gguf» | «safetensors»-MLX, §4.2)
/// и все FROM-пути из modelfile. Несколько FROM = split-GGUF — экспорт v1
/// откажется с внятной ошибкой (склейка — llama-gguf-split --merge, §4.2).
pub struct ShowInfo {
    pub format: Option<String>,
    pub from_paths: Vec<PathBuf>,
}

pub fn parse_show_body(body: &str) -> Result<ShowInfo, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("gguf export: bad /api/show response: {e}"))?;
    let format = v
        .get("details")
        .and_then(|d| d.get("format"))
        .and_then(|f| f.as_str())
        .map(String::from);
    let mut from_paths = Vec::new();
    if let Some(mf) = v.get("modelfile").and_then(|m| m.as_str()) {
        for line in mf.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("FROM ") {
                let p = rest.trim();
                // §4.2: адрес блога ищем в modelfile, не по sha исходника —
                // Ollama с ~0.30 пересериализует GGUF при импорте (#17554)
                if !p.is_empty() {
                    from_paths.push(PathBuf::from(p));
                }
            }
        }
    }
    Ok(ShowInfo { format, from_paths })
}

/// Корень хранилища Ollama: OLLAMA_MODELS → дефолт по ОС (§4.2: envconfig).
/// env_value/home — параметры (не чтение env) — под тесты.
pub fn models_root_from(env_value: Option<&str>, home: Option<&Path>) -> PathBuf {
    if let Some(v) = env_value.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(v);
    }
    let mut p = home.map(Path::to_path_buf).unwrap_or_default();
    p.push(".ollama");
    p.push("models");
    p
}

pub fn resolve_models_root() -> PathBuf {
    let env = std::env::var("OLLAMA_MODELS").ok();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from);
    models_root_from(env.as_deref(), home.as_deref())
}

/// Паттерн имени блоба: sha256-<64 hex> [код, manifest/layer.go, §4.2].
/// Гард перед копированием: путь из modelfile обязан им быть — опечатка
/// или неожиданный формат отсекаются до открытия файла.
pub fn is_blob_name(name: &str) -> bool {
    match name.strip_prefix("sha256-") {
        Some(hex) => hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        None => false,
    }
}

/// Имя файла экспорта: небезопасные для ФС символы имени модели
/// (hf.co/user/repo:Q4_K_M) → '_'.
fn slug_for(model: &str) -> String {
    let s: String = model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "model".into()
    } else {
        s
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Копия блоба с контролем целостности: блоб Ollama контент-адресный
/// (sha256 в ИМЕНИ файла), поэтому sha скопированного обязан совпасть с
/// ожидаемым — это бесплатная (sha2 уже в deps) гарантия «скопировалось
/// целиком», не доверяющая ни ФС, ни прерванным чтениям (§4.2).
/// Синхронная — вызывается из spawn_blocking. tmp не оставляет: любая
/// ошибка/отмена удаляют недописанный файл (§28.3).
pub(crate) fn copy_blob_verified(
    src: &Path,
    dst_tmp: &Path,
    expected_hex: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let mut run = || -> Result<u64, String> {
        let total = fs::metadata(src)
            .map_err(|e| format!("gguf export: stat blob: {e}"))?
            .len();
        let mut src_f = File::open(src).map_err(|e| format!("gguf export: open blob: {e}"))?;
        let mut dst_f =
            File::create(dst_tmp).map_err(|e| format!("gguf export: create tmp: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; COPY_CHUNK];
        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("gguf export: cancelled".into());
            }
            let n = src_f
                .read(&mut buf)
                .map_err(|e| format!("gguf export: read blob: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst_f
                .write_all(&buf[..n])
                .map_err(|e| format!("gguf export: write tmp: {e}"))?;
            received += n as u64;
            if received - last_emit >= EMIT_CHUNK {
                last_emit = received;
                on_progress(received, total);
            }
        }
        // Долговечность до rename (§3.3-6): без sync rename может дать
        // «готовый» файл, потерявший хвост при отключении питания
        dst_f
            .flush()
            .and_then(|_| dst_f.sync_all())
            .map_err(|e| format!("gguf export: flush tmp: {e}"))?;
        let hex = hex_lower(&hasher.finalize());
        if !hex.eq_ignore_ascii_case(expected_hex) {
            return Err(format!(
                "gguf export: blob digest mismatch (got {hex}, expected {expected_hex}) — corrupted copy"
            ));
        }
        on_progress(received, total);
        Ok(received)
    };
    let result = run();
    if result.is_err() {
        let _ = fs::remove_file(dst_tmp);
    }
    result
}

fn gguf_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("gguf: app_data_dir failed: {e}"))?
        .join("gguf"))
}

/// Результат экспорта блоба Ollama в appdata/gguf/<slug>.gguf.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedModel {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

/// Скачать модель через Ollama: POST /api/pull, NDJSON-строками прогресс
/// событием gguf-progress. Resume из коробки: повторный вызов с тем же
/// именем продолжает недокачанное (§4.1). Ollama должен быть запущен —
/// это процесс-сервер, без него ни pull, ни create (§4.6).
#[tauri::command(async)]
pub async fn gguf_pull(app: tauri::AppHandle, model: String) -> Result<(), String> {
    if GGUF_BUSY.swap(true, Ordering::Relaxed) {
        return Err("gguf lab: another operation is already running".into());
    }
    GGUF_CANCEL.store(false, Ordering::Relaxed);
    let result = do_pull(&app, &model).await;
    GGUF_BUSY.store(false, Ordering::Relaxed);
    result
}

async fn do_pull(app: &tauri::AppHandle, model: &str) -> Result<(), String> {
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    let resp = client
        .post(format!("{OLLAMA_URL}/api/pull"))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| {
            format!("gguf pull: cannot reach Ollama at {OLLAMA_URL} (is it running?): {e}")
        })?;
    if !resp.status().is_success() {
        return Err(format!("gguf pull: Ollama returned HTTP {}", resp.status().as_u16()));
    }

    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    let mut space_checked = false;
    let mut last_emit_received: Option<u64> = None;
    let mut last_emit_status = String::new();
    loop {
        // Stall-детект (§4.6): 60 с без байтов — соединение замерло
        let chunk = match tokio::time::timeout(
            std::time::Duration::from_secs(PULL_STALL_SECS),
            resp.chunk(),
        )
        .await
        {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("gguf pull: stream interrupted: {e}")),
            Err(_) => {
                return Err(format!(
                    "gguf pull: stalled — no data for {PULL_STALL_SECS}s"
                ))
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = std::str::from_utf8(&line[..line.len() - 1]).unwrap_or_default();
            if line.trim().is_empty() {
                continue;
            }
            match parse_pull_line(line)? {
                PullEvent::Done => {
                    let _ = app.emit(
                        "gguf-progress",
                        json!({ "phase": "pull", "model": model, "status": "success" }),
                    );
                    return Ok(());
                }
                PullEvent::Error(e) => return Err(format!("gguf pull: {e}")),
                PullEvent::Progress(p) => {
                    // Pre-flight места (§4.6): размер приходит только с первым
                    // прогресс-слоем — проверяем один раз, при нехватке рвём
                    // соединение (сервер отменяет pull по дисконнекту)
                    if !space_checked {
                        // digest borrowing (не move): p живёт дальше в emit
                        if let (Some(total), Some(_)) = (p.total, p.digest.as_deref()) {
                            space_checked = true;
                            let root = resolve_models_root();
                            match crate::fsutil::free_bytes(&root) {
                                Ok(free) if free < total => {
                                    return Err(format!(
                                        "gguf pull: insufficient disk space at {}: need {total}, have {free}",
                                        root.display()
                                    ));
                                }
                                // free_bytes — оптимизация сообщения, не гарант:
                                // ошибка statvfs не останавливает скачивание
                                Ok(_) | Err(_) => {}
                            }
                        }
                    }
                    // Тротлинг emit: статус сменился ИЛИ докачалось ≥ 8 МиБ
                    let moved = p
                        .completed
                        .map(|c| last_emit_received.is_none_or(|last| c - last >= 8 << 20))
                        .unwrap_or(true);
                    if p.status != last_emit_status || moved || p.completed.is_none() {
                        last_emit_status = p.status.clone();
                        last_emit_received = p.completed;
                        let _ = app.emit(
                            "gguf-progress",
                            json!({
                                "phase": "pull",
                                "model": model,
                                "status": p.status,
                                "digest": p.digest.clone(),
                                "received": p.completed,
                                "total": p.total,
                            }),
                        );
                    }
                }
            }
        }
        if GGUF_CANCEL.load(Ordering::Relaxed) {
            // Недокачанное остаётся в Ollama как *-partial — повторный pull
            // продолжит (resume, §4.1); чистить на нашей стороне нечего
            return Err("gguf pull: cancelled".into());
        }
    }
    Err("gguf pull: stream ended without success".into())
}

/// Экспорт модели из хранилища Ollama в appdata/gguf/<slug>.gguf:
/// /api/show → FROM <blob> → копия с sha256-верификацией (§4.2).
/// MLX-модели и split-GGUF — внятный отказ (v1, §28.1).
#[tauri::command(async)]
pub async fn gguf_export(app: tauri::AppHandle, model: String) -> Result<ExportedModel, String> {
    if GGUF_BUSY.swap(true, Ordering::Relaxed) {
        return Err("gguf lab: another operation is already running".into());
    }
    GGUF_CANCEL.store(false, Ordering::Relaxed);
    let result = do_export(&app, &model).await;
    GGUF_BUSY.store(false, Ordering::Relaxed);
    result
}

async fn do_export(app: &tauri::AppHandle, model: &str) -> Result<ExportedModel, String> {
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    let resp = client
        .post(format!("{OLLAMA_URL}/api/show"))
        .json(&json!({ "model": model }))
        .send()
        .await
        .map_err(|e| {
            format!("gguf export: cannot reach Ollama at {OLLAMA_URL} (is it running?): {e}")
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "gguf export: Ollama returned HTTP {} for '{model}'",
            resp.status().as_u16()
        ));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| format!("gguf export: read response: {e}"))?;
    let show = parse_show_body(&body)?;
    if show.format.as_deref() != Some("gguf") {
        return Err(format!(
            "gguf export: model format is {:?} — only gguf is exportable (MLX models are not GGUF)",
            show.format.as_deref().unwrap_or("unknown")
        ));
    }
    match show.from_paths.len() {
        0 => return Err("gguf export: no FROM path in modelfile — unexpected manifest".into()),
        1 => {}
        n => {
            return Err(format!(
                "gguf export: split GGUF ({n} parts) — merge first; v1 exports single-file only"
            ))
        }
    }
    let blob = &show.from_paths[0];
    let file_name = blob
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !is_blob_name(&file_name) {
        return Err(format!(
            "gguf export: unexpected blob name '{file_name}' (expected sha256-<hex>)"
        ));
    }
    let expected_hex = file_name["sha256-".len()..].to_lowercase();
    let size = fs::metadata(blob)
        .map_err(|e| format!("gguf export: stat blob {}: {e}", blob.display()))?
        .len();

    let dir = gguf_dir(app)?;
    // Диск-IO в blocking-пул (№4 аудита v5), место — по ЦЕЛЕВОМУ тому:
    // хранилище Ollama и appdata могут быть на разных дисках
    let dst_dir = dir.clone();
    tauri::async_runtime::spawn_blocking(move || fs::create_dir_all(&dst_dir))
        .await
        .map_err(|e| format!("gguf export: task failed: {e}"))?
        .map_err(|e| format!("gguf export: create dir: {e}"))?;
    match crate::fsutil::free_bytes(&dir) {
        Ok(free) if free < size => {
            return Err(format!(
                "gguf export: insufficient disk space at {}: need {size}, have {free}",
                dir.display()
            ));
        }
        Ok(_) | Err(_) => {}
    }

    let slug = slug_for(model);
    let final_path = dir.join(format!("{slug}.gguf"));
    let tmp_path = dir.join(format!("{slug}.gguf.tmp"));

    let blob = blob.clone();
    let tmp = tmp_path.clone();
    let emit_app = app.clone();
    let model_owned = model.to_string();
    let copied = tauri::async_runtime::spawn_blocking(move || {
        copy_blob_verified(
            &blob,
            &tmp,
            &expected_hex,
            &GGUF_CANCEL,
            |received, total| {
                let _ = emit_app.emit(
                    "gguf-progress",
                    json!({
                        "phase": "export",
                        "model": model_owned,
                        "received": received,
                        "total": total,
                    }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("gguf export: task failed: {e}"))?;

    match copied {
        Ok(bytes) => {
            // rename поверх существующего на Windows невозможен — экспорт
            // перезаписывает сознательно (повторный экспорт той же модели)
            if final_path.exists() {
                fs::remove_file(&final_path)
                    .map_err(|e| format!("gguf export: replace existing: {e}"))?;
            }
            fs::rename(&tmp_path, &final_path)
                .map_err(|e| format!("gguf export: rename: {e}"))?;
            Ok(ExportedModel {
                name: model.to_string(),
                path: final_path.to_string_lossy().into_owned(),
                size_bytes: bytes,
            })
        }
        Err(e) => Err(e), // tmp уже удалён внутри copy_blob_verified
    }
}

/// Кооперативная отмена активной операции GGUF Lab (pull/export/surgery):
/// циклы проверяют флаг между чанками, недописанные tmp удаляются.
#[tauri::command]
pub fn gguf_cancel() {
    GGUF_CANCEL.store(true, Ordering::Relaxed);
}

/// Резка модели из хранилища GGUF Lab (шаг 3c): план → исполнение →
/// post-flight гейт → отчёт. Принимает ТОЛЬКО имя файла в appdata/gguf
/// (не путь) — результат рядом: <база>_cut.gguf.
#[tauri::command(async)]
pub async fn gguf_cut(
    app: tauri::AppHandle,
    src_name: String,
    remove: Vec<u64>,
) -> Result<SurgeryReport, String> {
    if GGUF_BUSY.swap(true, Ordering::Relaxed) {
        return Err("gguf lab: another operation is already running".into());
    }
    GGUF_CANCEL.store(false, Ordering::Relaxed);
    let result = do_cut(app, src_name, remove).await;
    GGUF_BUSY.store(false, Ordering::Relaxed);
    result
}

async fn do_cut(
    app: tauri::AppHandle,
    src_name: String,
    remove: Vec<u64>,
) -> Result<SurgeryReport, String> {
    let dir = gguf_dir(&app)?;
    let src_name = validate_lab_file_name(&src_name)?;
    let src_path = dir.join(&src_name);
    if !src_path.is_file() {
        return Err(format!(
            "gguf cut: source file not found in GGUF Lab storage: {src_name}"
        ));
    }
    let stem = src_name
        .strip_suffix(".gguf")
        .unwrap_or(src_name.as_str())
        .to_string();
    let out_name = format!("{stem}_cut.gguf");
    let dst_path = dir.join(&out_name);

    let emit_app = app.clone();
    let emit_name = out_name.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        run_surgery_pipeline(
            &src_path,
            &dst_path,
            &remove,
            &GGUF_CANCEL,
            |phase, i, n, b, t| {
                let _ = emit_app.emit(
                    "gguf-progress",
                    json!({
                        "phase": phase,
                        "model": emit_name,
                        "step": i,
                        "steps": n,
                        "received": b,
                        "total": t,
                    }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("gguf cut: task failed: {e}"))?;
    if let Ok(r) = &report {
        let _ = app.emit(
            "gguf-progress",
            json!({
                "phase": "done",
                "model": r.output,
                "status": "success",
                "received": r.output_size_bytes,
                "total": r.output_size_bytes,
            }),
        );
    }
    report
}

// ---------------------------------------------------------------------------
// Хирургия: план + streaming-writer (шаг 3a волны §28.2).
// Алгоритм — GGUF_LAB_RESEARCH.md §1.4 (канонический порядок записи),
// §1.9 (чеклист инвариантов), §2.2 (канонический алгоритм резки), §6.2.
// ---------------------------------------------------------------------------

/// Выживший тензор плана: info — с НОВЫМ именем и НОВЫМ offset (так пишется
/// таблица), src_offset — старый offset (откуда копировать данные).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTensor {
    pub info: TensorInfo,
    pub src_offset: u64,
}

/// Правка KV-региона (шаг 3b). InPlace — фиксширинный скаляр (§2.4-7:
/// in-place правомерен только для фиксширинных скаляров); ReplacePair —
/// сплайс целой пары (массив другой длины/типа). ВСТАВОК НЕТ: kv_count
/// в заголовке не меняется — число пар постоянно. key — для post-flight
/// сверки по спанам выходного файла и человекочитаемого отчёта.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KvEdit {
    InPlace {
        key: String,
        value_offset: u64,
        width: u32,
        value: u64,
    },
    ReplacePair {
        key: String,
        pair_start: u64,
        pair_end: u64,
        bytes: Vec<u8>,
    },
}

/// Элементы перекодируемого массива: int-массивы (head_count_kv и др.)
/// и bool-массивы (sliding_window_pattern). Строковые массивы (токенайзер)
/// в хирургии не участвуют никогда.
#[derive(Debug, Clone, Copy)]
pub enum PairElems<'a> {
    Ints(&'a [i64]),
    Bools(&'a [bool]),
}

fn push_elem(b: &mut Vec<u8>, et: ValueType, v: i64) {
    match et {
        ValueType::UInt8 => b.push(v as u8),
        ValueType::Int8 => b.push(v as i8 as u8),
        ValueType::UInt16 => b.extend_from_slice(&(v as u16).to_le_bytes()),
        ValueType::Int16 => b.extend_from_slice(&(v as i16).to_le_bytes()),
        ValueType::UInt32 | ValueType::Int32 => b.extend_from_slice(&(v as i32).to_le_bytes()),
        ValueType::UInt64 | ValueType::Int64 => b.extend_from_slice(&v.to_le_bytes()),
        // Bool-массивы идут через PairElems::Bools; float/строковые массивы
        // per-layer семантики не несут и в правки не попадают (гарды)
        _ => {}
    }
}

/// Перекодировать ПАРУ целиком (ключ + Array + elem + len + элементы):
/// тип элемента сохраняется из исходника — llama.cpp читает его из пары (§1.1)
fn encode_array_pair(key: &str, elem: ValueType, elems: PairElems) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&(key.len() as u64).to_le_bytes());
    b.extend_from_slice(key.as_bytes());
    b.extend_from_slice(&9u32.to_le_bytes()); // ValueType::Array по кодам §1.1
    b.extend_from_slice(&(elem as u32).to_le_bytes());
    match elems {
        PairElems::Ints(v) => {
            b.extend_from_slice(&(v.len() as u64).to_le_bytes());
            for &x in v {
                push_elem(&mut b, elem, x);
            }
        }
        PairElems::Bools(v) => {
            b.extend_from_slice(&(v.len() as u64).to_le_bytes());
            for &x in v {
                b.push(u8::from(x));
            }
        }
    }
    b
}

/// План резки — самодостаточен для исполнения: источник мог измениться между
/// inspect и резкой, поэтому в плане зафиксирована идентичность исходника
/// (длина файла), и execute_surgery метаданные повторно не читает.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurgeryPlan {
    /// Исходные индексы слоёв (отсортированы, уникальны)
    pub remove: Vec<u64>,
    /// old → new индексы выживших слоёв (для UI/отчёта)
    pub renumber: Vec<(u64, u64)>,
    pub new_block_count: u64,
    pub new_tensors: Vec<PlanTensor>,
    /// Сумма nbytes выживших (данные без паддинга) — для UI-оценки
    pub total_out_bytes: u64,
    /// Оценка размера выходного файла (мета + выровненные данные)
    pub out_size_estimate: u64,
    pub warnings: Vec<String>,
    // === Идентичность исходника ===
    pub src_file_len: u64,
    pub src_data_start: u64,
    pub alignment: u32,
    pub kv_end: u64,
    /// Правки KV-региона (block_count + per-layer массивы + nextn +
    /// leading_dense); отсортированы по позиции при исполнении
    pub kv_edits: Vec<KvEdit>,
    /// Человекочитаемые сводки правок — в отчёт операции и UI
    pub kv_edits_summary: Vec<String>,
    /// Длина KV-региона ПОСЛЕ правок (для оценки размера выхода)
    pub kv_out_len: u64,
}

/// Новый индекс слоя: old минус число удалённых ПЕРЕД ним. Сортированный
/// remove + partition_point — O(log n) на тензор.
fn renumber_of(sorted_remove: &[u64], old: u64) -> u64 {
    old - sorted_remove.partition_point(|&r| r < old) as u64
}

/// `blk.{N}.{остаток}` → `blk.{new}.{остаток}`. Вызывается только для имён,
/// прошедших layer_index — None здесь внутренняя ошибка, не формат файла.
fn with_layer_index(name: &str, new_idx: u64) -> Option<String> {
    let rest = name.strip_prefix("blk.")?;
    let dot = rest.find('.')?;
    if !rest[..dot].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("blk.{new_idx}{}", &rest[dot..]))
}

/// Построить план резки (3a: dense-архитектуры без per-layer семантики).
/// Всё, что требует консистентности per-layer массивов/паттернов, — отказ
/// с внятной ошибкой до 3b (§28.1: гибриды — deny-list v1).
pub fn build_surgery_plan(src: &GgufFile, remove: &[u64]) -> Result<SurgeryPlan, String> {
    let arch = src
        .meta
        .architecture
        .clone()
        .ok_or_else(|| "gguf surgery: general.architecture is missing".to_string())?;
    // Различаем «ключа нет» и «ключ не целое число» — диагностике помогает
    // и владелец, и агент-инструмент (шаг 6)
    let block_count = match src.meta.block_count {
        Some(v) => u64::try_from(v)
            .map_err(|_| "gguf surgery: negative block_count".to_string())?,
        None => {
            return Err(if src
                .kv_spans
                .iter()
                .any(|(k, _)| k.ends_with(".block_count"))
            {
                "gguf surgery: block_count is not a fixed-width int (u32/i32/u64/i64) — cannot patch in place".to_string()
            } else {
                format!("gguf surgery: {arch}.block_count is missing")
            });
        }
    };
    // Неоднозначность: больше одного *.block_count — неясно, какой настоящий
    if src
        .kv_spans
        .iter()
        .filter(|(k, _)| k.ends_with(".block_count"))
        .count()
        > 1
    {
        return Err("gguf surgery: multiple *.block_count keys — cannot pick the real one".into());
    }
    // Гибриды в практике сообщества не грузятся после хирургии (§2.4-6)
    if src.flags.hybrid_ssm || src.flags.hybrid_conv {
        return Err(
            "gguf surgery: hybrid SSM/conv architecture — deny-list in v1 (research §6.3)".into(),
        );
    }

    // === Валидация набора удаления ===
    let mut sorted_remove = remove.to_vec();
    sorted_remove.sort_unstable();
    sorted_remove.dedup();
    if sorted_remove.is_empty() {
        return Err("gguf surgery: nothing to remove".into());
    }
    if let Some(&r) = sorted_remove.last() {
        if r >= block_count {
            return Err(format!(
                "gguf surgery: layer {r} is out of range (block_count={block_count})"
            ));
        }
    }
    let new_block_count = block_count - sorted_remove.len() as u64;
    if new_block_count == 0 {
        return Err("gguf surgery: cannot remove every layer".into());
    }

    // === Ренумерация + новые offsets (§1.1: кумулятивная сумма pad(nbytes)
    // по выжившим В ПОРЯДКЕ ФАЙЛА) ===
    let align = src.meta.alignment;
    let mut new_tensors = Vec::new();
    let mut renumber: Vec<(u64, u64)> = Vec::new();
    let mut running: u64 = 0;
    for t in &src.tensors {
        let Some(old_idx) = layer_index(&t.name) else {
            // Глобальные (token_embd/output/…) — вербатим, порядок сохранён
            new_tensors.push(PlanTensor {
                info: TensorInfo {
                    offset: running,
                    ..t.clone()
                },
                src_offset: t.offset,
            });
            running += pad_to(t.nbytes, align);
            continue;
        };
        if sorted_remove.binary_search(&old_idx).is_ok() {
            continue;
        }
        let new_idx = renumber_of(&sorted_remove, old_idx);
        let new_name = with_layer_index(&t.name, new_idx)
            .ok_or_else(|| format!("gguf surgery: internal: unrenumberable name '{}'", t.name))?;
        if !renumber.contains(&(old_idx, new_idx)) {
            renumber.push((old_idx, new_idx));
        }
        new_tensors.push(PlanTensor {
            info: TensorInfo {
                name: new_name,
                offset: running,
                ..t.clone()
            },
            src_offset: t.offset,
        });
        running += pad_to(t.nbytes, align);
    }
    renumber.sort_unstable();

    // === KV-правки (шаг 3b): block_count + per-layer массивы + nextn +
    // leading_dense. Правки строятся по спанам — точные адреса пар. ===
    let is_removed = |old: u64| sorted_remove.binary_search(&old).is_ok();
    let span_of = |key: &str| src.kv_spans.iter().find(|(k, _)| k == key).map(|(_, s)| *s);
    let mut kv_edits: Vec<KvEdit> = Vec::new();

    // block_count — in-place (§2.4-7: фиксширинный скаляр)
    let bc_span = span_of(&format!("{arch}.block_count"))
        .ok_or_else(|| "gguf surgery: internal: no span for block_count".to_string())?;
    let (bc_off, bc_width) = bc_span
        .scalar
        .ok_or_else(|| "gguf surgery: internal: block_count is not a scalar".to_string())?;
    kv_edits.push(KvEdit::InPlace {
        key: format!("{arch}.block_count"),
        value_offset: bc_off,
        width: bc_width,
        value: new_block_count,
    });
    let mut kv_edits_summary = vec![format!(
        "{arch}.block_count = {new_block_count} (in-place)"
    )];

    // Генерик-гард: ЛЮБОЙ другой {arch}.*-массив длиной block_count несёт
    // per-layer семантику, которую мы не знаем → отказ. Ловит будущие архи
    // (§1.6: паттерн-ключи арх-специфичны)
    const HANDLED_PER_LAYER: [&str; 5] = [
        "attention.head_count",
        "attention.head_count_kv",
        "feed_forward_length",
        "expert_used_count",
        "attention.sliding_window_pattern",
    ];
    let arch_prefix = format!("{arch}.");
    for (key, span) in &src.kv_spans {
        let Some(suffix) = key.strip_prefix(arch_prefix.as_str()) else {
            continue;
        };
        let Some((_, len, _)) = span.arr else { continue };
        if len == block_count && !HANDLED_PER_LAYER.contains(&suffix) {
            return Err(format!(
                "gguf surgery: unknown per-layer array '{key}' (length == block_count) — refusing to produce an inconsistent file"
            ));
        }
    }

    // Per-layer int-массивы: обрезка ПО МАППИНГУ, не хвостом (§2.2) —
    // ровно то, что ломает llama-quantize --prune-layers (research §2.4-1)
    for (suffix, spec) in [
        ("attention.head_count", &src.meta.head_count),
        ("attention.head_count_kv", &src.meta.head_count_kv),
        ("feed_forward_length", &src.meta.feed_forward_length),
        ("expert_used_count", &src.meta.expert_used_count),
    ] {
        let Some(LayerSpec::Array(values)) = spec else {
            continue; // скаляр — вербатим (§1.6: Mistral/Qwen2)
        };
        let key = format!("{arch}.{suffix}");
        let span = span_of(&key)
            .ok_or_else(|| format!("gguf surgery: internal: no span for {key}"))?;
        let Some((et, len, _)) = span.arr else {
            return Err(format!(
                "gguf surgery: internal: {key} parsed as array but file says otherwise"
            ));
        };
        if len as usize != values.len() || values.len() as u64 != block_count {
            return Err(format!(
                "gguf surgery: {key}: array length {} != block_count {block_count} — semantics unknown, refusing",
                values.len()
            ));
        }
        let new_values: Vec<i64> = (0..block_count)
            .filter(|old| !is_removed(*old))
            .map(|old| values[old as usize])
            .collect();
        kv_edits_summary.push(format!(
            "{key}: {} → {} элементов (remap по маппингу)",
            values.len(),
            new_values.len()
        ));
        kv_edits.push(KvEdit::ReplacePair {
            key: key.clone(),
            pair_start: span.key_start,
            pair_end: span.end,
            bytes: encode_array_pair(&key, et, PairElems::Ints(&new_values)),
        });
    }

    // === SWA (3b-0: лоадер llama.cpp читает массив → скаляр → per-arch дефолт) ===
    let pattern_key = format!("{arch}.attention.sliding_window_pattern");
    match &src.meta.sliding_window_pattern {
        Some(SwaPattern::Layers(flags)) => {
            // Явный bool-массив — полный ремап членства по выжившим
            let span = span_of(&pattern_key)
                .ok_or_else(|| format!("gguf surgery: internal: no span for {pattern_key}"))?;
            let Some((et, len, _)) = span.arr else {
                return Err(format!(
                    "gguf surgery: internal: {pattern_key} parsed as array but file says otherwise"
                ));
            };
            if et != ValueType::Bool
                || len as usize != flags.len()
                || flags.len() as u64 != block_count
            {
                return Err(format!(
                    "gguf surgery: {pattern_key}: expected bool array of block_count={block_count}, file has {:?} len {len}",
                    et
                ));
            }
            let new_flags: Vec<bool> = (0..block_count)
                .filter(|old| !is_removed(*old))
                .map(|old| flags[old as usize])
                .collect();
            kv_edits_summary.push(format!(
                "{pattern_key}: {} → {} слоёв (ремап SWA-членства)",
                flags.len(),
                new_flags.len()
            ));
            kv_edits.push(KvEdit::ReplacePair {
                key: pattern_key.clone(),
                pair_start: span.key_start,
                pair_end: span.end,
                bytes: encode_array_pair(&pattern_key, ValueType::Bool, PairElems::Bools(&new_flags)),
            });
        }
        Some(SwaPattern::Period(p)) => {
            // Фазовый гард без знания предиката (3b-0): выживший il переезжает
            // на j = il - delta(il), где delta = число удалённых ПЕРЕД ним
            // (partition_point, НЕ новый индекс); членство сохраняется для
            // ОБОИХ вариантов предиката (оба периодичны) ⇔ delta(il) % p == 0.
            // Файл НЕ правится.
            for old in 0..block_count {
                if is_removed(old) {
                    continue;
                }
                let delta = sorted_remove.partition_point(|&r| r < old) as u64;
                if !delta.is_multiple_of(u64::from(*p)) {
                    return Err(format!(
                        "gguf surgery: {pattern_key} is a period ({p}) — removal shifts the SWA phase (layer {old} moves by {delta}); remove layers in multiples of the period or re-export with an explicit bool-array pattern"
                    ));
                }
            }
        }
        None if src.flags.swa => {
            // Окно есть, явного паттерна нет — членство даёт per-arch дефолт
            // llama.cpp; хардкодить таблицу архов = дрейф за llama.cpp (3b-0)
            return Err(format!(
                "gguf surgery: {arch} has sliding_window but no explicit pattern key — membership comes from a per-arch default we do not hardcode; re-export with an explicit per-layer pattern (llama.cpp reads bool arrays)"
            ));
        }
        None => {}
    }

    // === MTP/nextn: stale nextn_predict_layers делает файл unloadable (§2.4-2);
    // trunk = block_count - nextn, MTP-слои — хвост [trunk, block_count) ===
    if let Some(nn) = src.meta.nextn_predict_layers.filter(|&v| v > 0) {
        let nn = u64::try_from(nn)
            .map_err(|_| "gguf surgery: negative nextn_predict_layers".to_string())?;
        let trunk = block_count - nn;
        let removed_in_mtp =
            sorted_remove.len() as u64 - sorted_remove.partition_point(|&r| r < trunk) as u64;
        let new_nextn = nn - removed_in_mtp;
        if new_nextn != nn {
            let key = format!("{arch}.nextn_predict_layers");
            let span = span_of(&key)
                .ok_or_else(|| format!("gguf surgery: {key} is not a fixed-width int"))?;
            let (off, width) = span.scalar.ok_or_else(|| {
                format!("gguf surgery: {key} is not a fixed-width int — cannot patch")
            })?;
            kv_edits_summary
                .push(format!("{key}: {nn} → {new_nextn} (MTP-хвост изменён)"));
            kv_edits.push(KvEdit::InPlace {
                key,
                value_offset: off,
                width,
                value: new_nextn,
            });
        }
    }

    // === MoE с dense-головой: dense = ПЕРВЫЕ ld слоёв; сдвигается, только
    // если удаление зацепило голову (§1.6) ===
    if let Some(ld) = src.meta.leading_dense_block_count {
        let ld = u64::try_from(ld)
            .map_err(|_| "gguf surgery: negative leading_dense_block_count".to_string())?;
        if ld > block_count {
            return Err(format!(
                "gguf surgery: leading_dense_block_count {ld} > block_count {block_count}"
            ));
        }
        let new_dense = (0..ld).filter(|old| !is_removed(*old)).count() as u64;
        if new_dense != ld {
            let key = format!("{arch}.leading_dense_block_count");
            let span = span_of(&key)
                .ok_or_else(|| format!("gguf surgery: {key} is not a fixed-width int"))?;
            let (off, width) = span.scalar.ok_or_else(|| {
                format!("gguf surgery: {key} is not a fixed-width int — cannot patch")
            })?;
            kv_edits_summary
                .push(format!("{key}: {ld} → {new_dense} (dense-голова сдвинута)"));
            kv_edits.push(KvEdit::InPlace {
                key,
                value_offset: off,
                width,
                value: new_dense,
            });
        }
    }

    // Оценка выхода: header + KV (после сплайсов) + регенерированная TI + данные
    let ti_size: u64 = new_tensors
        .iter()
        .map(|pt| 8 + pt.info.name.len() as u64 + 4 + 8 * pt.info.dims.len() as u64 + 4 + 8)
        .sum();
    let kv_out_len: i64 = (src.kv_end - 24) as i64
        + kv_edits
            .iter()
            .map(|e| match e {
                KvEdit::InPlace { .. } => 0,
                KvEdit::ReplacePair {
                    pair_start,
                    pair_end,
                    bytes,
                    ..
                } => bytes.len() as i64 - (*pair_end - *pair_start) as i64,
            })
            .sum::<i64>();
    if kv_out_len < 0 {
        return Err("gguf surgery: internal: negative kv length after edits".into());
    }
    let kv_out_len = kv_out_len as u64;
    let data_start = pad_to(24 + kv_out_len + ti_size, align);
    let out_size_estimate = data_start + running;

    // === Предупреждения плана (качество — на совести исследователя,
    // механику не ломаем; §2.3/§2.4) ===
    let mut warnings = Vec::new();
    if sorted_remove.contains(&(block_count - 1)) {
        warnings.push(
            "the LAST layer is being removed — deepest-block removal degrades quality the most (arXiv:2403.17887)".into(),
        );
    }
    if src.meta.expert_count.is_some() {
        warnings.push("MoE model: layer removal is mechanically safe, but expert statistics shift — validate with perplexity".into());
    }
    warnings.push(
        "general.file_type is copied verbatim and no longer reflects the pruned topology (cosmetic)".into(),
    );

    Ok(SurgeryPlan {
        remove: sorted_remove,
        renumber,
        new_block_count,
        total_out_bytes: new_tensors.iter().map(|pt| pt.info.nbytes).sum(),
        out_size_estimate,
        warnings,
        new_tensors,
        src_file_len: src.file_len,
        src_data_start: src.data_start,
        alignment: align,
        kv_end: src.kv_end,
        kv_edits,
        kv_edits_summary,
        kv_out_len,
    })
}

/// Исполнить план: записать новый GGUF в dst_tmp. Ход (§1.4, §1.9):
/// (1) header вербатим с in-place патчем tensor_count; (2) KV-регион
/// вербатим с in-place патчем block_count (фиксширинный — §2.4-7; словарь
/// НЕ перекодируется); (3) регенерация таблицы тензоров; (4) pad до
/// data_start; (5) потоковое копирование данных выживших чанками mmap →
/// BufWriter с pad после каждого тензора; (6) sync_all. Прогресс — по
/// тензорам (§3.3-7), отмена — между чанками. Ошибка/отмена удаляют tmp.
pub fn execute_surgery(
    src_path: &Path,
    plan: &SurgeryPlan,
    dst_tmp: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(usize, usize, u64, u64),
) -> Result<u64, String> {
    let mut run = || -> Result<u64, String> {
        let file = File::open(src_path).map_err(|e| format!("gguf surgery: open src: {e}"))?;
        let file_len = file
            .metadata()
            .map_err(|e| format!("gguf surgery: stat src: {e}"))?
            .len();
        if file_len != plan.src_file_len {
            return Err(format!(
                "gguf surgery: source changed since planning ({file_len} != {} bytes) — re-inspect",
                plan.src_file_len
            ));
        }
        // SAFETY: файл открыт только на чтение нашим процессом; усечение
        // третьей стороной во время операции — вне модели угроз (локальный
        // файл владельца, операция под Busy-гардом GGUF Lab)
        let mmap = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|e| format!("gguf surgery: mmap failed: {e}"))?;

        let mut w =
            BufWriter::with_capacity(COPY_CHUNK, File::create(dst_tmp).map_err(|e| {
                format!("gguf surgery: create tmp: {e}")
            })?);
        let mut written: u64 = 0;
        let track = |w: &mut BufWriter<File>, bytes: &[u8], written: &mut u64| -> Result<(), String> {
            w.write_all(bytes).map_err(|e| format!("gguf surgery: write: {e}"))?;
            *written += bytes.len() as u64;
            Ok(())
        };

        // (1) header [0..24): magic/version/kv_count вербатим, tensor_count
        // патчится на месте — поле u64 по спеке (§1.1), ширина не меняется
        if mmap.len() < 24 {
            return Err("gguf surgery: file shorter than a GGUF header".into());
        }
        let mut header = [0u8; 24];
        header.copy_from_slice(&mmap[..24]);
        header[8..16].copy_from_slice(&(plan.new_tensors.len() as u64).to_le_bytes());
        track(&mut w, &header, &mut written)?;

        // (2) KV-регион [24..kv_end): сегментный проход по правкам плана.
        // Нетронутые пары (токенайзер!) копируются байт-в-байт; ReplacePair —
        // сплайс пары; InPlace — перезапись ширины значения в буфере (§2.4-7)
        let mut in_place: Vec<(u64, u32, u64)> = Vec::new();
        let mut replaces: Vec<(u64, u64, &[u8])> = Vec::new();
        for e in &plan.kv_edits {
            match e {
                KvEdit::InPlace {
                    value_offset,
                    width,
                    value,
                    ..
                } => in_place.push((*value_offset, *width, *value)),
                KvEdit::ReplacePair {
                    pair_start,
                    pair_end,
                    bytes,
                    ..
                } => replaces.push((*pair_start, *pair_end, bytes.as_slice())),
            }
        }
        replaces.sort_by_key(|(start, _, _)| *start);
        fn copy_kv_range(
            mmap: &memmap2::Mmap,
            w: &mut BufWriter<File>,
            from: u64,
            to: u64,
            patches: &[(u64, u32, u64)],
            written: &mut u64,
            cancel: &AtomicBool,
        ) -> Result<(), String> {
            let mut pos = from;
            while pos < to {
                if cancel.load(Ordering::Relaxed) {
                    return Err("gguf surgery: cancelled".into());
                }
                let end = (pos + COPY_CHUNK as u64).min(to);
                let mut buf = mmap[pos as usize..end as usize].to_vec();
                for &(off, width, value) in patches {
                    if off >= pos && off + u64::from(width) <= end {
                        let i = (off - pos) as usize;
                        let bytes = if width == 4 {
                            (value as u32).to_le_bytes().to_vec()
                        } else {
                            value.to_le_bytes().to_vec()
                        };
                        buf[i..i + width as usize].copy_from_slice(&bytes);
                    }
                }
                w.write_all(&buf)
                    .map_err(|e| format!("gguf surgery: write: {e}"))?;
                *written += buf.len() as u64;
                pos = end;
            }
            Ok(())
        }
        let mut kv_pos = 24u64;
        for (rs, re, bytes) in &replaces {
            copy_kv_range(&mmap, &mut w, kv_pos, *rs, &in_place, &mut written, cancel)?;
            track(&mut w, bytes, &mut written)?;
            kv_pos = *re;
        }
        copy_kv_range(&mmap, &mut w, kv_pos, plan.kv_end, &in_place, &mut written, cancel)?;

        // (3) таблица тензоров регенерируется (число/имена/offsets изменились)
        for pt in &plan.new_tensors {
            let name = pt.info.name.as_bytes();
            track(&mut w, &(name.len() as u64).to_le_bytes(), &mut written)?;
            track(&mut w, name, &mut written)?;
            track(&mut w, &pt.info.n_dims.to_le_bytes(), &mut written)?;
            for d in &pt.info.dims {
                track(&mut w, &d.to_le_bytes(), &mut written)?;
            }
            track(&mut w, &pt.info.type_code.to_le_bytes(), &mut written)?;
            track(&mut w, &pt.info.offset.to_le_bytes(), &mut written)?;
        }

        // (4) pad до data_start — нулями (§1.9-7). TI начинается ПОСЛЕ
        // KV-региона ПОСЛЕ правок (сплайсы меняют его длину)
        let kv_out_end = 24 + plan.kv_out_len;
        let ti_end = kv_out_end
            + plan
                .new_tensors
                .iter()
                .map(|pt| 8 + pt.info.name.len() as u64 + 4 + 8 * pt.info.dims.len() as u64 + 4 + 8)
                .sum::<u64>();
        let data_start = pad_to(ti_end, plan.alignment);
        if data_start > ti_end {
            track(&mut w, &vec![0u8; (data_start - ti_end) as usize], &mut written)?;
        }

        // (5) данные выживших: копия диапазонов из mmap + pad после каждого
        // тензора (§1.4: offsetᵢ₊₁ = offsetᵢ + pad(nbytesᵢ))
        let zeros = vec![0u8; plan.alignment as usize];
        let total = plan.total_out_bytes;
        let mut bytes_done: u64 = 0;
        for (i, pt) in plan.new_tensors.iter().enumerate() {
            let start = (plan.src_data_start + pt.src_offset) as usize;
            let end = start + pt.info.nbytes as usize;
            if end > mmap.len() {
                return Err(format!(
                    "gguf surgery: tensor '{}' data range is out of the source file",
                    pt.info.name
                ));
            }
            let mut off = start;
            while off < end {
                if cancel.load(Ordering::Relaxed) {
                    return Err("gguf surgery: cancelled".into());
                }
                let chunk_end = (off + COPY_CHUNK).min(end);
                track(&mut w, &mmap[off..chunk_end], &mut written)?;
                off = chunk_end;
            }
            let padded_end = pad_to(pt.info.offset + pt.info.nbytes, plan.alignment);
            let pad_len = (padded_end - (pt.info.offset + pt.info.nbytes)) as usize;
            if pad_len > 0 {
                track(&mut w, &zeros[..pad_len], &mut written)?;
            }
            bytes_done += pt.info.nbytes;
            on_progress(i + 1, plan.new_tensors.len(), bytes_done, total);
        }

        // (6) долговечность до rename (§3.3-6)
        let f = w
            .into_inner()
            .map_err(|e| format!("gguf surgery: flush: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("gguf surgery: sync: {e}"))?;
        Ok(written)
    };
    let result = run();
    if result.is_err() || cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(dst_tmp);
    }
    result
}

/// Сводка post-flight гейта — часть отчёта операции
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostflightSummary {
    pub tensors_checked: usize,
    pub bytes_compared: u64,
}

/// Post-flight гейт (§6.2, §2.3 — «гейт на публикацию: реальная загрузка
/// обязательна», здесь — собственный ридер как структурный прокси):
/// (1) структурная валидация выхода собственным ридером — инварианты §1.7,
/// включая непрерывность offset'ов, проверяются парсером заново;
/// (2) семантика против плана: block_count, тензоры (имена/типы/размеры),
/// каждая KV-правка сверяется по спану выходного файла;
/// (3) данные выживших байт-в-байт против исходника (mmap обоих файлов,
/// чанки, отмена). Любое расхождение → Err, вызывающий удаляет tmp.
pub fn postflight_verify(
    src_path: &Path,
    out_path: &Path,
    plan: &SurgeryPlan,
    cancel: &AtomicBool,
) -> Result<PostflightSummary, String> {
    // (1) структурная валидация — GgufFile::open прогоняет весь §1.7
    let out = GgufFile::open(out_path)?;

    // (2) семантика против плана
    if out.meta.block_count != Some(plan.new_block_count as i64) {
        return Err(format!(
            "gguf surgery: postflight: block_count = {:?}, expected {}",
            out.meta.block_count, plan.new_block_count
        ));
    }
    if out.tensors.len() != plan.new_tensors.len() {
        return Err(format!(
            "gguf surgery: postflight: tensor count {} != plan {}",
            out.tensors.len(),
            plan.new_tensors.len()
        ));
    }
    for (pt, ot) in plan.new_tensors.iter().zip(&out.tensors) {
        if ot.name != pt.info.name
            || ot.type_code != pt.info.type_code
            || ot.nbytes != pt.info.nbytes
            || ot.dims != pt.info.dims
        {
            return Err(format!(
                "gguf surgery: postflight: tensor mismatch at '{}': got '{}' {:?} {} bytes",
                pt.info.name, ot.name, ot.dims, ot.nbytes
            ));
        }
    }
    let out_mmap = map_for_verify(out_path, "output")?;
    for e in &plan.kv_edits {
        match e {
            KvEdit::InPlace {
                key, value, width, ..
            } => {
                let span = out
                    .kv_spans
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, s)| *s)
                    .ok_or_else(|| {
                        format!("gguf surgery: postflight: key '{key}' missing in output")
                    })?;
                let (off, w) = span
                    .scalar
                    .ok_or_else(|| format!("gguf surgery: postflight: '{key}' is not a scalar in output"))?;
                if w != *width || off + u64::from(w) > out_mmap.len() as u64 {
                    return Err(format!("gguf surgery: postflight: '{key}' span is wrong"));
                }
                let i = off as usize;
                let raw = &out_mmap[i..i + w as usize];
                let got = if w == 4 {
                    u64::from(u32::from_le_bytes(raw.try_into().unwrap()))
                } else {
                    u64::from_le_bytes(raw.try_into().unwrap())
                };
                if got != *value {
                    return Err(format!(
                        "gguf surgery: postflight: '{key}' = {got}, expected {value}"
                    ));
                }
            }
            KvEdit::ReplacePair { key, bytes, .. } => {
                let span = out
                    .kv_spans
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, s)| *s)
                    .ok_or_else(|| {
                        format!("gguf surgery: postflight: key '{key}' missing in output")
                    })?;
                let got = &out_mmap[span.key_start as usize..span.end as usize];
                if got != bytes.as_slice() {
                    return Err(format!(
                        "gguf surgery: postflight: pair '{key}' does not match the plan"
                    ));
                }
            }
        }
    }

    // (3) данные выживших байт-в-байт (mmap обоих, чанки, отмена)
    let src_mmap = map_for_verify(src_path, "source")?;
    for pt in &plan.new_tensors {
        let s = (plan.src_data_start + pt.src_offset) as usize;
        let o = (out.data_start + pt.info.offset) as usize;
        let n = pt.info.nbytes as usize;
        if s + n > src_mmap.len() || o + n > out_mmap.len() {
            return Err(format!(
                "gguf surgery: postflight: data range of '{}' is out of bounds",
                pt.info.name
            ));
        }
        let mut off = 0usize;
        while off < n {
            if cancel.load(Ordering::Relaxed) {
                return Err("gguf surgery: postflight: cancelled".into());
            }
            let len = COPY_CHUNK.min(n - off);
            if src_mmap[s + off..s + off + len] != out_mmap[o + off..o + off + len] {
                return Err(format!(
                    "gguf surgery: postflight: data mismatch in tensor '{}' at +{}",
                    pt.info.name, off
                ));
            }
            off += len;
        }
    }
    Ok(PostflightSummary {
        tensors_checked: plan.new_tensors.len(),
        bytes_compared: plan.total_out_bytes,
    })
}

fn map_for_verify(path: &Path, what: &str) -> Result<memmap2::Mmap, String> {
    let f = File::open(path).map_err(|e| format!("gguf surgery: postflight: open {what}: {e}"))?;
    // SAFETY: файлы созданы этой же операцией и не пишутся параллельно
    // (Busy-гард GGUF Lab); усечение третьей стороной — вне модели угроз
    unsafe { memmap2::Mmap::map(&f) }.map_err(|e| format!("gguf surgery: postflight: mmap {what}: {e}"))
}

/// Отчёт операции резки — в UI и агент-инструменту (шаг 6)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurgeryReport {
    pub output: String,
    pub output_size_bytes: u64,
    pub duration_ms: u64,
    pub removed_layers: Vec<u64>,
    pub renumber: Vec<(u64, u64)>,
    pub new_block_count: u64,
    pub kv_edits: Vec<String>,
    pub warnings: Vec<String>,
    pub verified: PostflightSummary,
}

/// Валидатор имени файла в хранилище GGUF Lab: только имя, только .gguf.
/// Команда gguf_cut НЕ принимает произвольных путей с фронтенда — лаборатория
/// самодостаточна в appdata/gguf (§6.4), поэтому ensure_export_target не нужен.
fn validate_lab_file_name(name: &str) -> Result<String, String> {    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name != Path::new(name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    {
        return Err(format!(
            "gguf cut: '{name}' is not a plain file name (paths are not accepted)"
        ));
    }
    if !name.to_ascii_lowercase().ends_with(".gguf") {
        return Err(format!("gguf cut: '{name}' must be a .gguf file"));
    }
    Ok(name.to_string())
}

/// Полный цикл резки (шаг 3c): план → pre-flight места → исполнение →
/// post-flight гейт → rename → отчёт. Синхронная — под spawn_blocking
/// команды. tmp не переживает ни ошибку, ни отмену (§28.3).
pub(crate) fn run_surgery_pipeline(
    src_path: &Path,
    dst_path: &Path,
    remove: &[u64],
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&str, usize, usize, u64, u64),
) -> Result<SurgeryReport, String> {
    let started = std::time::Instant::now();
    let src = GgufFile::open(src_path)?;
    let plan = build_surgery_plan(&src, remove)?;

    // Pre-flight места (§6.2): оценка выхода известна из плана
    let dst_dir = dst_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    match crate::fsutil::free_bytes(&dst_dir) {
        Ok(free) if free < plan.out_size_estimate => {
            return Err(format!(
                "gguf surgery: insufficient disk space at {}: need {}, have {free}",
                dst_dir.display(),
                plan.out_size_estimate
            ));
        }
        Ok(_) | Err(_) => {}
    }

    let out_name = dst_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out.gguf".into());
    let tmp_path = dst_path.with_file_name(format!("{out_name}.tmp"));
    on_progress("plan", 0, 0, 0, plan.out_size_estimate);
    execute_surgery(src_path, &plan, &tmp_path, cancel, |i, n, b, t| {
        on_progress("surgery", i, n, b, t)
    })?;
    // Post-flight: ошибка/отмена → tmp прочь, отказ без «полуготового» файла
    let verified = match postflight_verify(src_path, &tmp_path, &plan, cancel) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    // rename поверх существующего на Windows невозможен — перезапись
    // сознательна (повторная резка той же модели)
    if dst_path.exists() {
        fs::remove_file(dst_path).map_err(|e| format!("gguf surgery: replace existing: {e}"))?;
    }
    fs::rename(&tmp_path, dst_path).map_err(|e| format!("gguf surgery: rename: {e}"))?;
    on_progress("done", 1, 1, plan.total_out_bytes, plan.total_out_bytes);

    let output_size = fs::metadata(dst_path)
        .map_err(|e| format!("gguf surgery: stat output: {e}"))?
        .len();
    Ok(SurgeryReport {
        output: out_name,
        output_size_bytes: output_size,
        duration_ms: started.elapsed().as_millis() as u64,
        removed_layers: plan.remove.clone(),
        renumber: plan.renumber.clone(),
        new_block_count: plan.new_block_count,
        kv_edits: plan.kv_edits_summary.clone(),
        warnings: plan.warnings.clone(),
        verified,
    })
}

// ---------------------------------------------------------------------------
// Хранилище GGUF Lab: список файлов и инспектор (UI шага 5)
// ---------------------------------------------------------------------------

/// Файл в хранилище GGUF Lab (appdata/gguf)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabFile {
    pub name: String,
    pub size_bytes: u64,
}

/// Список .gguf-файлов каталога лаборатории (один уровень, tmp пропущен).
/// Синхронная — под spawn_blocking команды.
fn lab_files_in(dir: &Path) -> Vec<LabFile> {
    let mut out: Vec<LabFile> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    if !p.is_file() {
                        return None;
                    }
                    let name = p.file_name()?.to_string_lossy().into_owned();
                    if !name.to_ascii_lowercase().ends_with(".gguf") || name.contains(".tmp") {
                        return None;
                    }
                    Some(LabFile {
                        size_bytes: e.metadata().ok()?.len(),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Файлы хранилища GGUF Lab
#[tauri::command(async)]
pub async fn gguf_lab_files(app: tauri::AppHandle) -> Result<Vec<LabFile>, String> {
    let dir = gguf_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Каталог создаётся лениво: пустое хранилище — норма, а не ошибка
        let _ = fs::create_dir_all(&dir);
        lab_files_in(&dir)
    })
    .await
    .map_err(|e| format!("gguf lab: task failed: {e}"))
}

/// Инспектор файла (read-only ядро шага 1): сводка + слои для таблицы UI
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufInspect {
    pub name: String,
    pub size_bytes: u64,
    pub version: u32,
    pub architecture: Option<String>,
    pub alignment: u32,
    pub block_count: Option<i64>,
    pub tensor_count: usize,
    pub quantization_version: Option<i64>,
    pub has_tokenizer: bool,
    pub flags: ArchFlags,
    pub warnings: Vec<String>,
    pub layers: Vec<LayerInfo>,
    pub global_tensors: Vec<TensorInfo>,
    pub total_tensor_bytes: u64,
}

/// Разобрать файл хранилища и отдать сводку для UI
#[tauri::command(async)]
pub async fn gguf_inspect(app: tauri::AppHandle, src_name: String) -> Result<GgufInspect, String> {
    let src_name = validate_lab_file_name(&src_name)?;
    let path = gguf_dir(&app)?.join(&src_name);
    let name = src_name;
    tauri::async_runtime::spawn_blocking(move || {
        let f = GgufFile::open(&path)?;
        let rep = f.layers();
        Ok(GgufInspect {
            name,
            size_bytes: f.file_len,
            version: f.meta.version,
            architecture: f.meta.architecture,
            alignment: f.meta.alignment,
            block_count: f.meta.block_count,
            tensor_count: f.tensors.len(),
            quantization_version: f.meta.quantization_version,
            has_tokenizer: f.meta.has_tokenizer,
            flags: f.flags,
            warnings: f.warnings,
            layers: rep.layers,
            global_tensors: rep.global,
            total_tensor_bytes: {
                // ДО частичного перемещения полей f — считаем из тензоров
                f.tensors.iter().map(|t| t.nbytes).sum()
            },
        })
    })
    .await
    .map_err(|e| format!("gguf lab: task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Тестовый рантайм (шаг 4 волны §28.2): llama-server + Ollama create.
// Детали — GGUF_LAB_RESEARCH.md §4.3/§4.4/§4.6 (api.md/server README 10.2026).
// ---------------------------------------------------------------------------

/// /health llama-server: 200 — модель готова; 503 — грузится (порт слушается
/// ДО загрузки модели — единственный надёжный сигнал готовности, §4.4)
const LLAMA_HEALTH_TIMEOUT_SECS: u64 = 300;
const HEALTH_POLL_MS: u64 = 500;

/// Состояние тест-сервера GGUF Lab: pid для kill_tree, порт и имя модели.
/// Child-хэндл не хранится сознательно: после успешного старта управляем
/// процессом через kill_tree (§proc), смерть процесса в чате проявится
/// ошибкой соединения — UI шага 5 покажет «сервер упал» по статусу.
struct ServerSession {
    pid: u32,
    port: u16,
    model: String,
}

static TEST_SERVER: std::sync::Mutex<Option<ServerSession>> = std::sync::Mutex::new(None);

fn lock_server() -> Result<std::sync::MutexGuard<'static, Option<ServerSession>>, String> {
    TEST_SERVER
        .lock()
        .map_err(|_| "gguf serve: server state poisoned".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerStatus {
    pub configured_path: Option<String>,
    pub resolved_path: Option<String>,
    pub server_running: bool,
    pub server_port: Option<u16>,
    pub server_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeInfo {
    pub port: u16,
    pub base_url: String,
    pub model: String,
}

/// Резолв llama-server: путь из конфига (gguf.json) → PATH-скан.
/// Паттерн dictation.rs (whisper-cli): конфиг с путь-фолбэком в PATH.
fn resolve_llama_server(config_path: Option<&str>, path_env: &str) -> Option<PathBuf> {
    if let Some(p) = config_path.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_env.split(sep) {
        if dir.trim().is_empty() {
            continue;
        }
        let cand = PathBuf::from(dir.trim()).join(exe);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Свободный порт: ephemeral-bind → отпустить. Гонка между drop и спавном
/// сервера теоретически возможна, /health-поллинг это выявит (refused).
fn pick_free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .map(|l| l.local_addr().expect("bound listener has addr").port())
        .map_err(|e| format!("gguf serve: no free port: {e}"))
}

enum HealthState {
    Ready,
    Loading,
    Other(String),
}

/// Чистая интерпретация ответа /health (§4.4) — под golden-тесты
fn interpret_health(status: u16, body: &str) -> HealthState {
    match status {
        200 => HealthState::Ready,
        503 => HealthState::Loading,
        other => HealthState::Other(format!("HTTP {other}: {}", body.trim())),
    }
}

/// Хвост лога для диагностики упавшего сервера (последние ~1.5 КиБ)
fn log_tail(path: &Path) -> String {
    let Ok(s) = fs::read_to_string(path) else {
        return "(log unreadable)".into();
    };
    if s.chars().count() <= 1500 {
        return s;
    }
    let tail: String = s.chars().skip(s.chars().count() - 1500).collect();
    format!("…{tail}")
}

/// Статус llama-server: конфиг + резолв + живая сессия
#[tauri::command(async)]
pub async fn gguf_llama_status(app: tauri::AppHandle) -> Result<LlamaServerStatus, String> {
    let configured = read_llama_config(&app);
    let resolved = resolve_llama_server(
        configured.as_deref(),
        &std::env::var("PATH").unwrap_or_default(),
    )
    .map(|p| p.to_string_lossy().into_owned());
    let g = lock_server()?;
    Ok(LlamaServerStatus {
        configured_path: configured,
        resolved_path: resolved,
        server_running: g.is_some(),
        server_port: g.as_ref().map(|s| s.port),
        server_model: g.as_ref().map(|s| s.model.clone()),
    })
}

/// Путь к llama-server: Some — задать (перезаписать), None — оставить как есть.
/// Хранится в gguf.json (паттерн dictation.json)
#[tauri::command(async)]
pub async fn gguf_llama_set_path(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cur = crate::settings::read_json_config(&app, "gguf.json")
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        cur.insert("llama_server_path".into(), json!(path));
        crate::settings::save_json_config(&app, "gguf.json", &serde_json::Value::Object(cur))
    })
    .await
    .map_err(|e| format!("gguf config task failed: {e}"))?
}

fn read_llama_config(app: &tauri::AppHandle) -> Option<String> {
    crate::settings::read_json_config(app, "gguf.json")
        .ok()
        .and_then(|v| {
            v.get("llama_server_path")
                .and_then(|p| p.as_str())
                .map(String::from)
        })
}

/// Поднять llama-server над моделью из хранилища GGUF Lab: эфемерный порт,
/// лог в appdata/gguf/logs, /health-поллинг до готовности (§4.4: 503 = грузится,
/// refused = ещё не слушает — ждём, но смерть процесса фейлим сразу с хвостом
/// лога). Килла по закрытию — gguf_serve_stop (kill_tree).
#[tauri::command(async)]
pub async fn gguf_serve_start(
    app: tauri::AppHandle,
    src_name: String,
    ctx_size: Option<u32>,
) -> Result<ServeInfo, String> {
    let src_name = validate_lab_file_name(&src_name)?;
    if lock_server()?.is_some() {
        return Err("gguf serve: a test server is already running — stop it first".into());
    }
    let dir = gguf_dir(&app)?;
    let model_path = dir.join(&src_name);
    if !model_path.is_file() {
        return Err(format!(
            "gguf serve: source file not found in GGUF Lab storage: {src_name}"
        ));
    }
    let bin = {
        let configured = read_llama_config(&app);
        resolve_llama_server(
            configured.as_deref(),
            &std::env::var("PATH").unwrap_or_default(),
        )
        .ok_or_else(|| {
            "llama-server not found — install llama.cpp, add it to PATH or set the path in settings (or use the download button)".to_string()
        })?
    };
    let port = pick_free_port()?;
    let ctx = ctx_size.unwrap_or(4096);
    let alias = src_name.trim_end_matches(".gguf").to_string();

    let logs_dir = dir.join("logs");
    let log_path = logs_dir.join(format!("llama-server-{port}.log"));
    tauri::async_runtime::spawn_blocking(move || fs::create_dir_all(&logs_dir))
        .await
        .map_err(|e| format!("gguf serve: task failed: {e}"))?
        .map_err(|e| format!("gguf serve: create logs dir: {e}"))?;

    let mut cmd = std::process::Command::new(&bin);
    cmd.args([
        "-m",
        &model_path.to_string_lossy(),
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-c",
        &ctx.to_string(),
        "-a",
        &alias,
    ]);
    let mut child = tauri::async_runtime::spawn_blocking({
        let log_path = log_path.clone();
        move || crate::proc::spawn_detached(&mut cmd, &log_path)
    })
    .await
    .map_err(|e| format!("gguf serve: task failed: {e}"))??;

    // /health-поллинг (§4.4): 503 = Loading → ждать; refused → ждать, но
    // смерть процесса фейлит сразу; 200 = Ready
    let client = crate::network::shared_client(std::time::Duration::from_secs(2))?;
    let health_url = format!("http://127.0.0.1:{port}/health");
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(LLAMA_HEALTH_TIMEOUT_SECS);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            crate::proc::kill_tree(child.id());
            return Err(format!(
                "llama-server exited during startup (code {status:?}) — log tail: {}",
                log_tail(&log_path)
            ));
        }
        if let Ok(resp) = client.get(&health_url).send().await {
            let code = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            match interpret_health(code, &body) {
                HealthState::Ready => break,
                HealthState::Loading => {}
                HealthState::Other(m) => {
                    crate::proc::kill_tree(child.id());
                    return Err(format!(
                        "llama-server /health: {m} — log tail: {}",
                        log_tail(&log_path)
                    ));
                }
            }
        } // Err: ещё не слушает — ждём до дедлайна
        if std::time::Instant::now() > deadline {
            crate::proc::kill_tree(child.id());
            return Err(format!(
                "llama-server not ready after {LLAMA_HEALTH_TIMEOUT_SECS}s — log tail: {}",
                log_tail(&log_path)
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_MS)).await;
    }
    let info = ServeInfo {
        port,
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: alias.clone(),
    };
    *lock_server()? = Some(ServerSession {
        pid: child.id(),
        port,
        model: src_name,
    });
    drop(child);
    Ok(info)
}

/// Остановить тест-сервер: kill_tree по pid сессии
#[tauri::command]
pub fn gguf_serve_stop() -> Result<(), String> {
    let mut g = lock_server()?;
    if let Some(s) = g.take() {
        crate::proc::kill_tree(s.pid);
    }
    Ok(())
}

// === Скачивание llama-server (§4.4) ===

#[derive(Debug, Clone)]
struct ReleaseAsset {
    name: String,
    url: String,
}

/// Чистый парсер ответа /releases (массив объектов {tag_name, assets:
/// [{name, browser_download_url}]}) — под golden-тесты формата GitHub API
fn parse_releases(body: &str) -> Result<Vec<(String, Vec<ReleaseAsset>)>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("gguf download: bad releases JSON: {e}"))?;
    let arr = v
        .as_array()
        .ok_or_else(|| "gguf download: releases JSON is not an array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|r| {
            let tag = r.get("tag_name")?.as_str()?.to_string();
            let assets = r
                .get("assets")?
                .as_array()?
                .iter()
                .filter_map(|a| {
                    Some(ReleaseAsset {
                        name: a.get("name")?.as_str()?.to_string(),
                        url: a.get("browser_download_url")?.as_str()?.to_string(),
                    })
                })
                .collect();
            Some((tag, assets))
        })
        .collect())
}

/// Бинари llama.cpp живут на per-commit тегах bNNNNN; semver-«latest» несёт
/// только nightly-tag.txt (проверено по API 10.2026, §4.4) — берём ПЕРВЫЙ
/// b-тег в списке релизов
fn pick_binary_release(
    releases: &[(String, Vec<ReleaseAsset>)],
) -> Option<&(String, Vec<ReleaseAsset>)> {
    releases.iter().find(|(tag, _)| {
        tag.strip_prefix('b')
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
    })
}

/// Выбор ассета под платформу: CPU-варианты (CUDA/Vulkan/RoCM/SYCL/OpenVINO —
/// без них: ~18.5 МиБ против сотен, а ускорение — руками через путь в
/// настройках). Имена сверены с релизом b11451 (4-0)
fn pick_release_asset<'a>(
    assets: &'a [ReleaseAsset],
    os: &str,
    arch: &str,
) -> Option<&'a ReleaseAsset> {
    let needle = match (os, arch) {
        ("windows", "x86_64") => "bin-win-cpu-x64.zip",
        ("linux", "x86_64") => "bin-ubuntu-x64.tar.gz",
        ("macos", "x86_64") => "bin-macos-x64.tar.gz",
        ("macos", "aarch64") => "bin-macos-arm64.tar.gz",
        ("linux", "aarch64") => "bin-ubuntu-arm64.tar.gz",
        _ => return None,
    };
    assets.iter().find(|a| a.name.contains(needle))
}

fn current_os_arch() -> (&'static str, &'static str) {
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "unknown"
    };
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    (os, arch)
}

/// Скачать llama-server последнего бинарого релиза в appdata/gguf/bin и
/// распаковать: tar/bsdtar (Windows tar.exe умеет zip) — без zip-зависимости.
/// Найденный бинарь сохраняется в gguf.json как llama_server_path.
#[tauri::command(async)]
pub async fn gguf_llama_download(app: tauri::AppHandle) -> Result<String, String> {
    if GGUF_BUSY.swap(true, Ordering::Relaxed) {
        return Err("gguf lab: another operation is already running".into());
    }
    GGUF_CANCEL.store(false, Ordering::Relaxed);
    let result = do_llama_download(app).await;
    GGUF_BUSY.store(false, Ordering::Relaxed);
    result
}

async fn do_llama_download(app: tauri::AppHandle) -> Result<String, String> {
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;
    // (1) список релизов → первый b-тег
    let releases = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15")
        .header("User-Agent", "Nocturn-GGUF-Lab")
        .send()
        .await
        .map_err(|e| format!("gguf download: cannot reach GitHub: {e}"))?;
    if !releases.status().is_success() {
        return Err(format!(
            "gguf download: GitHub returned HTTP {}",
            releases.status().as_u16()
        ));
    }
    let body = releases
        .text()
        .await
        .map_err(|e| format!("gguf download: read releases: {e}"))?;
    let releases = parse_releases(&body)?;
    let (tag, assets) = pick_binary_release(&releases)
        .ok_or_else(|| "gguf download: no binary release (bNNNNN) found in the last 15 releases".to_string())?;
    let (os, arch) = current_os_arch();
    let asset = pick_release_asset(assets, os, arch)
        .ok_or_else(|| format!("gguf download: no CPU asset for {os}/{arch} in {tag}"))?;
    let asset_url = asset.url.clone();
    let asset_name = asset.name.clone();
    let _ = app.emit(
        "gguf-progress",
        json!({ "phase": "download", "model": asset_name, "status": format!("downloading {tag}") }),
    );

    // (2) стрим в tmp → rename (паттерн voice.rs), прогресс ~1 МиБ
    let dir = gguf_dir(&app)?;
    let bin_dir = dir.join("bin");
    tauri::async_runtime::spawn_blocking({
        let bin_dir = bin_dir.clone();
        move || fs::create_dir_all(&bin_dir)
    })
    .await
    .map_err(|e| format!("gguf download: task failed: {e}"))?
    .map_err(|e| format!("gguf download: create dir: {e}"))?;
    let archive_path = bin_dir.join(&asset_name);
    let tmp_path = bin_dir.join(format!("{asset_name}.tmp"));
    let tmp_in_task = tmp_path.clone();

    let resp = client
        .get(&asset_url)
        .header("User-Agent", "Nocturn-GGUF-Lab")
        .send()
        .await
        .map_err(|e| format!("gguf download: fetch asset: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "gguf download: asset fetch returned HTTP {}",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut resp = resp;
    {
        let app2 = app.clone();
        let emit_name = asset_name.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async move {
                let mut file = tokio::fs::File::create(&tmp_in_task)
                    .await
                    .map_err(|e| format!("gguf download: create tmp: {e}"))?;
                use tokio::io::AsyncWriteExt as _;
                let mut received: u64 = 0;
                let mut last_emit: u64 = 0;
                while let Some(chunk) = resp
                    .chunk()
                    .await
                    .map_err(|e| format!("gguf download: interrupted: {e}"))?
                {
                    if GGUF_CANCEL.load(Ordering::Relaxed) {
                        return Err("gguf download: cancelled".into());
                    }
                    file.write_all(&chunk)
                        .await
                        .map_err(|e| format!("gguf download: write: {e}"))?;
                    received += chunk.len() as u64;
                    if received - last_emit >= 1 << 20 {
                        last_emit = received;
                        let _ = app2.emit(
                            "gguf-progress",
                            json!({ "phase": "download", "model": emit_name, "received": received, "total": total }),
                        );
                    }
                }
                file.flush()
                    .await
                    .map_err(|e| format!("gguf download: flush: {e}"))?;
                if received == 0 {
                    return Err("gguf download: empty response".into());
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| format!("gguf download: task failed: {e}"))??;
    }
    if GGUF_CANCEL.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&tmp_path);
        return Err("gguf download: cancelled".into());
    }
    fs::rename(&tmp_path, &archive_path)
        .map_err(|e| format!("gguf download: rename: {e}"))?;

    // (3) распаковка: bsdtar (Windows tar.exe) умеет zip; GNU tar — tar.gz.
    // CPU-ассет ~18.5 МиБ — распаковка секундная
    let flag = if archive_path.to_string_lossy().ends_with(".zip") {
        "-xf"
    } else {
        "-xzf"
    };
    let bin_dir2 = bin_dir.clone();
    let archive = archive_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("tar");
        cmd.args([flag, &archive.to_string_lossy(), "-C", &bin_dir2.to_string_lossy()]);
        crate::proc::run_command_opts(&mut cmd, std::time::Duration::from_secs(600), None, None)
            .map_err(|e| format!("gguf download: extract: {e}"))
            .and_then(|out| {
                if out.timed_out || out.status != Some(0) {
                    Err(format!(
                        "gguf download: extract failed (status {:?}) — stderr: {}",
                        out.status,
                        out.stderr.chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()
                    ))
                } else {
                    Ok(())
                }
            })
    })
    .await
    .map_err(|e| format!("gguf download: task failed: {e}"))??;
    let _ = fs::remove_file(&archive_path);

    // (4) найти llama-server рекурсивно (релиз пакует build/bin/Release/*)
    let found = find_llama_server(&bin_dir)
        .ok_or_else(|| "gguf download: llama-server not found after extraction".to_string())?;
    let found_str = found.to_string_lossy().into_owned();
    // Сохранить в конфиг — следующий serve_start подхватит
    let app2 = app.clone();
    let found2 = found_str.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut cur = crate::settings::read_json_config(&app2, "gguf.json")
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        cur.insert("llama_server_path".into(), json!(found2));
        crate::settings::save_json_config(&app2, "gguf.json", &serde_json::Value::Object(cur))
    })
    .await
    .map_err(|e| format!("gguf download: task failed: {e}"))??;
    Ok(found_str)
}

/// Рекурсивный поиск llama-server(.exe) в каталоге (стек, не рекурсия —
/// как dir_size в fsutil)
fn find_llama_server(dir: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().is_some_and(|n| n == exe) {
                return Some(p);
            }
        }
    }
    None
}

// === Импорт в Ollama: blob push + create (§4.3) ===

enum CreateEvent {
    Status(String),
    Done,
    Error(String),
}

/// Чистая интерпретация NDJSON-строки /api/create (§4.3) — под golden-тесты
fn parse_create_line(line: &str) -> Result<CreateEvent, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("gguf import: bad NDJSON ({e}): {line}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Ok(CreateEvent::Error(err.to_string()));
    }
    match v.get("status").and_then(|s| s.as_str()) {
        Some("success") => Ok(CreateEvent::Done),
        Some(s) => Ok(CreateEvent::Status(s.to_string())),
        None => Ok(CreateEvent::Status(String::new())),
    }
}

fn validate_ollama_model_name(name: &str) -> Result<(), String> {
    // Локальное имя модели: буквы/цифры/._-/ (+тег через ':'); пути и пробелы — нет
    if name.is_empty()
        || name.contains("..")
        || name.chars().any(|c| {
            c.is_whitespace() || c == '\\' || c.is_control()
        })
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
    {
        return Err(format!(
            "gguf import: '{name}' is not a valid Ollama model name (letters, digits, . _ - : /)"
        ));
    }
    Ok(())
}

/// SHA-256 файла стримом (sync — под spawn_blocking): блоб Ollama
/// контент-адресный, дайджест нужен ДО пуша (§4.3)
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("gguf import: open: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("gguf import: read: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// Импортировать GGUF из хранилища GGUF Lab в Ollama: HEAD/POST /api/blobs
/// + POST /api/create (НОВЫЙ трёхшаговый формат, §4.3 — поле modelfile
/// удалено из API). Прогресс — событием gguf-progress (phase "import").
#[tauri::command(async)]
pub async fn gguf_ollama_import(
    app: tauri::AppHandle,
    src_name: String,
    model_name: String,
) -> Result<(), String> {
    if GGUF_BUSY.swap(true, Ordering::Relaxed) {
        return Err("gguf lab: another operation is already running".into());
    }
    GGUF_CANCEL.store(false, Ordering::Relaxed);
    let result = do_ollama_import(app, src_name, model_name).await;
    GGUF_BUSY.store(false, Ordering::Relaxed);
    result
}

async fn wait_cancelled() {
    loop {
        if GGUF_CANCEL.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn do_ollama_import(
    app: tauri::AppHandle,
    src_name: String,
    model_name: String,
) -> Result<(), String> {
    let src_name = validate_lab_file_name(&src_name)?;
    validate_ollama_model_name(&model_name)?;
    let dir = gguf_dir(&app)?;
    let src_path = dir.join(&src_name);
    if !src_path.is_file() {
        return Err(format!(
            "gguf import: source file not found in GGUF Lab storage: {src_name}"
        ));
    }
    let client = crate::network::shared_client(std::time::Duration::from_secs(30))?;

    // (1) дайджест (spawn_blocking — мульти-ГБ чтение)
    let digest_path = src_path.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || sha256_file(&digest_path))
        .await
        .map_err(|e| format!("gguf import: task failed: {e}"))??;
    let digest_url = format!("{OLLAMA_URL}/api/blobs/sha256:{digest}");

    // (2) push блоба, если его ещё нет (HEAD → 404 → POST стримом)
    let head = client.head(&digest_url).send().await.map_err(|e| {
        format!("gguf import: cannot reach Ollama at {OLLAMA_URL} (is it running?): {e}")
    })?;
    if head.status().as_u16() == 404 {
        let size = fs::metadata(&src_path)
            .map_err(|e| format!("gguf import: stat: {e}"))?
            .len();
        let file = tokio::fs::File::open(&src_path)
            .await
            .map_err(|e| format!("gguf import: open: {e}"))?;
        // Стрим чанками — файл не материализуется в памяти (§3.3)
        use tokio::io::AsyncReadExt as _;
        let stream = futures_util::stream::unfold(
            (file, 0u64),
            |(mut f, done)| async move {
                let mut buf = vec![0u8; COPY_CHUNK];
                match f.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(n) => Some((Ok::<_, std::io::Error>(buf[..n].to_vec()), (f, done + n as u64))),
                    Err(e) => Some((Err(e), (f, done))),
                }
            },
        );
        let push = client
            .post(&digest_url)
            .header("Content-Length", size)
            .body(reqwest::Body::wrap_stream(stream))
            .send();
        // Отмена пуша: дроп future = дроп соединения = сервер отменяет приём
        let pushed = tokio::select! {
            r = push => r,
            _ = wait_cancelled() => return Err("gguf import: cancelled".into()),
        };
        let status = pushed
            .map_err(|e| format!("gguf import: blob push failed: {e}"))?
            .status();
        if status.as_u16() == 400 {
            return Err("gguf import: Ollama rejected the blob (digest mismatch)".into());
        }
        if !status.is_success() {
            return Err(format!("gguf import: blob push returned HTTP {}", status.as_u16()));
        }
    } else if !head.status().is_success() {
        return Err(format!(
            "gguf import: blob check returned HTTP {}",
            head.status().as_u16()
        ));
    }

    // (3) create: NDJSON-поток статусов; ошибка/отмена — сразу
    let create = client
        .post(format!("{OLLAMA_URL}/api/create"))
        .json(&json!({
            "model": model_name,
            "files": { "model.gguf": format!("sha256:{digest}") }
        }))
        .send();
    let resp = tokio::select! {
        r = create => r,
        _ = wait_cancelled() => return Err("gguf import: cancelled".into()),
    };
    let mut resp = resp
        .map_err(|e| format!("gguf import: create failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "gguf import: create returned HTTP {}",
            resp.status().as_u16()
        ));
    }
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            c = resp.chunk() => c.map_err(|e| format!("gguf import: stream interrupted: {e}"))?,
            _ = wait_cancelled() => return Err("gguf import: cancelled".into()),
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = std::str::from_utf8(&line[..line.len() - 1]).unwrap_or_default();
            if line.trim().is_empty() {
                continue;
            }
            match parse_create_line(line)? {
                CreateEvent::Done => {
                    let _ = app.emit(
                        "gguf-progress",
                        json!({ "phase": "import", "model": model_name, "status": "success" }),
                    );
                    return Ok(());
                }
                CreateEvent::Error(e) => return Err(format!("gguf import: {e}")),
                CreateEvent::Status(s) => {
                    let _ = app.emit(
                        "gguf-progress",
                        json!({ "phase": "import", "model": model_name, "status": s }),
                    );
                }
            }
        }
    }
    Err("gguf import: stream ended without success".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // === Синтетический GGUF: канонический писатель по §1.4 (тесты только) ===
    // Референс для негативных тестов §1.7; golden-тест первых байтов ловит
    // расхождение builder'а с реальным форматом.

    enum Kv {
        S(String),
        U32(u32),
        Bool(bool),
        ArrU32(Vec<u32>),
        ArrI32(Vec<i32>),
        ArrBool(Vec<bool>),
        ArrStr(Vec<String>),
        /// Строка с ОБЪЯВЛЕННОЙ длиной без байтов — hostile-тест капов
        HugeString(u64),
        /// Числовой массив с объявленной длиной, байты не пишутся
        HugeArrU64(u64),
    }

    struct SynthTensor {
        name: String,
        dims: Vec<u64>,
        ttype: i32,
        /// 0 = нули; >0 = детерминированный паттерн — данные после хирургии
        /// сверяются байт-в-байт с исходником (нули не ловят подмену диапазона)
        pattern: u8,
    }

    fn st(name: &str, dims: &[u64], ttype: i32) -> SynthTensor {
        SynthTensor {
            name: name.to_string(),
            dims: dims.to_vec(),
            ttype,
            pattern: 0,
        }
    }

    fn stp(name: &str, dims: &[u64], ttype: i32, pattern: u8) -> SynthTensor {
        SynthTensor {
            name: name.to_string(),
            dims: dims.to_vec(),
            ttype,
            pattern,
        }
    }

    struct Synth {
        version: u32,
        alignment: Option<u32>,
        kv: Vec<(String, Kv)>,
        tensors: Vec<SynthTensor>,
        /// Флаги битой записи для негативных тестов
        swap_counts: bool,
        big_endian: bool,
        shift_offset: Option<(usize, u64)>,
        truncate_tail: u64,
    }

    impl Default for Synth {
        fn default() -> Self {
            Self {
                version: 3,
                alignment: None,
                kv: Vec::new(),
                tensors: Vec::new(),
                swap_counts: false,
                big_endian: false,
                shift_offset: None,
                truncate_tail: 0,
            }
        }
    }

    impl SynthTensor {
        fn nbytes(&self) -> u64 {
            // n_dims=0 — битый файл для reader'а (отказ до nbytes), но билдеру
            // нужно место данных: 0 байтов. Невалидный/удалённый ttype — то же:
            // reader отвергнет по типу раньше nbytes.
            if self.dims.is_empty() {
                return 0;
            }
            match ggml_type(self.ttype) {
                Some(ty) => tensor_nbytes(&ty, &self.dims).expect("synth: size fits"),
                None => 0,
            }
        }
    }

    impl Synth {
        /// Минимальный dense-файл «как у llama»: token_embd/output + blk.N нормы.
        fn llama_dense(blocks: u64) -> Self {
            let mut kv = vec![
                (
                    "general.architecture".to_string(),
                    Kv::S("llama".to_string()),
                ),
                ("general.quantization_version".to_string(), Kv::U32(2)),
                ("llama.block_count".to_string(), Kv::U32(blocks as u32)),
            ];
            if blocks > 0 {
                kv.push(("llama.attention.head_count".to_string(), Kv::U32(32)));
            }
            let mut tensors = vec![
                st("token_embd.weight", &[128, 8], 0),
                st("output.weight", &[128, 8], 0),
            ];
            for i in 0..blocks {
                tensors.push(st(&format!("blk.{i}.attn_norm.weight"), &[128], 0));
                tensors.push(st(&format!("blk.{i}.ffn_norm.weight"), &[128], 0));
            }
            Self {
                kv,
                tensors,
                ..Self::default()
            }
        }

        fn build(&self) -> Vec<u8> {
            let align = self.alignment.unwrap_or(DEFAULT_ALIGNMENT);
            // +1 за general.alignment, который пишется ниже при Some
            let extra_kv = usize::from(self.alignment.is_some());
            let (n_tensors, n_kv) = if self.swap_counts {
                (
                    (self.kv.len() + extra_kv) as u64,
                    self.tensors.len() as u64,
                )
            } else {
                (
                    self.tensors.len() as u64,
                    (self.kv.len() + extra_kv) as u64,
                )
            };
            let mut w = Vec::new();
            w.extend_from_slice(&MAGIC);
            if self.big_endian {
                w.extend_from_slice(&self.version.to_be_bytes());
            } else {
                w.extend_from_slice(&self.version.to_le_bytes());
            }
            w.extend_from_slice(&n_tensors.to_le_bytes());
            w.extend_from_slice(&n_kv.to_le_bytes());

            // general.alignment обязан быть В ФАЙЛЕ, если задан: паддинг
            // builder'а и ридер должны видеть одно и то же значение
            if let Some(a) = self.alignment {
                write_str(&mut w, "general.alignment");
                w.extend_from_slice(&4u32.to_le_bytes());
                w.extend_from_slice(&a.to_le_bytes());
            }

            for (key, v) in &self.kv {
                write_str(&mut w, key);
                match v {
                    Kv::S(s) => {
                        w.extend_from_slice(&8u32.to_le_bytes());
                        write_str(&mut w, s);
                    }
                    Kv::HugeString(len) => {
                        // байтов нет — reader обязан отсечь капом, не аллоцировать
                        w.extend_from_slice(&8u32.to_le_bytes());
                        w.extend_from_slice(&len.to_le_bytes());
                    }
                    Kv::U32(x) => {
                        w.extend_from_slice(&4u32.to_le_bytes());
                        w.extend_from_slice(&x.to_le_bytes());
                    }
                    Kv::Bool(b) => {
                        w.extend_from_slice(&7u32.to_le_bytes());
                        w.push(u8::from(*b));
                    }
                    Kv::ArrU32(a) => {
                        w.extend_from_slice(&9u32.to_le_bytes());
                        w.extend_from_slice(&4u32.to_le_bytes());
                        w.extend_from_slice(&(a.len() as u64).to_le_bytes());
                        for x in a {
                            w.extend_from_slice(&x.to_le_bytes());
                        }
                    }
                    Kv::ArrI32(a) => {
                        w.extend_from_slice(&9u32.to_le_bytes());
                        w.extend_from_slice(&5u32.to_le_bytes());
                        w.extend_from_slice(&(a.len() as u64).to_le_bytes());
                        for x in a {
                            w.extend_from_slice(&x.to_le_bytes());
                        }
                    }
                    Kv::ArrBool(a) => {
                        w.extend_from_slice(&9u32.to_le_bytes());
                        w.extend_from_slice(&7u32.to_le_bytes());
                        w.extend_from_slice(&(a.len() as u64).to_le_bytes());
                        for b in a {
                            w.push(u8::from(*b));
                        }
                    }
                    Kv::ArrStr(a) => {
                        w.extend_from_slice(&9u32.to_le_bytes());
                        w.extend_from_slice(&8u32.to_le_bytes());
                        w.extend_from_slice(&(a.len() as u64).to_le_bytes());
                        for s in a {
                            write_str(&mut w, s);
                        }
                    }
                    Kv::HugeArrU64(len) => {
                        w.extend_from_slice(&9u32.to_le_bytes());
                        w.extend_from_slice(&10u32.to_le_bytes());
                        w.extend_from_slice(&len.to_le_bytes());
                    }
                }
            }

            let offsets = canonical_offsets(self, align);
            for (i, t) in self.tensors.iter().enumerate() {
                write_str(&mut w, &t.name);
                w.extend_from_slice(&(t.dims.len() as u32).to_le_bytes());
                for d in &t.dims {
                    w.extend_from_slice(&d.to_le_bytes());
                }
                w.extend_from_slice(&t.ttype.to_le_bytes());
                let offset = match self.shift_offset {
                    Some((idx, delta)) if idx == i => offsets[i] + delta,
                    _ => offsets[i],
                };
                w.extend_from_slice(&offset.to_le_bytes());
            }
            // Паддинг до data_start (§1.4) и данные тензорами по порядку
            let data_start = pad_raw(w.len() as u64, align);
            w.resize(data_start as usize, 0);
            for (i, t) in self.tensors.iter().enumerate() {
                let start = (data_start + offsets[i]) as usize;
                let end = start + t.nbytes() as usize;
                if w.len() < end {
                    w.resize(end, 0);
                }
                if t.pattern != 0 {
                    for (j, b) in w[start..end].iter_mut().enumerate() {
                        *b = (j as u8).wrapping_mul(t.pattern).wrapping_add(t.pattern);
                    }
                }
            }
            if self.truncate_tail > 0 {
                let cut = w.len().saturating_sub(self.truncate_tail as usize);
                w.truncate(cut);
            }
            w
        }
    }

    fn write_str(w: &mut Vec<u8>, s: &str) {
        w.extend_from_slice(&(s.len() as u64).to_le_bytes());
        w.extend_from_slice(s.as_bytes());
    }

    /// Канонические offsets: кумулятивная сумма pad(nbytes) (§1.1) —
    /// единственный источник правды для builder'а и для shift-теста.
    fn canonical_offsets(s: &Synth, align: u32) -> Vec<u64> {
        let mut out = Vec::with_capacity(s.tensors.len());
        let mut running = 0u64;
        for t in &s.tensors {
            out.push(running);
            running += pad_raw(t.nbytes(), align);
        }
        out
    }

    /// Паддинг без debug_assert: негативные тесты строят файлы с битым
    /// alignment, читающая сторона такие отвергает своей валидацией.
    fn pad_raw(v: u64, align: u32) -> u64 {
        v.div_ceil(u64::from(align)) * u64::from(align)
    }

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("haloui-gguf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn parse_bytes(name: &str, bytes: &[u8]) -> Result<GgufFile, String> {
        GgufFile::open(&write_tmp(name, bytes))
    }

    fn expect_err(s: &Synth, name: &str, needle: &str) {
        let err = parse_bytes(name, &s.build()).unwrap_err();
        assert!(err.contains(needle), "expected '{needle}' in error, got: {err}");
    }

    // === Golden: раскладка заголовка §1.1 (tensor_count РАНЬШЕ kv_count) ===

    #[test]
    fn golden_header_layout_v3() {
        // llama_dense(0): 3 KV (arch, quantization_version, block_count), 2 тензора
        let b = Synth::llama_dense(0).build();
        assert_eq!(&b[0..4], b"GGUF");
        assert_eq!(&b[4..8], &3u32.to_le_bytes());
        assert_eq!(u64::from_le_bytes(b[8..16].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(b[16..24].try_into().unwrap()), 3);
    }

    /// Защита транскрипции таблицы геометрии (§1.3) — опечатка здесь = битый
    /// nbytes у квантов.
    #[test]
    fn geometry_table_matches_reference() {
        let cases = [
            (0, "F32", 1, 4),
            (2, "Q4_0", 32, 18),
            (8, "Q8_0", 32, 34),
            (12, "Q4_K", 256, 144),
            (14, "Q6_K", 256, 210),
            (23, "IQ4_XS", 256, 136),
            (29, "IQ1_M", 256, 56),
            (30, "BF16", 1, 2),
            (34, "TQ1_0", 256, 54),
            (35, "TQ2_0", 256, 66),
            (39, "MXFP4", 32, 17),
            (40, "NVFP4", 64, 36),
            (41, "Q1_0", 128, 18),
            (42, "Q2_0", 64, 18),
        ];
        for (code, name, blk, ts) in cases {
            let ty = ggml_type(code).unwrap_or_else(|| panic!("type {name} missing"));
            assert_eq!((ty.name, ty.block_size, ty.type_size), (name, blk, ts));
        }
        for code in [4, 5, 31, 32, 33, 36, 37, 38] {
            assert!(ggml_type(code).is_none(), "removed type {code} must not parse");
        }
        assert!(ggml_type(43).is_none());
    }

    // === Позитивные сценарии ===

    #[test]
    fn parses_dense_llama_and_groups_layers() {
        let f = parse_bytes("dense.gguf", &Synth::llama_dense(4).build()).unwrap();
        assert_eq!(f.meta.architecture.as_deref(), Some("llama"));
        assert_eq!(f.meta.block_count, Some(4));
        assert_eq!(f.meta.alignment, DEFAULT_ALIGNMENT);
        assert!(!f.meta.has_tokenizer);
        let rep = f.layers();
        assert_eq!(rep.layers.len(), 4);
        assert_eq!(rep.layers[0].index, 0);
        assert_eq!(rep.layers[3].index, 3);
        assert_eq!(rep.global.len(), 2);
        assert!(rep.global.iter().any(|t| t.name == "token_embd.weight"));
        assert!(rep.layers.iter().all(|l| l.has_attention));
        assert!(!f.flags.moe && !f.flags.swa && !f.flags.nextn);
        assert!(f.warnings.is_empty());
    }

    #[test]
    fn parses_v2_and_custom_alignment() {
        let mut s = Synth::llama_dense(1);
        s.version = 2;
        s.alignment = Some(64);
        let f = parse_bytes("v2.gguf", &s.build()).unwrap();
        assert_eq!(f.meta.version, 2);
        assert_eq!(f.meta.alignment, 64);
        assert_eq!(f.data_start % 64, 0, "data_start выровнен на alignment");
    }

    #[test]
    fn tokenizer_arrays_skipped_but_keys_kept() {
        let mut s = Synth::llama_dense(1);
        let vocab: Vec<String> = (0..1000).map(|i| format!("tok{i}")).collect();
        s.kv.push(("tokenizer.ggml.tokens".into(), Kv::ArrStr(vocab)));
        // 5000 > RETAIN_ARRAY_CAP: путь skip с РЕАЛЬНЫМИ байтами в файле
        s.kv.push((
            "tokenizer.ggml.scores".into(),
            Kv::ArrU32(vec![7; 5000]),
        ));
        let f = parse_bytes("tok.gguf", &s.build()).unwrap();
        assert!(f.meta.has_tokenizer);
        assert!(f.meta.kv_keys.contains(&"tokenizer.ggml.tokens".to_string()));
    }

    #[test]
    fn per_layer_arrays_resolved_as_layer_spec() {
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 8, 4, 4]),
        ));
        s.kv.push((
            "llama.feed_forward_length".into(),
            Kv::ArrU32(vec![256; 4]),
        ));
        let f = parse_bytes("spec.gguf", &s.build()).unwrap();
        assert_eq!(
            f.meta.head_count,
            Some(LayerSpec::Scalar(32)),
            "head_count остаётся скаляром (§1.6: Mistral/Qwen2)"
        );
        assert_eq!(
            f.meta.head_count_kv,
            Some(LayerSpec::Array(vec![8, 8, 4, 4])),
            "массивы per-layer должны удержаться целиком — резка по маппингу (§2.2)"
        );
        assert_eq!(
            f.meta.feed_forward_length,
            Some(LayerSpec::Array(vec![256; 4]))
        );
    }

    #[test]
    fn swa_pattern_scalar_and_bool_array() {
        // gemma-стиль: scalar период
        let mut s = Synth::llama_dense(6);
        s.kv[0] = ("general.architecture".into(), Kv::S("gemma3".into()));
        s.kv.push(("gemma3.attention.sliding_window".into(), Kv::U32(512)));
        s.kv.push(("gemma3.attention.sliding_window_pattern".into(), Kv::U32(6)));
        let f = parse_bytes("swa-scalar.gguf", &s.build()).unwrap();
        assert!(f.flags.swa);
        assert_eq!(f.meta.sliding_window_pattern, Some(SwaPattern::Period(6)));

        // gemma3n/4-стиль: bool-массив per-layer
        let mut s = Synth::llama_dense(6);
        s.kv[0] = ("general.architecture".into(), Kv::S("gemma4".into()));
        s.kv.push((
            "gemma4.attention.sliding_window_pattern".into(),
            Kv::ArrBool(vec![false, true, true, true, true, false]),
        ));
        let f = parse_bytes("swa-bool.gguf", &s.build()).unwrap();
        assert_eq!(
            f.meta.sliding_window_pattern,
            Some(SwaPattern::Layers(vec![false, true, true, true, true, false]))
        );
    }

    #[test]
    fn moe_and_nextn_flags() {
        let mut s = Synth::llama_dense(2);
        s.kv[0] = ("general.architecture".into(), Kv::S("qwen3moe".into()));
        s.kv.push(("qwen3moe.expert_count".into(), Kv::U32(8)));
        s.kv.push(("qwen3moe.nextn_predict_layers".into(), Kv::U32(1)));
        // MoE-эксперты: 3D-тензор Q8_0 (dims[0]=256 кратен block_size)
        s.tensors
            .push(st("blk.0.ffn_gate_exps.weight", &[256, 128, 8], 8));
        s.tensors
            .push(st("blk.2.nextn.eh_proj.weight", &[128, 128], 0));
        let f = parse_bytes("moe.gguf", &s.build()).unwrap();
        assert!(f.flags.moe);
        assert!(
            f.flags.nextn,
            "MTP определяется и по ключу, и по тензорам (§1.6)"
        );
        assert_eq!(f.meta.expert_count, Some(8));
        let rep = f.layers();
        let moe_layer = rep.layers.iter().find(|l| l.index == 0).unwrap();
        assert!(moe_layer.has_moe_experts);
    }

    #[test]
    fn hybrid_conv_flags_and_zero_kv_heads() {
        // LFM2-стиль: conv-слой + head_count_kv с 0 для conv-слоёв (§1.6)
        let mut s = Synth::llama_dense(4);
        s.kv[0] = ("general.architecture".into(), Kv::S("lfm2".into()));
        s.kv.push((
            "lfm2.attention.head_count_kv".into(),
            Kv::ArrI32(vec![16, 0, 16, 0]),
        ));
        s.tensors.push(st("blk.1.shortconv.conv.weight", &[64], 0));
        let f = parse_bytes("hybrid.gguf", &s.build()).unwrap();
        assert!(f.flags.hybrid_conv);
        assert_eq!(
            f.meta.head_count_kv,
            Some(LayerSpec::Array(vec![16, 0, 16, 0])),
            "нули conv-слоёв обязаны дожить до planner'а"
        );
    }

    #[test]
    fn arch_after_arch_keys_still_resolves() {
        // general.architecture не обязан быть первым KV — резолв post-parse
        let mut s = Synth::llama_dense(1);
        let arch = s.kv.remove(0);
        s.kv.insert(2, arch);
        let f = parse_bytes("arch-order.gguf", &s.build()).unwrap();
        assert_eq!(f.meta.block_count, Some(1));
    }

    #[test]
    fn warnings_for_missing_arch_and_quant_version() {
        let mut s = Synth::llama_dense(1);
        s.kv.retain(|(k, _)| k != "general.architecture");
        let f = parse_bytes("noarch.gguf", &s.build()).unwrap();
        assert!(f.warnings.iter().any(|w| w.contains("architecture")));
        assert_eq!(f.meta.block_count, None);

        // кванты без quantization_version — спека требует, код прощает (§1.7-7)
        let mut s = Synth::llama_dense(1);
        s.kv.retain(|(k, _)| k != "general.quantization_version");
        s.tensors.push(st("blk.0.attn_q.weight", &[256, 128], 12)); // Q4_K
        let f = parse_bytes("noqver.gguf", &s.build()).unwrap();
        assert!(f.warnings.iter().any(|w| w.contains("quantization_version")));
    }

    // === Негативные: по одному на пункт §1.7 ===

    #[test]
    fn rejects_bad_magic() {
        let mut b = Synth::llama_dense(1).build();
        b[0] = b'X';
        let err = parse_bytes("badmagic.gguf", &b).unwrap_err();
        assert!(err.contains("bad magic"), "got: {err}");
    }

    #[test]
    fn rejects_v1_v4_and_big_endian() {
        let mut s = Synth::llama_dense(1);
        s.version = 1;
        expect_err(&s, "v1.gguf", "version 1");

        let mut s = Synth::llama_dense(1);
        s.version = 4;
        expect_err(&s, "v4.gguf", "unsupported version");

        let mut s = Synth::llama_dense(1);
        s.big_endian = true;
        expect_err(&s, "be.gguf", "big-endian");
    }

    #[test]
    fn rejects_swapped_header_counts() {
        let mut s = Synth::llama_dense(2);
        s.swap_counts = true;
        // 6 тензоров / 4 KV меняются местами → парс срывается на заведомой
        // бессмыслице (не «тихо прочитали другой файл»)
        assert!(parse_bytes("swap.gguf", &s.build()).is_err());
    }

    #[test]
    fn rejects_duplicate_kv_key_and_tensor_name() {
        let mut s = Synth::llama_dense(1);
        s.kv.push(("llama.block_count".into(), Kv::U32(9)));
        expect_err(&s, "dupkey.gguf", "duplicate kv key");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.attn_norm.weight", &[128], 0));
        expect_err(&s, "duptensor.gguf", "duplicate tensor name");
    }

    #[test]
    fn rejects_long_and_empty_names() {
        let mut s = Synth::llama_dense(1);
        let long = "a".repeat(64); // 64 байта = ≥ GGML_MAX_NAME (§1.8)
        s.tensors.push(st(&long, &[128], 0));
        expect_err(&s, "longname.gguf", "too long");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("", &[128], 0));
        expect_err(&s, "emptyname.gguf", "empty name");
    }

    #[test]
    fn rejects_bad_dims_and_types() {
        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.x", &[128, 8, 4, 2, 1], 0)); // n_dims=5
        expect_err(&s, "dims5.gguf", "invalid n_dims");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.x", &[], 0)); // n_dims=0
        expect_err(&s, "dims0.gguf", "invalid n_dims");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.x", &[128], 43)); // == GGML_TYPE_COUNT
        expect_err(&s, "type43.gguf", "unknown type");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.x", &[128], 4)); // Q4_2 — удалён
        expect_err(&s, "type-removed.gguf", "removed type");

        let mut s = Synth::llama_dense(1);
        s.tensors.push(st("blk.0.x", &[128, 0], 0)); // dim = 0
        expect_err(&s, "dim0.gguf", "is zero");
    }

    #[test]
    fn rejects_quant_ne0_not_multiple_of_block() {
        let mut s = Synth::llama_dense(1);
        s.tensors
            .push(st("blk.0.attn_q.weight", &[300], 12)); // Q4_K, 300 % 256 != 0
        expect_err(&s, "qmisalign.gguf", "not a multiple of block size");
    }

    #[test]
    fn rejects_non_pow2_alignment() {
        let mut s = Synth::llama_dense(1);
        s.alignment = Some(24); // кратное 8, но НЕ степень двойки (§1.8)
        expect_err(&s, "align24.gguf", "power of two");
    }

    #[test]
    fn alignment_of_wrong_type_falls_back_to_default() {
        let mut s = Synth::llama_dense(1);
        s.kv.push(("general.alignment".into(), Kv::S("32".into())));
        // строка вместо u32 → alignment не резолвится, файл структурно валиден
        let f = parse_bytes("align-str.gguf", &s.build()).unwrap();
        assert_eq!(f.meta.alignment, DEFAULT_ALIGNMENT);
    }

    #[test]
    fn rejects_offset_hole() {
        let mut s = Synth::llama_dense(2);
        s.shift_offset = Some((1, 32)); // «дыра» ровно в alignment — всё равно отказ
        expect_err(&s, "hole.gguf", "has offset");
    }

    #[test]
    fn rejects_truncated_file() {
        let mut s = Synth::llama_dense(2);
        s.truncate_tail = 10;
        expect_err(&s, "trunc.gguf", "truncated");
    }

    #[test]
    fn rejects_hostile_lengths_without_alloc() {
        let mut s = Synth::llama_dense(1);
        s.kv.push(("evil.string".into(), Kv::HugeString(1 << 40)));
        expect_err(&s, "hugestr.gguf", "exceeds");

        let mut s = Synth::llama_dense(1);
        s.kv.push(("evil.arr".into(), Kv::HugeArrU64(1 << 40)));
        expect_err(&s, "hugearr.gguf", "exceeds");
    }

    #[test]
    fn rejects_bad_bool_byte() {
        let mut s = Synth::llama_dense(1);
        s.kv.push(("some.flag".into(), Kv::Bool(true)));
        let mut b = s.build();
        // bool-значение в потоке: код типа 07 00 00 00, затем байт 0/1;
        // «anything else is invalid» (§1.1) — правим сам байт значения
        let pos = b
            .windows(5)
            .position(|w| w[0] == 7 && w[1] == 0 && w[2] == 0 && w[3] == 0)
            .expect("bool kv present in synth file");
        b[pos + 4] = 2;
        let err = parse_bytes("badbool.gguf", &b).unwrap_err();
        assert!(err.contains("bool"), "got: {err}");
    }

    #[test]
    fn rejects_empty_kv_key() {
        let mut s = Synth::llama_dense(1);
        s.kv.push(("".into(), Kv::U32(1)));
        expect_err(&s, "emptykey.gguf", "empty kv key");
    }

    #[test]
    fn zero_tensor_file_is_valid() {
        // совсем пустой файл: 0 KV, 0 тензоров
        let f = parse_bytes("empty.gguf", &Synth::default().build()).unwrap();
        assert!(f.tensors.is_empty());
        assert_eq!(f.total_tensor_bytes(), 0);
        assert!(f.layers().layers.is_empty());
    }

    // === Шаг 2: конвейер Ollama ===

    #[test]
    fn pull_line_all_event_shapes() {
        // §4.1: манифест без digest; прогресс с digest/total/completed;
        // completed отсутствует до старта слоя; верификация; success; error
        match parse_pull_line(r#"{"status":"pulling manifest"}"#).unwrap() {
            PullEvent::Progress(p) => {
                assert_eq!(p.status, "pulling manifest");
                assert!(p.digest.is_none() && p.total.is_none() && p.completed.is_none());
            }
            _ => panic!("expected progress"),
        }
        match parse_pull_line(
            r#"{"status":"pulling abc123","digest":"sha256:abc123","total":1000,"completed":500}"#,
        )
        .unwrap()
        {
            PullEvent::Progress(p) => {
                assert_eq!(p.digest.as_deref(), Some("sha256:abc123"));
                assert_eq!(p.total, Some(1000));
                assert_eq!(p.completed, Some(500));
            }
            _ => panic!("expected progress"),
        }
        match parse_pull_line(r#"{"status":"pulling abc123","digest":"sha256:abc123","total":1000}"#)
            .unwrap()
        {
            PullEvent::Progress(p) => {
                assert_eq!(p.total, Some(1000));
                assert!(p.completed.is_none(), "completed опционален (§4.1)");
            }
            _ => panic!("expected progress"),
        }
        assert!(matches!(
            parse_pull_line(r#"{"status":"verifying sha256 digest"}"#).unwrap(),
            PullEvent::Progress(_)
        ));
        assert!(matches!(
            parse_pull_line(r#"{"status":"success"}"#).unwrap(),
            PullEvent::Done
        ));
        match parse_pull_line(r#"{"error":"pull model manifest: file does not exist"}"#).unwrap() {
            PullEvent::Error(e) => assert!(e.contains("does not exist")),
            _ => panic!("expected error event"),
        }
        // Unknown поля не ломают парсер (Ollama добавляет поля между версиями)
        assert!(matches!(
            parse_pull_line(r#"{"status":"x","new_future_field":1}"#).unwrap(),
            PullEvent::Progress(_)
        ));
        assert!(parse_pull_line("not json").is_err());
    }

    #[test]
    fn show_body_from_paths_and_format() {
        // ВАЖНО: это r#"…"#-строка — последовательность "# внутри разорвала бы
        // литерал, поэтому в комментарии Modelfile нет решётки
        let body = r#"{
            "modelfile": "comment\nFROM C:\\Users\\u\\.ollama\\models\\blobs\\sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nPARAMETER stop \"<|eot|>\"\n",
            "details": { "format": "gguf", "family": "llama" }
        }"#;
        let info = parse_show_body(body).unwrap();
        assert_eq!(info.format.as_deref(), Some("gguf"));
        assert_eq!(info.from_paths.len(), 1);
        assert!(is_blob_name(
            info.from_paths[0]
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        ));

        // MLX: формат не gguf
        let body = r#"{"modelfile":"FROM x","details":{"format":"safetensors"}}"#;
        assert_eq!(parse_show_body(body).unwrap().format.as_deref(), Some("safetensors"));

        // Split: два FROM — экспорт v1 обязан отказаться
        let body = r#"{"modelfile":"FROM /a\nFROM /b","details":{"format":"gguf"}}"#;
        assert_eq!(parse_show_body(body).unwrap().from_paths.len(), 2);

        // Нет modelfile — пусто, без паники
        let body = r#"{"details":{"format":"gguf"}}"#;
        let info = parse_show_body(body).unwrap();
        assert!(info.from_paths.is_empty());
    }

    #[test]
    fn models_root_resolution() {
        let home = Path::new("/home/u");
        // OLLAMA_MODELS перекрывает дефолт (§4.2), в т.ч. пустая строка — нет
        assert_eq!(
            models_root_from(Some("D:\\models"), Some(home)),
            PathBuf::from("D:\\models")
        );
        assert_eq!(
            models_root_from(Some("  "), Some(home)),
            home.join(".ollama").join("models")
        );
        assert_eq!(
            models_root_from(None, Some(home)),
            home.join(".ollama").join("models")
        );
        // home неизвестен — не паникуем (относительный фолбэк)
        assert_eq!(
            models_root_from(None, None),
            PathBuf::from(".ollama").join("models")
        );
    }

    #[test]
    fn blob_name_pattern() {
        let hex = "a".repeat(64);
        assert!(is_blob_name(&format!("sha256-{hex}")));
        assert!(is_blob_name(&format!("sha256-{}", hex.to_uppercase())));
        assert!(!is_blob_name("sha256-short"));
        assert!(!is_blob_name("model.gguf"));
        assert!(!is_blob_name("sha256-"));
    }

    #[test]
    fn slug_is_filesystem_safe() {
        assert_eq!(slug_for("llama3:latest"), "llama3_latest");
        assert_eq!(slug_for("hf.co/user/repo:Q4_K_M"), "hf.co_user_repo_Q4_K_M");
        assert_eq!(slug_for(""), "model");
    }

    #[test]
    fn copy_blob_verifies_hash_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("haloui-gguf-copy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("sha256-src");
        let payload: Vec<u8> = (0..513 * 1024u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &payload).unwrap();
        let expected = hex_lower(&Sha256::digest(&payload));

        let dst = dir.join("out.gguf.tmp");
        let cancel = AtomicBool::new(false);
        let n = copy_blob_verified(&src, &dst, &expected, &cancel, |_, _| {}).unwrap();
        assert_eq!(n as usize, payload.len());
        assert_eq!(fs::read(&dst).unwrap(), payload, "копия байт-в-байт");

        // Неверный ожидаемый хэш → отказ и tmp удалён
        let wrong = "0".repeat(64);
        let err = copy_blob_verified(&src, &dst, &wrong, &cancel, |_, _| {}).unwrap_err();
        assert!(err.contains("mismatch"), "got: {err}");
        assert!(!dst.exists(), "tmp не остаётся после ошибки (§28.3)");

        // Отмена до старта → отказ, tmp удалён
        let cancel = AtomicBool::new(true);
        let err = copy_blob_verified(&src, &dst, &expected, &cancel, |_, _| {}).unwrap_err();
        assert!(err.contains("cancelled"));
        assert!(!dst.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    // === Шаг 3a: хирургия (план + streaming-writer) ===

    /// Полный прогон: синтез → parse → plan → execute → байты результата
    fn run_cut(
        s: &Synth,
        remove: &[u64],
        name: &str,
    ) -> (GgufFile, SurgeryPlan, GgufFile, Vec<u8>, std::path::PathBuf) {
        let src_path = write_tmp(&format!("{name}.src.gguf"), &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, remove).unwrap();
        let dst = write_tmp(&format!("{name}.out.gguf"), &[]);
        let cancel = AtomicBool::new(false);
        execute_surgery(&src_path, &plan, &dst, &cancel, |_, _, _, _| {}).unwrap();
        let bytes = fs::read(&dst).unwrap();
        let out = GgufFile::open(&dst).unwrap();
        (src, plan, out, bytes, src_path)
    }

    /// Данные выжившего тензора в результате == данные исходника (байт-в-байт)
    fn assert_data_equal(
        src: &GgufFile,
        src_bytes: &[u8],
        out: &GgufFile,
        out_bytes: &[u8],
        plan: &SurgeryPlan,
    ) {
        for pt in &plan.new_tensors {
            let s = (src.data_start + pt.src_offset) as usize;
            let o = (out.data_start + pt.info.offset) as usize;
            assert_eq!(
                &src_bytes[s..s + pt.info.nbytes as usize],
                &out_bytes[o..o + pt.info.nbytes as usize],
                "tensor '{}' data must survive byte-exact",
                pt.info.name
            );
        }
    }

    #[test]
    fn surgery_dense_middle_cut_byte_exact() {
        let mut s = Synth::llama_dense(4);
        // Паттерн-данные + квант Q4_K (геометрия 256/144 — не байтово-кратная)
        s.tensors = vec![
            stp("token_embd.weight", &[128, 8], 0, 7),
            stp("output_norm.weight", &[128], 0, 11),
            stp("output.weight", &[128, 8], 0, 13),
        ];
        for i in 0..4u64 {
            s.tensors
                .push(stp(&format!("blk.{i}.attn_norm.weight"), &[128], 0, 17 + i as u8));
            s.tensors
                .push(stp(&format!("blk.{i}.attn_q.weight"), &[256, 16], 12, 23 + i as u8));
        }
        let (src, plan, out, out_bytes, src_path) = run_cut(&s, &[1, 2], "cutmid");

        // План: ренумерация и счётчики
        assert_eq!(plan.new_block_count, 2);
        assert_eq!(plan.renumber, vec![(0, 0), (3, 1)]);
        assert_eq!(plan.remove, vec![1, 2]);

        // Post-flight №1: результат парсится собственным ридером
        // (инвариант непрерывности offsets проверен при parse)
        assert_eq!(out.meta.block_count, Some(2));
        assert_eq!(out.meta.version, src.meta.version);
        assert_eq!(out.meta.architecture.as_deref(), Some("llama"));
        // Токенайзер-ключи не потеряны (KV-регион вербатим)
        assert_eq!(out.meta.kv_keys, src.meta.kv_keys);

        // Точный размер: оценка плана == факту записи
        assert_eq!(out.file_len, plan.out_size_estimate);

        // Данные выживших байт-в-байт
        let src_bytes = fs::read(&src_path).unwrap();
        assert_data_equal(&src, &src_bytes, &out, &out_bytes, &plan);

        // Имена: blk.0 на месте, blk.3 → blk.1, вырезанных нет
        let names: HashSet<String> = out.tensors.iter().map(|t| t.name.clone()).collect();
        assert!(names.contains("blk.0.attn_norm.weight"));
        assert!(names.contains("blk.1.attn_q.weight"));
        assert!(!names
            .iter()
            .any(|n| n.starts_with("blk.2.") || n.starts_with("blk.3.")));

        // Глобальные не тронуты
        assert!(names.contains("token_embd.weight") && names.contains("output.weight"));
        assert!(!out.flags.moe && !out.flags.nextn);
    }

    #[test]
    fn surgery_cut_first_and_last_with_warning() {
        let s = Synth::llama_dense(3);
        let (src, plan, out, out_bytes, src_path) = run_cut(&s, &[0, 2], "cutfl");
        assert_eq!(plan.renumber, vec![(1, 0)], "выживает только средний слой");
        assert!(
            plan.warnings.iter().any(|w| w.contains("LAST layer")),
            "удаление последнего слоя обязано предупреждать (arXiv:2403.17887)"
        );
        assert_eq!(out.meta.block_count, Some(1));
        let src_bytes = fs::read(&src_path).unwrap();
        assert_data_equal(&src, &src_bytes, &out, &out_bytes, &plan);
    }

    #[test]
    fn surgery_preserves_v2_and_alignment() {
        let mut s = Synth::llama_dense(3);
        s.version = 2;
        s.alignment = Some(64);
        s.tensors.push(stp("blk.2.attn_q.weight", &[256, 16], 12, 5));
        let (src, _plan, out, out_bytes, src_path) = run_cut(&s, &[1], "cutv2");
        assert_eq!(out.meta.version, 2, "v2 остаётся v2 (вербатим-заголовок)");
        assert_eq!(out.meta.alignment, 64);
        assert_eq!(out.data_start % 64, 0);
        let src_bytes = fs::read(&src_path).unwrap();
        assert_data_equal(&src, &src_bytes, &out, &out_bytes, &_plan);
    }

    #[test]
    fn surgery_progress_reports_completion() {
        let s = Synth::llama_dense(3);
        let src_path = write_tmp("cutprog.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[1]).unwrap();
        let dst = write_tmp("cutprog.out.gguf", &[]);
        let mut steps = Vec::new();
        execute_surgery(&src_path, &plan, &dst, &AtomicBool::new(false), |d, t, b, bt| {
            steps.push((d, t, b, bt));
        })
        .unwrap();
        let (d, t, b, bt) = *steps.last().unwrap();
        assert_eq!((d, t), (plan.new_tensors.len(), plan.new_tensors.len()));
        assert_eq!((b, bt), (plan.total_out_bytes, plan.total_out_bytes));
    }

    #[test]
    fn surgery_cancel_removes_tmp() {
        let s = Synth::llama_dense(2);
        let src_path = write_tmp("cutcancel.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[0]).unwrap();
        let dst = write_tmp("cutcancel.out.gguf.tmp", &[]);
        let err = execute_surgery(
            &src_path,
            &plan,
            &dst,
            &AtomicBool::new(true),
            |_, _, _, _| {},
        )
        .unwrap_err();
        assert!(err.contains("cancelled"), "got: {err}");
        assert!(!dst.exists(), "tmp не остаётся после отмены (§28.3)");
    }

    #[test]
    fn surgery_refuses_changed_source() {
        let s = Synth::llama_dense(2);
        let src_path = write_tmp("cutchg.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[0]).unwrap();
        // «Источник изменился между inspect и резкой»: дописали байт
        let mut bytes = s.build();
        bytes.push(0xFF);
        fs::write(&src_path, &bytes).unwrap();
        let err = execute_surgery(
            &src_path,
            &plan,
            &write_tmp("cutchg.out.tmp", &[]),
            &AtomicBool::new(false),
            |_, _, _, _| {},
        )
        .unwrap_err();
        assert!(err.contains("changed since planning"), "got: {err}");
    }

    /// Гард-лист 3b: что по-прежнему запрещено (гибриды, неоднозначность,
    /// нескалярный block_count, битые наборы, неявный/фазовый SWA, неизвестные
    /// per-layer массивы)
    #[test]
    fn surgery_guards_still_deny() {
        let expect_denied = |s: &Synth, remove: &[u64], name: &str, needle: &str| {
            let src = GgufFile::open(&write_tmp(&format!("{name}.src.gguf"), &s.build())).unwrap();
            let err = build_surgery_plan(&src, remove).unwrap_err();
            assert!(err.contains(needle), "expected '{needle}', got: {err}");
        };

        // Гибрид (deny-list v1, §2.4-6)
        let mut s = Synth::llama_dense(2);
        s.tensors.push(st("blk.1.shortconv.conv.weight", &[64], 0));
        expect_denied(&s, &[0], "guard-hybrid", "hybrid");

        // Неоднозначный block_count
        let mut s = Synth::llama_dense(2);
        s.kv.push(("evil.block_count".into(), Kv::U32(1)));
        expect_denied(&s, &[0], "guard-ambig", "multiple *.block_count");

        // block_count не фиксированной ширины (строка) — in-place невозможен
        let mut s = Synth::llama_dense(2);
        s.kv[2] = ("llama.block_count".into(), Kv::S("2".into()));
        expect_denied(&s, &[0], "guard-strbc", "fixed-width int");

        // Неявный SWA: окно есть, явного паттерна нет — членство даёт
        // per-arch дефолт, который мы сознательно не хардкодим (3b-0)
        let mut s = Synth::llama_dense(2);
        s.kv.push(("llama.attention.sliding_window".into(), Kv::U32(512)));
        expect_denied(&s, &[0], "guard-implicit-swa", "no explicit pattern key");

        // Скалярный период с фазовым сдвигом: срез [0] двигает выжившего
        // old=1 на delta=1, 1 % 2 != 0 → отказ
        let mut s = Synth::llama_dense(2);
        s.kv.push((
            "llama.attention.sliding_window_pattern".into(),
            Kv::U32(2),
        ));
        expect_denied(&s, &[0], "guard-swa-phase", "shifts the SWA phase");

        // Неизвестный per-layer массив (len == block_count) — generic-гард
        let mut s = Synth::llama_dense(2);
        s.kv.push(("llama.custom_gate".into(), Kv::ArrU32(vec![1, 0])));
        expect_denied(
            &s,
            &[0],
            "guard-unknown-arr",
            "unknown per-layer array",
        );

        // Пустой набор / вне диапазона / все слои
        let s = Synth::llama_dense(2);
        expect_denied(&s, &[], "guard-empty", "nothing to remove");
        expect_denied(&s, &[2], "guard-range", "out of range");
        expect_denied(&s, &[0, 1], "guard-all", "cannot remove every");
    }

    // === Шаг 3b: per-layer массивы, SWA-паттерны, nextn, dense-голова ===

    #[test]
    fn surgery_3b_per_layer_array_cut_by_mapping() {
        // §2.2/§2.4-1: элемент удаляется ПО ИНДЕКСУ, не хвостом
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 4, 2, 1]),
        ));
        let (src, plan, out, out_bytes, src_path) = run_cut(&s, &[1], "arr-mid");
        // [8,4,2,1] минус индекс 1 → [8,2,1], а не [8,4,2]
        assert_eq!(
            out.meta.head_count_kv,
            Some(LayerSpec::Array(vec![8, 2, 1])),
            "обрезка по маппингу (llama-quantize обрезал бы хвост)"
        );
        assert_eq!(out.meta.block_count, Some(3));
        let src_bytes = fs::read(&src_path).unwrap();
        assert_data_equal(&src, &src_bytes, &out, &out_bytes, &plan);

        // remove first: [8,4,2,1] − idx0 → [4,2,1]
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 4, 2, 1]),
        ));
        let (_src, _plan, out, _bytes, _p) = run_cut(&s, &[0], "arr-first");
        assert_eq!(
            out.meta.head_count_kv,
            Some(LayerSpec::Array(vec![4, 2, 1]))
        );
    }

    #[test]
    fn surgery_3b_scalar_head_count_stays_verbatim() {
        // Скалярный per-layer ключ (Mistral/Qwen2-стиль) не правится вовсе
        let s = Synth::llama_dense(3);
        let (_src, plan, out, _b, _p) = run_cut(&s, &[1], "scalar-hc");
        assert_eq!(out.meta.head_count, Some(LayerSpec::Scalar(32)));
        // Единственная KV-правка — block_count
        assert_eq!(plan.kv_edits.len(), 1);
        assert!(matches!(plan.kv_edits[0], KvEdit::InPlace { .. }));
    }

    #[test]
    fn surgery_3b_swa_bool_array_remaps_membership() {
        // gemma3n/4-стиль: явный bool-массив — членство переносится по
        // маппингу: старый слой il → новый j с ТЕМ ЖЕ SWA-признаком.
        // Смена арха = переименовать и арх-ключи (block_count!)
        let mut s = Synth::llama_dense(6);
        s.kv[0] = ("general.architecture".into(), Kv::S("gemma3".into()));
        s.kv[2] = ("gemma3.block_count".into(), Kv::U32(6));
        s.kv.push(("gemma3.attention.sliding_window".into(), Kv::U32(512)));
        s.kv.push((
            "gemma3.attention.sliding_window_pattern".into(),
            Kv::ArrBool(vec![false, true, true, false, true, true]),
        ));
        let (_src, _plan, out, _bytes, _p) = run_cut(&s, &[1, 2], "swa-arr");
        // Выжившие old [0,3,4,5] → new [0,1,2,3]: [false,false,true,true]
        assert_eq!(
            out.meta.sliding_window_pattern,
            Some(SwaPattern::Layers(vec![false, false, true, true])),
            "SWA-членство каждого слоя сохранено при переезде"
        );
        assert_eq!(out.meta.block_count, Some(4));
    }

    #[test]
    fn surgery_3b_swa_period_uniform_cut_is_allowed_without_edits() {
        // Скалярный период: резка КРАТНА периоду → фаза сохраняется,
        // файл правок паттерна не требует (predicate-free, 3b-0)
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.sliding_window_pattern".into(),
            Kv::U32(2),
        ));
        // remove [0,1]: выжившие old [2,3] c delta=2 ≡ 0 (mod 2)
        let (_src, plan, out, _bytes, _p) = run_cut(&s, &[0, 1], "swa-ok");
        assert_eq!(
            out.meta.sliding_window_pattern,
            Some(SwaPattern::Period(2)),
            "паттерн-пара не тронута"
        );
        // Никаких ReplacePair: правка одна (block_count)
        assert_eq!(plan.kv_edits.len(), 1);
    }

    #[test]
    fn surgery_3b_nextn_tail_cut_resets_count() {
        // DeepSeek-стиль: bc=4 включает MTP → nextn=1, trunk=0..3, MTP=blk.3;
        // срез MTP-хвоста обязан обнулить nextn_predict_layers (§2.4-2)
        let mut s = Synth::llama_dense(4);
        s.kv.push(("llama.nextn_predict_layers".into(), Kv::U32(1)));
        s.tensors
            .push(st("blk.3.nextn.eh_proj.weight", &[128, 128], 0));
        let (_src, plan, out, _bytes, _p) = run_cut(&s, &[3], "nextn-tail");
        assert_eq!(out.meta.nextn_predict_layers, Some(0));
        assert!(!out.flags.nextn);
        assert_eq!(plan.kv_edits.len(), 2, "block_count + nextn");
        // MTP-тензоры ушли вместе со слоем
        assert!(!out.tensors.iter().any(|t| t.name.contains(".nextn.")));
    }

    #[test]
    fn surgery_3b_nextn_middle_cut_renumbers_mtp() {
        // Срез СЕРЕДИНЫ trunk (bc=4, nextn=1, trunk=0..3): счётчик не меняется,
        // MTP-блок переезжает: blk.3.nextn → blk.2.nextn
        let mut s = Synth::llama_dense(4);
        s.kv.push(("llama.nextn_predict_layers".into(), Kv::U32(1)));
        s.tensors
            .push(st("blk.3.nextn.eh_proj.weight", &[128, 128], 0));
        let (_src, _plan, out, _bytes, _p) = run_cut(&s, &[1], "nextn-mid");
        assert_eq!(out.meta.nextn_predict_layers, Some(1));
        assert!(out
            .tensors
            .iter()
            .any(|t| t.name == "blk.2.nextn.eh_proj.weight"));
    }

    #[test]
    fn surgery_3b_leading_dense_shifts_only_when_head_touched() {
        // dense-голова = первые 2 слоя из 4; удаляем слой 0 → dense=1
        let mut s = Synth::llama_dense(4);
        s.kv
            .push(("llama.leading_dense_block_count".into(), Kv::U32(2)));
        let (_src, _plan, out, _bytes, _p) = run_cut(&s, &[0], "dense-shift");
        assert_eq!(out.meta.leading_dense_block_count, Some(1));

        // удаляем слой MoE-области (2) → dense не меняется
        let s = {
            let mut s = Synth::llama_dense(4);
            s.kv
                .push(("llama.leading_dense_block_count".into(), Kv::U32(2)));
            s
        };
        let (_src, plan, out, _bytes, _p) = run_cut(&s, &[2], "dense-keep");
        assert_eq!(out.meta.leading_dense_block_count, Some(2));
        // правка одна — block_count; dense не патчился
        assert_eq!(plan.kv_edits.len(), 1);
    }

    #[test]
    fn surgery_3b_tokenizer_region_survives_byte_exact() {
        // Сплайс массива сдвигает хвост KV-региона: токенайзер обязан
        // переехать БЕЗ перекодировки (§2.4-7)
        let mut s = Synth::llama_dense(4);
        let vocab: Vec<String> = (0..300).map(|i| format!("tok-{i}-padpad")).collect();
        s.kv.push(("tokenizer.ggml.tokens".into(), Kv::ArrStr(vocab)));
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 8, 4, 4]),
        ));
        let (src, plan, out, out_bytes, src_path) = run_cut(&s, &[1, 2], "tok-splice");
        assert!(out.meta.has_tokenizer);
        // Токенайзер-пара байт-в-байт (спан → спан)
        let src_bytes = fs::read(&src_path).unwrap();
        let tok_key = "tokenizer.ggml.tokens";
        let src_span = src
            .kv_spans
            .iter()
            .find(|(k, _)| k == tok_key)
            .unwrap()
            .1;
        let out_span = out
            .kv_spans
            .iter()
            .find(|(k, _)| k == tok_key)
            .unwrap()
            .1;
        assert_eq!(
            &src_bytes[src_span.key_start as usize..src_span.end as usize],
            &out_bytes[out_span.key_start as usize..out_span.end as usize],
            "токенайзер переехал байт-в-байт"
        );
        // Массив переехал НАЗНАЧЕНИЕ: массив обрезан по маппингу
        assert_eq!(
            out.meta.head_count_kv,
            Some(LayerSpec::Array(vec![8, 4]))
        );
        // Сплайс сократил KV-регион, оценка сходится с фактом
        assert_eq!(out.file_len, plan.out_size_estimate);
        assert!(plan.kv_out_len < src.kv_end - 24);
    }

    #[test]
    fn surgery_3b_mixed_everything_roundtrip() {
        // Всё сразу: массивы + bool-паттерн + nextn + dense-голова в одном
        // файле (DeepSeek-раскладка: bc=4 включает MTP, trunk=0..3):
        // резка середины trunk, байт-в-байт данные, полный roundtrip
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 8, 4, 4]),
        ));
        s.kv.push((
            "llama.attention.sliding_window_pattern".into(),
            Kv::ArrBool(vec![false, true, false, true]),
        ));
        s.kv.push(("llama.nextn_predict_layers".into(), Kv::U32(1)));
        s.kv
            .push(("llama.leading_dense_block_count".into(), Kv::U32(2)));
        s.tensors
            .push(st("blk.3.nextn.eh_proj.weight", &[128, 128], 0));
        let (src, plan, out, out_bytes, src_path) = run_cut(&s, &[1, 2], "mixed");
        assert_eq!(plan.remove, vec![1, 2]);
        assert_eq!(out.meta.block_count, Some(2));
        assert_eq!(
            out.meta.head_count_kv,
            Some(LayerSpec::Array(vec![8, 4]))
        );
        assert_eq!(
            out.meta.sliding_window_pattern,
            Some(SwaPattern::Layers(vec![false, true]))
        );
        // MTP-хвост не тронут: счётчик на месте, блок переехал blk.3 → blk.1
        assert_eq!(out.meta.nextn_predict_layers, Some(1));
        assert!(out
            .tensors
            .iter()
            .any(|t| t.name == "blk.1.nextn.eh_proj.weight"));
        // dense-голова (первые 2) потеряла слой 1 → 1
        assert_eq!(out.meta.leading_dense_block_count, Some(1));
        let src_bytes = fs::read(&src_path).unwrap();
        assert_data_equal(&src, &src_bytes, &out, &out_bytes, &plan);
        assert_eq!(out.file_len, plan.out_size_estimate);
    }

    #[test]
    fn surgery_plan_estimate_matches_written_file() {
        // Оценка out_size_estimate уже сверена в surgery_dense_middle_cut_byte_exact
        // через file_len; здесь — прямой инвариант суммы
        let s = Synth::llama_dense(3);
        let src = GgufFile::open(&write_tmp("est.src.gguf", &s.build())).unwrap();
        let plan = build_surgery_plan(&src, &[1]).unwrap();
        assert_eq!(plan.total_out_bytes, plan.new_tensors.iter().map(|pt| pt.info.nbytes).sum::<u64>());
        // New offsets — строго кумулятивная сумма pad (§1.1)
        let mut running = 0u64;
        for pt in &plan.new_tensors {
            assert_eq!(pt.info.offset, running);
            running += pad_to(pt.info.nbytes, plan.alignment);
        }
    }

    // === Шаг 3c: post-flight гейт + пайплайн ===

    fn s_mixed() -> Synth {
        let mut s = Synth::llama_dense(4);
        s.kv.push((
            "llama.attention.head_count_kv".into(),
            Kv::ArrU32(vec![8, 8, 4, 4]),
        ));
        s.tensors
            .push(st("blk.3.nextn.eh_proj.weight", &[128, 128], 0));
        s
    }

    fn out_path_of(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("haloui-gguf-{}", std::process::id()))
            .join(format!("{name}.out.gguf"))
    }

    #[test]
    fn postflight_passes_on_clean_cut() {
        let (src, plan, _out, _bytes, src_path) = run_cut(&s_mixed(), &[1], "pf-ok");
        let out_path = out_path_of("pf-ok");
        let summary =
            postflight_verify(&src_path, &out_path, &plan, &AtomicBool::new(false)).unwrap();
        assert_eq!(summary.tensors_checked, plan.new_tensors.len());
        assert_eq!(summary.bytes_compared, plan.total_out_bytes);
        let _ = src;
    }

    #[test]
    fn postflight_catches_corrupted_data() {
        // Резка с паттерн-данными → порча байта данных в выходе → отказ
        let mut s = s_mixed();
        for i in 0..4u64 {
            s.tensors
                .push(stp(&format!("blk.{i}.attn_q.weight"), &[256, 16], 12, 31 + i as u8));
        }
        let src_path = write_tmp("pf-data.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[1]).unwrap();
        let dst = write_tmp("pf-data.out.gguf", &[]);
        execute_surgery(&src_path, &plan, &dst, &AtomicBool::new(false), |_, _, _, _| {}).unwrap();
        // Порча: переворачиваем байт в середине данных выжившего тензора
        let mut bytes = fs::read(&dst).unwrap();
        let mid = src.data_start as usize + plan.new_tensors[3].src_offset as usize + 100;
        bytes[mid] ^= 0xFF;
        let corrupt = write_tmp("pf-data.corrupt.gguf", &bytes);
        let err = postflight_verify(&src_path, &corrupt, &plan, &AtomicBool::new(false))
            .unwrap_err();
        assert!(err.contains("data mismatch"), "got: {err}");
    }

    #[test]
    fn postflight_catches_corrupted_kv_edit() {
        // Порча значения block_count в выходе → семантический отказ
        let s = Synth::llama_dense(4);
        let src_path = write_tmp("pf-kv.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[1]).unwrap();
        let dst = write_tmp("pf-kv.out.gguf", &[]);
        execute_surgery(&src_path, &plan, &dst, &AtomicBool::new(false), |_, _, _, _| {}).unwrap();
        let mut bytes = fs::read(&dst).unwrap();
        // block_count-правка — InPlace по адресу из плана
        let edit = plan
            .kv_edits
            .iter()
            .find_map(|e| match e {
                KvEdit::InPlace { key, value_offset, width, .. } if key.ends_with(".block_count") => {
                    Some((*value_offset, *width))
                }
                _ => None,
            })
            .unwrap();
        bytes[edit.0 as usize] ^= 0x01;
        let corrupt = write_tmp("pf-kv.corrupt.gguf", &bytes);
        let err = postflight_verify(&src_path, &corrupt, &plan, &AtomicBool::new(false))
            .unwrap_err();
        assert!(err.contains("postflight"), "got: {err}");
    }

    #[test]
    fn postflight_catches_structural_corruption() {
        let s = Synth::llama_dense(4);
        let src_path = write_tmp("pf-struct.src.gguf", &s.build());
        let src = GgufFile::open(&src_path).unwrap();
        let plan = build_surgery_plan(&src, &[1]).unwrap();
        let dst = write_tmp("pf-struct.out.gguf", &[]);
        execute_surgery(&src_path, &plan, &dst, &AtomicBool::new(false), |_, _, _, _| {}).unwrap();
        // Усечение файла → структурный отказ на GgufFile::open (§1.7)
        let mut bytes = fs::read(&dst).unwrap();
        bytes.truncate(bytes.len() - 64);
        let corrupt = write_tmp("pf-struct.corrupt.gguf", &bytes);
        let err = postflight_verify(&src_path, &corrupt, &plan, &AtomicBool::new(false))
            .unwrap_err();
        assert!(err.contains("gguf:"), "structural rejection expected, got: {err}");
    }

    #[test]
    fn pipeline_reports_and_verifies() {
        let mut s = s_mixed();
        for i in 0..4u64 {
            s.tensors
                .push(stp(&format!("blk.{i}.attn_q.weight"), &[256, 16], 12, 41 + i as u8));
        }
        let dir = std::env::temp_dir().join(format!("haloui-gguf-pipe-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src_path = dir.join("model.gguf");
        fs::write(&src_path, s.build()).unwrap();
        let dst_path = dir.join("model_cut.gguf");

        let mut phases = Vec::new();
        let report = run_surgery_pipeline(
            &src_path,
            &dst_path,
            &[1],
            &AtomicBool::new(false),
            |phase, _i, _n, _b, _t| phases.push(phase.to_string()),
        )
        .unwrap();

        // Отчёт: имена, ренумерация, сводки правок, верификация
        assert_eq!(report.output, "model_cut.gguf");
        assert_eq!(report.removed_layers, vec![1]);
        assert_eq!(report.renumber, vec![(0, 0), (2, 1), (3, 2)]);
        assert_eq!(report.new_block_count, 3);
        assert!(report
            .kv_edits
            .iter()
            .any(|x| x.contains("block_count = 3")));
        assert!(report.duration_ms < 60_000);
        // Верификация: сверены все тензоры и все байты данных
        let out = GgufFile::open(&dst_path).unwrap();
        assert_eq!(report.verified.tensors_checked, out.tensors.len());
        assert_eq!(report.verified.bytes_compared, report.output_size_bytes - out.data_start);
        // Фазы дошли от плана до done
        assert_eq!(phases.first().unwrap(), "plan");
        assert_eq!(phases.last().unwrap(), "done");
        // Результат на диске — валидный GGUF с ожидаемым block_count
        assert_eq!(out.meta.block_count, Some(3));
        // tmp не остался
        assert!(!dir.join("model_cut.gguf.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pipeline_rejects_bad_source_and_names() {
        let dir = std::env::temp_dir().join(format!("haloui-gguf-name-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Имя результата — не путь: валидатор отсекает traversal и мусор
        assert!(validate_lab_file_name("model.gguf").is_ok());
        assert!(validate_lab_file_name("hf.co_user_repo_Q4_K_M.gguf").is_ok());
        for bad in [
            "../model.gguf",
            "a/b.gguf",
            "a\\b.gguf",
            "..",
            "model.txt",
            "",
            "sub/../model.gguf",
        ] {
            assert!(
                validate_lab_file_name(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
        // Пайплайн: источник не существует → внятный отказ
        let err = run_surgery_pipeline(
            &dir.join("missing.gguf"),
            &dir.join("out.gguf"),
            &[0],
            &AtomicBool::new(false),
            |_, _, _, _, _| {},
        )
        .unwrap_err();
        assert!(err.contains("open failed") || err.contains("missing"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    // === Шаг 4: тестовый рантайм ===

    #[test]
    fn health_states_are_interpreted() {
        // §4.4: 200 = Ready; 503 = Loading (порт слушается ДО загрузки);
        // остальное — ошибка с телом для диагностики
        assert!(matches!(interpret_health(200, r#"{"status":"ok"}"#), HealthState::Ready));
        assert!(matches!(interpret_health(503, r#"{"error":{"code":503}}"#), HealthState::Loading));
        match interpret_health(500, "boom") {
            HealthState::Other(m) => assert!(m.contains("500") && m.contains("boom")),
            _ => panic!("expected Other"),
        }
    }

    #[test]
    fn release_parsing_and_asset_pick() {
        // Реальная структура ответа /releases: semver-«latest» без бинарей
        // (v0.6.0 + nightly-tag.txt) и бинарный b-тег (имена — с b11451, 4-0)
        let body = r#"[
            {"tag_name": "v0.6.0", "assets": [{"name": "nightly-tag.txt", "browser_download_url": "https://x/nightly-tag.txt"}]},
            {"tag_name": "b11451", "assets": [
                {"name": "llama-b11451-bin-win-cpu-x64.zip", "browser_download_url": "https://x/win.zip"},
                {"name": "llama-b11451-bin-win-cuda-12.4-x64.zip", "browser_download_url": "https://x/cuda.zip"},
                {"name": "llama-b11451-bin-ubuntu-x64.tar.gz", "browser_download_url": "https://x/lin.tar.gz"},
                {"name": "llama-b11451-bin-macos-x64.tar.gz", "browser_download_url": "https://x/mac.tar.gz"},
                {"name": "llama-b11451-bin-macos-arm64.tar.gz", "browser_download_url": "https://x/mac-arm.tar.gz"}
            ]}
        ]"#;
        let releases = parse_releases(body).unwrap();
        let bin = pick_binary_release(&releases).unwrap();
        assert_eq!(bin.0, "b11451", "semver-релиз с одним nightly-tag.txt пропускается");
        // Windows CPU (не CUDA!)
        let a = pick_release_asset(&bin.1, "windows", "x86_64").unwrap();
        assert_eq!(a.name, "llama-b11451-bin-win-cpu-x64.zip");
        assert_eq!(a.url, "https://x/win.zip");
        assert_eq!(
            pick_release_asset(&bin.1, "linux", "x86_64").unwrap().name,
            "llama-b11451-bin-ubuntu-x64.tar.gz"
        );
        assert_eq!(
            pick_release_asset(&bin.1, "macos", "aarch64").unwrap().name,
            "llama-b11451-bin-macos-arm64.tar.gz"
        );
        // Нет ассета для экзотики → None (отказ с сообщением наверху)
        assert!(pick_release_asset(&bin.1, "linux", "riscv64").is_none());
        // Совсем без бинарей → None
        let empty = parse_releases(r#"[{"tag_name": "v1.0", "assets": []}]"#).unwrap();
        assert!(pick_binary_release(&empty).is_none());
        // Битый JSON
        assert!(parse_releases("not json").is_err());
    }

    #[test]
    fn llama_server_resolution_config_first_then_path() {
        // Конфиг-путь существует → он; конфиг-путь мёртв → PATH-скан
        let dir = std::env::temp_dir().join(format!("haloui-gguf-resolve-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = dir.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" });
        fs::write(&real, b"stub").unwrap();
        let sep = if cfg!(windows) { ';' } else { ':' };
        let path_env = format!(
            "C:\\nowhere{sep}{}{sep}D:\\nowhere2",
            dir.to_string_lossy()
        );
        let found = resolve_llama_server(None, &path_env).expect("PATH probe must find stub");
        assert_eq!(found, real);
        // Конфиг перекрывает PATH
        let cfg = resolve_llama_server(Some(real.to_string_lossy().as_ref()), "").unwrap();
        assert_eq!(cfg, real);
        // Мёртвый конфиг-путь → фолбэк в PATH
        let dead = resolve_llama_server(Some("Z:/definitely/missing/llama-server.exe"), &path_env);
        assert_eq!(dead, Some(real));
        // Нигде нет → None
        assert!(resolve_llama_server(None, "C:\\nowhere").is_none());
        // Пустые сегменты PATH не ломают
        assert!(resolve_llama_server(None, ";;").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ollama_model_names_validated() {
        assert!(validate_ollama_model_name("my-cut").is_ok());
        assert!(validate_ollama_model_name("qwen3-8b_pruned:latest").is_ok());
        assert!(validate_ollama_model_name("hf.co/user/repo:Q4_K_M").is_ok());
        for bad in ["", "my model", "a\\b", "..", "модель", "x\ny"] {
            assert!(
                validate_ollama_model_name(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
    }
}
