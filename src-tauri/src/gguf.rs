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
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueType {
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
pub struct ArchFlags {
    pub swa: bool,
    pub moe: bool,
    pub hybrid_ssm: bool,
    pub hybrid_conv: bool,
    pub nextn: bool,
}

#[derive(Debug, Clone, Serialize)]
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
pub struct LayerReport {
    pub layers: Vec<LayerInfo>,
    /// Не-блочные тензоры: token_embd, output, output_norm, rope-факторы…
    pub global: Vec<TensorInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GgufFile {
    pub meta: GgufMeta,
    pub tensors: Vec<TensorInfo>,
    pub flags: ArchFlags,
    /// Абсолютный offset data-секции = pad(конец таблицы тензоров, alignment)
    pub data_start: u64,
    pub file_len: u64,
    /// Некритичные проблемы (спека требует, код прощает): идут в отчёт
    pub warnings: Vec<String>,
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
        let kv_region_start = self.pos;
        for i in 0..kv_count {
            // Кап бюджета СТРОГО по объявленным длинам — враждебный файл
            // с array len 2^40 отсекается до любых больших аллокаций.
            if self.pos - kv_region_start > MAX_KV_REGION_BYTES {
                return Err(format!(
                    "gguf: kv region exceeds {MAX_KV_REGION_BYTES} bytes (hostile or corrupt) after {i} pairs"
                ));
            }
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
            let value = self.read_kv_value(&key, vt)?;
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
            kv_keys.push(key);
            if let Some(v) = value {
                retained.push((kv_keys.last().unwrap().clone(), v));
            }
        }

        let meta = resolve_meta(version, &retained, kv_keys, alignment);

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
            ValueType::Array => self.read_kv_array(key)?,
        })
    }

    fn read_kv_array(&mut self, key: &str) -> Result<Option<Retained>, String> {
        let elem_code = self.read_u32()?;
        let et = ValueType::from_code(elem_code)
            .ok_or_else(|| format!("gguf: kv '{key}' array has unknown element type {elem_code}"))?;
        let len = self.read_u64()?;
        if len > MAX_ARRAY_ELEMS {
            return Err(format!(
                "gguf: kv '{key}' array length {len} exceeds format limit"
            ));
        }
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
    }

    fn st(name: &str, dims: &[u64], ttype: i32) -> SynthTensor {
        SynthTensor {
            name: name.to_string(),
            dims: dims.to_vec(),
            ttype,
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
            // Паддинг до data_start (§1.4) и данные нулями («веса»)
            let data_start = pad_raw(w.len() as u64, align);
            w.resize(data_start as usize, 0);
            for (i, t) in self.tensors.iter().enumerate() {
                let end = data_start + offsets[i] + t.nbytes();
                if w.len() < end as usize {
                    w.resize(end as usize, 0);
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
}
