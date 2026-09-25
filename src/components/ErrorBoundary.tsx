/**
 * Локальный ErrorBoundary: падение рендера одного блока (например, одной
 * карточки с markdown от модели) больше не выносит всё приложение в белый
 * экран — вместо блока показывается компактная красная карточка с ошибкой
 * и кнопкой «показать снова» (сброс состояния = повторный рендер).
 *
 * Это классовый компонент по необходимости: границы ошибок в React
 * реализуются только через componentDidCatch/getDerivedStateFromError.
 */

import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Заголовок фолбэка (из локали) */
  title: string;
  /** Текст кнопки повтора (из локали) */
  action: string;
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

  componentDidCatch(error: Error) {
    // Ошибка в консоль для диагностики: секретов в render-ошибках не бывает,
    // а без лога найти битый контент было бы невозможно
    console.error("[nocturn] render error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-xs text-red-300">
          <p className="font-medium">⚠ {this.props.title}</p>
          <p className="mt-1 max-w-md break-words opacity-80">
            {String(this.state.error.message ?? this.state.error)}
          </p>
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
