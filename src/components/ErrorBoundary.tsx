/**
 * Локальный ErrorBoundary: падение рендера одного блока (например, одной
 * карточки с markdown от модели) больше не выносит всё приложение в белый
 * экран — вместо блока показывается компактная красная карточка и кнопкой
 * «показать снова» (сброс состояния = повторный рендер).
 *
 * Это классовый компонент по необходимости: границы ошибок в React
 * реализуются только через componentDidCatch/getDerivedStateFromError.
 */

import { Component, type ReactNode } from "react";
import { WarnIcon } from "./cards/icons";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Заголовок фолбэка (из локали) */
  title: string;
  /** Текст кнопки повтора (из локали) */
  action: string;
  /**
   * Данные поддерева (id сессии, размер списка, тема): смена значения
   * сбрасывает пойманную ошибку. Без этого новый нормальный контент в той
   * же карточке навсегда оставался бы фолбэком — ошибка относится к
   * конкретному содержимому, а не к контейнеру.
   */
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    // Данные сменились — старая ошибка больше не про этот контент.
    // Сравнение здесь, а не в getDerivedStateFromProps: при самом сбое
    // там ещё нечего сопоставить с новым ключом, свежая ошибка стиралась бы
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error) {
    // Ошибка в консоль для диагностики: секретов в render-ошибках не бывает,
    // а без лога найти битый контент было бы невозможно
    console.error("[nocturn] render error:", error);
  }

  render() {
    if (this.state.error) {
      // Сырой текст ошибки — только в консоль (выше): в UI он бывает и
      // техническим, и не локализованным, и потенциально раскрывающим
      // внутренности; пользователю достаточно факта сбоя и кнопки повтора
      return (
        <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-xs text-red-300">
          <p className="flex items-center gap-1.5 font-medium"><WarnIcon /> {this.props.title}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-md border border-red-400/40 px-2 py-1 transition-colors hover:bg-red-500/10"
          >
            {this.props.action}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
