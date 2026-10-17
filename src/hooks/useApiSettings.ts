import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  cryptoReset,
  cryptoSetup,
  cryptoStatus,
  cryptoUnlock,
  DEFAULT_SETTINGS,
  detectLocalRuntimes,
  loadProfiles,
  loadSettings,
  loadSettingsDetailed,
  providerFromBaseUrl,
  saveProfiles,
  saveSettings,
  setKeyEncryption,
  testConnection,
  type ApiProfile,
  type ApiSettings,
  type ApiStatus,
  type LocalRuntime,
  type LocalRuntimes,
} from "../api";
import { useLang } from "../locales";
import type { Session } from "../types";
import type { Appearance } from "../appearance";

/**
 * Домен «Подключение к ИИ»: настройки API, профили ключей, статус соединения,
 * шифрование (crypto-gate + idle-lock), автодетект Ollama.
 * Первичная загрузка — loadInitial(), вызывается из стартового эффекта App;
 * промисы участвуют в gating сплэша вместе с проектами и историей.
 */
export function useApiSettings(opts: {
  activeId: string | null;
  sessions: Session[];
  setSessions: Dispatch<SetStateAction<Session[]>>;
  /** Текущее оформление — снапшот уходит в профиль при «Сохранить текущие» */
  appearance: Appearance;
  addToast: (text: string) => void;
}) {
  const { activeId, sessions, setSessions, appearance, addToast } = opts;
  const { t } = useLang();

  const [apiSettings, setApiSettings] = useState<ApiSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [apiStatus, setApiStatus] = useState<ApiStatus>({ kind: "idle" });
  // Профили ключей — отдельное хранилище profiles.json
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const profilesLoadedRef = useRef(false);
  // Настройки ещё не загружены с диска — автосейв ждёт, чтобы не затереть файл
  const settingsLoadedRef = useRef(false);
  // Чтение настроек упало (битый/нечитаемый settings.json): автосейв
  // заморожен до явного «Сохранить» — иначе дефолты затирают файл,
  // из которого можно было бы вытащить данные руками
  const settingsBrokenRef = useRef(false);
  // Гейт мастер-пароля: loading → none / unlock / create.
  // Пока не «none» — автосейвы ключей заблокированы (защита от затирания)
  const [cryptoGate, setCryptoGate] = useState<
    "loading" | "none" | "unlock" | "create" | "disable"
  >("loading");
  const [localRuntimes, setLocalRuntimes] = useState<LocalRuntimes>({
    ollama: null,
    lmstudio: null,
  });
  // Ожидание создания мастер-пароля при включении тумблера шифрования
  const encPendingRef = useRef(false);
  // Резолвер промиса тумблера: тумблер ждёт финала гейта (успех/отмена),
  // а не получает true сразу — иначе вызывающий не отличал успех от отмены
  const encResultRef = useRef<((ok: boolean) => void) | null>(null);
  const resolveEnc = useCallback((ok: boolean) => {
    encResultRef.current?.(ok);
    encResultRef.current = null;
  }, []);

  /** Первичная загрузка: настройки + профили + гейт пароля. Один вызов */
  const loadInitial = useCallback(() => {
    const settingsReady = loadSettingsDetailed()
      .then((r) => {
        if (r.status === "error") {
          settingsBrokenRef.current = true;
          addToast(t("error.settingsCorrupted", { e: r.error }));
          return;
        }
        const s = r.status === "ok" ? r.data : { ...DEFAULT_SETTINGS };
        if (s.api_key || s.base_url || s.model) {
          // Старые настройки без метки провайдера — восстанавливаем по URL
          if (!s.provider) s.provider = providerFromBaseUrl(s.base_url);
          setApiSettings(s);
          // Свежий список моделей при старте — для vision-предупреждений
          if (s.api_key && s.base_url) {
            setApiStatus({ kind: "checking" });
            testConnection(s.base_url, s.api_key, s.provider)
              .then((models) =>
                setApiStatus({
                  kind: "ok",
                  models,
                  message: t("api.connected", { n: models.length }),
                }),
              )
              .catch((e) => setApiStatus({ kind: "error", message: String(e) }));
          }
        }
      })
      .finally(() => {
        settingsLoadedRef.current = true;
      });
    // Профили: отдельное хранилище, при первом запуске мигрируют из settings.json
    const profilesReady = loadProfiles()
      .then((store) => {
        // Защита от битого/неожиданного ответа хранилища: форма ЭЛЕМЕНТОВ
        // тоже проверяется (раньше as-каст пропускал битые записи до рендера)
        setProfiles(
          Array.isArray((store as { profiles?: unknown })?.profiles)
            ? ((store as { profiles: unknown[] }).profiles.filter(
                (p): p is ApiProfile =>
                  !!p &&
                  typeof p === "object" &&
                  typeof (p as ApiProfile).name === "string",
              ))
            : [],
        );
        setActiveProfileId(
          typeof (store as { active?: unknown })?.active === "string"
            ? (store.active as string)
            : "",
        );
      })
      .catch(() => {})
      .finally(() => {
        profilesLoadedRef.current = true;
      });
    // Гейт мастер-пароля: если шифрование включено и хранилище заперто —
    // блокируем интерфейс окном входа до разблокировки
    cryptoStatus()
      .then((cs) => {
        if (cs.enabled && !cs.unlocked) {
          setCryptoGate(cs.setup ? "unlock" : "create");
        } else {
          setCryptoGate("none");
        }
      })
      .catch(() => setCryptoGate("none"));
    return Promise.all([settingsReady, profilesReady]);
  }, [t, addToast]);

  // Автосохранение настроек API: любое изменение (включая смену профиля
  // из чата) попадает на диск без кнопки «Сохранить».
  // Пока гейт пароля не пройден — не пишем (не затираем зашифрованные поля)
  useEffect(() => {
    if (!settingsLoadedRef.current || settingsBrokenRef.current || cryptoGate !== "none") return;
    const timer = window.setTimeout(() => {
      saveSettings(apiSettings).catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [apiSettings, cryptoGate]);

  // Автосохранение профилей (profiles.json); ключи шифруются, если включено
  useEffect(() => {
    if (!profilesLoadedRef.current || cryptoGate !== "none") return;
    const timer = window.setTimeout(() => {
      saveProfiles(
        { profiles, active: activeProfileId },
        apiSettings.encrypt_keys ?? false,
      ).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [profiles, activeProfileId, apiSettings.encrypt_keys, cryptoGate]);

  const handleTestConnection = useCallback(() => {
    setApiStatus({ kind: "checking" });
    testConnection(apiSettings.base_url, apiSettings.api_key, apiSettings.provider)
      .then((models) =>
        setApiStatus({
          kind: "ok",
          models,
          message: t("api.connected", { n: models.length }),
        }),
      )
      .catch((e) => setApiStatus({ kind: "error", message: String(e) }));
  }, [apiSettings.base_url, apiSettings.api_key, apiSettings.provider, t]);

  const handleSaveSettings = async () => {
    await saveSettings(apiSettings);
    // Явное сохранение переписывает файл целиком — блокировка автосейва
    // снята, битое состояние больше не читается
    settingsBrokenRef.current = false;
  };

  /** Перечитать ключи с диска (после разблокировки/смены шифрования) */
  const reloadSecrets = useCallback(async () => {
    const [s, store] = await Promise.all([loadSettings(), loadProfiles()]);
    setApiSettings(s);
    setProfiles(store.profiles ?? []);
    setActiveProfileId(store.active ?? "");
  }, []);

  /** Тумблер шифрования: включение открывает окно создания мастер-пароля,
      выключение — окно разблокировки (расшифровать можно только с паролем).
      Промис резолвится финалом гейта: false — отмена или неудача, true —
      режим действительно сменился */
  const handleEncryptionToggle = useCallback(
    (enable: boolean) =>
      new Promise<boolean>((resolve) => {
        encResultRef.current = resolve;
        if (enable) {
          encPendingRef.current = true;
          setCryptoGate("create");
        } else {
          setCryptoGate("disable");
        }
      }),
    [],
  );

  /** Сабмит из окна гейта: создание пароля, разблокировка или отключение шифрования.
   *  false — неверный пароль; исключение — сбой операции: гейт показывает
   *  другой текст, пользователь не гоняет перебор паролей при падении бекенда */
  const handleGateSubmit = useCallback(
    async (password: string) => {
      try {
        if (cryptoGate === "create") {
          await cryptoSetup(password);
          if (encPendingRef.current) {
            await setKeyEncryption(true);
            encPendingRef.current = false;
          }
          await reloadSecrets();
          setCryptoGate("none");
          resolveEnc(true);
          return true;
        }
        // unlock и disable: сначала проверяем пароль
        await cryptoUnlock(password);
        if (cryptoGate === "disable") {
          try {
            await setKeyEncryption(false);
          } catch {
            // Пароль верный и хранилище уже разблокировано — висеть окну
            // нечему: закрываем, а неудачу отключения показывает тумблер
            // (resolveEnc(false)), состояние encrypt_keys не меняем
            encPendingRef.current = false;
            await reloadSecrets().catch(() => {});
            setCryptoGate("none");
            resolveEnc(false);
            return true;
          }
        }
        await reloadSecrets();
        setCryptoGate("none");
        resolveEnc(true);
        return true;
      } catch (e) {
        // «wrong password» — единственный штатный отказ бекенда; сбой IPC
        // и ограничение перебора пробрасываются как сбой
        if (String(e).includes("wrong password")) return false;
        throw e;
      }
    },
    [cryptoGate, reloadSecrets, resolveEnc],
  );

  /** «Забыли пароль»: сброс шифрования, зашифрованные ключи утеряны.
      Тумблер, открывший гейт, получает false — включить шифрование не вышло */
  const handleGateReset = useCallback(async () => {
    await cryptoReset().catch(() => {});
    encPendingRef.current = false;
    await reloadSecrets();
    setCryptoGate("none");
    resolveEnc(false);
  }, [reloadSecrets, resolveEnc]);

  /** Отмена гейта, открытого из тумблера: ничего не включаем/не выключаем */
  const handleGateCancel = useCallback(() => {
    encPendingRef.current = false;
    setCryptoGate("none");
    resolveEnc(false);
  }, [resolveEnc]);

  // Idle-lock: если хранилище само заперлось (15 мин без операций с ключом) —
  // при возврате в окно показываем гейт разблокировки, иначе зашифрованные
  // операции начнут падать «vault is locked» без понятного объяснения
  const cryptoGateRef = useRef(cryptoGate);
  const vaultWasUnlockedRef = useRef(false);
  useEffect(() => {
    cryptoGateRef.current = cryptoGate;
  }, [cryptoGate]);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const st = await cryptoStatus();
        if (!alive) return;
        if (st.enabled && st.setup && !st.unlocked && vaultWasUnlockedRef.current) {
          vaultWasUnlockedRef.current = false;
          if (cryptoGateRef.current === "none") setCryptoGate("unlock");
        } else if (st.unlocked) {
          vaultWasUnlockedRef.current = true;
        }
      } catch {
        // браузерное превью — крипто нет
      }
    };
    const iv = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    void check();
    return () => {
      alive = false;
      window.clearInterval(iv);
      window.removeEventListener("focus", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Профили API: отдельное хранилище + привязка к чату/проекту ----------

  /** Подставить связку профиля в активные настройки */
  const applyProfileSettings = useCallback((p: ApiProfile) => {
    setApiSettings((prev) => ({
      ...prev,
      api_key: p.api_key,
      base_url: p.base_url,
      model: p.model,
      provider: p.provider,
      fallback_model: p.fallback_model,
    }));
  }, []);

  /** Сохранить текущие ключ+URL+модель как новый профиль и привязать к чату */
  const handleAddProfile = useCallback(
    (name: string) => {
      const profile: ApiProfile = {
        // uuid, не Date.now(): два профиля в одну миллисекунду получали
        // одинаковый id — дубли ключей и коллизии React-ключей
        id: `p-${crypto.randomUUID()}`,
        name: name.trim() || providerFromBaseUrl(apiSettings.base_url),
        api_key: apiSettings.api_key,
        base_url: apiSettings.base_url,
        model: apiSettings.model,
        provider: apiSettings.provider,
        fallback_model: apiSettings.fallback_model,
        // Снапшот оформления для opt-in «тема из профиля»
        appearance: { ...appearance },
      };
      setProfiles((prev) => [...prev, profile]);
      setActiveProfileId(profile.id);
      // Привязка к активному чату — при его открытии профиль вернётся
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId ? { ...s, profileId: profile.id } : s,
        ),
      );
    },
    [apiSettings, activeId, setSessions, appearance],
  );

  /** Переключиться на профиль: подставить настройки + привязать к чату */
  const handleApplyProfile = useCallback(
    (id: string) => {
      const p = profiles.find((x) => x.id === id);
      if (!p) return;
      setActiveProfileId(id);
      applyProfileSettings(p);
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, profileId: id } : s)),
      );
    },
    [profiles, activeId, applyProfileSettings, setSessions],
  );

  const handleDeleteProfile = useCallback(
    (id: string) => {
      setProfiles((prev) => prev.filter((p) => p.id !== id));
      if (activeProfileId === id) setActiveProfileId("");
    },
    [activeProfileId],
  );

  // Открытие чата с привязанным профилем — подставляем его связку.
  // Сравнение по id профиля: настройки могли менять вручную, не перетираем
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId);
    if (!s?.profileId || s.profileId === activeProfileId) return;
    const p = profiles.find((x) => x.id === s.profileId);
    if (!p) return; // профиль удалён — остаёмся на текущих настройках
    setActiveProfileId(p.id);
    applyProfileSettings(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Автообнаружение локальных рантаймов: при старте и каждые 30 секунд
  const detectLocal = useCallback(() => {
    detectLocalRuntimes()
      .then(setLocalRuntimes)
      .catch(() => setLocalRuntimes({ ollama: null, lmstudio: null }));
  }, []);
  useEffect(() => {
    detectLocal();
    const iv = window.setInterval(detectLocal, 30_000);
    return () => window.clearInterval(iv);
  }, [detectLocal]);

  // Переключение на локальную модель: локальные рантаймы не требуют ключа
  // (подставляем имя рантайма — поле непустое и показывает источник).
  // Merge, а не замена: полная замена выбрасывала encrypt_keys, и автосейв
  // молча снимал шифрование профилей
  const handleUseLocalModel = (id: string, runtime: LocalRuntime) => {
    setApiSettings((prev) => ({
      ...prev,
      api_key: runtime,
      base_url:
        runtime === "lmstudio"
          ? "http://localhost:1234/v1"
          : "http://localhost:11434/v1",
      model: id,
      provider: "custom",
      // Облачный fallback локальной модели бессмыслен и опасен тратой
      // ключа: при исчерпании ретраев прогон ушёл бы в облако
      fallback_model: undefined,
    }));
  };

  /** Подключить поднятый GGUF Lab сервер к текущим настройкам чата:
   *  llama-server без --api-key игнорирует Authorization — ключ-маркер.
   *  useCallback: пробрасывается в memo-модалку GGUF Lab — инлайн-функция
   *  пробивала мемоизацию */

  const handleUseGgufServe = useCallback((baseUrl: string, model: string) => {
    setApiSettings((prev) => ({
      ...prev,
      api_key: "gguf-lab",
      base_url: baseUrl,
      model,
      provider: "custom",
      // Локальный llama-server не должен падать в облачный fallback
      fallback_model: undefined,
    }));
  }, []);

  return {
    apiSettings,
    setApiSettings,
    apiStatus,
    setApiStatus,
    profiles,
    activeProfileId,
    setActiveProfileId,
    cryptoGate,
    localRuntimes,
    loadInitial,
    handleUseGgufServe,
    detectLocal,
    handleTestConnection,
    handleSaveSettings,
    reloadSecrets,
    handleEncryptionToggle,
    handleGateSubmit,
    handleGateReset,
    handleGateCancel,
    applyProfileSettings,
    handleAddProfile,
    handleApplyProfile,
    handleDeleteProfile,
    handleUseLocalModel,
  };
}
