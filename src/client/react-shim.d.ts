// Minimal ambient declarations for the standalone client half.
//
// The plugin is built without the Harness type packages and without
// `@types/react`: at runtime the module loader supplies the baseline React
// module (`require('react')`), and esbuild compiles JSX with the classic
// `React.createElement` factory. These declarations only exist so
// `tsc --noEmit` accepts this standalone plugin; they cover exactly the surface
// the plugin uses.

declare module 'react' {
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): any
  // `any` so the classic JSX runtime accepts `<>…</>` fragments, whose element
  // type resolves to this value.
  export const Fragment: any

  export function useState<S>(initialState: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void]
  export function useReducer<S>(reducer: (state: S) => S, initialState: S): [S, () => void]
  export function useReducer<S, A>(reducer: (state: S, action: A) => S, initialState: S): [S, (action: A) => void]
  export function useRef<T>(initialValue: T): { current: T }
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => unknown>(callback: T, deps: readonly unknown[]): T

  export type ReactNode = any
}

// Classic JSX namespace (normally contributed by @types/react).
declare namespace JSX {
  type Element = any
  interface ElementChildrenAttribute {
    children: {}
  }
  interface IntrinsicElements {
    [name: string]: any
  }
}
